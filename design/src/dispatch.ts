// F-CONDUCTOR-02 · DESPACHO en dos modos (story + sprint) desde projects.settings. Es la política
// que GitHub no tiene: readiness por-story (deps done), gating por-sprint (orden goal-mode, gate
// cross-sprint), routing de canal/modelo por lane, y el tope de concurrencia. Lógica PURA (sin
// GitHub ni Supabase) para testear el kernel del despacho; el worker es la cáscara de I/O.
//
// Espeja `engine/internal/conductor/dispatch.go` de v1 (Candidates :159-258, prompts :449/:462),
// adaptado al vocab de v2 (`review`/`backlog`, deps = `blocked_by` uuid[]). El label agent:running
// lo maneja el propio workflow claude.yml (set al arrancar / clear en always()), así que el despacho
// NO lo toca — la proyección (Fase 1) lee ese label + liveRunCount.

// ── Política (el slice de projects.settings que el despacho necesita) ────────────
export interface Policy {
  executionUnit: "sprint" | "story";
  channel: string;                        // canal por defecto: "claude_action" | "copilot"
  maxConcurrency: number;                 // stories running a la vez; 0 = sin límite
  modelByLane: Map<string, string>;       // lane → modelo ("" / ausente = auto)
  channelByLane: Map<string, string>;     // lane → canal; ausente = channel del proyecto
}

// channelFor / modelFor: resuelven el canal/modelo de una lane bajo la política (v1 executorFor).
export function channelFor(pol: Policy, lane: string): string {
  return pol.channelByLane.get(lane) || pol.channel;
}
export function modelFor(pol: Policy, lane: string): string {
  return pol.modelByLane.get(lane) || "";
}

// ── La story tal como el despacho la necesita ──────────────────────────────────
export interface DStory {
  id: string;
  key: string;
  title: string;
  lane: string;
  status: string;                 // vocab v2
  sprintId: string | null;
  deps: string[];                 // blocked_by (uuids)
  issue: number | null;           // de external_ref; null = no espejada en GitHub
  body: string | null;
  acceptance: string | null;
}
export interface DSprint { id: string; key: string; title: string }

// Candidate: una unidad despachable bajo la política actual.
export interface Candidate {
  kind: "story" | "sprint";
  id: string;                     // story id o sprint id
  title: string;
  stories: string[];              // ids miembro en orden de deps; story-kind = [id]
  issues: number[];               // números de issue, en el mismo orden
  lane: string;
  model: string;
  channel: string;
}

// sprintNum: extrae el número de una key de sprint ("SP2","S1"→ dígitos) para ordenar; sin dígitos
// va al final (v1 sprintNum).
function sprintNum(key: string): number {
  const d = key.replace(/\D/g, "");
  return d ? Number(d) : 1 << 30;
}

// dominantLane: la lane más frecuente entre las stories de un sprint (v1 dominantLane).
function dominantLane(members: DStory[]): string {
  const counts = new Map<string, number>();
  let best = "", bestN = 0;
  for (const st of members) {
    if (!st.lane) continue;
    const n = (counts.get(st.lane) ?? 0) + 1;
    counts.set(st.lane, n);
    if (n > bestN) { best = st.lane; bestN = n; }
  }
  return best;
}

