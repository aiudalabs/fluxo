import { test } from "node:test";
import assert from "node:assert/strict";
import { gateAutoApprovable, autoResolver } from "./autonomy.ts";
import type { GateRequest, GateResolver, GateDecision } from "./engine.ts";

const req = (over: Partial<GateRequest> = {}): GateRequest => ({
  gateId: "g", phaseId: "p", reason: "?", openQuestions: [], attempt: 1, ...over,
});

// ── La política (gateAutoApprovable) ───────────────────────────────────────────────
test("auto_if_safe + sin preguntas + workflow de rutina → auto-aprobable", () => {
  assert.equal(gateAutoApprovable(req(), "auto_if_safe", "design"), true);
  assert.equal(gateAutoApprovable(req(), "auto_if_safe", "sprint-planning"), true);
  assert.equal(gateAutoApprovable(req(), "auto_if_safe", "iterate"), true);
});
test("modo manual (off) → NUNCA auto (siempre humano)", () => {
  assert.equal(gateAutoApprovable(req(), "off", "design"), false);
});
test("juicio humano irreemplazable NUNCA se auto-aprueba: retro (self-edit) y review (aceptar incremento)", () => {
  assert.equal(gateAutoApprovable(req(), "auto_if_safe", "retro"), false);
  assert.equal(gateAutoApprovable(req(), "auto_if_safe", "sprint-review"), false);
});
test("una fase con preguntas abiertas → humano (aunque sea auto)", () => {
  assert.equal(gateAutoApprovable(req({ openQuestions: ["¿seña?"] }), "auto_if_safe", "design"), false);
});

// ── El wrapper (autoResolver) ──────────────────────────────────────────────────────
function spyHuman(decision: GateDecision): GateResolver & { calls: number } {
  const r = { calls: 0, async resolve() { r.calls++; return decision; } };
  return r;
}

test("autoResolver: gate seguro → aprueba solo (sin llamar al humano) + audita", async () => {
  const human = spyHuman({ outcome: "revise" });
  let audited = false;
  const r = autoResolver(human, { mode: "auto_if_safe", workflowId: "design", onAuto: () => { audited = true; } });
  const d = await r.resolve(req());
  assert.equal(d.outcome, "approve");
  assert.equal(human.calls, 0);     // NO se consultó al humano
  assert.equal(audited, true);      // se auditó la auto-aprobación
});

test("autoResolver: gate NO seguro (retro) → delega al humano", async () => {
  const human = spyHuman({ outcome: "approve", feedback: "ok" });
  const r = autoResolver(human, { mode: "auto_if_safe", workflowId: "retro" });
  const d = await r.resolve(req());
  assert.equal(human.calls, 1);     // se consultó al humano
  assert.equal(d.feedback, "ok");   // devolvió la decisión humana
});

test("autoResolver: modo manual → delega al humano en todos", async () => {
  const human = spyHuman({ outcome: "approve" });
  const r = autoResolver(human, { mode: "off", workflowId: "design" });
  await r.resolve(req());
  assert.equal(human.calls, 1);
});
