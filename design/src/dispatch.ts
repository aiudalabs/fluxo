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
  // Candado de sprint-planning: con planning_mode=ceremony, un sprint NO se despacha hasta que la
  // ceremonia lo planeó (planned_at estampado). Ausente/false = sin gate (backward-compatible).
  planningRequired?: boolean;
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
  screenKey?: string | null;      // role.screen de la pantalla (P8-C); null/ausente = no es pantalla
  needsCapabilities?: string[];   // capabilities que la story REFERENCIA por su secret (P6-2b Paso 3);
                                  // el caller lo computa data-driven (capabilities.ts). Vacío/ausente
                                  // = no gatea. El kernel solo chequea `needs ⊆ greenCapabilities`.
}
export interface DSprint { id: string; key: string; title: string; plannedAt?: string | null }

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

// sprintToPlan: el sprint FRONTIER que la ceremonia sprint-planning debe planear = el de MENOR
// posición con trabajo sin terminar que aún NO está planeado (y cuyos anteriores están asentados).
// null = nada que planear. Just-in-time: si el frontier ya está planeado, NO se adelanta el siguiente
// (el candado del dispatch lo dejará buildear). `unbuilt` = sprint id → # de stories status != done.
// `sprints` en orden de posición. Pura → testeable sin DB (la usa reconcileCeremonies del worker).
export function sprintToPlan(sprints: Array<{ id: string; key: string; planned_at: string | null }>, unbuilt: Map<string, number>): string | null {
  for (const sp of sprints) {
    if ((unbuilt.get(sp.id) ?? 0) === 0) continue; // sprint asentado → seguir
    return sp.planned_at ? null : sp.key;          // primer sprint con trabajo: planeado → nada; si no → planealo
  }
  return null;
}

// sprintToReview: el sprint a REVISAR = el de menor posición TERMINADO (tiene stories y todas done)
// que aún NO está revisado (reviewed_at null). null = nada que revisar. `total`/`unbuilt` = sprint id
// → # de stories (todas / sin terminar). Pura → testeable. Prioridad sobre planning (orden Scrum).
export function sprintToReview(
  sprints: Array<{ id: string; key: string; reviewed_at: string | null }>,
  total: Map<string, number>,
  unbuilt: Map<string, number>,
): string | null {
  for (const sp of sprints) {
    if ((total.get(sp.id) ?? 0) === 0) continue;      // sprint vacío → nada que revisar
    if ((unbuilt.get(sp.id) ?? 0) > 0) continue;      // aún tiene trabajo → no terminado
    if (sp.reviewed_at) continue;                     // ya revisado
    return sp.key;                                    // terminado + sin revisar → revisalo
  }
  return null;
}

