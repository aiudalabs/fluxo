import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { buildScaffold, substitute, leftoverVars, type ScaffoldVars } from "./scaffold.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry"); // design/src → fluxo/registry

// Vars como las arma el handoff para el stack de MiSalon (react-supabase). design_tokens/path_map_*/
// validation_commands quedan sin resolver a propósito (aún no hay generador de pre-render).
const VARS: ScaffoldVars = {
  project_name: "Idearium", stack: "react-supabase", language: "es",
  lanes: "- backend\n- frontend", art_director: "on",
};

// ── substitute ────────────────────────────────────────────────────────────────
test("substitute reemplaza {{project_name}} y NO toca ${{ ... }} de GitHub Actions", () => {
  const out = substitute("gate for {{project_name}} — ${{ secrets.X }} — {{project_name}}", VARS);
  assert.equal(out, "gate for Idearium — ${{ secrets.X }} — Idearium");
});

test("substitute deja intacta una var sin valor (para que el guard la cace)", () => {
  const out = substitute("tokens: {{design_tokens}}", VARS);
  assert.match(out, /\{\{design_tokens\}\}/);
  assert.deepEqual(leftoverVars(out), ["design_tokens"]);
});

// ── buildScaffold contra el registry real ───────────────────────────────────────
test("buildScaffold (react-supabase) emite el HARNESS DE VERIFY completo", () => {
  const { files } = buildScaffold(registryDir, VARS);
  const paths = new Set(files.map((f) => f.path));
  for (const must of [
    ".github/workflows/claude.yml",
    ".github/workflows/claude-review.yml",
    ".github/workflows/suite-integrity.yml",
    ".github/workflows/e2e-verify.yml",
    ".github/workflows/provisioning-lint.yml",
    ".github/workflows/ui-verify.yml",
    ".github/workflows/test-verify.yml",
    ".fluxo/verify/e2e_verify.py",
    ".fluxo/verify/provisioning_lint.py",
    ".fluxo/verify/stack.verify.yaml",
    ".fluxo/verify/provisioning.rules.yaml",
  ]) assert.ok(paths.has(must), `falta ${must} en el scaffold`);
});

test("NINGÚN archivo emitido conserva una var {{...}} sin resolver", () => {
  const { files } = buildScaffold(registryDir, VARS);
  for (const f of files) assert.deepEqual(leftoverVars(f.content), [], `${f.path} tiene vars sin resolver`);
});

test("los archivos con vars sin generador (AGENTS/CLAUDE/frontend.instructions) se SALTAN, no se emiten a medias", () => {
  const { files, skipped } = buildScaffold(registryDir, VARS);
  const emitted = new Set(files.map((f) => f.path));
  const skips = new Set(skipped.map((s) => s.path));
  for (const p of ["AGENTS.md", "CLAUDE.md", ".github/instructions/frontend.instructions.md"]) {
    assert.ok(!emitted.has(p), `${p} NO debería emitirse (tiene vars sin resolver)`);
    assert.ok(skips.has(p), `${p} debería estar en skipped`);
  }
  // el skip reporta QUÉ var falta (para el follow-up del generador)
  const agents = skipped.find((s) => s.path === "AGENTS.md")!;
  assert.ok(agents.missing.includes("path_map_backend"));
});

test("e2e-verify y provisioning-lint son BLOQUEANTES (sin continue-on-error) — cierra L-AUTO-3", () => {
  const { files } = buildScaffold(registryDir, VARS);
  for (const p of [".github/workflows/e2e-verify.yml", ".github/workflows/provisioning-lint.yml", ".github/workflows/test-verify.yml"]) {
    const wf = files.find((f) => f.path === p)!;
    assert.doesNotMatch(wf.content, /continue-on-error:\s*true/, `${p} sigue siendo continue-on-error`);
  }
});

test("claude-review.yml queda SUSTITUIDO (nombre presente, sin placeholder)", () => {
  const { files } = buildScaffold(registryDir, VARS);
  const review = files.find((f) => f.path.endsWith("claude-review.yml"))!;
  assert.match(review.content, /Idearium/);
  assert.deepEqual(leftoverVars(review.content), []);
});

test("cada workflow del scaffold es YAML válido y tiene jobs", () => {
  const { files } = buildScaffold(registryDir, VARS);
  for (const f of files.filter((x) => x.path.startsWith(".github/workflows/"))) {
    const doc = yaml.load(f.content) as Record<string, unknown>;
    assert.ok(doc && typeof doc === "object", `${f.path} no parseó a objeto`);
    assert.ok("jobs" in doc, `${f.path} no tiene jobs`);
  }
});

test("sin stack → solo _common (sin ui-verify ni .fluxo del stack)", () => {
  const { files } = buildScaffold(registryDir, { project_name: "Demo" });
  const paths = new Set(files.map((f) => f.path));
  assert.ok(paths.has(".github/workflows/e2e-verify.yml"), "_common debe estar");
  assert.ok(!paths.has(".github/workflows/ui-verify.yml"), "ui-verify es per-stack, no debería estar sin stack");
});
