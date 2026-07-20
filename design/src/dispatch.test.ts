import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidates, storyPrompt, sprintPrompt, screenPointer, channelFor, modelFor, docsGuardOk,
  type Policy, type DStory, type DSprint,
} from "./dispatch.ts";

// ── helpers ─────────────────────────────────────────────────────────────────────
const pol = (over: Partial<Policy> = {}): Policy => ({
  executionUnit: "story", channel: "claude_action", maxConcurrency: 0,
  modelByLane: new Map(), channelByLane: new Map(), ...over,
});
let n = 0;
const st = (over: Partial<DStory>): DStory => ({
  id: over.id ?? `id-${++n}`, key: over.key ?? "S-0", title: over.title ?? "t", lane: over.lane ?? "",
  status: over.status ?? "backlog", sprintId: over.sprintId ?? null, deps: over.deps ?? [],
  issue: "issue" in over ? over.issue! : 1, body: over.body ?? null, acceptance: over.acceptance ?? null,
});
const sprints = (...ss: DSprint[]) => new Map(ss.map((s) => [s.id, s]));

// ── channelFor / modelFor ────────────────────────────────────────────────────────
test("channelFor: lane override gana; si no, el canal del proyecto", () => {
  const p = pol({ channel: "claude_action", channelByLane: new Map([["ui", "copilot"]]) });
  assert.equal(channelFor(p, "ui"), "copilot");
  assert.equal(channelFor(p, "backend"), "claude_action");
});
test("modelFor: lane model o '' (auto)", () => {
  const p = pol({ modelByLane: new Map([["ui", "sonnet"]]) });
  assert.equal(modelFor(p, "ui"), "sonnet");
  assert.equal(modelFor(p, "backend"), "");
});

// ── STORY mode ────────────────────────────────────────────────────────────────────
test("story mode: backlog con deps done → candidato; deps pendientes → no", () => {
  const dep = st({ id: "dep", key: "S-1", status: "done", issue: 1 });
  const ready = st({ id: "a", key: "S-2", issue: 2, deps: ["dep"] });
  const blocked = st({ id: "b", key: "S-3", issue: 3, deps: ["missing"] });
  const missing = st({ id: "missing", key: "S-4", status: "backlog", issue: 4 });
  const out = candidates([dep, ready, blocked, missing], sprints(), pol());
  const ids = out.map((c) => c.id).sort();
  // `a` (dep done) y `missing` (sin deps) listos; `b` bloqueada por `missing` no-done.
  assert.deepEqual(ids, ["a", "missing"]);
  assert.ok(out.every((c) => c.kind === "story"));
});

test("story mode: no espejada (issue null) NO es candidata", () => {
  const out = candidates([st({ id: "a", issue: null })], sprints(), pol());
  assert.deepEqual(out, []);
});

test("concurrencia: inFlight >= maxConcurrency → sin candidatos", () => {
  const running = st({ id: "r", status: "running", issue: 1 });
  const ready = st({ id: "a", status: "backlog", issue: 2 });
  assert.deepEqual(candidates([running, ready], sprints(), pol({ maxConcurrency: 1 })), []);
  // con cupo 2 sí sale el ready
  assert.equal(candidates([running, ready], sprints(), pol({ maxConcurrency: 2 })).length, 1);
});

test("story mode: canal/modelo por lane se resuelven en el candidato", () => {
  const s = st({ id: "a", lane: "ui", issue: 7 });
  const p = pol({ channelByLane: new Map([["ui", "copilot"]]), modelByLane: new Map([["ui", "sonnet"]]) });
  const [c] = candidates([s], sprints(), p);
  assert.equal(c.channel, "copilot");
  assert.equal(c.model, "sonnet");
  assert.deepEqual(c.issues, [7]);
});

