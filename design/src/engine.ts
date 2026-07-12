// F5-04 · The design orchestration engine. It walks a design Workflow phase-by-phase,
// runs each phase's agent, and FREEZES at every human_gate until a human resolves it.
//
// The gate is CONVERSATIONAL (the whole point of F5-04): a resolution is not a binary
// approve/reject. It is one of:
//   • approve                     → advance to the next step
//   • revise  (feedback)          → loop back to the phase with the reviewer's correction
//   • answer  (open questions)    → loop back to the phase with the human's answers to the
//                                   questions the phase itself surfaced
// revise and answer can arrive together; both re-run the guarded phase (bounded by the
// gate's on_fail.max) so the doc is regenerated with the new context, then the gate is
// asked again. approve is the only way forward.
//
// The engine is pure orchestration over injected PORTS — no SDK, no DB, no I/O of its own
// (golden rule 6: the kernel is small and hard-tested). F6-02 supplies the real ports:
// an AgentRunner backed by the Agent SDK + workdir-harvest, and a GateResolver + Sink
// backed by Supabase (the human answers in Studio, the brain records the gate_answer).

import { type Step, type Workflow } from "./workflow.ts";
import { resolveInputs, resolveRef, recordOutput, type StepContext } from "./resolve.ts";
import { extractOpenQuestions } from "./openquestions.ts";

export interface Artifact {
  path: string; // e.g. docs/BRIEF.md, docs/mockups/patient.html
  content: string;
  kind?: string; // doc | mockup | config | file (set by the harvester; carried to Studio)
}

export interface PhaseRun {
  phaseId: string;
  agent: string;
  inputs: Record<string, unknown>; // already resolved against the run context
  feedback?: string; // a prior gate's correction ($<gate>.detail)
  answers?: QA[]; // a prior gate's answers to the open questions
}

export interface PhaseResult {
  text: string; // the primary doc text — recorded at $<phase>.output.text
  artifacts?: Artifact[]; // every file the phase produced (workdir-harvest, F6-02)
}

export interface AgentRunner {
  run(input: PhaseRun): Promise<PhaseResult>;
}

export interface QA {
  q: string;
  a: string;
}

export type GateOutcome = "approve" | "revise";

export interface GateRequest {
  gateId: string;
  phaseId: string; // the phase this gate guards (its on_fail.goto)
  reason: string;
  openQuestions: string[]; // pulled from the phase's produced doc
  attempt: number; // 1-based; capped by the gate's on_fail.max
}

export interface GateDecision {
  outcome: GateOutcome;
  feedback?: string; // free-form correction
  answers?: QA[]; // answers to the open questions
}

export interface GateResolver {
  // Blocks until a human resolves the gate (in prod: waits on a Studio decision).
  resolve(req: GateRequest): Promise<GateDecision>;
}

// A handoff step (pr / ticket_publish) hands the design off to the client repo — F5-03,
// infra-blocked. If no executor is injected the engine stops at the first handoff and
// reports `awaiting_handoff` (design is done, publish is the next, external step).
export interface HandoffExecutor {
  run(step: Extract<Step, { kind: "handoff" }>, ctx: StepContext): Promise<void>;
}

export interface EngineSink {
  onPhaseStart?(phaseId: string, attempt: number): void | Promise<void>;
  onPhaseDone?(phaseId: string, result: PhaseResult): void | Promise<void>;
  onGate?(req: GateRequest, decision: GateDecision): void | Promise<void>;
  onHandoff?(step: Extract<Step, { kind: "handoff" }>): void | Promise<void>;
}

export type RunStatus = "done" | "awaiting_handoff";

export interface RunResult {
  status: RunStatus;
  ctx: StepContext;
  // Per-phase count of how many times the phase actually ran (1 + reject loops).
  phaseRuns: Record<string, number>;
}

export interface EngineDeps {
  runner: AgentRunner;
  resolver: GateResolver;
  handoff?: HandoffExecutor;
  sink?: EngineSink;
}

export class GateExhaustedError extends Error {
  gateId: string;
  phaseId: string;
  max: number;
  constructor(gateId: string, phaseId: string, max: number) {
    super(`gate ${gateId}: not approved within ${max} attempt(s)`);
    this.name = "GateExhaustedError";
    this.gateId = gateId;
    this.phaseId = phaseId;
    this.max = max;
  }
}

function stepIndex(steps: Step[], id: string): number {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`engine: goto references unknown step ${id}`);
  return i;
}

// runDesign executes the workflow. `trigger` seeds $trigger.* (instructions, repo, …).
export async function runDesign(
  wf: Workflow,
  trigger: Record<string, unknown>,
  deps: EngineDeps,
): Promise<RunResult> {
  const { runner, resolver, handoff, sink } = deps;
  const steps = wf.steps;
  const ctx: StepContext = { trigger };
  const phaseRuns: Record<string, number> = {};
  // Corrections queued for a phase by a prior gate reject (feedback + answers).
  const pending: Record<string, { feedback?: string; answers?: QA[] }> = {};
  const gateAttempts: Record<string, number> = {};

  let i = 0;
  while (i < steps.length) {
    const step = steps[i];

    if (step.kind === "design") {
      const attempt = (phaseRuns[step.id] ?? 0) + 1;
      phaseRuns[step.id] = attempt;
      await sink?.onPhaseStart?.(step.id, attempt);
      const queued = pending[step.id];
      const result = await runner.run({
        phaseId: step.id,
        agent: step.agent,
        inputs: resolveInputs(step.inputs, ctx),
        feedback: queued?.feedback,
        answers: queued?.answers,
      });
      delete pending[step.id];
      recordOutput(ctx, step.id, result.text);
      await sink?.onPhaseDone?.(step.id, result);
      i++;
      continue;
    }

    if (step.kind === "validate") {
      // The real schema lint runs out-of-band (a separate validator). The engine keeps
      // the phase moving; a genuine lint failure is modelled by the AgentRunner looping
      // its own phase. Nothing to do here but advance.
      i++;
      continue;
    }

    if (step.kind === "gate") {
      const phaseId = step.onFail.goto;
      const attempt = (gateAttempts[step.id] ?? 0) + 1;
      gateAttempts[step.id] = attempt;
      const phaseText = (resolveRef(`$${phaseId}.output.text`, ctx) as string) ?? "";
      const req: GateRequest = {
        gateId: step.id,
        phaseId,
        reason: step.reason,
        openQuestions: extractOpenQuestions(phaseText),
        attempt,
      };
      const decision = await resolver.resolve(req);
      await sink?.onGate?.(req, decision);

      if (decision.outcome === "approve") {
        i++;
        continue;
      }

      // revise / answer: bounded loop back to the guarded phase.
      if (attempt >= step.onFail.max) {
        throw new GateExhaustedError(step.id, phaseId, step.onFail.max);
      }
      // Expose the reviewer's correction as $<gate>.detail so the workflow's declared
      // `feedback: $<gate>.detail` ref resolves — the method stays in data.
      ctx[step.id] = { detail: decision.feedback ?? "" };
      const feedback = step.onFail.feedback
        ? (resolveRef(step.onFail.feedback, ctx) as string)
        : decision.feedback;
      pending[phaseId] = { feedback, answers: decision.answers };
      i = stepIndex(steps, phaseId);
      continue;
    }

    // handoff (pr / ticket_publish) — F5-03.
    await sink?.onHandoff?.(step);
    if (!handoff) {
      return { status: "awaiting_handoff", ctx, phaseRuns };
    }
    await handoff.run(step, ctx);
    i++;
  }

  return { status: "done", ctx, phaseRuns };
}
