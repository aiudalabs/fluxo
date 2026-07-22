// proposals.ts — el DSL de propuestas de la retro (registry_apply). Parsea el bloque `proposals:` de
// un RETRO doc y valida su FORMA + los GUARDRAILS de seguridad (esto EDITA el método de la fábrica,
// así que es lo más sensible del sistema). Puro → testeable. La existencia del archivo a reemplazar
// la chequea el executor contra el FS. Gramática/candados: registry/skills/retro-method.md.
//
// Candados (todo-o-nada — una propuesta ilegal aborta TODO nombrándola):
//  1. kind ∈ {agent, skill, workflow} — nada más del repo.
//  2. id path-safe: ^[a-z0-9_-]+$ (minúscula-kebab, sin ".") — sin traversal ni separadores ni casing.
//  3. NUNCA el método propio de la retro (retro-analyst / retro-method / retro) — meta-cambio humano.
//  4. content (el archivo COMPLETO propuesto) no vacío.
import { load } from "js-yaml";

export type ProposalKind = "agent" | "skill" | "workflow";
export interface Proposal {
  kind: ProposalKind;
  id: string;
  content: string;      // el archivo COMPLETO que reemplaza al existente
  rationale?: string;
  evidence?: string;
}

const KINDS = new Set<ProposalKind>(["agent", "skill", "workflow"]);
// SIN flag `i` a propósito: los ids del registry son minúscula-kebab, y el candado PROTECTED compara
// en minúscula exacta. Aceptar mayúsculas dejaría pasar `Retro-Analyst` (≠ `retro-analyst`) que en un
// FS case-insensitive (macOS, el deploy) escribiría sobre el método propio de la retro. Sin punto: la
// spec es kebab puro y `.` no aporta (evita ids-basura tipo `.`).
const ID_RE = /^[a-z0-9_-]+$/;
// El método de la retro NO es auto-editable (candado #3): proponerlo aborta todo.
const PROTECTED = new Set(["agent:retro-analyst", "skill:retro-method", "workflow:retro"]);

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// extractProposalsRaw: el valor de `proposals` desde un fenced ```yaml (o el archivo entero).
function extractProposalsRaw(retroText: string): unknown {
  const fences = [...retroText.matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fences) {
    let doc: unknown;
    try { doc = load(block); } catch { continue; }
    if (isRecord(doc) && "proposals" in doc) return doc.proposals;
  }
  let whole: unknown;
  try { whole = load(retroText); } catch { whole = undefined; }
  if (isRecord(whole) && "proposals" in whole) return whole.proposals;
  throw new ProposalError("no se encontró un bloque `proposals:` en la retro (ni fenced ```yaml ni el archivo entero)");
}

function parseOne(raw: unknown, i: number): Proposal {
  const where = `propuesta #${i + 1}`;
  if (!isRecord(raw)) throw new ProposalError(`${where}: no es un objeto`);
  const kind = asString(raw.kind) as ProposalKind | undefined;
  if (!kind || !KINDS.has(kind)) throw new ProposalError(`${where}: kind inválido ${JSON.stringify(raw.kind)} (esperado agent|skill|workflow)`);
  const id = asString(raw.id);
  if (!id) throw new ProposalError(`${where} (${kind}): falta id`);
  if (!ID_RE.test(id) || id.includes("..")) throw new ProposalError(`${where} (${kind} ${id}): id no path-safe`);
  if (PROTECTED.has(`${kind}:${id}`)) throw new ProposalError(`${where}: '${kind} ${id}' es el método propio de la retro — NO auto-editable (meta-cambio humano)`);
  const content = asString(raw.content);
  if (!content) throw new ProposalError(`${where} (${kind} ${id}): falta content (el archivo completo propuesto)`);
  const p: Proposal = { kind, id, content };
  const rationale = asString(raw.rationale); if (rationale) p.rationale = rationale;
  const evidence = asString(raw.evidence); if (evidence) p.evidence = evidence;
  return p;
}

// parseProposals: el bloque → propuestas tipadas, con forma y guardrails validados. `proposals: []`
// (o vacío) es legal → [] (la retro no encontró problema del método). Lanza ProposalError nombrando
// la ofensora. El executor luego chequea que el archivo a reemplazar EXISTA (solo mejora, no crea).
export function parseProposals(retroText: string): Proposal[] {
  const raw = extractProposalsRaw(retroText);
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ProposalError("`proposals:` debe ser una lista (o vacía)");
  return raw.map(parseOne);
}

// registryPath: dónde vive el archivo del método a reemplazar. agent/skill = .md (la persona/skill);
// workflow = .yaml. El id ya fue validado path-safe → no hay traversal.
export function registryPath(p: Proposal): string {
  if (p.kind === "workflow") return `workflows/${p.id}.yaml`;
  return `${p.kind}s/${p.id}.md`; // agents/<id>.md · skills/<id>.md
}
