// GET /api/projects/[id]/candidates · qué se puede DESPACHAR AHORA (F6a). Corre el kernel puro
// candidates() (design/src/dispatch.ts vía dispatchData) sobre las stories+sprints+settings del
// proyecto leídas de Supabase — es DB-only (candidates() no lee GitHub: usa status + external_ref
// de la DB). Ownership server-side por el tenant de la sesión. El board pinta el botón ▶ sobre
// las unidades que este endpoint devuelve.
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, admin } from "@/lib/server/githubAuth";
import { loadDispatchContext, computeCandidates } from "@/lib/server/dispatchData";
import type { DispatchCandidate } from "@/lib/types";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const context = await loadDispatchContext(admin(), session.tenant, id);
  if (!context) return NextResponse.json({ error: "project not found" }, { status: 404 });

  // Sin repo no hay a dónde despachar → sin candidatos (pero no es un error).
  if (!context.repo) return NextResponse.json({ candidates: [] });

  const ui = computeCandidates(context.storyRows, context.sprintRows, context.settings);
  // UICandidate → DispatchCandidate (shape que el board/KanbanBoard ya consume). `stories` = KEYs
  // para mapear el botón a cada card; `executor` = canal; `id` = KEY estable (handle del POST).
  const candidates: DispatchCandidate[] = ui.map((c) => ({
    kind: c.kind, id: c.id, title: c.title, stories: c.storyKeys,
    lane: c.lane, model: c.model, executor: c.channel,
  }));
  return NextResponse.json({ candidates });
}
