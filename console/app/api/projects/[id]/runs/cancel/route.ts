// POST /api/projects/[id]/runs/cancel · DETENER una UNIDAD "running". No había forma de parar un
// build (ni un "running" falso que quedó pegado cuando una Action falló). Este endpoint, con el token
// OAuth del usuario (la App tiene actions:write):
//   1. EXPANDE la unidad server-side según execution_unit del proyecto (NO confía en el cliente): en
//      sprint-mode, detener una story detiene TODO el sprint corriendo (todas sus stories `running`
//      del mismo sprint); en story-mode, solo esa story. Espeja la unidad de despacho de dispatch.ts.
//   2. Por cada miembro: saca el label `agent:running` del issue (la proyección deja de verlo running)
//      y resetea la story a `backlog` (via el RPC project_external_status, service_role) → re-despachable.
//   3. Cancela el run vivo de Actions — best-effort y money-safe. `session_url` guarda la página del
//      workflow, NO un run id, y con concurrencia ilimitada (default) no se puede mapear run→issue.
//      Regla honesta: si hay EXACTAMENTE 1 run vivo (queued|in_progress) en el repo → se cancela (el
//      caso serial/sprint típico). Si hay >1 → NO se toca ninguno (no cortar trabajo ajeno) y se avisa.
//      Si hay 0 → nada que cancelar (el caso "running falso" tras un fallo). Un repo = un proyecto (BYO),
//      así que los runs de claude.yml del repo son de ESTE proyecto.
// Los pasos 1-2 son siempre confiables (destraban el estado sin depender de la histéresis ni del run).
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";

const API = "https://api.github.com";
const H = (t: string) => ({ Authorization: `token ${t}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" });
function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// liveRunIds: ids de los workflow runs de claude.yml vivos (queued|in_progress) del repo. Es la señal
// "hay un agente pagando ahora mismo". Best-effort: si la API falla, devuelve [] (no bloquea el reset).
async function liveRunIds(slug: string, token: string): Promise<number[]> {
  const ids: number[] = [];
  for (const status of ["queued", "in_progress"]) {
    try {
      const res = await fetch(`${API}/repos/${slug}/actions/workflows/claude.yml/runs?status=${status}&per_page=50`, { headers: H(token) });
      if (!res.ok) continue;
      const data = (await res.json()) as { workflow_runs?: Array<{ id: number }> };
      for (const r of data.workflow_runs ?? []) ids.push(r.id);
    } catch { /* best-effort */ }
  }
  return ids;
}

interface StoryRow { id: string; key: string; status: string; sprint_id: string | null; external_ref: string | null }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { storyKey?: string };
  if (!body.storyKey) return NextResponse.json({ error: "storyKey requerido" }, { status: 400 });

  const sb = admin();
  const { data: proj } = await sb.from("projects").select("tenant_id,repo,settings").eq("id", id).maybeSingle();
  if (!proj || (proj as { tenant_id: string }).tenant_id !== session.tenant) return NextResponse.json({ error: "sin acceso" }, { status: 403 });
  const slug = slugOf((proj as { repo: string | null }).repo);
  const executionUnit = ((proj as { settings?: { execution_unit?: string } }).settings?.execution_unit) === "sprint" ? "sprint" : "story";

  const { data: target } = await sb.from("stories").select("id,key,status,sprint_id,external_ref").eq("project_id", id).eq("key", body.storyKey).maybeSingle();
  if (!target) return NextResponse.json({ error: "story no encontrada" }, { status: 404 });
  const t = target as StoryRow;

  // Expandir a la UNIDAD: en sprint-mode con sprint asignado, todas las stories `running` del mismo
  // sprint (la unidad de despacho); si no, solo la target. Solo stories running (no tocar backlog/done).
  let members: StoryRow[] = [t];
  if (executionUnit === "sprint" && t.sprint_id) {
    const { data: siblings } = await sb.from("stories")
      .select("id,key,status,sprint_id,external_ref")
      .eq("project_id", id).eq("sprint_id", t.sprint_id).eq("status", "running");
    const set = new Map<string, StoryRow>((siblings as StoryRow[] ?? []).map((s) => [s.id, s]));
    set.set(t.id, t); // incluir la target aunque su status ya no sea running (running falso)
    members = [...set.values()];
  }

  const token = await getUserToken(session.sub);
  if (!token && slug) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  // 1) cancelar el run vivo — best-effort, money-safe (ver cabecera).
  let cancelledRuns = 0, liveRuns = 0;
  if (slug && token) {
    const live = await liveRunIds(slug, token);
    liveRuns = live.length;
    if (live.length === 1) {
      const res = await fetch(`${API}/repos/${slug}/actions/runs/${live[0]}/cancel`, { method: "POST", headers: H(token) }).catch(() => null);
      if (res && res.ok) cancelledRuns = 1;
    }
    // >1 run vivo: no cancelar ninguno (no cortar trabajo ajeno con concurrencia ilimitada). Se reporta.
  }

  // 2) por cada miembro: sacar agent:running del issue (best-effort) + resetear a backlog (inmediato).
  for (const m of members) {
    const issueNum = (m.external_ref ?? "").match(/#(\d+)$/)?.[1];
    if (slug && token && issueNum) {
      await fetch(`${API}/repos/${slug}/issues/${issueNum}/labels/${encodeURIComponent("agent:running")}`, { method: "DELETE", headers: H(token) }).catch(() => {});
    }
    const { error } = await sb.rpc("project_external_status", { p_story_id: m.id, p_status: "backlog", p_pr_url: null, p_agent_lost: null });
    if (error) return NextResponse.json({ error: `reset ${m.key}: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, unit: executionUnit, members: members.map((m) => m.key),
    cancelledRuns, liveRuns,
  });
}
