// effects.ts — el EffectExecutor unificado del motor. Despacha un paso-efecto por su `stepType` al
// handler correcto: el motor NO ramifica por método (golden rule #1) — ramifica ACÁ, en la capa de
// ports. Cubre el handoff al repo (pr/ticket_publish, vía makeHandoff) y los efectos de ceremonia.
// Sumar un efecto = un case acá + su método en el store; cero cambios en el kernel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HandoffExecutor } from "./engine.ts";
import { resolveInputs, type StepContext } from "./resolve.ts";
import type { Step } from "./workflow.ts";
import type { SupabaseDesignStore } from "./supabase.ts";
import { makeHandoff, type GithubTarget } from "./handoff.ts";
import { parseActions } from "./plan.ts";
import { computePlan } from "./planApply.ts";

type EffectStep = Extract<Step, { kind: "handoff" }>;

// applyPlanStep: la ceremonia sprint-planning aprobada → muta el backlog VIVO. Lee el PLAN doc del
// workdir, parsea sus acciones, las valida contra la data viva (computePlan) y las aplica atómico,
// estampando planned_at (lo que DESTRABA el dispatch del sprint). `sprint_id` del trigger = KEY.
async function applyPlanStep(store: SupabaseDesignStore, workdir: string, step: EffectStep, ctx: StepContext): Promise<void> {
  const inputs = resolveInputs(step.inputs, ctx);
  const planPath = String(inputs.plan ?? "");
  const sprintKey = String(inputs.sprint_id ?? "");
  if (!planPath || !sprintKey) throw new Error(`plan_apply: faltan inputs (plan='${planPath}' sprint_id='${sprintKey}')`);
  const planText = readFileSync(join(workdir, planPath), "utf8");
  const actions = parseActions(planText);
  const live = await store.loadLiveBacklog();
  const muts = computePlan(actions, live.stories, live.sprints);
  await store.applySprintPlan(muts, sprintKey);
  await store.brainAppend("sprint_planned", { sprint: sprintKey, actions: actions.length, mutations: muts.length }, "engine:plan_apply");
  console.log(`  ↪ plan_apply: sprint ${sprintKey} planeado — ${actions.length} acción(es) → ${muts.length} mutación(es), planned_at estampado`);
}

// reviewCloseStep: cierra la ceremonia sprint-review — estampa reviewed_at (destraba el ciclo) y
// registra la decisión (accepted | accepted_with_corrections según el doc de correcciones). Determinista.
async function reviewCloseStep(store: SupabaseDesignStore, workdir: string, step: EffectStep, ctx: StepContext): Promise<void> {
  const inputs = resolveInputs(step.inputs, ctx);
  const sprintKey = String(inputs.sprint_id ?? "");
  if (!sprintKey) throw new Error(`review_close: falta sprint_id`);
  const corrPath = String(inputs.corrections ?? "");
  let corrections = 0;
  if (corrPath) {
    try {
      const txt = readFileSync(join(workdir, corrPath), "utf8");
      corrections = (txt.match(/^\s*-\s+(id|key):/gm) ?? []).length; // # de stories de corrección en el doc
    } catch { /* sin doc (skip_if_empty saltó corrections) → sin correcciones */ }
  }
  await store.stampSprintReviewed(sprintKey);
  const decision = corrections > 0 ? "accepted_with_corrections" : "accepted";
  await store.brainAppend("sprint_reviewed", { sprint: sprintKey, decision, corrections }, "engine:review_close");
  console.log(`  ↪ review_close: sprint ${sprintKey} ${decision}${corrections ? ` (${corrections} corrección/es)` : ""}, reviewed_at estampado`);
}

// makeEffectExecutor: el executor único que se inyecta a runDesign. Despacha por stepType. Un design/
// iterate run usa pr/ticket_publish; una ceremonia usa sus efectos. Todos por el mismo executor.
export function makeEffectExecutor(store: SupabaseDesignStore, workdir: string, opts?: { github?: GithubTarget; full?: boolean }): HandoffExecutor {
  const publish = makeHandoff(store, workdir, opts?.github, { full: opts?.full });
  return {
    async run(step: EffectStep, ctx: StepContext): Promise<void> {
      switch (step.stepType) {
        case "pr":
        case "ticket_publish":
          return publish.run(step, ctx);
        case "plan_apply":
          return applyPlanStep(store, workdir, step, ctx);
        case "review_close":
          return reviewCloseStep(store, workdir, step, ctx);
        default:
          throw new Error(`effect: stepType no soportado '${step.stepType}' (¿falta cablear su handler en effects.ts?)`);
      }
    },
  };
}
