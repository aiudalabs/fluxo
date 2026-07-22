// plan.ts — el DSL de acciones de sprint-planning. Parsea el bloque `actions:` de un PLAN doc y
// valida su FORMA (no contra el store — eso lo hace plan_apply contra la data VIVA al aplicar).
// Puro, sin DB → testeable solo. Gramática: registry/skills/sprint-planning-method.md §Actions.
//
// Atomicidad (golden rule #2, estado crítico determinista): el consumidor valida TODO antes de
// aplicar NADA. Este parser es el primer filtro — una forma ilegal aborta nombrando la acción, así
// el validate_plan del workflow rebota al planner ANTES de que el humano apruebe algo inaplicable.
import { load } from "js-yaml";

export type PlanAction =
  | { op: "move"; storyId: string; sprintId: string }
  | { op: "defer"; storyId: string }
  | { op: "cancel"; storyId: string }
  | { op: "edit"; storyId: string; fields: EditFields }
  | { op: "split"; storyId: string; parts: SplitPart[] };

// edit: solo los campos nombrados cambian. Nombres alineados al store (screen_key snake).
export interface EditFields {
  title?: string;
  body?: string;
  acceptance?: string;
  owner?: string;
  screen_key?: string;
  deps?: string[]; // REEMPLAZA el set de deps
}
export interface SplitPart {
  id?: string; // opcional; si falta, el apply auto-nombra S-4-a, S-4-b…
  title: string; // requerido
  body?: string;
  acceptance?: string;
  owner?: string; // hereda el de la original si falta
}

const OPS = new Set(["move", "defer", "cancel", "edit", "split"]);
const EDIT_FIELDS = ["title", "body", "acceptance", "owner", "screen_key", "deps"] as const;

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

// extractActionsDoc: encuentra el objeto YAML que tiene la clave `actions`. Acepta (a) un bloque
// fenced ```yaml|yml|(sin lenguaje) que parsee a un objeto con `actions`, o (b) el archivo entero
// como YAML con `actions`. Devuelve el valor de `actions` crudo (aún sin validar).
function extractActionsRaw(planText: string): unknown {
  const fences = [...planText.matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fences) {
    let doc: unknown;
    try { doc = load(block); } catch { continue; }
    if (isRecord(doc) && "actions" in doc) return doc.actions;
  }
  // Fallback: el archivo entero como YAML (un PLAN escrito solo como yaml).
  let whole: unknown;
  try { whole = load(planText); } catch { whole = undefined; }
  if (isRecord(whole) && "actions" in whole) return whole.actions;
  throw new PlanParseError("no se encontró un bloque `actions:` en el plan (ni fenced ```yaml ni el archivo entero)");
}

function parseOne(raw: unknown, i: number): PlanAction {
  const where = `acción #${i + 1}`;
  if (!isRecord(raw)) throw new PlanParseError(`${where}: no es un objeto`);
  const op = asString(raw.op);
  if (!op || !OPS.has(op)) throw new PlanParseError(`${where}: op inválido ${JSON.stringify(raw.op)} (esperado move|defer|cancel|edit|split)`);
  const storyId = asString(raw.story_id);
  if (!storyId) throw new PlanParseError(`${where} (${op}): falta story_id`);
  const args = isRecord(raw.args) ? raw.args : {};

  if (op === "move") {
    const sprintId = asString(args.sprint_id);
    if (!sprintId) throw new PlanParseError(`${where} (move ${storyId}): falta args.sprint_id (sprint destino)`);
    return { op, storyId, sprintId };
  }
  if (op === "defer" || op === "cancel") {
    // No llevan args — un args poblado casi siempre es un `move` mal escrito. Fail loud.
    if (Object.keys(args).length) throw new PlanParseError(`${where} (${op} ${storyId}): no lleva args`);
    return { op, storyId };
  }
  if (op === "edit") {
    // Rechazá claves desconocidas ANTES de armar el patch: un campo mal escrito (p.ej. "acceptence")
    // se dropearía en silencio y el humano aprobaría un edit que hace menos de lo escrito.
    for (const k of Object.keys(args)) {
      if (!(EDIT_FIELDS as readonly string[]).includes(k))
        throw new PlanParseError(`${where} (edit ${storyId}): campo desconocido en args: ${k} (permitidos: ${EDIT_FIELDS.join(", ")})`);
    }
    const fields: EditFields = {};
    for (const f of EDIT_FIELDS) {
      if (args[f] === undefined) continue;
      if (f === "deps") {
        if (!Array.isArray(args.deps) || !args.deps.every((d) => typeof d === "string"))
          throw new PlanParseError(`${where} (edit ${storyId}): deps debe ser una lista de ids (strings)`);
        fields.deps = args.deps as string[];
      } else {
        const v = asString(args[f]);
        if (v === undefined) throw new PlanParseError(`${where} (edit ${storyId}): ${f} debe ser un string no vacío`);
        (fields as Record<string, string>)[f] = v;
      }
    }
    if (Object.keys(fields).length === 0) throw new PlanParseError(`${where} (edit ${storyId}): sin campos a cambiar`);
    return { op, storyId, fields };
  }
  // split
  const rawParts = args.parts;
  if (!Array.isArray(rawParts) || rawParts.length < 2)
    throw new PlanParseError(`${where} (split ${storyId}): args.parts debe tener ≥2 partes`);
  const parts: SplitPart[] = rawParts.map((p, j) => {
    if (!isRecord(p)) throw new PlanParseError(`${where} (split ${storyId}): parte #${j + 1} no es un objeto`);
    const title = asString(p.title);
    if (!title) throw new PlanParseError(`${where} (split ${storyId}): parte #${j + 1} sin title`);
    const part: SplitPart = { title };
    const id = asString(p.id); if (id) part.id = id;
    const body = asString(p.body); if (body) part.body = body;
    const acceptance = asString(p.acceptance); if (acceptance) part.acceptance = acceptance;
    const owner = asString(p.owner); if (owner) part.owner = owner;
    return part;
  });
  // ids explícitos duplicados dentro del mismo split = colisión (el apply exige ids únicos).
  const ids = parts.map((p) => p.id).filter((x): x is string => !!x);
  if (new Set(ids).size !== ids.length) throw new PlanParseError(`${where} (split ${storyId}): ids de partes duplicados`);
  return { op, storyId, parts };
}

// parseActions: el bloque → acciones tipadas y con forma válida. Un `actions: []` (o vacío) es
// legal y devuelve [] (plan que solo confirma el goal). Lanza PlanParseError nombrando la ofensora.
export function parseActions(planText: string): PlanAction[] {
  const rawActions = extractActionsRaw(planText);
  if (rawActions === null || rawActions === undefined) return [];
  if (!Array.isArray(rawActions)) throw new PlanParseError("`actions:` debe ser una lista (o vacía)");
  return rawActions.map(parseOne);
}
