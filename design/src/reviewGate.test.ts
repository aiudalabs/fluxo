import { test } from "node:test";
import assert from "node:assert/strict";
import { openP0, sprintP0Clear, partitionFindings, normalizeFindings } from "./reviewGate.ts";

// Helpers: una story como la ve el gate (subset de la fila DB): status + severidad de origen.
const p0 = (status: string) => ({ status, severity: "P0" as const });
const def = (status: string) => ({ status, severity: "deferred" as const });
const plain = (status: string) => ({ status, severity: null });

// ── openP0: el corazón del gate — cuenta SOLO las P0 aún abiertas (status != done).
test("openP0: cuenta solo P0 no-done", () => {
  assert.equal(openP0([p0("backlog"), p0("done"), def("backlog"), plain("running")]), 1);
});

test("openP0: dos P0 abiertas (backlog + running) → 2", () => {
  assert.equal(openP0([p0("backlog"), p0("running"), p0("done")]), 2);
});

// ── sprintP0Clear: el contrato "done ⟺ 0 P0 abiertas" (docs/19:214).
test("sprintP0Clear: sin P0 abiertas → true (P0 done + deferred/plain no bloquean)", () => {
  assert.equal(sprintP0Clear([p0("done"), def("backlog"), plain("running")]), true);
});

test("sprintP0Clear: una P0 abierta → false (bloquea el done del sprint)", () => {
  assert.equal(sprintP0Clear([p0("backlog")]), false);
});

test("sprintP0Clear: sprint legacy sin findings → true (no rompe proyectos sin reviewer)", () => {
  assert.equal(sprintP0Clear([plain("done"), plain("done")]), true);
});

// ── partitionFindings: el re-feed. P0 → mismo sprint; deferred → siguiente.
test("partitionFindings: P0 → mismo sprint (re-bloquea), deferred → siguiente", () => {
  const r = partitionFindings(
    [
      { id: "R1", title: "el APK no buildea", severity: "P0" },
      { id: "R2", title: "spacing 2px off vs mockup", severity: "deferred" },
    ],
    { currentSprint: "sprint-3", nextSprint: "sprint-4" },
  );
  assert.equal(r.p0, 1);
  assert.equal(r.deferred, 1);
  const byId = Object.fromEntries(r.stories.map((s) => [s.id, s]));
  assert.equal(byId.R1.sprint_id, "sprint-3"); // P0 → MISMO sprint → unbuilt>0 → re-dispatch
  assert.equal(byId.R1.kind, "bug"); // default de un P0
  assert.equal(byId.R1.severity, "P0");
  assert.equal(byId.R2.sprint_id, "sprint-4"); // deferred → siguiente sprint
  assert.equal(byId.R2.kind, "story"); // default de un deferred
  assert.equal(byId.R2.severity, "deferred");
});

test("partitionFindings: acceptance default = title; kind/owner/screen_key respetados", () => {
  const r = partitionFindings(
    [{ id: "R1", title: "login rompe", severity: "P0", owner: "flutter-dev", screen_key: "login", kind: "bug" }],
    { currentSprint: "s1", nextSprint: "s2" },
  );
  const s = r.stories[0];
  assert.equal(s.acceptance, "login rompe"); // sin acceptance explícito → title
  assert.equal(s.owner, "flutter-dev");
  assert.equal(s.screen_key, "login");
  assert.equal(s.id, "R1"); // id estable → re-publicar es idempotente
});

test("partitionFindings: vacío → sin stories, 0/0", () => {
  const r = partitionFindings([], { currentSprint: "s1", nextSprint: "s2" });
  assert.deepEqual(r, { stories: [], p0: 0, deferred: 0 });
});

// ── normalizeFindings: saneo de la salida (no confiable) del reviewer ─────────────────────────────
test("normalizeFindings: parsea array, respeta P0, default deferred, descarta sin título", () => {
  const r = normalizeFindings([
    { id: "R1", title: "APK no buildea", severity: "P0", owner: "flutter-dev" },
    { id: "R2", title: "spacing", severity: "nonsense" }, // severity inválida → deferred
    { title: "sin id" },                                   // sin id → se genera
    { id: "R4", body: "sin título" },                      // sin título → descartada
    "basura",                                              // no-objeto → descartada
  ]);
  assert.equal(r.length, 3);
  assert.equal(r[0].severity, "P0");
  assert.equal(r[1].severity, "deferred"); // severity inválida NO bloquea
  assert.match(r[2].id, /^R-/);            // id generado
});

test("normalizeFindings: acepta string JSON y null/no-array → []", () => {
  assert.equal(normalizeFindings('[{"id":"R1","title":"x","severity":"P0"}]')[0].severity, "P0");
  assert.deepEqual(normalizeFindings(null), []);
  assert.deepEqual(normalizeFindings("no-json"), []);
  assert.deepEqual(normalizeFindings({ not: "array" }), []);
});
