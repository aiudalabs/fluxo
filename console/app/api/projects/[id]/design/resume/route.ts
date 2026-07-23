// POST /api/projects/[id]/design/resume · REANUDAR un design-run que quedó `failed`. El worker no
// re-resume runs terminales (failed) ni arranca uno nuevo si el proyecto ya tiene run → un fallo (aun
// transitorio, p.ej. un 525 de Supabase) dejaba el diseño trabado sin salida. Este endpoint repone el
// último run failed a "running" + heartbeat viejo → el worker lo ve HUÉRFANO y lo re-resume desde donde
// quedó (las fases/gates ya resueltos se saltean). Server-side + service_role (no confía en el cliente).
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, admin } from "@/lib/server/githubAuth";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = admin();
  const { data: proj } = await sb.from("projects").select("tenant_id").eq("id", id).single();
  if (!proj || (proj as { tenant_id: string }).tenant_id !== session.tenant) return NextResponse.json({ error: "sin acceso" }, { status: 403 });

  const { data: run } = await sb.from("design_runs").select("id,status,workflow").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!run) return NextResponse.json({ error: "no hay design-run para este proyecto" }, { status: 404 });
  const r = run as { id: string; status: string; workflow: string };
  if (r.status !== "failed") return NextResponse.json({ error: "el run no está fallido (nada que reanudar)" }, { status: 409 });
  // Las ceremonias (sprint-planning/review/retro) se re-planean solas (reconcileCeremonies); no van por acá.
  if (["sprint-planning", "sprint-review", "retro"].includes(r.workflow)) {
    return NextResponse.json({ error: "las ceremonias se re-planean automáticamente (mirá el Flow)" }, { status: 409 });
  }

  // running + heartbeat viejo (>90s) = huérfano → reconcileDesign lo re-resume en el próximo tick.
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { error } = await sb.from("design_runs").update({ status: "running", heartbeat_at: stale }).eq("id", r.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, runId: r.id });
}
