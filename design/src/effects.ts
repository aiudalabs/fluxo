// effects.ts — el EffectExecutor unificado del motor. Despacha un paso-efecto por su `stepType` al
// handler correcto: el motor NO ramifica por método (golden rule #1) — ramifica ACÁ, en la capa de
// ports. Cubre el handoff al repo (pr/ticket_publish, vía makeHandoff) y los efectos de ceremonia.
// Sumar un efecto = un case acá + su método en el store; cero cambios en el kernel.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HandoffExecutor } from "./engine.ts";
import { resolveInputs, type StepContext } from "./resolve.ts";
import type { Step } from "./workflow.ts";
import type { SupabaseDesignStore } from "./supabase.ts";
import { makeHandoff, parseBacklog, type GithubTarget } from "./handoff.ts";
import { parseActions } from "./plan.ts";
import { computePlan } from "./planApply.ts";
import { parseProposals, registryPath } from "./proposals.ts";

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

// releaseStep: la "preview" del sprint-review. v1 LIVIANA: la preview es el código INTEGRADO en la
// rama dev (vista de GitHub), no una app corriendo — honesto y sin infra. Se sube a una preview
// navegable (Vercel/CF) en un incremento posterior. Escribe preview_url en el ctx para que el paso
// `report` lo referencie ($release.output.preview_url) — el motor no persiste output de efectos, pero
// una ceremonia caída se re-corre fresca (no se reanuda), así que alcanza con el ctx en vuelo.
function releaseStep(repo: string | undefined, step: EffectStep, ctx: StepContext): void {
  const previewUrl = repo ? `https://github.com/${repo}/tree/dev` : "";
  ctx[step.id] = { output: { preview_url: previewUrl } };
  console.log(`  ↪ release: preview v1 (código integrado en dev) → ${previewUrl || "(sin repo)"}`);
}

// publishCorrectionsStep: un ticket_publish con `optional:true` (sprint-review) — appendea las stories
// de corrección del doc `backlog:` al backlog (idempotente, delta aditivo como iterate). Optional: si
// el doc no existe (skip_if_empty saltó corrections) o no trae stories, es un no-op limpio, no un error.
async function publishCorrectionsStep(store: SupabaseDesignStore, workdir: string, step: EffectStep, ctx: StepContext): Promise<void> {
  const inputs = resolveInputs(step.inputs, ctx);
  const path = String(inputs.backlog ?? "");
  let text: string;
  try { text = readFileSync(join(workdir, path), "utf8"); }
  catch { console.log(`  ↪ publish (opcional): sin doc ${path} → no-op`); return; }
  const { sprints, stories } = parseBacklog(text);
  if (!stories.length) { console.log(`  ↪ publish (opcional): ${path} sin stories → no-op`); return; }
  const r = await store.publishBacklog(sprints, stories, { full: false }); // APPEND (nunca encoge)
  await store.brainAppend("corrections_published", { stories: r.stories }, "engine:publish_corrections");
  console.log(`  ↪ publish: ${stories.length} corrección(es) appendadas al backlog`);
}

// registryApplyStep: la retro aprobada → EDITA el método de la fábrica (agents/skills/workflows).
// Lo más sensible del sistema: parseProposals ya validó forma + guardrails (kind, path-safe, nunca
// el método propio de la retro). Acá el candado extra: el archivo a reemplazar DEBE existir (solo
// mejora, no crea) y todo-o-nada (validar-todo antes de escribir-nada). Estampa retro_at al cerrar.
async function registryApplyStep(store: SupabaseDesignStore, workdir: string, registryDir: string, step: EffectStep, ctx: StepContext): Promise<void> {
  const inputs = resolveInputs(step.inputs, ctx);
  const sprintKey = String(inputs.sprint_id ?? "");
  const retroPath = String(inputs.retro ?? "");
  if (!sprintKey || !retroPath) throw new Error(`registry_apply: faltan inputs (sprint_id='${sprintKey}' retro='${retroPath}')`);
  const proposals = parseProposals(readFileSync(join(workdir, retroPath), "utf8"));
  // Validar TODO antes de escribir NADA (atómico): cada archivo a reemplazar debe existir.
  const targets = proposals.map((p) => {
    const rel = registryPath(p);
    const abs = join(registryDir, rel);
    if (!existsSync(abs)) throw new Error(`registry_apply: ${p.kind} '${p.id}' no existe (${rel}) — la retro solo MEJORA método existente, no crea archivos nuevos`);
    return { p, abs, rel };
  });
  // Escribir TODO primero (los targets ya están validados), LUEGO auditar, LUEGO estampar. Si un
  // brainAppend falla, retro_at queda sin estampar → el próximo tick re-corre fresco (writes whole-file
  // idempotentes) — evita el estado parcial de intercalar write y audit.
  for (const { p, abs, rel } of targets) {
    writeFileSync(abs, p.content, "utf8");
    console.log(`  ↪ registry_apply: método editado → ${rel}`);
  }
  for (const { p, rel } of targets) {
    await store.brainAppend("method_edited", { kind: p.kind, id: p.id, path: rel, rationale: p.rationale ?? null }, "engine:registry_apply");
  }
  await store.stampSprintRetro(sprintKey);
  console.log(`  ↪ retro cerrada: sprint ${sprintKey}, ${proposals.length} edición(es) al método, retro_at estampado`);
}

// makeEffectExecutor: el executor único que se inyecta a runDesign. Despacha por stepType. Un design/
// iterate run usa pr/ticket_publish; una ceremonia usa sus efectos. Todos por el mismo executor.
export function makeEffectExecutor(store: SupabaseDesignStore, workdir: string, opts?: { github?: GithubTarget; full?: boolean; repo?: string; registryDir?: string }): HandoffExecutor {
  const publish = makeHandoff(store, workdir, opts?.github, { full: opts?.full });
  return {
    async run(step: EffectStep, ctx: StepContext): Promise<void> {
      switch (step.stepType) {
        case "pr":
        case "ticket_publish":
          // `optional:true` distingue el publish de CORRECCIONES (sprint-review, append de un delta)
          // del handoff de diseño/iterate (docs/backlog.yaml completo). Data-driven, no por step id.
          return step.inputs.optional === true
            ? publishCorrectionsStep(store, workdir, step, ctx)
            : publish.run(step, ctx);
        case "plan_apply":
          return applyPlanStep(store, workdir, step, ctx);
        case "review_close":
          return reviewCloseStep(store, workdir, step, ctx);
        case "release":
          return releaseStep(opts?.repo, step, ctx);
        case "registry_apply":
          if (!opts?.registryDir) throw new Error("registry_apply: falta registryDir en el executor");
          return registryApplyStep(store, workdir, opts.registryDir, step, ctx);
        default:
          throw new Error(`effect: stepType no soportado '${step.stepType}' (¿falta cablear su handler en effects.ts?)`);
      }
    },
  };
}
