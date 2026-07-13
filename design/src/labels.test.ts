import { test } from "node:test";
import assert from "node:assert/strict";
import { labelSpecsFor, laneColor, sprintColor } from "./labels.ts";

test("labelSpecsFor emite sprint + lane + épica con sus colores", () => {
  const specs = labelSpecsFor({ sprint: "SP1", lane: "python-dev", epic_id: "EPIC-1" });
  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  assert.equal(byName["SP1"].color, sprintColor("SP1"));
  assert.equal(byName["python-dev"].color, "3572a5"); // curado
  assert.equal(byName["EPIC-1"].color, "5319e7"); // púrpura de épica
});

test("es determinista: el mismo nombre siempre da el mismo color", () => {
  assert.equal(laneColor("react-dev"), laneColor("react-dev"));
  assert.equal(sprintColor("SP3"), sprintColor("SP3"));
});

test("sprints distintos → colores distintos (se distinguen por color)", () => {
  const colors = ["SP1", "SP2", "SP3", "SP4"].map(sprintColor);
  assert.equal(new Set(colors).size, 4);
});

test("lane desconocida cae a la paleta (color hex válido), no rompe", () => {
  const c = laneColor("un-agente-nuevo");
  assert.match(c, /^[0-9a-f]{6}$/);
});

test("story sin sprint/lane/épica → sin labels", () => {
  assert.deepEqual(labelSpecsFor({}), []);
});
