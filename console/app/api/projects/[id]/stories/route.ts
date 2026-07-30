// POST /api/projects/[id]/stories · agregar una story DIRECTAMENTE al backlog desde la UI.
// El usuario escribe título + cuerpo (el prompt/spec). Creamos un issue de GitHub (para que la story
// quede "espejada" → despachable por el kernel, que exige external_ref) y la insertamos en backlog SIN
// deps → queda READY al toque → el usuario la lanza con ▶ (al motor que tenga el proyecto: Actions o
// fluxo_engine). No depende del scrum-master ni de un design run: es una story de autor humano.
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";

const API = "https://api.github.com";

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { title?: string; body?: string; screen_key?: string; lane?: string };
  const title = (b.title ?? "").trim();
  const body = (b.body ?? "").trim();
  if (!title) return NextResponse.json({ error: "el título es requerido" }, { status: 400 });

  // Proyecto (tenant scope) + repo.
  const { data: project } = await admin().from("projects").select("repo, tenant_id").eq("id", id).eq("tenant_id", session.tenant).single();
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const slug = slugOf(project.repo);
  if (!slug) return NextResponse.json({ error: "el proyecto todavía no tiene repo" }, { status: 400 });

  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  // Issue de GitHub → external_ref (mirrored). El cuerpo del issue ES el spec que el agente recibe.
  const issueBody = body || title;
  const res = await fetch(`${API}/repos/${slug}/issues`, {
    method: "POST",
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo", "Content-Type": "application/json" },
    body: JSON.stringify({ title: `[user] ${title}`, body: issueBody, labels: ["fluxo:user-story"] }),
  });
  if (!res.ok) return NextResponse.json({ error: `no se pudo crear el issue: ${res.status} ${(await res.text()).slice(0, 200)}` }, { status: 502 });
  const issue = (await res.json()) as { number: number };

  // Insert de la story: backlog, SIN deps → ready. key con prefijo de autor humano (único).
  const key = `U-${Date.now().toString(36)}`;
  const { error } = await admin().from("stories").insert({
    project_id: id, tenant_id: session.tenant, key, title, body: body || null,
    lane: b.lane?.trim() || "react-dev", status: "backlog",
    external_ref: `github:${slug}#${issue.number}`, repo: project.repo,
    screen_key: b.screen_key?.trim() || null, blocked_by: [],
  });
  if (error) return NextResponse.json({ error: `no se pudo crear la story: ${error.message}` }, { status: 502 });

  return NextResponse.json({ ok: true, key, issue: issue.number, issueUrl: `https://github.com/${slug}/issues/${issue.number}` });
}
