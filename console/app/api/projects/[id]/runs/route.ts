// /api/projects/[id]/runs · APROBAR WORKFLOWS (F6b — el "aprobar workflows" de v1 approve.go,
// pero MANUAL desde la vista Agentes; el auto_if_safe es Fase 5). Los runs de CI de PRs de agentes
// quedan `action_required` (un agente podría editar el CI, así que GitHub los retiene). Acá:
//   GET  → lista los runs en `action_required` del repo (con el token OAuth del usuario).
//   POST → aprueba UN run { runId } (POST .../actions/runs/{id}/approve).
// Ownership server-side por el tenant de la sesión; el token del usuario (la App tiene actions:write).
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";

const API = "https://api.github.com";
const H = (t: string) => ({ Authorization: `token ${t}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" });

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// projectSlugFor: repo del proyecto SOLO si es del tenant de la sesión (ownership server-side).
async function projectSlugFor(tenant: string, id: string): Promise<{ slug: string | null; found: boolean }> {
  const { data } = await admin().from("projects").select("repo,tenant_id").eq("id", id).maybeSingle();
  if (!data || data.tenant_id !== tenant) return { slug: null, found: false };
  return { slug: slugOf(data.repo as string | null), found: true };
}

interface RunSummary {
  id: number; name: string; title: string; html_url: string;
  branch: string; event: string; created_at: string;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const { slug, found } = await projectSlugFor(session.tenant, id);
  if (!found) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (!slug) return NextResponse.json({ runs: [] });

  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  const res = await fetch(`${API}/repos/${slug}/actions/runs?status=action_required&per_page=30`, { headers: H(token) });
  if (!res.ok) return NextResponse.json({ error: `GET runs → ${res.status}` }, { status: 502 });
  const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
  const runs: RunSummary[] = (data.workflow_runs ?? []).map((r) => ({
    id: r.id as number,
    name: (r.name as string) ?? "",
    title: (r.display_title as string) ?? "",
    html_url: (r.html_url as string) ?? "",
    branch: (r.head_branch as string) ?? "",
    event: (r.event as string) ?? "",
    created_at: (r.created_at as string) ?? "",
  }));
  return NextResponse.json({ runs });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { runId?: number };
  if (!body.runId) return NextResponse.json({ error: "runId requerido" }, { status: 400 });

  const { slug, found } = await projectSlugFor(session.tenant, id);
  if (!found) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (!slug) return NextResponse.json({ error: "el proyecto todavía no tiene repo" }, { status: 400 });

  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  const res = await fetch(`${API}/repos/${slug}/actions/runs/${body.runId}/approve`, { method: "POST", headers: H(token) });
  if (!res.ok) return NextResponse.json({ error: `approve → ${res.status} ${(await res.text()).split("\n")[0]}` }, { status: 502 });
  return NextResponse.json({ approved: true });
}
