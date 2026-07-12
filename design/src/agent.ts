// F5-01 · Run a registry design agent via the Claude Agent SDK (D2).
//
// The agent's ROLE lives in markdown (registry/agents/<id>.md) — the golden rule:
// the agent lives in markdown, the loop lives in the SDK. We load the role as the
// system prompt and the <id>.yaml for the model, then drive one design turn and
// capture the final text as `{ output: { text } }` — the shape the resolver expects
// (closes L-D2).
//
// Tools are disabled for a design step: the deliverable is TEXT (a brief/PRD/etc.),
// so the agent should reason and answer, not touch the filesystem. Skills and the
// brain-write MCP tool compose here later via `systemPrompt` append and
// `mcpServers`; this is the pure text-generation core.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface Agent {
  id: string;
  role: string; // the .md system prompt
  model: string;
}

interface AgentSpec {
  id?: string;
  model?: string;
}

// loadAgent reads registry/agents/<id>.md (role) + <id>.yaml (model).
export function loadAgent(registryDir: string, id: string): Agent {
  const role = readFileSync(join(registryDir, "agents", `${id}.md`), "utf8");
  const spec = load(readFileSync(join(registryDir, "agents", `${id}.yaml`), "utf8")) as AgentSpec;
  if (!spec?.model) {
    throw new Error(`design: agent ${id} has no model in its yaml`);
  }
  return { id, role, model: spec.model };
}

export interface StepOutput {
  output: { text: string };
}

// The registry roles are written for a tool-enabled runner that writes docs to the
// filesystem. In the design runtime the deliverable is the step's TEXT output, so
// we append an output-channel directive that redirects the same work to the reply.
// The METHOD (the role) is untouched; only where the document lands changes.
const OUTPUT_DIRECTIVE =
  "\n\n# Output channel (design runtime)\n" +
  "Produce the COMPLETE document as your text response. Do NOT use any tools and do " +
  "NOT try to write files — return only the finished document as text.";

// runAgent drives one design turn and returns the produced text at output.text.
// It reads CLAUDE_CODE_OAUTH_TOKEN from the environment (the spawned CLI authates
// with it) — the token is never passed in code.
export async function runAgent(agent: Agent, prompt: string): Promise<StepOutput> {
  let resultText = "";
  let assistantText = "";

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: agent.role + OUTPUT_DIRECTIVE,
      model: agent.model,
      allowedTools: [],
      disallowedTools: ["*"], // pure text generation for a design step
      settingSources: [], // ignore local .claude settings
      maxTurns: 1,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") assistantText += block.text;
      }
    } else if (message.type === "result" && message.subtype === "success") {
      resultText = message.result;
    }
  }

  const text = resultText || assistantText;
  return { output: { text } };
}
