// F6-02 · The real AgentRunner for the design engine: Claude Agent SDK + workdir-harvest.
//
// One WORKDIR per run, shared across phases — so a later phase reads the earlier phases'
// docs by path from the workdir (docs/PRD.md, docs/UI_SCREENS.md) while the engine also
// threads their text via $<phase>.output.text. Each phase composes its prompt from the
// resolved inputs (+ any gate feedback/answers), runs the agent scoped to the workdir,
// and returns the harvested artifacts as the PhaseResult (which the Supabase sink writes
// to design_phases and the brain).

import { loadAgent, runAgent } from "./agent.ts";
import { composePrompt } from "./prompt.ts";
import type { AgentRunner, PhaseRun, PhaseResult } from "./engine.ts";

export function makeSdkRunner(registryDir: string, workdir: string): AgentRunner {
  const cache = new Map<string, ReturnType<typeof loadAgent>>();
  const agentFor = (id: string) => {
    let a = cache.get(id);
    if (!a) {
      a = loadAgent(registryDir, id);
      cache.set(id, a);
    }
    return a;
  };

  return {
    async run(pr: PhaseRun): Promise<PhaseResult> {
      const prompt = composePrompt({ inputs: pr.inputs, feedback: pr.feedback, answers: pr.answers });
      const step = await runAgent(agentFor(pr.agent), prompt, workdir);
      return { text: step.output.text, artifacts: step.artifacts };
    },
  };
}
