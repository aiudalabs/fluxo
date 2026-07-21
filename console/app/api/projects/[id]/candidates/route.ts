// GET /api/projects/[id]/candidates · qué se puede DESPACHAR AHORA (F6a). Corre el kernel puro
// candidates() (design/src/dispatch.ts vía dispatchData) sobre las stories+sprints+settings del
// proyecto leídas de Supabase — es DB-only (candidates() no lee GitHub: usa status + external_ref
// de la DB). Ownership server-side por el tenant de la sesión. El board pinta el botón ▶ sobre
// las unidades que este endpoint devuelve.
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, admin, getUserToken } from "@/lib/server/githubAuth";
import { loadDispatchContext, computeCandidates, loadCapabilityGate, capWaitingByKey } from "@/lib/server/dispatchData";
import { githubSecretProbe } from "@/lib/server/capabilitiesData";
import type { DispatchCandidate } from "@/lib/types";

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const context = await loadDispatchContext(admin(), session.tenant, id);
  if (!context) return NextResponse.json({ error: "project not found" }, { status: 404 });

  // Sin repo no hay a dónde despachar → sin candidatos (pero no es un error).
  const slug = slugOf(context.repo);
  if (!slug) return NextResponse.json({ candidates: [], capWaiting: {} });

  // Readiness gate por capability (P6-2b Paso 3): resolvemos qué capabilities necesita cada story y
  // cuáles están 🟢 (Actions secret presente, probeado con el token del usuario). Una story que
  // referencia un secret aún no sembrado NO aparece como candidata (sin ▶) y el board la pinta
  // "esperando capability". Probe fail-open: sin token / 403 / red → no gatea (misma verdad que POST).
  const token = await getUserToken(session.sub);
  const { gate, caps } = await loadCapabilityGate(admin(), id, context.storyRows, githubSecretProbe(slug, token));

  const ui = computeCandidates(context.storyRows, context.sprintRows, context.settings, gate);
  // UICandidate → DispatchCandidate (shape que el board/KanbanBoard ya consume). `stories` = KEYs
  // para mapear el botón a cada card; `executor` = canal; `id` = KEY estable (handle del POST).
  const candidates: DispatchCandidate[] = ui.map((c) => ({
    kind: c.kind, id: c.id, title: c.title, stories: c.storyKeys,
    lane: c.lane, model: c.model, executor: c.channel,
  }));
  // capWaiting: por story KEY, las capabilities no-🟢 que la bloquean (para el "⧗ esperando capability").
  const capWaiting = capWaitingByKey(context.storyRows, gate, caps);
  return NextResponse.json({ candidates, capWaiting });
}
