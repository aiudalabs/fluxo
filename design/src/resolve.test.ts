import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRef, resolveInputs, recordOutput, type StepContext } from "./resolve.ts";

test("resolves $step.output.text to the agent output (the L-D2 fix)", () => {
  const ctx: StepContext = { discovery: { output: { text: "the brief" } } };
  assert.equal(resolveRef("$discovery.output.text", ctx), "the brief");
});

test("the v1 bug shape $step.text yields undefined, not a silent empty string", () => {
  const ctx: StepContext = { discovery: { output: { text: "the brief" } } };
  // This is exactly what broke in v1: text lives at output.text, so $discovery.text
  // has no value — the resolver returns undefined so the gap is visible.
  assert.equal(resolveRef("$discovery.text", ctx), undefined);
});

test("resolves $trigger.instructions", () => {
  const ctx: StepContext = { trigger: { instructions: "build an app" } };
  assert.equal(resolveRef("$trigger.instructions", ctx), "build an app");
});

test("a literal (no $) is returned unchanged", () => {
  assert.equal(resolveRef("docs/BRIEF.md", {}), "docs/BRIEF.md");
});

test("a missing path yields undefined", () => {
  assert.equal(resolveRef("$nope.output.text", { discovery: {} }), undefined);
});

test("resolveInputs resolves refs and keeps literals", () => {
  const ctx: StepContext = { discovery: { output: { text: "brief text" } } };
  const inputs = { brief: "$discovery.output.text", output: "docs/PRD.md" };
  assert.deepEqual(resolveInputs(inputs, ctx), {
    brief: "brief text",
    output: "docs/PRD.md",
  });
});

test("recordOutput + resolveRef round-trip across steps (context chaining)", () => {
  const ctx: StepContext = { trigger: { instructions: "idea" } };
  recordOutput(ctx, "discovery", "a full brief");
  // The next phase reads the prior phase's output — the chain v1 got wrong.
  assert.equal(resolveRef("$discovery.output.text", ctx), "a full brief");
});
