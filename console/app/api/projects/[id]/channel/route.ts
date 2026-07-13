// /api/projects/[id]/channel · el CANAL DE BUILD (portado de v1 dispatch.go listExecutors +
// setClaudeSecret). Dos cosas:
//   GET  → PROBE live: ¿el canal claude_action está listo? = workflow claude.yml en main
//          (Contents:read) Y el secret CLAUDE_CODE_OAUTH_TOKEN presente (Secrets:read). No es
//          un flag en DB — se verifica en vivo. Si la App no tiene el permiso Secrets, lo dice.
//   PUT  → SIEMBRA el secret {token} en el repo vía `gh secret set` (gh cifra con la public key
//          del repo). El token NUNCA se guarda en Fluxo — pasa derecho a GitHub (BYO). Requiere
//          que la Fluxo App tenga el permiso "Secrets: write".
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";

const pexec = promisify(execFile);
const SECRET = "CLAUDE_CODE_OAUTH_TOKEN";
const APP_SETTINGS_PERMS = "https://github.com/settings/apps/fluxo-by-aiudalabs-com/permissions";

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// projectFor: lee el proyecto SOLO si es del tenant de la sesión (ownership server-side).
async function projectFor(tenant: string, id: string): Promise<{ repo: string | null; settings: Record<string, unknown> } | null> {
  const { data } = await admin().from("projects").select("repo,settings,tenant_id").eq("id", id).maybeSingle();
  if (!data || data.tenant_id !== tenant) return null;
  return { repo: data.repo as string | null, settings: (data.settings as Record<string, unknown>) ?? {} };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });
  const { id } = await ctx.params;
  const project = await projectFor(session.tenant, id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const slug = slugOf(project.repo);
  if (!slug) return NextResponse.json({ channels: [], reason: "el proyecto todavía no tiene repo" });
  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  const H = { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" };
  const [wf, sec] = await Promise.all([
    fetch(`https://api.github.com/repos/${slug}/contents/.github/workflows/claude.yml?ref=main`, { headers: H }),
    fetch(`https://api.github.com/repos/${slug}/actions/secrets/${SECRET}`, { headers: H }),
  ]);
  const workflowPresent = wf.ok;
  // 401/403 en el endpoint de secrets = la App NO tiene el permiso Secrets (no es "falta el
  // secret", es "no podemos verlo"). Lo señalamos para que el usuario agregue el permiso.
  const secretsPermMissing = sec.status === 401 || sec.status === 403;
  const secretPresent = sec.ok;

  const claude = {
    id: "claude_action",
    available: workflowPresent && secretPresent,
    reason: !workflowPresent
      ? "falta el workflow claude.yml en main (se agrega al publicar el backlog)"
      : secretsPermMissing
      ? "la Fluxo App necesita el permiso «Secrets: Read & write» para gestionar el token"
      : !secretPresent
      ? "falta el secret CLAUDE_CODE_OAUTH_TOKEN — pegalo abajo para activarlo"
      : "listo",
    workflowPresent,
    secretPresent,
    secretsPermMissing,
  };
  // Copilot en v2 sigue detrás del permiso Copilot de la App (degradado). Honesto: no listo.
  const copilot = { id: "copilot", available: false, reason: "próximamente — requiere el permiso Copilot de la App", workflowPresent: false, secretPresent: false, secretsPermMissing: false };

  return NextResponse.json({
    channels: [claude, copilot],
    defaultChannel: (project.settings.channel as string) ?? "claude_action",
    permissionsUrl: secretsPermMissing ? APP_SETTINGS_PERMS : null,
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });
  const { id } = await ctx.params;
  const project = await projectFor(session.tenant, id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const slug = slugOf(project.repo);
  if (!slug) return NextResponse.json({ error: "el proyecto todavía no tiene repo" }, { status: 400 });

  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!token || token.length < 10) return NextResponse.json({ error: "token vacío o inválido" }, { status: 400 });
  const ghToken = await getUserToken(session.sub);
  if (!ghToken) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  // `gh secret set` cifra el valor con la public key del repo y lo sube. El token del usuario
  // (con el permiso Secrets de la App) autentica. NO se persiste en Fluxo — pasa a GitHub y ya.
  try {
    await pexec("gh", ["secret", "set", SECRET, "--repo", slug, "--body", token], {
      env: { ...process.env, GH_TOKEN: ghToken },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const permMissing = /401|403|Bad credentials|not accessible|Resource not accessible/i.test(msg);
    return NextResponse.json(
      {
        error: permMissing
          ? "GitHub rechazó el secret: la Fluxo App necesita el permiso «Secrets: Read & write». Agregalo y reintentá."
          : `no se pudo setear el secret: ${msg.split("\n")[0]}`,
        permissionsUrl: permMissing ? APP_SETTINGS_PERMS : null,
      },
      { status: permMissing ? 409 : 502 },
    );
  }
  return NextResponse.json({ saved: true });
}