// sprintToRetro: el sprint para la RETRO = el de menor posición ya REVISADO (reviewed_at) que aún NO
// tiene retro (retro_at null). null = nada. Orden Scrum: review(N) → retro(N) → planning(N+1); la
// retro va DESPUÉS de review y ANTES del planning del siguiente. Pura → testeable.
export function sprintToRetro(sprints: Array<{ id: string; key: string; reviewed_at: string | null; retro_at: string | null }>): string | null {
  for (const sp of sprints) {
    if (!sp.reviewed_at) continue; // aún no revisado → no hay retro
    if (sp.retro_at) continue;     // ya tiene retro
    return sp.key;                 // revisado sin retro → retro
  }
  return null;
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
//
// P6-2b · Paso 3 — readiness gate por CAPABILITY: una story que REFERENCIA el secret de una
// capability (needsCapabilities, computado data-driven por el caller) NO despacha hasta que esa
// capability esté 🟢 (su Actions secret presente). El estado 🟢 es NETWORK → no puede resolverse en
// el kernel: entra como `greenCapabilities` (el caller lo probea y lo pasa). El kernel solo hace el
// chequeo PURO `needs ⊆ green`. Set vacío por defecto = gate off (backward-compatible: una story sin
// needs, o sin green set, se comporta igual que antes). Gate BLANDO: apenas la capability pasa a 🟢,
// la story vuelve a ser candidata.
export function candidates(
  stories: DStory[],
  sprintsById: Map<string, DSprint>,
  pol: Policy,
  greenCapabilities: ReadonlySet<string> = new Set(),
): Candidate[] {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const inFlight = stories.filter((s) => s.status === "running").length;
  // Tope de concurrencia: con el cupo lleno no hay candidatos.
  if (pol.maxConcurrency > 0 && inFlight >= pol.maxConcurrency) return [];

  const mirrored = (s: DStory) => s.issue != null;
  const done = (id: string) => byId.get(id)?.status === "done";
  const depsDone = (s: DStory) => s.deps.every(done);
  // needsMet: todas las capabilities que la story referencia están 🟢. Sin needs → true (no gatea).
  const needsMet = (s: DStory) => (s.needsCapabilities ?? []).every((c) => greenCapabilities.has(c));
  // Candado de planning: si el modo lo exige y la story está en un sprint, ese sprint debe estar
  // planeado (planned_at). Una story sin sprint no tiene qué planear → no gatea.
  const sprintPlanned = (s: DStory) => !pol.planningRequired || !s.sprintId || sprintsById.get(s.sprintId)?.plannedAt != null;
  const storyReady = (s: DStory) => s.status === "backlog" && mirrored(s) && depsDone(s) && needsMet(s) && sprintPlanned(s);
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
    let pending = 0, flight = 0, gated = false, capGated = false;
    for (const st of members) {
      if (st.status === "backlog") {
        pending++;
        // El sprint despacha como UNA unidad atómica (goal-mode, un run): si un miembro backlog
        // referencia una capability aún no 🟢, el run se estrellaría en esa story → gateamos TODO
        // el sprint hasta que esté verde (P6-2b Paso 3).
        if (!needsMet(st)) capGated = true;
      } else if (st.status === "running" || st.status === "review") flight++;
      for (const dep of st.deps) {
        const depSt = byId.get(dep);
        if (depSt && depSt.sprintId !== sid && !done(dep)) gated = true;
      }
    }
    // Candado de planning (sprint-mode): sin planear (planned_at), el sprint no despacha.
    const notPlanned = !!pol.planningRequired && !sprintsById.get(sid)?.plannedAt;
    if (pending === 0 || flight > 0 || gated || capGated || notPlanned) continue;
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
// Guards de ejecución en runner efímero (L-AUTO-5), PARTIDOS por ExecEnv. El `if` que los elige está en
// story/sprintPrompt (param `engine`). Por qué se parten (y no es por la máquina — una action y nuestro
// contenedor son igual de efímeros):
//  · COMMON_GUARD — el ÚNICO límite que impone la efimeralidad, y aplica a AMBOS paths: un proceso en
//    background que no esperás muere cuando la corrida termina y la máquina se destruye (fue el bug
//    "APK en background → terminó sin trabajo"). Los subagentes NO caen acá: son SINCRÓNICOS (el padre
//    los espera y terminan antes de que `claude` retorne).
//  · ACTION_GUARD (claude-code-action) — su WRAPPER (no la máquina) no orquesta bien subagentes: la action
//    terminaba vacía al spawnear uno. Por eso además prohíbe delegar. Enforcement duro en claude.yml
//    (`--disallowedTools Task`); esto es el cinturón por prompt.
//  · ENGINE_GUARD (fluxo_engine) — corre `claude -p` CRUDO (el mismo binario que local, sin wrapper): los
//    subagentes funcionan. Reproduce el `/goal` local: no ALCANZA con permitir subagentes (permitir ≠ invocar
//    — con "podés" el agente los hace lineal). Le ORDENAMOS orquestar CUANDO el objetivo se descompone en
//    partes independientes (features/áreas/pantallas): un subagente por parte + un auditor por parte
//    (audit→fix). Cambio chico y atómico ⇒ lineal. Único límite operativo: COMMON_GUARD.
export const COMMON_GUARD =
  "Runner efímero: NO lances procesos en background que no esperes (un build/servidor con `&` que no " +
  "aguardás no llega a correr — la máquina se destruye al terminar). Todo el trabajo (commits + PR) ocurre " +
  "en ESTA corrida. Nada de fire-and-forget.";
export const ACTION_GUARD =
  "IMPORTANTE — trabajá VOS DIRECTAMENTE en esta sesión (leé, editá, testeá, commiteá y abrí el PR acá " +
  "mismo). NO delegues a subagentes (no uses el tool Agent/Task). " + COMMON_GUARD;
export const ENGINE_GUARD =
  "IMPORTANTE — ORQUESTÁ, no trabajes lineal cuando el objetivo se descompone. Tenés el tool Task/Agent y " +
  "DEBÉS usarlo si el objetivo tiene VARIAS partes independientes (varias features, varias áreas o varias " +
  "pantallas): 1) descomponé el objetivo en esas partes; 2) lanzá UN subagente por parte que la implemente y " +
  "la testee; 3) lanzá un subagente AUDITOR por parte que revise la calidad y devuelva correcciones (loop " +
  "audit→fix hasta que quede de nivel producto). Corré los subagentes en paralelo donde se pueda y esperá a " +
  "que cada uno termine (son sincrónicos). Reservá el trabajo lineal (vos mismo, sin delegar) SOLO para un " +
  "cambio chico y atómico. No te quedes en el mínimo funcional: perseguí el objetivo a fondo. " + COMMON_GUARD;

// INCREMENTAL_COMMIT — commiteá y pusheá a medida que avanzás (no todo al final). Dos razones, y la
// segunda es un CONTRATO con el conductor: (1) si la sesión se corta (timeout, límite), el trabajo ya
// hecho queda salvado en la rama; (2) el conductor detecta que SEGUÍS VIVO por tus commits — un
// watchdog corta el run si no ve commits nuevos por mucho rato (asume que te colgaste). Por eso NO
// dejes todo para un commit final: el silencio prolongado se lee como "colgado" y te cancelan.
export const INCREMENTAL_COMMIT =
  "COMMITEÁ Y PUSHEÁ INCREMENTALMENTE: después de completar CADA story (o cada bloque de trabajo con " +
  "sus tests en verde) hacé `git add -A && git commit` y `git push` en tu rama ANTES de seguir — nunca " +
  "dejes todo para el final. Esto salva el trabajo si la corrida se corta, y —clave— es la señal de que " +
  "seguís trabajando: el conductor tiene un watchdog que cancela el run si no ve commits nuevos por un " +
  "buen rato (lo interpreta como que te colgaste). Commits frecuentes = te dejan trabajar tranquilo.";

// screenPointer: cuando la story construye una pantalla (screen_key presente), apunta al dev a
// SU spec y SU mockup — no al genérico "leé docs/" (P8-C). El spec de la pantalla vive en
// docs/UI_SCREENS.md y el mockup aprobado (lo que el art-director de ui-verify compara) en
// docs/mockups/<screen_key>.html. Sin screen_key devuelve "" (stories de backend/foundation).
export function screenPointer(screenKey?: string | null): string {
  if (!screenKey) return "";
  return (
    `\nEsta story construye la pantalla \`${screenKey}\`: su spec está en docs/UI_SCREENS.md ` +
    `(la sección \`${screenKey}\`), su mockup aprobado en docs/mockups/${screenKey}.html, y el design ` +
    `system del proyecto en docs/DESIGN_SYSTEM.md. Replicá el mockup con FIDELIDAD y aplicá los tokens del ` +
    `design system — el art-director compara tu pantalla contra el mockup y rebota el PR si diverge.`
  );
}

// uiFidelity: preamble de calidad visual (registry/prompts/ui-fidelity.md) que el CALLER lee y pasa. Se
// inyecta SOLO si la story construye una pantalla (screenKey) — un proyecto sin UI no lo recibe. dispatch.ts
// es puro: no lee el archivo, solo lo ensambla (el "qué" es data del registry, el "cómo" es este pegamento).
export function storyPrompt(
  s: Pick<DStory, "key" | "title" | "body" | "acceptance" | "issue" | "screenKey">,
  uiFidelity?: string,
  engine = false, // fluxo_engine → ENGINE_GUARD (permite orquestar subagentes); default (Actions) → ACTION_GUARD
): string {
  const n = s.issue;
  const parts = [
    `Resolvé el issue #${n} (${s.key} — ${s.title}).`,
    `\n${engine ? ENGINE_GUARD : ACTION_GUARD}`,
    `\n${INCREMENTAL_COMMIT}`,
    s.screenKey && uiFidelity ? `\n${uiFidelity.trim()}` : "",
    s.body ? `\n${s.body.trim()}` : "",
    s.acceptance ? `\n## Criterios de aceptación\n${s.acceptance.trim()}` : "",
    screenPointer(s.screenKey),
    `\nImplementá cada criterio de aceptación con tests honestos que lo ejerciten — no agregues features ` +
    `fuera de alcance. ` +
    (s.screenKey ? `La calidad visual NO es un extra: la pantalla debe verse como el mockup, no un wireframe funcional. ` : "") +
    `Leé los docs de diseño en docs/ para el contexto. Abrí un pull request cuya descripción incluya \`Closes #${n}\`.`,
  ];
  return parts.filter(Boolean).join("\n");
}

// sprintPrompt: el contrato goal-mode — todas las stories, EN ORDEN, una rama, UN PR que las cierra
// a todas. v1 buildPrompt sprint (:462-482).
export function sprintPrompt(
  title: string,
  members: Array<Pick<DStory, "key" | "title" | "body" | "acceptance" | "issue" | "screenKey">>,
  uiFidelity?: string,
  engine = false, // ver storyPrompt
): string {
  const hasScreens = members.some((m) => m.screenKey);
  const b: string[] = [];
  b.push(`# Modo goal — implementá este SPRINT COMPLETO (${title}) en una sola pasada\n`);
  b.push(
    "Estás implementando un SPRINT ENTERO en un solo run, en una sola rama, que se convierte en UN pull request. " +
    "Trabajá cada story de abajo EN EL ORDEN DADO — están en orden de dependencias. " +
    "No abras ramas ni PRs separados por story.\n");
  b.push((engine ? ENGINE_GUARD : ACTION_GUARD) + "\n");
  b.push(INCREMENTAL_COMMIT + "\n");
  // Preamble de fidelidad visual: solo si el sprint toca al menos una pantalla (data-driven, no ciego).
  if (uiFidelity && hasScreens) b.push(uiFidelity.trim() + "\n");
  b.push("Leé los docs de diseño en docs/ para el contexto.\n");
  b.push("Stories (en orden):\n");
  const closes: string[] = [];
  for (const st of members) {
    closes.push(`Closes #${st.issue}`);
    b.push(`### ${st.key} — ${st.title} (issue #${st.issue})`);
    if (st.body?.trim()) b.push(st.body.trim());
    if (st.acceptance?.trim()) b.push(`\nCriterios de aceptación:\n${st.acceptance.trim()}`);
    if (st.screenKey) b.push(screenPointer(st.screenKey).trimStart());
    b.push("");
  }
  b.push(`La descripción del PR DEBE incluir: ${closes.join(", ")}.`);
  b.push("Los criterios de aceptación de TODAS las stories deben pasar juntos; escribí tests honestos por criterio." +
    (hasScreens ? " Y cada pantalla debe verse como su mockup — la fidelidad visual es parte de \"terminado\", igual que los tests." : ""));
  return b.join("\n");
}

// reviewPrompt (F4/docs19 §3.2): el TICKET del REVIEWER autónomo. La PERSONA (build-limpio + run +
// anti-stub + severidad) vive en registry/agents/reviewer.md — el runner la antepone; acá va solo el
// QUÉ revisar (el spec del sprint) y el CONTRATO de salida (findings.json). Pura → testeable. `engine`
// no aplica (el reviewer no orquesta ni abre PR). El reviewer corre sobre el código YA MERGEADO.
export function reviewPrompt(
  title: string,
  goal: string,
  members: Array<Pick<DStory, "key" | "title" | "acceptance" | "screenKey">>,
): string {
  const hasScreens = members.some((m) => m.screenKey);
  const b: string[] = [];
  b.push(`# Review del incremento del sprint — ${title}`);
  b.push(
    `\nSos el REVIEWER de contexto fresco. Revisá el incremento YA MERGEADO de este sprint contra su ` +
    `objetivo y los criterios de aceptación de sus stories. Tu criterio NO es "los tests pasan": ` +
    `BUILDEÁ el artefacto real del target y CORRÉLO (flutter build apk / npm run build + servir / el ` +
    `binario), confirmá que arranca y hace lo que el sprint promete. Cazá stubs/configs falsos que ` +
    `simulen una integración (stub-certified-as-success). Un criterio incumplible con un input concreto, ` +
    `un artefacto que no buildea/no arranca, o un fake que "pinta verde" = P0.`);
  if (goal.trim()) b.push(`\n## Objetivo del sprint\n${goal.trim()}`);
  b.push(`\n## Stories del sprint (su AC es el contrato)`);
  for (const st of members) {
    b.push(`### ${st.key} — ${st.title}`);
    if (st.acceptance?.trim()) b.push(`Criterios de aceptación:\n${st.acceptance.trim()}`);
    if (st.screenKey) b.push(`Construye la pantalla \`${st.screenKey}\`: su mockup aprobado está en docs/mockups/${st.screenKey}.html — la pantalla real debe VERSE como el mockup y RENDERIZAR (no en blanco).`);
    b.push("");
  }
  b.push(
    `## Salida — escribí tus findings a \`/work/findings.json\`\n` +
    `Un array JSON (usá bash: \`cat > /work/findings.json <<'EOF' … EOF\`). Cada finding:\n` +
    `  { "id": "<slug estable, ej R-<sprint>-01>", "title": "<qué está mal, una línea>", ` +
    `"severity": "P0"|"deferred", "body": "<detalle: archivo/pantalla + input que falla + evidencia de tu build/run>", ` +
    `"acceptance": "<con qué lo das por resuelto>", "owner": "<lane, ej flutter-dev>"` +
    (hasScreens ? `, "screen_key": "<si es una pantalla>"` : "") + ` }\n` +
    `severity: **P0** = bloquea (AC incumplido / no buildea / no arranca / stub falso). **deferred** = ` +
    `mejora o edge fuera del AC, no bloquea. Si el incremento está limpio, escribí EXACTAMENTE \`[]\`. ` +
    `NO inventes objeciones para parecer riguroso: si el AC se cumple y el artefacto buildea+corre, es \`[]\`.`);
  return b.join("\n");
}

// docsGuardOk — el guard `docs-on-main` (Fase 5): no despachar si el PRD del proyecto no está en
// `main`. Fail-open: `prdOnMain === false` ⇒ NO despacha; `true` o `null` (el chequeo a GitHub
// falló) ⇒ despacha igual (no bloqueamos el build por un error transitorio de red). Faithful a v1
// (guard que fail-open, no fail-closed).
export function docsGuardOk(prdOnMain: boolean | null): boolean {
  return prdOnMain !== false;
}
