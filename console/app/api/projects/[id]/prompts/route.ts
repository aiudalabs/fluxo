// /api/projects/[id]/prompts · "qué se le manda a los engines" (F-registry). Reconstruye, con el
// MISMO kernel que despacha (design/src/dispatch.ts → story/sprintPrompt), el prompt EXACTO que se
// envía por corrida — por story (story-mode) y por sprint (sprint-mode). Es determinista desde la
// data de la story, así que refleja fielmente lo que recibió/recibiría el agente. Ownership
// server-side por el tenant de la sesión (reusa loadDispatchContext).
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, admin } from "@/lib/server/githubAuth";
import { loadDispatchContext } from "@/lib/server/dispatchData";
import { storyPrompt, sprintPrompt } from "../../../../../../design/src/dispatch.ts";

function issueNumOf(ref: string | null | undefined): number | null {
  const m = (ref ?? "").match(/#(\d+)$/);
  return m ? Number(m[1]) : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const context = await loadDispatchContext(admin(), session.tenant, id);
  if (!context) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const pick = (r: (typeof context.storyRows)[number]) => ({
    key: r.key, title: r.title, body: r.body, acceptance: r.acceptance, issue: issueNumOf(r.external_ref),
    screenKey: r.screen_key,
  });

  // El preview refleja el guard REAL según el motor del proyecto (engine permite subagentes, Actions no).
  const engine = (context.settings as { exec_env?: string }).exec_env === "fluxo_engine";

  // Por story: solo las espejadas a un issue (sin issue no hay despacho).
  const stories = context.storyRows
    .filter((r) => issueNumOf(r.external_ref) != null)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({ key: r.key, title: r.title, status: r.status, sprint: r.sprint_id, prompt: storyPrompt(pick(r), undefined, engine) }));

  // Por sprint: agrupa por sprint_id, ordena por key, arma el sprintPrompt goal-mode.
  const metaById = new Map(context.sprintRows.map((s) => [s.id, { key: s.key, title: s.title ?? "" }]));
  const bySprint = new Map<string, (typeof context.storyRows)>();
  for (const r of context.storyRows) {
    if (!r.sprint_id) continue;
    (bySprint.get(r.sprint_id) ?? bySprint.set(r.sprint_id, []).get(r.sprint_id)!).push(r);
  }
  const sprints = [...bySprint.entries()]
    .map(([sid, rows]) => {
      const meta = metaById.get(sid);
      const members = rows
        .filter((r) => issueNumOf(r.external_ref) != null)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(pick);
      const title = meta?.title || meta?.key || sid;
      return { key: meta?.key ?? sid, title: meta?.title ?? "", storyKeys: members.map((m) => m.key), prompt: members.length ? sprintPrompt(title, members, undefined, engine) : "" };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return NextResponse.json({ executionUnit: context.settings.execution_unit ?? "story", stories, sprints });
}
