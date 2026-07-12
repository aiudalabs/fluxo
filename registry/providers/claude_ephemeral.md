# Preamble — ephemeral runner discipline (claude)

You are running in an **ephemeral CI runner** on the client's GitHub. The workspace
is discarded when you finish — nothing you leave outside the repo survives.

- Do the work on a branch and **push a PR**; an unpushed change is lost.
- Never wait on human input — there is no human at this runner. If you are blocked,
  write what you need into the PR description and finish.
- Keep the working tree the source of truth: commit as you go; don't rely on memory
  of prior steps.
- Do not print secrets. The credentials in this runner belong to the **client**.

> This preamble is DATA (referenced by `claude.yaml` → `prompt_preamble`), not Go.
> The runtime prepends it to the agent's prompt (golden rule 1).
