// F4 (docs/19 §3.4, §5): el gate autónomo "sprint done ⟺ 0 P0" + el re-feed de findings al backlog.
// Todo PURO y determinista (golden rule #2: el gate crítico es código, no juicio de agente). El
// REVIEWER (agente, contexto fresco) produce findings; ESTE módulo decide sin ambigüedad qué bloquea
// el "done" del sprint y a dónde va cada finding. Espeja el estilo de automerge.ts / autonomy.ts:
// predicados puros, sin efectos; el wiring (publishBacklog, stamp reviewed_at, auto-merge) vive afuera.

export type Severity = "P0" | "deferred";

// Un finding del reviewer (contrato JSON de registry/agents/reviewer.md). Severidad binaria:
//   P0       = bloquea el "done" del sprint — defecto dentro del AC, no buildea/no corre, o
//              stub-certified-as-success (docs/19 §3.2).
//   deferred = mejora / edge fuera del AC → al backlog, NO bloquea.
export interface Finding {
  id: string; // estable → re-publicar no duplica (espeja el corrections contract de sprint-review.yaml)
  title: string;
  severity: Severity;
  body?: string;
  acceptance?: string; // el criterio con el que "el reviewer lo da por resuelto"
  owner?: string; // la lane (flutter-dev / firebase-dev / …)
  screen_key?: string; // opcional, frontend
  kind?: "bug" | "story";
}

// El spec de story que publishBacklog consume (contrato docs/backlog.yaml), + la marca `severity`
// que le da origen-finding a la story para que el gate P0 la reconozca.
export interface StorySpec {
  id: string;
  title: string;
  body: string;
  acceptance: string;
  kind: "bug" | "story";
  owner?: string;
  screen_key?: string;
  sprint_id: string;
  severity: Severity;
}

// Story tal como el gate la ve (subset de la fila DB): status + la severidad de origen (null si la
// story no nació de un finding — el caso legacy, sin reviewer).
export interface StoryLike {
  status: string; // backlog|ready|running|review|done|failed|blocked
  severity?: Severity | null;
}

// openP0: cuántas P0 siguen ABIERTAS (status != done) en un sprint. El corazón del gate.
export function openP0(stories: StoryLike[]): number {
  return stories.filter((s) => s.severity === "P0" && s.status !== "done").length;
}

// sprintP0Clear: ¿el sprint está libre de P0 abiertas? Es el contrato "done ⟺ 0 P0" (docs/19:214).
// Un sprint SIN findings (severity null en todas) pasa trivialmente → NO rompe proyectos legacy sin
// reviewer. NO reemplaza el gate `unbuilt` de sprintToReview (dispatch.ts): lo COMPLEMENTA. Como las
// P0 se insertan como stories del MISMO sprint en estado backlog, `unbuilt` ya las cuenta y re-bloquea
// solo; este predicado hace el contrato P0 explícito para el review-close y el auto-merge.
export function sprintP0Clear(stories: StoryLike[]): boolean {
  return openP0(stories) === 0;
}

// partitionFindings: el re-feed. Mapea los findings del reviewer a story specs para publishBacklog.
//   P0       → sprint_id = currentSprint (el MISMO sprint) → unbuilt>0 → re-bloquea + re-despacha a dev.
//   deferred → sprint_id = nextSprint → NO bloquea el sprint actual, se resuelve más adelante.
// Idempotente por id (re-publicar no duplica). Pura. `currentSprint`/`nextSprint` son keys de sprint.
export function partitionFindings(
  findings: Finding[],
  ctx: { currentSprint: string; nextSprint: string },
): { stories: StorySpec[]; p0: number; deferred: number } {
  const stories: StorySpec[] = [];
  let p0 = 0;
  let deferred = 0;
  for (const f of findings) {
    const isP0 = f.severity === "P0";
    if (isP0) p0++;
    else deferred++;
    stories.push({
      id: f.id,
      title: f.title,
      body: f.body ?? "",
      acceptance: f.acceptance ?? f.title,
      kind: f.kind ?? (isP0 ? "bug" : "story"),
      owner: f.owner,
      screen_key: f.screen_key,
      sprint_id: isP0 ? ctx.currentSprint : ctx.nextSprint,
      severity: f.severity,
    });
  }
  return { stories, p0, deferred };
}
