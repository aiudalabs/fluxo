// F6-02 verify · The conversational-gate coordination loop against LOCAL Supabase, with
// a FAKE agent (no CLAUDE token needed). Proves the real wiring the Studio depends on:
//
//   1. The engine (F5-04) runs on the Supabase ports (design_runs/phases/gates).
//   2. A gate FREEZES the run until "Studio" flips the row to resolved.
//   3. Answering the open questions loops the phase; the answers reach the re-run.
//   4. The harvested artifacts land in design_phases.
//   5. RLS: another tenant cannot see the run.
//
// Run: set -a; source .env; set +a; node --experimental-strip-types design/scripts/verify-gate-loop.ts

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseWorkflow } from "../src/workflow.ts";
import { runDesign, type AgentRunner, type PhaseRun, type PhaseResult } from "../src/engine.ts";
import { SupabaseDesignStore, mintTenantJwt } from "../src/supabase.ts";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!url || !anonKey || !jwtSecret) {
  console.error("need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET (source .env)");
  process.exit(1);
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "33333333-3333-3333-3333-333333333333";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const fail = (m: string) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake agent: first pass leaves an open question; once answered, it resolves it.
const runner: AgentRunner = {
  async run(pr: PhaseRun): Promise<PhaseResult> {
    const content = pr.answers
      ? "# Brief\n## Open Questions\nNinguna — resuelto."
      : "# Brief\n## Open Questions\n- ¿Se cobra seña?";
    return { text: content, artifacts: [{ path: "docs/BRIEF.md", kind: "doc", content }] };
  },
};

const wf = parseWorkflow({
  id: "t",
  steps: [
    { id: "discovery", type: "design", label: "Descubrimiento", agent: "analyst", inputs: { instructions: "$trigger.instructions", output: "docs/BRIEF.md" } },
    { id: "discovery_gate", type: "human_gate", inputs: { reason: "Revisa el brief" }, on_fail: { goto: "discovery", max: 100, feedback: "$discovery_gate.detail" } },
  ],
});

const store = new SupabaseDesignStore({ url, anonKey, jwtSecret, tenant: TENANT_A, project: PROJECT, pollMs: 700 });
const runId = await store.createRun("design", [{ phase_id: "discovery", label: "Descubrimiento", ord: 0 }]);
console.log(`▶ run ${runId} created`);

// ── "Studio": poll for the pending gate and resolve it like a human would. First time,
//    the doc has an open question → answer it (revise). Second time it's clean → approve.
const token = mintTenantJwt(jwtSecret, TENANT_A);
const rest = (path: string, init: RequestInit & { prefer?: string } = {}) =>
  fetch(`${url.replace(/\/$/, "")}/rest/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${token}`, Prefer: init.prefer ?? "return=minimal" },
  });

let answeredCount = 0;
let approvedCount = 0;
const studio = (async () => {
  for (let i = 0; i < 60; i++) {
    await delay(500);
    const res = await rest(`/design_gates?run_id=eq.${runId}&status=eq.pending&select=id,open_questions`);
    const rows = (await res.json()) as Array<{ id: string; open_questions: string[] }>;
    for (const g of rows) {
      if (g.open_questions.length > 0) {
        await rest(`/design_gates?id=eq.${g.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "resolved", outcome: "revise", answers: [{ q: g.open_questions[0], a: "Sí, 30%." }], resolved_at: new Date().toISOString() }),
        });
        answeredCount++;
      } else {
        await rest(`/design_gates?id=eq.${g.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "resolved", outcome: "approve", resolved_at: new Date().toISOString() }),
        });
        approvedCount++;
      }
    }
    if (approvedCount > 0) return; // done once we approve
  }
})();

const res = await runDesign(wf, { instructions: "peluquería" }, { runner, resolver: store.resolver, sink: store.sink });
await studio;
await store.setRunStatus(res.status);

// ── Assertions ────────────────────────────────────────────────────────────────
if (res.status !== "done") fail(`run status = ${res.status}, expected done`);
if (res.phaseRuns.discovery !== 2) fail(`discovery ran ${res.phaseRuns.discovery}x, expected 2 (answered once)`);
if (answeredCount !== 1) fail(`studio answered ${answeredCount} gates, expected 1`);
if (approvedCount !== 1) fail(`studio approved ${approvedCount} gates, expected 1`);
console.log(`✓ gate loop: discovery ran ${res.phaseRuns.discovery}x — 1 answered (open question), 1 approved`);

// The answered gate carries the human's answer.
const gres = await rest(`/design_gates?run_id=eq.${runId}&outcome=eq.revise&select=answers`);
const [ans] = (await gres.json()) as Array<{ answers: Array<{ q: string; a: string }> }>;
if (ans?.answers?.[0]?.a !== "Sí, 30%.") fail("answered gate is missing the human's answer");
console.log(`✓ the answer to the open question is stored: "${ans.answers[0].q}" → "${ans.answers[0].a}"`);

// The harvested artifact landed in design_phases.
const pres = await rest(`/design_phases?run_id=eq.${runId}&phase_id=eq.discovery&select=status,artifacts`);
const [phase] = (await pres.json()) as Array<{ status: string; artifacts: Array<{ path: string }> }>;
if (phase?.status !== "done" || phase.artifacts?.[0]?.path !== "docs/BRIEF.md") fail("phase artifact not harvested to design_phases");
console.log(`✓ phase 'discovery' is done with harvested artifact ${phase.artifacts[0].path}`);

// The gate outcomes were recorded to the brain (kind gate_answer, D5) — the moat.
const bres0 = await rest(`/brain_events?kind=eq.gate_answer&actor=eq.human:studio&select=payload&order=id.desc&limit=2`);
const brainRows = (await bres0.json()) as Array<{ payload: { gate: string; outcome: string } }>;
if (brainRows.length < 1 || !brainRows.some((r) => r.payload.gate === "discovery_gate")) {
  fail("no gate_answer written to the brain");
}
console.log(`✓ gate outcomes recorded to the brain (${brainRows.length} gate_answer events)`);

// RLS: tenant B cannot see tenant A's run.
const bToken = mintTenantJwt(jwtSecret, TENANT_B);
const bres = await fetch(`${url.replace(/\/$/, "")}/rest/v1/design_runs?id=eq.${runId}`, {
  headers: { apikey: anonKey, Authorization: `Bearer ${bToken}` },
});
const bRows = (await bres.json()) as unknown[];
if (bRows.length !== 0) fail(`tenant B saw ${bRows.length} rows of tenant A's run (RLS leak!)`);
console.log("✓ RLS: tenant B cannot see tenant A's design run");

console.log("\n✓ F6-02 gate-coordination loop verified end-to-end against local Supabase");
