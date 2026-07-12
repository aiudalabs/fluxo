# Skill — brain-write

Append a durable, auditable fact to the **brain** — the append-only registry that is
Fluxo's moat (docs/00-vision). The brain is what vibecoding loses: every decision, gate
answer, rejected design and requirement→issue→PR link is written here **as it happens**,
so the agency can later show the client an honest trail of *why* the product is the way
it is. If it isn't in the brain, it didn't happen.

> The brain is `public.brain_events` (F1-01): append-only, tenant-isolated by RLS. You
> **cannot** read or write another tenant's rows, and you **cannot** edit or delete a row
> once written — history is immutable by construction. Don't try to "fix" a past event;
> append a correcting one.

## When you MUST append (not optional)

Append exactly one event, at the moment it occurs, for each of:

- **`decision`** — a durable choice with non-obvious impact (a locked default, a stack
  pick, a tradeoff accepted). Include what was decided AND the rationale.
- **`gate_answer`** — the outcome of a human gate: approved / changes-requested, plus the
  reviewer's feedback and answers to any open questions the gate raised.
- **`rejected_design`** — a design/approach that was considered and NOT taken, with the
  reason. This is the highest-value memory: it stops the factory re-proposing dead ends.
- **`provenance`** — a link in the chain requirement→issue→PR→published (F1-03). Written
  when a backlog is published and when a PR merges, so the trail is reconstructable.

Do NOT append routine chatter (a file edit, a lint pass, an intermediate thought). The
brain is signal, not a log tail — mirror the provenance protocol: only facts with
non-obvious downstream impact.

## The contract — one call, with provenance

Appending is a **single call** to the `brain_write` tool. You supply the content; the
runtime injects the identity so you cannot spoof it:

| field | who sets it | notes |
|---|---|---|
| `tenant_id`, `project_id` | **runtime context** (never you) | RLS scope — injected, not chosen |
| `kind` | you | one of the kinds above |
| `payload` | you | JSON; see per-kind shape below |
| `actor` | you | who/what produced it: an agent id (`architect`), `human:<user>`, or `system` |
| `ts` | database (`now()`) | you never set time |

Because `tenant_id`/`project_id` come from context, a call is scoped to the current
project automatically — you never pass another tenant's id, and RLS would reject it if you
tried.

### Payload shapes (keep them small and structured)

```jsonc
// decision
{ "title": "Platform = Supabase managed", "decision": "…", "rationale": "…",
  "alternatives_rejected": ["self-host Postgres+batteries"], "refs": ["docs/06-decisiones#D1"] }

// gate_answer
{ "gate": "arch_gate", "outcome": "approved", "feedback": "…",
  "answered": [{ "q": "índices?", "a": "…" }] }

// rejected_design
{ "what": "serial conductor every 25s", "why_rejected": "flap / cost (L-ARCH-4)",
  "chosen_instead": "webhooks + Realtime" }

// provenance
{ "requirement": "FR-03", "issue": "client/repo#42", "pr": "client/repo#57",
  "stage": "merged" }
```

## After you append

State, in one line, that you wrote it: `brain: <kind> "<title>" appended`. The brain
explorer (F1-04) and the requirement→issue→PR trail (F1-03) read these rows directly —
a missing append is a hole in the story the agency tells the client.
