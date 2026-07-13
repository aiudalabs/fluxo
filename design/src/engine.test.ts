import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseWorkflow, loadWorkflow } from "./workflow.ts";
import {
  runDesign,
  GateExhaustedError,
  type AgentRunner,
  type PhaseRun,
  type PhaseResult,
  type GateResolver,
  type GateRequest,
  type GateDecision,
  type HandoffExecutor,
} from "./engine.ts";
import { recordOutput, type StepContext } from "./resolve.ts";

const registryDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "registry");

// A fake agent that records every call and returns configurable text per phase.
function fakeRunner(textFor: (r: PhaseRun) => string = () => "doc"): AgentRunner & { calls: PhaseRun[] } {
  const calls: PhaseRun[] = [];
  return {
    calls,
    async run(r: PhaseRun): Promise<PhaseResult> {
      calls.push(r);
      return { text: textFor(r) };
    },
  };
}

// A resolver driven by a scripted queue of decisions, keyed by gate id.
function scriptedResolver(script: Record<string, GateDecision[]>): GateResolver & { seen: GateRequest[] } {
  const seen: GateRequest[] = [];
  const idx: Record<string, number> = {};
  return {
    seen,
    async resolve(req: GateRequest): Promise<GateDecision> {
      seen.push(req);
      const q = script[req.gateId] ?? [];
      const d = q[idx[req.gateId] ?? 0] ?? { outcome: "approve" };
      idx[req.gateId] = (idx[req.gateId] ?? 0) + 1;
      return d;
    },
  };
}

const oneGate = parseWorkflow({
  id: "t",
  steps: [
    { id: "phase", type: "design", label: "Phase", agent: "analyst", inputs: { instructions: "$trigger.instructions" } },
    { id: "phase_gate", type: "human_gate", inputs: { reason: "ok?" }, on_fail: { goto: "phase", max: 100, feedback: "$phase_gate.detail" } },
  ],
});

test("approve advances — the phase runs exactly once", async () => {
  const runner = fakeRunner();
  const resolver = scriptedResolver({ phase_gate: [{ outcome: "approve" }] });
  const res = await runDesign(oneGate, { instructions: "idea" }, { runner, resolver });
  assert.equal(res.status, "done");
  assert.equal(res.phaseRuns.phase, 1);
  assert.equal(runner.calls[0].inputs.instructions, "idea"); // $trigger resolved
});

test("revise loops the phase with the reviewer's feedback via $gate.detail", async () => {
  const runner = fakeRunner();
  const resolver = scriptedResolver({
    phase_gate: [{ outcome: "revise", feedback: "aclara el scope de la sección 5" }, { outcome: "approve" }],
  });
  const res = await runDesign(oneGate, { instructions: "idea" }, { runner, resolver });
  assert.equal(res.status, "done");
  assert.equal(res.phaseRuns.phase, 2); // ran again after the reject
  assert.equal(runner.calls[0].feedback, undefined); // first pass had none
  assert.equal(runner.calls[1].feedback, "aclara el scope de la sección 5"); // resolved from $phase_gate.detail
});

test("answering open questions loops the phase with the answers injected", async () => {
  // The phase doc surfaces two open questions; the human answers them at the gate.
  const runner = fakeRunner((r) =>
    r.answers ? "# Brief\n## Open Questions\nNinguna." : "# Brief\n## Open Questions\n- ¿Seña?\n- ¿No-show?",
  );
  const answers = [
    { q: "¿Seña?", a: "Sí, 30%." },
    { q: "¿No-show?", a: "Se cobra la seña." },
  ];
  const resolver = scriptedResolver({ phase_gate: [{ outcome: "revise", answers }, { outcome: "approve" }] });
  const res = await runDesign(oneGate, { instructions: "idea" }, { runner, resolver });

  // The gate saw the open questions the phase produced.
  assert.deepEqual(resolver.seen[0].openQuestions, ["¿Seña?", "¿No-show?"]);
  // The re-run received the human's answers.
  assert.deepEqual(runner.calls[1].answers, answers);
  // Second time around, the doc has no open questions → the gate is asked with an empty list.
  assert.deepEqual(resolver.seen[1].openQuestions, []);
  assert.equal(res.status, "done");
});

test("a gate that never approves is bounded by on_fail.max", async () => {
  const wf = parseWorkflow({
    id: "t",
    steps: [
      { id: "p", type: "design", label: "P", agent: "a", inputs: {} },
      { id: "p_gate", type: "human_gate", inputs: { reason: "?" }, on_fail: { goto: "p", max: 2, feedback: "$p_gate.detail" } },
    ],
  });
  const runner = fakeRunner();
  const resolver = scriptedResolver({ p_gate: [{ outcome: "revise", feedback: "x" }, { outcome: "revise", feedback: "y" }] });
  await assert.rejects(runDesign(wf, {}, { runner, resolver }), (e) => {
    assert.ok(e instanceof GateExhaustedError);
    assert.equal(e.gateId, "p_gate");
    assert.equal(e.max, 2);
    return true;
  });
});

