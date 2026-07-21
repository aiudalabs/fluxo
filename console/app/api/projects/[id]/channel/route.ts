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
import {
  registryDir,
  resolveProjectCapabilities,
  secretWhitelist,
  loadProvisioningYaml,
  CLAUDE_SECRET,
  type ResolvedCapability,
} from "@/lib/server/capabilitiesData";

const pexec = promisify(execFile);
const SECRET = CLAUDE_SECRET; // el canal de build de Claude (siempre presente, no es una capability)
const APP_SETTINGS_PERMS = "https://github.com/settings/apps/fluxo-by-aiudalabs-com/permissions";

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// projectCapabilities: resuelve las capabilities del proyecto (data-driven) desde el registry a
// partir del `stack` de su docs/provisioning.yaml. La fuente del provisioning.yaml es el brain
// (brain_events kind=artifact, project-wide, versionado — la misma que lee el Studio); tomamos la
// última versión del path. Sin provisioning aún (diseño no corrido) → [] (no rompe el canal claude).
async function projectCapabilities(projectId: string): Promise<ResolvedCapability[]> {
  const content = await loadProvisioningYaml(admin(), projectId);
  if (!content) return [];
  return resolveProjectCapabilities(registryDir(), content);
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
  let token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  const H = (t: string) => ({ Authorization: `token ${t}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" });
  const secretUrl = `https://api.github.com/repos/${slug}/actions/secrets/${SECRET}`;
  const [wf, sec0] = await Promise.all([
    fetch(`https://api.github.com/repos/${slug}/contents/.github/workflows/claude.yml?ref=main`, { headers: H(token) }),
    fetch(secretUrl, { headers: H(token) }),
  ]);
  let sec = sec0;
  // 401/403 en secrets puede ser (a) la App no tiene el permiso, o (b) el token guardado es
  // ANTERIOR a que el usuario concediera el permiso (no lo trae hasta re-emitirse). Forzamos
  // un refresh y reintentamos UNA vez: si sigue 401/403 es (a) de verdad; si no, era (b).
  if (sec.status === 401 || sec.status === 403) {
    const fresh = await getUserToken(session.sub, true);
    if (fresh && fresh !== token) { token = fresh; sec = await fetch(secretUrl, { headers: H(token) }); }
  }
  const workflowPresent = wf.ok;
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

  // Capabilities del proyecto (Firebase, Vercel…): por cada una, ¿está su Actions secret presente en
  // el repo? v1 del probe = "secret presente" (igual que el token de Claude); el probe pesado del YAML
  // (correr contra el servicio real) se difiere. Reusamos el `token` (ya refrescado por el bloque de
  // arriba si hizo falta). Un secret ausente → ⚪ (falta); presente → 🟢.
  const caps = await projectCapabilities(id);
  const capabilities = await Promise.all(
    caps.map(async (c) => {
      if (!c.secret) {
        return { id: c.id, name: c.name, secret: null, guide: c.guide ?? null, summary: c.summary ?? null, status: "n/a", secretsPermMissing: false };
      }
      const r = await fetch(`https://api.github.com/repos/${slug}/actions/secrets/${c.secret}`, { headers: H(token) });
      const permMissing = r.status === 401 || r.status === 403;
      return {
        id: c.id,
        name: c.name,
        secret: c.secret,
        guide: c.guide ?? null,
        summary: c.summary ?? null,
        status: r.ok ? "ready" : "missing",
        secretsPermMissing: permMissing,
      };
    }),
  );

  return NextResponse.json({
    channels: [claude, copilot],
    capabilities,
    defaultChannel: (project.settings.channel as string) ?? "claude_action",
    permissionsUrl: secretsPermMissing || capabilities.some((c) => c.secretsPermMissing) ? APP_SETTINGS_PERMS : null,
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

  // Acepta { secret, value } (una capability) o el legacy { token } (el canal de Claude). El valor
  // NUNCA se persiste en Fluxo — pasa derecho a `gh secret set`.
  const body = (await req.json().catch(() => ({}))) as { secret?: string; value?: string; token?: string };
  const secretName = (body.secret ?? SECRET).trim();
  const secretValue = body.value ?? body.token;
  if (!secretValue || secretValue.length < 10) return NextResponse.json({ error: "valor del secret vacío o inválido" }, { status: 400 });

  // ⚠️ SEGURIDAD: solo se siembra un secret de la whitelist del proyecto (el token de Claude ∪ los
  // secrets de las capabilities que el registry declara para su stack). NUNCA un secret arbitrario.
  const caps = await projectCapabilities(id);
  if (!secretWhitelist(caps).has(secretName)) {
    return NextResponse.json({ error: `secret «${secretName}» no permitido para este proyecto` }, { status: 400 });
  }

  let ghToken = await getUserToken(session.sub);
  if (!ghToken) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  // `gh secret set` cifra el valor con la public key del repo y lo sube. El token del usuario
  // (con el permiso Secrets de la App) autentica. NO se persiste en Fluxo — pasa a GitHub y ya.
  const permRe = /401|403|Bad credentials|not accessible|Resource not accessible/i;
  const seed = (t: string) => pexec("gh", ["secret", "set", secretName, "--repo", slug, "--body", secretValue], { env: { ...process.env, GH_TOKEN: t } });
  try {
    await seed(ghToken);
  } catch (e) {
    // Un 401/403 puede ser un token anterior al permiso recién concedido → force-refresh + retry.
    if (permRe.test(e instanceof Error ? e.message : String(e))) {
      const fresh = await getUserToken(session.sub, true);
      if (fresh && fresh !== ghToken) {
        ghToken = fresh;
        try { await seed(ghToken); return NextResponse.json({ saved: true }); } catch { /* cae al error de abajo */ }
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    const permMissing = permRe.test(msg);
    return NextResponse.json(
      {
        error: permMissing
          ? "GitHub rechazó el secret: la Fluxo App necesita el permiso «Secrets: Read & write» (aprobalo en la instalación)."
          : `no se pudo setear el secret: ${msg.split("\n")[0]}`,
        permissionsUrl: permMissing ? APP_SETTINGS_PERMS : null,
      },
      { status: permMissing ? 409 : 502 },
    );
  }
  return NextResponse.json({ saved: true });
}
