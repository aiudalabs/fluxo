import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlan, PlanApplyError, type LiveStory, type LiveSprint } from "./planApply.ts";
import type { PlanAction } from "./plan.ts";

const sprints: LiveSprint[] = [
  { key: "SP1", position: 1 },
  { key: "SP2", position: 2 },
  { key: "SP3", position: 3 },
];
const stories = (): LiveStory[] => [
  { key: "S-1", status: "backlog", sprintKey: "SP1", deps: [] },
  { key: "S-2", status: "backlog", sprintKey: "SP1", deps: ["S-1"] },
  { key: "S-3", status: "backlog", sprintKey: "SP2", deps: [] },
  { key: "S-9", status: "running", sprintKey: "SP2", deps: [] },
  { key: "S-10", status: "backlog", sprintKey: "SP3", deps: [] },
];
const rejects = (acts: PlanAction[], re: RegExp) =>
  assert.throws(() => computePlan(acts, stories(), sprints), (e) => e instanceof PlanApplyError && re.test(e.message));

test("actions vacías → sin mutaciones (solo confirma el goal)", () => {
  assert.deepEqual(computePlan([], stories(), sprints), []);
});

test("move a un sprint existente → setSprint", () => {
  assert.deepEqual(
    computePlan([{ op: "move", storyId: "S-1", sprintId: "SP3" }], stories(), sprints),
    [{ kind: "setSprint", storyKey: "S-1", sprintKey: "SP3" }],
  );
});

test("move de una story en vuelo (running) aborta", () => {
  rejects([{ op: "move", storyId: "S-9", sprintId: "SP3" }], /solo se puede mover/);
});

test("move a un sprint inexistente aborta", () => {
  rejects([{ op: "move", storyId: "S-1", sprintId: "SP99" }], /destino 'SP99' no existe/);
});

test("defer → mueve al sprint siguiente por posición", () => {
  assert.deepEqual(
    computePlan([{ op: "defer", storyId: "S-1" }], stories(), sprints), // S-1 en SP1 → SP2
    [{ kind: "setSprint", storyKey: "S-1", sprintKey: "SP2" }],
  );
});

test("defer desde el último sprint aborta (crear el siguiente no está soportado aún)", () => {
  rejects([{ op: "defer", storyId: "S-10" }], /no hay sprint posterior/); // S-10 en SP3 (último)
});

test("edit de campos simples → patchFields", () => {
  assert.deepEqual(
    computePlan([{ op: "edit", storyId: "S-2", fields: { title: "Nuevo", owner: "python-dev" } }], stories(), sprints),
    [{ kind: "patchFields", storyKey: "S-2", fields: { title: "Nuevo", owner: "python-dev" } }],
  );
});

test("edit de deps → setDeps (reemplaza el set)", () => {
  assert.deepEqual(
    computePlan([{ op: "edit", storyId: "S-2", fields: { deps: ["S-3"] } }], stories(), sprints),
    [{ kind: "setDeps", storyKey: "S-2", depKeys: ["S-3"] }],
  );
});

test("edit con deps: [] BORRA las deps", () => {
  assert.deepEqual(
    computePlan([{ op: "edit", storyId: "S-2", fields: { deps: [] } }], stories(), sprints),
    [{ kind: "setDeps", storyKey: "S-2", depKeys: [] }],
  );
});

test("edit con patch + deps → dos mutaciones en orden", () => {
  assert.deepEqual(
    computePlan([{ op: "edit", storyId: "S-2", fields: { title: "x", deps: ["S-3"] } }], stories(), sprints),
    [{ kind: "patchFields", storyKey: "S-2", fields: { title: "x" } }, { kind: "setDeps", storyKey: "S-2", depKeys: ["S-3"] }],
  );
});

test("edit con self-dep aborta", () => {
  rejects([{ op: "edit", storyId: "S-1", fields: { deps: ["S-1"] } }], /no puede depender de sí misma/);
});

test("edit con dep inexistente aborta", () => {
  rejects([{ op: "edit", storyId: "S-1", fields: { deps: ["S-404"] } }], /la dep 'S-404' no existe/);
});

test("edit que forma un ciclo aborta (S-1→S-2→S-1)", () => {
  // S-2 ya depende de S-1; hacer que S-1 dependa de S-2 cierra el ciclo.
  rejects([{ op: "edit", storyId: "S-1", fields: { deps: ["S-2"] } }], /forman un ciclo/);
});

test("ciclo CROSS-acción: dos edits sanos por separado pero juntos ciclo → aborta", () => {
  const st: LiveStory[] = [
    { key: "A", status: "backlog", sprintKey: "SP1", deps: [] },
    { key: "B", status: "backlog", sprintKey: "SP1", deps: [] },
  ];
  assert.throws(
    () => computePlan([{ op: "edit", storyId: "A", fields: { deps: ["B"] } }, { op: "edit", storyId: "B", fields: { deps: ["A"] } }], st, sprints),
    (e) => e instanceof PlanApplyError && /forman un ciclo/.test(e.message),
  );
});

test("ciclo largo S1→S2→S3→S1 aborta", () => {
  const st: LiveStory[] = [
    { key: "S1", status: "backlog", sprintKey: "SP1", deps: ["S2"] },
    { key: "S2", status: "backlog", sprintKey: "SP1", deps: ["S3"] },
    { key: "S3", status: "backlog", sprintKey: "SP1", deps: [] },
  ];
  assert.throws(
    () => computePlan([{ op: "edit", storyId: "S3", fields: { deps: ["S1"] } }], st, sprints),
    (e) => e instanceof PlanApplyError && /ciclo/.test(e.message),
  );
});

test("no muta los inputs (ni en éxito ni al lanzar)", () => {
  const st = stories();
  const snapshot = JSON.parse(JSON.stringify(st));
  computePlan([{ op: "edit", storyId: "S-2", fields: { deps: ["S-3"] } }], st, sprints); // éxito
  assert.deepEqual(st, snapshot);
  try { computePlan([{ op: "edit", storyId: "S-1", fields: { deps: ["S-2"] } }], st, sprints); } catch { /* esperado */ }
  assert.deepEqual(st, snapshot); // tampoco mutó al lanzar
});

test("defer de una story 'ready' está permitido (spec: defer no restringe status)", () => {
  const st: LiveStory[] = [{ key: "R", status: "ready", sprintKey: "SP1", deps: [] }];
  assert.deepEqual(computePlan([{ op: "defer", storyId: "R" }], st, sprints), [{ kind: "setSprint", storyKey: "R", sprintKey: "SP2" }]);
});

test("defer de una story 'running' (en vuelo) aborta", () => {
  rejects([{ op: "defer", storyId: "S-9" }], /en vuelo\/terminada/); // S-9 está running
});

test("dos acciones sobre la misma story abortan", () => {
  rejects([{ op: "move", storyId: "S-1", sprintId: "SP2" }, { op: "defer", storyId: "S-1" }], /dos acciones sobre la misma story/);
});

test("acción sobre una story inexistente aborta", () => {
  rejects([{ op: "cancel", storyId: "S-404" }], /no existe en el backlog vivo/);
});

test("cancel y split se rechazan limpio (aún no soportados)", () => {
  rejects([{ op: "cancel", storyId: "S-1" }], /'cancel' aún no está soportado/);
  rejects([{ op: "split", storyId: "S-1", parts: [{ title: "a" }, { title: "b" }] }], /'split' aún no está soportado/);
});