// ── SPRINT mode ────────────────────────────────────────────────────────────────────
test("sprint mode: sprint sin deps cross-sprint y con backlog → UN candidato con todas sus stories en orden", () => {
  const a = st({ id: "a", key: "S1-02", sprintId: "sp1", issue: 12, lane: "backend" });
  const b = st({ id: "b", key: "S1-01", sprintId: "sp1", issue: 11, lane: "backend" });
  const out = candidates([a, b], sprints({ id: "sp1", key: "SP1", title: "Sprint 1" }), pol({ executionUnit: "sprint" }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "sprint");
  assert.equal(out[0].title, "Sprint 1");
  assert.deepEqual(out[0].stories, ["b", "a"]);   // orden por key: S1-01 antes que S1-02
  assert.deepEqual(out[0].issues, [11, 12]);
  assert.equal(out[0].lane, "backend");
});

test("sprint mode: algo del sprint en vuelo (running|review) → NO se re-despacha", () => {
  const running = st({ id: "a", key: "S1-01", sprintId: "sp1", status: "running", issue: 11 });
  const pend = st({ id: "b", key: "S1-02", sprintId: "sp1", status: "backlog", issue: 12 });
  const out = candidates([running, pend], sprints({ id: "sp1", key: "SP1", title: "" }), pol({ executionUnit: "sprint" }));
  assert.deepEqual(out, []);
  // idem con review
  const review = st({ id: "a", key: "S1-01", sprintId: "sp1", status: "review", issue: 11 });
  assert.deepEqual(candidates([review, pend], sprints({ id: "sp1", key: "SP1", title: "" }), pol({ executionUnit: "sprint" })), []);
});

test("sprint mode: GATE cross-sprint — sp2 depende de sp1 no-done → sp2 gated; sp1 corre", () => {
  const s1a = st({ id: "s1a", key: "S1-01", sprintId: "sp1", status: "backlog", issue: 11 });
  const s2a = st({ id: "s2a", key: "S2-01", sprintId: "sp2", status: "backlog", issue: 21, deps: ["s1a"] });
  const sm = sprints({ id: "sp1", key: "SP1", title: "" }, { id: "sp2", key: "SP2", title: "" });
  const out = candidates([s1a, s2a], sm, pol({ executionUnit: "sprint" }));
  assert.deepEqual(out.map((c) => c.id), ["sp1"]); // solo sp1; sp2 espera
});

test("sprint mode: dep cross-sprint DONE → el dependiente se desbloquea", () => {
  const s1a = st({ id: "s1a", key: "S1-01", sprintId: "sp1", status: "done", issue: 11 });
  const s2a = st({ id: "s2a", key: "S2-01", sprintId: "sp2", status: "backlog", issue: 21, deps: ["s1a"] });
  const sm = sprints({ id: "sp1", key: "SP1", title: "" }, { id: "sp2", key: "SP2", title: "" });
  const out = candidates([s1a, s2a], sm, pol({ executionUnit: "sprint" }));
  assert.deepEqual(out.map((c) => c.id), ["sp2"]); // sp1 sin pending (todo done); sp2 ya desbloqueado
});

test("sprint mode: sprints INDEPENDIENTES → ambos candidatos (paralelo), ordenados por número de sprint", () => {
  const s2 = st({ id: "s2", key: "S2-01", sprintId: "sp2", issue: 21 });
  const s1 = st({ id: "s1", key: "S1-01", sprintId: "sp1", issue: 11 });
  const sm = sprints({ id: "sp1", key: "SP1", title: "" }, { id: "sp2", key: "SP2", title: "" });
  const out = candidates([s2, s1], sm, pol({ executionUnit: "sprint" }));
  assert.deepEqual(out.map((c) => c.id), ["sp1", "sp2"]); // orden SP1, SP2
});

test("sprint mode: dep INTRA-sprint no-done NO gatea (el agente goal-mode las hace en orden)", () => {
  const a = st({ id: "a", key: "S1-01", sprintId: "sp1", status: "backlog", issue: 11 });
  const b = st({ id: "b", key: "S1-02", sprintId: "sp1", status: "backlog", issue: 12, deps: ["a"] });
  const out = candidates([a, b], sprints({ id: "sp1", key: "SP1", title: "" }), pol({ executionUnit: "sprint" }));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].stories, ["a", "b"]);
});

