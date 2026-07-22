// planApply.ts — aplica un PLAN aprobado al backlog VIVO. Atómico (golden rule #2, estado crítico
// determinista): valida TODAS las acciones contra la data viva y si UNA es ilegal no aplica NADA,
// nombrando la ofensora. El núcleo `computePlan` es PURO (opera sobre snapshots, sin DB) → testeable.
//
// Alcance de este slice: move / edit / defer(→ sprint siguiente existente) + `actions:[]`. `cancel`
// (requiere status 'cancelled' — migración) y `split` (requiere rewire de deps) se RECHAZAN limpio
// hasta su incremento, para que un plan que los use falle atómico y no en silencio.
import type { PlanAction, EditFields } from "./plan.ts";

// Snapshots de la data viva (keys humanas, como las ve el planner; el store resuelve key→uuid).
export interface LiveStory {
  key: string;
  status: string;               // backlog | ready | running | review | done | failed | blocked
  sprintKey: string | null;     // sprint al que pertenece (key)
  deps: string[];               // dependencias como KEYS de story (blocked_by resuelto a keys)
}
export interface LiveSprint {
  key: string;
  position: number;             // orden de disparo
}

// Mutaciones concretas que el store aplicará (idempotentes). El store resuelve keys→uuids.
export type StoreMutation =
  | { kind: "setSprint"; storyKey: string; sprintKey: string }        // move / defer
  | { kind: "patchFields"; storyKey: string; fields: Omit<EditFields, "deps"> } // edit (no-deps)
  | { kind: "setDeps"; storyKey: string; depKeys: string[] };          // edit deps (reemplaza el set)

export class PlanApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanApplyError";
  }
}

const MOVABLE = new Set(["backlog", "failed"]);          // move: spec §Actions — solo backlog/failed
const NON_DEFERRABLE = new Set(["running", "review", "done"]); // defer: cualquiera MENOS en-vuelo/terminada

// reachesSelf: ¿la story `start` depende transitivamente de sí misma, dado el grafo key→deps?
// (detecta el ciclo que introducirían las nuevas deps de un edit).
function reachesSelf(start: string, graph: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === start) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(graph.get(n) ?? []));
  }
  return false;
}

// computePlan: valida TODAS las acciones contra los snapshots y devuelve las mutaciones (en orden),
// o lanza PlanApplyError con la primera ofensora. No aplica nada (eso lo hace el caller contra el store).
export function computePlan(actions: PlanAction[], stories: LiveStory[], sprints: LiveSprint[]): StoreMutation[] {
  const storyByKey = new Map(stories.map((s) => [s.key, s]));
  const sprintByKey = new Map(sprints.map((s) => [s.key, s]));
  const sprintsByPos = [...sprints].sort((a, b) => a.position - b.position);

  // Grafo de deps ACUMULADO: arranca del snapshot y se sobre-escribe con cada edit aceptado, para que
  // la detección de ciclos vea también las deps que OTRAS acciones del mismo plan ya cambiaron (un
  // ciclo cross-acción: edit A deps=[B] + edit B deps=[A], cada uno sano contra el snapshot pero
  // juntos ciclo). Copia las listas para no mutar los inputs.
  const graph = new Map(stories.map((s) => [s.key, [...s.deps]]));
  const touched = new Set<string>(); // una story no puede ser objeto de dos acciones (spec §Atomicidad)
  // NOTA de contrato: en un `edit` se hace push de patchFields ANTES de validar las deps, así que si
  // las deps son ilegales `muts` queda con una mutación parcial de esa acción — INOFENSIVO solo
  // porque el contrato es "si lanza, el caller no aplica NADA". No consumir un retorno parcial.
  const muts: StoreMutation[] = [];

  for (const a of actions) {
    const st = storyByKey.get(a.storyId);
    if (!st) throw new PlanApplyError(`${a.op} ${a.storyId}: la story no existe en el backlog vivo`);
    if (touched.has(a.storyId)) throw new PlanApplyError(`${a.storyId}: dos acciones sobre la misma story (conflicto)`);
    touched.add(a.storyId);

    if (a.op === "move") {
      if (!MOVABLE.has(st.status)) throw new PlanApplyError(`move ${a.storyId}: solo se puede mover una story 'backlog'/'failed' (está '${st.status}')`);
      if (!sprintByKey.has(a.sprintId)) throw new PlanApplyError(`move ${a.storyId}: el sprint destino '${a.sprintId}' no existe`);
      muts.push({ kind: "setSprint", storyKey: a.storyId, sprintKey: a.sprintId });
      continue;
    }

    if (a.op === "defer") {
      // spec §Actions: defer no restringe status (solo "must be in a sprint"). Bloqueamos únicamente
      // lo en-vuelo/terminado — diferir una story ready/blocked/backlog/failed es legítimo (§3 "shed
      // weakest-priority stories").
      if (NON_DEFERRABLE.has(st.status)) throw new PlanApplyError(`defer ${a.storyId}: no se puede diferir una story en vuelo/terminada (está '${st.status}')`);
      if (!st.sprintKey) throw new PlanApplyError(`defer ${a.storyId}: la story no está en ningún sprint`);
      const cur = sprintByKey.get(st.sprintKey);
      if (!cur) throw new PlanApplyError(`defer ${a.storyId}: su sprint '${st.sprintKey}' no existe en el snapshot`);
      const next = sprintsByPos.find((sp) => sp.position > cur.position);
      if (!next) throw new PlanApplyError(`defer ${a.storyId}: no hay sprint posterior a '${st.sprintKey}' (crear el sprint siguiente aún no está soportado — usá move a un sprint existente)`);
      muts.push({ kind: "setSprint", storyKey: a.storyId, sprintKey: next.key });
      continue;
    }

    if (a.op === "edit") {
      const { deps, ...rest } = a.fields;
      if (Object.keys(rest).length) muts.push({ kind: "patchFields", storyKey: a.storyId, fields: rest });
      if (deps !== undefined) {
        for (const d of deps) {
          if (d === a.storyId) throw new PlanApplyError(`edit ${a.storyId}: no puede depender de sí misma`);
          if (!storyByKey.has(d)) throw new PlanApplyError(`edit ${a.storyId}: la dep '${d}' no existe`);
        }
        // Ciclo: acumulo las deps nuevas en el grafo (que ya trae las de edits previos del plan) y
        // chequeo que la story no se alcance a sí misma. Cubre ciclos de una y de varias acciones.
        graph.set(a.storyId, deps);
        if (reachesSelf(a.storyId, graph)) throw new PlanApplyError(`edit ${a.storyId}: las deps forman un ciclo`);
        muts.push({ kind: "setDeps", storyKey: a.storyId, depKeys: deps });
      }
      continue;
    }

    // cancel / split — aún no soportados por el apply (fallar atómico, nunca en silencio).
    throw new PlanApplyError(`${a.op} ${a.storyId}: '${a.op}' aún no está soportado por el apply (próximo incremento) — el plan no se aplicó`);
  }

  return muts;
}
