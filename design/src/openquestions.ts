// F5-04 · Surface the OPEN QUESTIONS a phase left unresolved, so the gate can present
// them to the human to ANSWER (not just approve/reject). The design roles already write
// an "Open Questions" / "Preguntas abiertas" section (see registry/agents/analyst.md §8),
// so we read that section out of the produced doc rather than asking the agent to emit a
// second structured channel.
//
// Pure + deterministic: find the H2 whose title matches open-questions, then collect the
// list items (-, *, or 1.) until the next H2. A section that says "none / ninguna" yields
// no questions.

const HEADING = /^#{2,3}\s+(.*)$/;
const OPEN_Q = /open\s+questions|preguntas\s+abiertas/i;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;
const NONE = /^\s*(none|ninguna|n\/?a|no\s+hay|sin\s+preguntas)\b/i;

export function extractOpenQuestions(markdown: string): string[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const questions: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      // Entering the open-questions section, or leaving it at the next heading.
      inSection = OPEN_Q.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    if (NONE.test(line)) continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      // Strip a leading "FR-03:"-style label but keep the question text.
      questions.push(item[1].trim());
    }
  }
  return questions;
}
