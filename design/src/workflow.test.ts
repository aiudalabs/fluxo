import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseWorkflow, loadWorkflow, designPhases, type Step } from "./workflow.ts";

const registryDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "registry");

test("maps declared step types to engine kinds", () => {
  const wf = parseWorkflow({
    id: "t",
    steps: [
      { id: "a", type: "design", label: "A", agent: "analyst", inputs: { x: "$trigger.instructions" } },
      { id: "a_gate", type: "human_gate", inputs: { reason: "ok?" }, on_fail: { goto: "a", max: 5, feedback: "$a_gate.detail" } },
      { id: "v", type: "validate", inputs: { schema: "prd", path: "docs/PRD.md" }, on_fail: { goto: "a", max: 2 } },
      { id: "pub", type: "ticket_publish", inputs: {} },
    ],
  });
  assert.deepEqual(
    wf.steps.map((s) => s.kind),
    ["design", "gate", "validate", "handoff"],
  );
  const gate = wf.steps[1] as Extract<Step, { kind: "gate" }>;
  assert.equal(gate.onFail.goto, "a");
  assert.equal(gate.onFail.max, 5);
});

test("rejects a gate with no on_fail (nowhere to loop)", () => {
  assert.throws(
    () => parseWorkflow({ id: "t", steps: [{ id: "g", type: "human_gate", inputs: {} }] }),
    /has no on_fail/,
  );
});

test("rejects an unknown step type loudly", () => {
  assert.throws(() => parseWorkflow({ id: "t", steps: [{ id: "x", type: "bogus" }] }), /unknown type/);
});

test("loads the real design.yaml and derives its phases in order", () => {
  const wf = loadWorkflow(registryDir, "design");
  assert.equal(wf.id, "design");
  const phases = designPhases(wf).map((p) => p.id);
  assert.deepEqual(phases, [
    "discovery",
    "constitution",
    "prd",
    "data_model",
    "architecture",
    "ui",
    "mockups",
    "backlog",
  ]);
  // Every gate loops back to a real earlier step.
  const ids = new Set(wf.steps.map((s) => s.id));
  for (const s of wf.steps) {
    if (s.kind === "gate") assert.ok(ids.has(s.onFail.goto), `${s.id} → ${s.onFail.goto}`);
  }
});