test("stops at a handoff step (awaiting F5-03) when no executor is injected", async () => {
  const wf = parseWorkflow({
    id: "t",
    steps: [
      { id: "p", type: "design", label: "P", agent: "a", inputs: {} },
      { id: "p_gate", type: "human_gate", inputs: { reason: "?" }, on_fail: { goto: "p", max: 100 } },
      { id: "pub", type: "ticket_publish", inputs: {} },
    ],
  });
  const runner = fakeRunner();
  const resolver = scriptedResolver({ p_gate: [{ outcome: "approve" }] });
  let handedOff = false;
  const res = await runDesign(wf, {}, { runner, resolver, sink: { onHandoff: () => { handedOff = true; } } });
  assert.equal(res.status, "awaiting_handoff");
  assert.ok(handedOff);

  // With an executor injected, it runs and the workflow completes.
  const exec: HandoffExecutor = { run: async () => {} };
  const res2 = await runDesign(wf, {}, { runner: fakeRunner(), resolver: scriptedResolver({ p_gate: [{ outcome: "approve" }] }), handoff: exec });
  assert.equal(res2.status, "done");
});

test("real design.yaml: auto-approving every gate walks all phases to the handoff", async () => {
  const wf = loadWorkflow(registryDir, "design");
  const runner = fakeRunner();
  const resolver = scriptedResolver({}); // default = approve
  const phaseOrder: string[] = [];
  const res = await runDesign(
    wf,
    { instructions: "peluquería app", repo: "acme/salon", project_id: "p1" },
    { runner, resolver, sink: { onPhaseStart: (id) => { phaseOrder.push(id); } } },
  );
  // docs_pr is the first handoff (type: pr) → the design halts there awaiting F5-03.
  assert.equal(res.status, "awaiting_handoff");
  assert.deepEqual(phaseOrder, ["discovery", "constitution", "prd", "data_model", "architecture", "ui", "mockups", "backlog"]);
});

// ── Crash-resume (Opción B) ──────────────────────────────────────────────────────
// The kernel honours a ResumeState: a pre-seeded ctx (done phases) + startIndex, so a
// resumed run does NOT re-run completed phases or re-ask already-approved gates.
const twoPhase = parseWorkflow({
  id: "t2",
  steps: [
    { id: "p1", type: "design", label: "P1", agent: "a", inputs: {} },
    { id: "g1", type: "human_gate", inputs: { reason: "?" }, on_fail: { goto: "p1", max: 5 } },
    { id: "p2", type: "design", label: "P2", agent: "b", inputs: {} },
    { id: "g2", type: "human_gate", inputs: { reason: "?" }, on_fail: { goto: "p2", max: 5 } },
  ],
});

test("resume: startIndex past a done phase skips it — only p2 runs, only g2 is asked", async () => {
  const runner = fakeRunner();
  const resolver = scriptedResolver({ g2: [{ outcome: "approve" }] });
  const ctx: StepContext = { trigger: { instructions: "idea" } };
  recordOutput(ctx, "p1", "brief ya generado antes del crash");
  const res = await runDesign(twoPhase, { instructions: "idea" }, { runner, resolver }, { ctx, phaseRuns: { p1: 1 }, startIndex: 2 });
  assert.equal(res.status, "done");
  assert.deepEqual(runner.calls.map((c) => c.phaseId), ["p2"]); // p1 NOT re-run
  assert.deepEqual(resolver.seen.map((r) => r.gateId), ["g2"]); // g1 NOT re-asked
  assert.equal(res.phaseRuns.p1, 1); // preserved from the seed
  assert.equal(res.phaseRuns.p2, 1);
});

test("resume: startIndex AT a frozen gate re-asks that gate, then continues", async () => {
  // Crash while frozen at g1: p1 done, g1 pending → resume AT g1 (index 1).
  const runner = fakeRunner();
  const resolver = scriptedResolver({ g1: [{ outcome: "approve" }], g2: [{ outcome: "approve" }] });
  const ctx: StepContext = { trigger: { instructions: "idea" } };
  recordOutput(ctx, "p1", "brief");
  const res = await runDesign(twoPhase, { instructions: "idea" }, { runner, resolver }, { ctx, phaseRuns: { p1: 1 }, startIndex: 1 });
  assert.equal(res.status, "done");
  assert.deepEqual(resolver.seen.map((r) => r.gateId), ["g1", "g2"]); // g1 resolved on resume
  assert.deepEqual(runner.calls.map((c) => c.phaseId), ["p2"]); // p1 stayed done, only p2 ran
});
