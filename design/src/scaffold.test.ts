import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { buildScaffold, substitute } from "./scaffold.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry"); // design/src → fluxo/registry

// ── substitute ────────────────────────────────────────────────────────────────
test("substitute reemplaza {{project_name}} (todas las ocurrencias)", () => {
  const out = substitute("gate for {{project_name}} — {{project_name}}", { projectName: "Idearium" });
  assert.equal(out, "gate for Idearium — Idearium");
});

// ── buildScaffold contra el registry real ───────────────────────────────────────
test("buildScaffold incluye claude.yml + claude-review.yml + suite-integrity.yml", () => {
  const s = buildScaffold(registryDir, { projectName: "Demo" });
  const paths = s.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    ".github/workflows/claude-review.yml",
    ".github/workflows/claude.yml",
    ".github/workflows/suite-integrity.yml",
  ]);
});

test("claude-review.yml queda SUSTITUIDO (nombre presente, sin placeholders sueltos)", () => {
  const s = buildScaffold(registryDir, { projectName: "Idearium" });
  const review = s.find((f) => f.path.endsWith("claude-review.yml"))!;
  assert.match(review.content, /release gate for Idearium/);
  // No queda el placeholder sin resolver. (Ojo: {{ }} de GitHub Actions como ${{ secrets.X }}
  // son legítimos y NO son placeholders nuestros — solo chequeamos {{project_name}}.)
  assert.doesNotMatch(review.content, /\{\{\s*project_name\s*\}\}/);
});

test("claude.yml NO se sustituye (no tiene placeholders) y va tal cual del registry", () => {
  const s = buildScaffold(registryDir, { projectName: "Idearium" });
  const claude = s.find((f) => f.path.endsWith("claude.yml") && !f.path.includes("review"))!;
  assert.doesNotMatch(claude.content, /Idearium/);
  assert.match(claude.content, /workflow_dispatch/);
});

test("cada workflow del scaffold es YAML válido y tiene jobs", () => {
  const s = buildScaffold(registryDir, { projectName: "Demo" });
  for (const f of s) {
    const doc = yaml.load(f.content) as Record<string, unknown>;
    assert.ok(doc && typeof doc === "object", `${f.path} no parseó a objeto`);
    assert.ok("jobs" in doc, `${f.path} no tiene jobs`);
  }
});

test("claude-review dispara en pull_request y usa el veredicto REQUEST_CHANGES", () => {
  const s = buildScaffold(registryDir, { projectName: "Demo" });
  const review = s.find((f) => f.path.endsWith("claude-review.yml"))!;
  assert.match(review.content, /on:\s*\n\s*pull_request:/);
  assert.match(review.content, /REQUEST_CHANGES/);
  assert.match(review.content, /CLAUDE_CODE_OAUTH_TOKEN/);   // mismo secret que claude.yml
  assert.match(review.content, /allowed_bots:\s*"\*"/);       // revisa PRs de bots (claude/copilot)
});

test("suite-integrity falla si baja el conteo de tests (contiene el guard determinista)", () => {
  const s = buildScaffold(registryDir, { projectName: "Demo" });
  const si = s.find((f) => f.path.endsWith("suite-integrity.yml"))!;
  assert.match(si.content, /head_count.*-lt.*base_count|head_count" -lt "base_count/);
  assert.match(si.content, /exit 1/);
});

test("buildScaffold con registryDir inexistente → vacío (defensivo, no rompe)", () => {
  assert.deepEqual(buildScaffold("/no/such/dir", { projectName: "x" }), []);
});