// candidates: qué se puede despachar AHORA bajo la política. Vacío si el canal está lleno
// (concurrencia) o no hay unidades listas. Solo stories espejadas (issue != null) califican.
export function candidates(stories: DStory[], sprintsById: Map<string, DSprint>, pol: Policy): Candidate[] {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const inFlight = stories.filter((s) => s.status === "running").length;
  // Tope de concurrencia: con el cupo lleno no hay candidatos.
  if (pol.maxConcurrency > 0 && inFlight >= pol.maxConcurrency) return [];

  const mirrored = (s: DStory) => s.issue != null;
  const done = (id: string) => byId.get(id)?.status === "done";
  const depsDone = (s: DStory) => s.deps.every(done);
  const storyReady = (s: DStory) => s.status === "backlog" && mirrored(s) && depsDone(s);
  const byKey = (a: DStory, b: DStory) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  // ── STORY mode ────────────────────────────────────────────────────────────────
  if (pol.executionUnit !== "sprint") {
    const out: Candidate[] = [];
    for (const s of stories) {
      if (!storyReady(s)) continue;
      out.push({
        kind: "story", id: s.id, title: s.title, stories: [s.id], issues: [s.issue!],
        lane: s.lane, model: modelFor(pol, s.lane), channel: channelFor(pol, s.lane),
      });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  // ── SPRINT mode (goal-mode) ─────────────────────────────────────────────────────
  // Un sprint es despachable cuando le queda trabajo backlog, NADA suyo está en vuelo
  // (running|review), y toda dependencia CROSS-SPRINT está done. Sprints independientes en
  // paralelo; el dependiente espera al merge del prerequisito (issue cierra → dep done).
  const bySprint = new Map<string, DStory[]>();
  for (const s of stories) {
    if (s.sprintId && mirrored(s)) {
      const arr = bySprint.get(s.sprintId) ?? [];
      arr.push(s);
      bySprint.set(s.sprintId, arr);
    }
  }
  const out: Candidate[] = [];
  for (const [sid, members] of bySprint) {
    let pending = 0, flight = 0, gated = false;
    for (const st of members) {
      if (st.status === "backlog") pending++;
      else if (st.status === "running" || st.status === "review") flight++;
      for (const dep of st.deps) {
        const depSt = byId.get(dep);
        if (depSt && depSt.sprintId !== sid && !done(dep)) gated = true;
      }
    }
    if (pending === 0 || flight > 0 || gated) continue;
    const ordered = [...members].sort(byKey);
    const backlog = ordered.filter((st) => st.status === "backlog"); // orden de deps por convención (key)
    const lane = dominantLane(members);
    const sp = sprintsById.get(sid);
    out.push({
      kind: "sprint", id: sid,
      title: sp?.title || sp?.key || `${sid} · ${backlog.length} stories`,
      stories: backlog.map((st) => st.id),
      issues: backlog.map((st) => st.issue!),
      lane, model: modelFor(pol, lane), channel: channelFor(pol, lane),
    });
  }
  out.sort((a, b) => sprintNum(sprintsById.get(a.id)?.key ?? a.id) - sprintNum(sprintsById.get(b.id)?.key ?? b.id));
  return out;
}

// ── Prompts ────────────────────────────────────────────────────────────────────
// storyPrompt: apunta a UN issue (su body ya lleva el spec + ACs del handoff). v1 buildPrompt story.
// HEADLESS_GUARD — guard de ejecución en runner efímero (L-AUTO-5). En claude-code-action el agente
// corre headless SIN sub-agentes ni procesos en background: si delega a un subagente (tool Agent/Task)
// o lanza un build/proceso "en background" y no lo espera, la action termina SIN trabajo y la story
// queda trabada (fue el bug que nos trajo de v1: "APK en background → action terminó"; reapareció con
// un spawn de subagente). El enforcement DURO vive en claude.yml (`--disallowedTools Task` +
// rescate que señaliza `agent:failed` en run vacío → requeue inmediato); esto es el cinturón por prompt.
export const HEADLESS_GUARD =
  "IMPORTANTE — runner headless efímero: trabajá VOS DIRECTAMENTE en esta sesión (leé, editá, testeá, " +
  "commiteá y abrí el PR acá mismo). NO delegues a subagentes (no uses el tool Agent/Task) ni lances " +
  "procesos en background que no esperes — en este runner no se ejecutan y la corrida termina sin trabajo. " +
  "Nada de fire-and-forget.";

export function storyPrompt(s: Pick<DStory, "key" | "title" | "body" | "acceptance" | "issue">): string {
  const n = s.issue;
  const parts = [
    `Resolvé el issue #${n} (${s.key} — ${s.title}).`,
    `\n${HEADLESS_GUARD}`,
    s.body ? `\n${s.body.trim()}` : "",
    s.acceptance ? `\n## Criterios de aceptación\n${s.acceptance.trim()}` : "",
    `\nImplementá EXACTAMENTE lo que especifican los criterios de aceptación — cada checkbox, nada más. ` +
    `Escribí tests honestos que ejerciten cada criterio. Leé los docs de diseño en docs/ para el contexto. ` +
    `Abrí un pull request cuya descripción incluya \`Closes #${n}\`.`,
  ];
  return parts.join("\n");
}

// sprintPrompt: el contrato goal-mode — todas las stories, EN ORDEN, una rama, UN PR que las cierra
// a todas. v1 buildPrompt sprint (:462-482).
export function sprintPrompt(
  title: string,
  members: Array<Pick<DStory, "key" | "title" | "body" | "acceptance" | "issue">>,
): string {
  const b: string[] = [];
  b.push(`# Modo goal — implementá este SPRINT COMPLETO (${title}) en una sola pasada\n`);
  b.push(
    "Estás implementando un SPRINT ENTERO en un solo run, en una sola rama, que se convierte en UN pull request. " +
    "Trabajá cada story de abajo EN EL ORDEN DADO — están en orden de dependencias. " +
    "No abras ramas ni PRs separados por story.\n");
  b.push(HEADLESS_GUARD + "\n");
  b.push("Leé los docs de diseño en docs/ para el contexto.\n");
  b.push("Stories (en orden):\n");
  const closes: string[] = [];
  for (const st of members) {
    closes.push(`Closes #${st.issue}`);
    b.push(`### ${st.key} — ${st.title} (issue #${st.issue})`);
    if (st.body?.trim()) b.push(st.body.trim());
    if (st.acceptance?.trim()) b.push(`\nCriterios de aceptación:\n${st.acceptance.trim()}`);
    b.push("");
  }
  b.push(`La descripción del PR DEBE incluir: ${closes.join(", ")}.`);
  b.push("Los criterios de aceptación de TODAS las stories deben pasar juntos; escribí tests honestos por criterio.");
  return b.join("\n");
}

// docsGuardOk — el guard `docs-on-main` (Fase 5): no despachar si el PRD del proyecto no está en
// `main`. Fail-open: `prdOnMain === false` ⇒ NO despacha; `true` o `null` (el chequeo a GitHub
// falló) ⇒ despacha igual (no bloqueamos el build por un error transitorio de red). Faithful a v1
// (guard que fail-open, no fail-closed).
export function docsGuardOk(prdOnMain: boolean | null): boolean {
  return prdOnMain !== false;
}
