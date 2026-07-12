// F5-01 / F6-02 · Run a registry design agent via the Claude Agent SDK (D2).
//
// The agent's ROLE lives in markdown (registry/agents/<id>.md) — the golden rule:
// the agent lives in markdown, the loop lives in the SDK. We load the role as the
// system prompt and the <id>.yaml for the model, then drive a design turn.
//
// F6-02 (decision D5): the deliverable is FILES, not reply text. The agent runs with
// write tools scoped to a WORKDIR (cwd) and writes its docs/mockups as the role asks;
// the runtime then HARVESTS the files it produced (harvest.ts). The old OUTPUT_DIRECTIVE
// (which redirected the doc into the reply) is gone — writing to disk is the role's
// natural shape and handles multi-file phases (mockups, architecture) for free.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { snapshotDir, harvestChanged, primaryText, type Artifact } from "./harvest.ts";

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
  artifacts: Artifact[]; // every file the phase wrote to the workdir (D5)
}

// runAgent drives a design turn in a scoped WORKDIR and returns the harvested artifacts
// plus the primary doc text (what a downstream phase reads as $<phase>.output.text). The
// agent writes to disk with Read/Write/Edit scoped to `workdir` (cwd); it cannot touch
// anything else. Reads CLAUDE_CODE_OAUTH_TOKEN from the environment (the spawned CLI
// authenticates with it) — the token is never passed in code.
export async function runAgent(agent: Agent, prompt: string, workdir: string): Promise<StepOutput> {
  const before = snapshotDir(workdir);
  let resultText = "";
  let assistantText = "";

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: agent.role,
      model: agent.model,
      cwd: workdir, // scope the filesystem to the phase's workdir
      allowedTools: ["Read", "Write", "Edit"], // write the deliverables to disk (D5)
      settingSources: [], // ignore local .claude settings
      permissionMode: "bypassPermissions", // the workdir IS the sandbox
      maxTurns: 40, // multi-file phases (mockups) need several write turns
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

  const artifacts = harvestChanged(workdir, before);
  // The canonical output text is the produced doc (so phases chain on the artifact, not
  // on chatty reply text). Fall back to the reply only if nothing was written.
  const text = primaryText(artifacts) || resultText || assistantText;
  return { output: { text }, artifacts };
}
