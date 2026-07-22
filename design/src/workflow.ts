// F5-04 · Parse a registry design workflow (registry/workflows/<id>.yaml) into a
// typed, ordered step list the engine walks. The METHOD stays in data — this loader
// is generic: it maps the declared `type` of each step to an engine `kind` and never
// branches on a step id (golden rule 1).
//
// Step types in the design workflow:
//   design         → an agent produces artifact(s) for a phase
//   validate       → a schema lint before the human sees the doc (engine treats the
//                    real linting as out-of-band; it honours the on_fail loop)
//   human_gate     → freeze until a human approves / corrects / answers open questions
//   pr | ticket_publish → handoff to the client repo (F5-03, infra-blocked)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

export interface OnFail {
  goto: string;
  max: number;
  feedback?: string; // a `$<gate>.detail`-style ref, resolved at loop time
}

export type Step =
  | {
      kind: "design";
      id: string;
      label: string;
      agent: string;
      inputs: Record<string, unknown>;
      onFail?: OnFail;
      // skip_if_empty: nombres de campos de contexto (feedback/answers) que, si NINGUNO está
      // presente en la corrida encolada, saltean esta fase por completo (no llama al agente). El
      // caso: un paso reject-loop-body (p.ej. `corrections` de sprint-review) que en el pase lineal
      // feliz no debe hacer nada, y solo se activa cuando el gate rechaza/responde.
      skipIfEmpty?: string[];
    }
  | { kind: "validate"; id: string; label: string; inputs: Record<string, unknown>; onFail?: OnFail }
  | { kind: "gate"; id: string; reason: string; onFail: OnFail }
  // handoff = el paso-EFECTO genérico: el motor no sabe QUÉ hace, solo llama al executor inyectado
  // por `stepType`. Cubre pr/ticket_publish (handoff al repo) Y los efectos de ceremonia
  // (release/plan_apply/review_close/registry_apply). Sumar un efecto = un stepType nuevo acá + su
  // handler en la capa de ports (main.ts) — cero branching de método en el motor (golden rule #1).
  | { kind: "handoff"; id: string; stepType: string; label: string; inputs: Record<string, unknown> };

export interface Workflow {
  id: string;
  version: string;
  steps: Step[];
}

interface RawStep {
  id?: string;
  type?: string;
  label?: string;
  agent?: string;
  inputs?: Record<string, unknown>;
  on_fail?: { goto?: string; max?: number; feedback?: string };
  skip_if_empty?: string[];
}

interface RawWorkflow {
  id?: string;
  version?: string;
  steps?: RawStep[];
}

function parseOnFail(raw: RawStep["on_fail"], stepId: string): OnFail | undefined {
  if (!raw) return undefined;
  if (!raw.goto) throw new Error(`workflow: step ${stepId} on_fail has no goto`);
  return { goto: raw.goto, max: raw.max ?? 1, feedback: raw.feedback };
}

// mapStep turns a declared step into a typed engine Step. Unknown types are an error
// (fail loud, not silently skipped — L-AUTO-3).
function mapStep(raw: RawStep): Step {
  const id = raw.id;
  if (!id) throw new Error("workflow: a step has no id");
  const type = raw.type;
  const inputs = raw.inputs ?? {};
  switch (type) {
    case "design": {
      if (!raw.agent) throw new Error(`workflow: design step ${id} has no agent`);
      return {
        kind: "design", id, label: raw.label ?? id, agent: raw.agent, inputs,
        onFail: parseOnFail(raw.on_fail, id),
        ...(Array.isArray(raw.skip_if_empty) && raw.skip_if_empty.length ? { skipIfEmpty: raw.skip_if_empty } : {}),
      };
    }
    case "validate":
      return { kind: "validate", id, label: raw.label ?? id, inputs, onFail: parseOnFail(raw.on_fail, id) };
    case "human_gate": {
      const onFail = parseOnFail(raw.on_fail, id);
      if (!onFail) throw new Error(`workflow: gate ${id} has no on_fail (nowhere to loop on reject)`);
      const reason = typeof inputs.reason === "string" ? inputs.reason : "";
      return { kind: "gate", id, reason, onFail };
    }
    // Efectos: handoff al repo (pr/ticket_publish) + efectos de ceremonia. Todos van al mismo
    // executor inyectado, que despacha por stepType. El motor no ramifica por cuál sea.
    case "pr":
    case "ticket_publish":
    case "release":
    case "plan_apply":
    case "review_close":
    case "registry_apply":
      return { kind: "handoff", id, stepType: type, label: raw.label ?? id, inputs };
    default:
      throw new Error(`workflow: step ${id} has unknown type ${String(type)}`);
  }
}

export function parseWorkflow(doc: unknown): Workflow {
  const raw = doc as RawWorkflow;
  if (!raw?.id) throw new Error("workflow: no id");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error("workflow: no steps");
  return { id: raw.id, version: raw.version ?? "0", steps: raw.steps.map(mapStep) };
}

export function loadWorkflow(registryDir: string, id: string): Workflow {
  const text = readFileSync(join(registryDir, "workflows", `${id}.yaml`), "utf8");
  return parseWorkflow(load(text));
}

// designPhases lists the phase (design) steps in order — the UI derives the pipeline
// from these (type: design = a phase; the following human_gate = its gate).
export function designPhases(wf: Workflow): Array<{ id: string; label: string }> {
  return wf.steps.filter((s): s is Extract<Step, { kind: "design" }> => s.kind === "design").map((s) => ({ id: s.id, label: s.label }));
}

// declaredOutputs: los `output:` que las fases design del workflow declaran producir —
// la fuente de verdad EN DATA (registry) de qué documentos debe dejar un run. El handoff
// la usa para verificar intención-vs-realidad sobre lo cosechado (repodocs.planRepoDocs);
// NUNCA para enumerar qué commitear (eso se deriva del workdir — el bug REPO_DOCS).
export function declaredOutputs(wf: Workflow): string[] {
  const outs = wf.steps
    .filter((s): s is Extract<Step, { kind: "design" }> => s.kind === "design")
    .map((s) => s.inputs.output)
    .filter((o): o is string => typeof o === "string" && o.trim() !== "")
    .map((o) => o.trim());
  return [...new Set(outs)];
}
