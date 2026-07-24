// POST /api/projects/[id]/runs/cancel · DETENER una story "running". Hoy no había forma de parar un
// build (ni un "running" falso que quedó pegado cuando una Action falló). Este endpoint, con el token
// OAuth del usuario (la App tiene actions:write): (1) cancela el workflow_run vivo si lo hay, (2) saca
// el label `agent:running` del issue para que la proyección deje de verlo running, y (3) resetea la
// story a `backlog` (via el RPC project_external_status, service_role) → queda re-despachable. Todo
// best-effort en 1 y 2 (si la Action ya terminó/no hay run, igual resetea el estado). Ownership por tenant.
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";

const API = "https://api.github.com";
const H = (t: string) => ({ Authorization: `token ${t}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" });
function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { storyKey?: string };
  if (!body.storyKey) return NextResponse.json({ error: "storyKey requerido" }, { status: 400 });

  const sb = admin();
  const { data: proj } = await sb.from("projects").select("tenant_id,repo").eq("id", id).maybeSingle();
  if (!proj || (proj as { tenant_id: string }).tenant_id !== session.tenant) return NextResponse.json({ error: "sin acceso" }, { status: 403 });
  const slug = slugOf((proj as { repo: string | null }).repo);

  const { data: story } = await sb.from("stories").select("id,external_ref,session_url,status").eq("project_id", id).eq("key", body.storyKey).maybeSingle();
  if (!story) return NextResponse.json({ error: "story no encontrada" }, { status: 404 });
  const s = story as { id: string; external_ref: string | null; session_url: string | null; status: string };

  const token = await getUserToken(session.sub);
  if (!token && slug) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  const issueNum = (s.external_ref ?? "").match(/#(\d+)$/)?.[1];
  const runId = (s.session_url ?? "").match(/actions\/runs\/(\d+)/)?.[1];

  // 1) cancelar el run vivo (si hay) — best-effort.
  if (slug && token && runId) {
    await fetch(`${API}/repos/${slug}/actions/runs/${runId}/cancel`, { method: "POST", headers: H(token) }).catch(() => {});
  }
  // 2) sacar agent:running del issue → la proyección lo ve idle, no running (best-effort).
  if (slug && token && issueNum) {
    await fetch(`${API}/repos/${slug}/issues/${issueNum}/labels/${encodeURIComponent("agent:running")}`, { method: "DELETE", headers: H(token) }).catch(() => {});
  }
  // 3) resetear el estado en la DB → backlog (inmediato; la proyección ya no lo pisa).
  const { error } = await sb.rpc("project_external_status", { p_story_id: s.id, p_status: "backlog", p_pr_url: null, p_agent_lost: null });
  if (error) return NextResponse.json({ error: `reset: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, cancelledRun: !!runId });
}
