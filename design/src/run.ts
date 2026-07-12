// F5-01 verification: run a real design agent via the Agent SDK end-to-end and
// prove the resolver chain. Usage:
//   node --experimental-strip-types src/run.ts [agentId] ["instruction"]
// Requires CLAUDE_CODE_OAUTH_TOKEN in the environment.

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadAgent, runAgent } from "./agent.ts";
import { composePrompt } from "./prompt.ts";
import { resolveRef, recordOutput, type StepContext } from "./resolve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry");

const agentId = process.argv[2] ?? "analyst";
const instruction =
  process.argv[3] ??
  "Idea: una app para que las clientas de una peluquería reserven turno, y una web para que la dueña vea y ordene los turnos. En español.";

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set (source ../.env first)");
  process.exit(1);
}

const ctx: StepContext = { trigger: { instructions: instruction } };
// Compose the phase prompt (F6-02): tell the agent to write docs/BRIEF.md to the workdir.
const promptInput = composePrompt({
  inputs: { instructions: resolveRef("$trigger.instructions", ctx), output: "docs/BRIEF.md" },
});
const workdir = mkdtempSync(join(tmpdir(), "fluxo-design-"));

console.log(`▶ running design agent "${agentId}" via the Claude Agent SDK (workdir-harvest)…`);
console.log(`  workdir: ${workdir}`);
const agent = loadAgent(registryDir, agentId);
const step = await runAgent(agent, promptInput, workdir);

// Store the result the way the workflow does, then read it back the way the NEXT
// phase would (the L-D2 chain).
recordOutput(ctx, "discovery", step.output.text);
const chained = resolveRef("$discovery.output.text", ctx);

const text = step.output.text ?? "";
console.log(`\n✓ harvested ${step.artifacts.length} artifact(s): ${step.artifacts.map((a) => a.path).join(", ")}`);
console.log(`✓ output.text length: ${text.length}`);
console.log(`✓ chain $discovery.output.text resolves: ${chained === text}`);
console.log(`\n--- output.text (first 600 chars) ---\n${text.slice(0, 600)}\n---`);

if (step.artifacts.length === 0 || text.trim().length === 0) {
  console.error("✗ no artifact harvested — the agent wrote nothing to the workdir");
  process.exit(1);
}
console.log("\n✓ F6-02 workdir-harvest: the design agent wrote its deliverable to disk and it was harvested");
