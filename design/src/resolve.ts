// F5-01 · Input resolution for the design workflow — the fix for L-D2.
//
// v1's bug: workflow steps referenced `$discovery.text`, but the agent's output
// lives at `$discovery.output.text` — so `$discovery.text` resolved to "" and the
// PRD/architecture phases silently received empty context. The resolver here walks
// the FULL dotted path against the step context, so `$discovery.output.text` reads
// the actual text and a wrong path (`$discovery.text`) yields undefined (surfaced,
// not silently blanked).

// StepContext maps step ids to their results, e.g.
//   { trigger: { instructions: "..." },
//     discovery: { output: { text: "the brief" } } }
export type StepContext = Record<string, unknown>;

// resolveRef reads a `$a.b.c` reference from the context. A non-`$` string is a
// literal and returned as-is. A path that doesn't exist yields undefined.
export function resolveRef(ref: string, ctx: StepContext): unknown {
  if (!ref.startsWith("$")) return ref;
  const path = ref.slice(1).split(".");
  let cur: unknown = ctx;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// resolveInputs resolves every `$`-reference in a step's inputs against the
// context, leaving literals untouched.
export function resolveInputs(
  inputs: Record<string, unknown>,
  ctx: StepContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = typeof v === "string" ? resolveRef(v, ctx) : v;
  }
  return out;
}

// recordOutput stores a step's result under `<stepId>.output.text` — the shape
// downstream references expect (`$<stepId>.output.text`).
export function recordOutput(ctx: StepContext, stepId: string, text: string): void {
  ctx[stepId] = { output: { text } };
}