test("sprint mode: solo las stories BACKLOG entran al despacho (las done no)", () => {
  const done = st({ id: "a", key: "S1-01", sprintId: "sp1", status: "done", issue: 11 });
  const pend = st({ id: "b", key: "S1-02", sprintId: "sp1", status: "backlog", issue: 12 });
  const out = candidates([done, pend], sprints({ id: "sp1", key: "SP1", title: "" }), pol({ executionUnit: "sprint" }));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].stories, ["b"]); // solo la backlog
  assert.deepEqual(out[0].issues, [12]);
});

// ── prompts ────────────────────────────────────────────────────────────────────────
test("storyPrompt: apunta al issue y pide Closes #N", () => {
  const p = storyPrompt({ key: "S-1", title: "Login", body: "hacé login", acceptance: "- entra", issue: 5 });
  assert.match(p, /issue #5/);
  assert.match(p, /Closes #5/);
  assert.match(p, /Criterios de aceptación/);
});

test("sprintPrompt: goal-mode, una rama/PR, Closes de TODAS", () => {
  const p = sprintPrompt("Sprint 1", [
    { key: "S1-01", title: "A", body: "ba", acceptance: "aa", issue: 11 },
    { key: "S1-02", title: "B", body: "bb", acceptance: "ab", issue: 12 },
  ]);
  assert.match(p, /Modo goal/);
  assert.match(p, /una sola rama/);
  assert.match(p, /Closes #11, Closes #12/);
  // las dos stories, en orden
  assert.ok(p.indexOf("S1-01") < p.indexOf("S1-02"));
});

// ── P8-C · puntero a spec+mockup de la pantalla en el prompt del dev ──────────────
test("screenPointer: con screen_key apunta a UI_SCREENS.md y al mockup; sin él, vacío", () => {
  const p = screenPointer("owner.calendar");
  assert.match(p, /`owner\.calendar`/);
  assert.match(p, /docs\/UI_SCREENS\.md/);
  assert.match(p, /docs\/mockups\/owner\.calendar\.html/);
  assert.equal(screenPointer(undefined), "");
  assert.equal(screenPointer(null), "");
});

test("storyPrompt: story con screen_key incluye el puntero a spec+mockup; sin él no", () => {
  const withScreen = storyPrompt({ key: "S4-18", title: "Calendario", body: "b", acceptance: "a", issue: 5, screenKey: "owner.calendar" });
  assert.match(withScreen, /docs\/mockups\/owner\.calendar\.html/);
  assert.match(withScreen, /Closes #5/);
  const noScreen = storyPrompt({ key: "S1-01", title: "API", body: "b", acceptance: "a", issue: 6, screenKey: null });
  assert.doesNotMatch(noScreen, /docs\/mockups\//);
});

test("sprintPrompt: cada story con screen_key trae su puntero al mockup", () => {
  const p = sprintPrompt("Sprint 4", [
    { key: "S4-18", title: "Cal", body: "b", acceptance: "a", issue: 11, screenKey: "owner.calendar" },
    { key: "S4-19", title: "API", body: "b", acceptance: "a", issue: 12, screenKey: null },
  ]);
  assert.match(p, /docs\/mockups\/owner\.calendar\.html/);
  // la story sin screen_key no inventa un mockup
  assert.equal((p.match(/docs\/mockups\//g) ?? []).length, 1);
});

// ── docsGuardOk (guard docs-on-main, Fase 5) ──────────────────────────────────────
test("docsGuardOk: sin PRD en main NO despacha; con PRD sí; chequeo fallado = fail-open", () => {
  assert.equal(docsGuardOk(false), false); // PRD ausente en main → no despacha
  assert.equal(docsGuardOk(true), true);   // PRD presente → despacha
  assert.equal(docsGuardOk(null), true);   // chequeo a GitHub falló → fail-open, despacha
});
