// F5-01 verification: run a real design agent via the Agent SDK end-to-end and
// prove the resolver chain. Usage:
//   node --experimental-strip-types src/run.ts [agentId] ["instruction"]
// Requires CLAUDE_CODE_OAUTH_TOKEN in the environment.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadAgent, runAgent } from "./agent.ts";
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
const promptInput = resolveRef("$trigger.instructions", ctx) as string;

console.log(`▶ running design agent "${agentId}" via the Claude Agent SDK…`);
const agent = loadAgent(registryDir, agentId);
const step = await runAgent(agent, promptInput);

// Store the result the way the workflow does, then read it back the way the NEXT
// phase would (the L-D2 chain).
recordOutput(ctx, "discovery", step.output.text);
const chained = resolveRef("$discovery.output.text", ctx);

const text = step.output.text ?? "";
console.log(`\n✓ output.text length: ${text.length}`);
console.log(`✓ chain $discovery.output.text resolves: ${chained === text}`);
console.log(`\n--- output.text (first 600 chars) ---\n${text.slice(0, 600)}\n---`);

if (text.trim().length === 0) {
  console.error("✗ output.text is empty — the agent produced nothing");
  process.exit(1);
}
console.log("\n✓ F5-01 real design agent run produced non-empty output.text");
