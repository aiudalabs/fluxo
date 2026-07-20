import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planRepoDocs, MAX_DOC_BYTES } from "./repodocs.ts";
import { loadWorkflow, declaredOutputs } from "./workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry");

// Workdir de fixture con la forma real post-run: docs planos + mockups anidados.
function makeWorkdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repodocs-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// ── el contrato central: TODO lo que hay bajo docs/** entra, recursivo ──────────
test("planRepoDocs incluye todo docs/** recursivo — mockups y subdirectorios nuevos incluidos", () => {
  const wd = makeWorkdir({
    "docs/BRIEF.md": "b",
    "docs/backlog.yaml": "stories: []",
    "docs/mockups/index.html": "<html/>",
    "docs/mockups/owner.calendar.html": "<html/>",
    "docs/increments/2026-07/DELTA.md": "delta", // doc de un incremento futuro: entra sin tocar código
    "notes.txt": "fuera de docs/ — no va",
  });
  const plan = planRepoDocs(wd, [], []);
  assert.deepEqual(plan.files, [
    "docs/BRIEF.md",
    "docs/backlog.yaml",
    "docs/increments/2026-07/DELTA.md",
    "docs/mockups/index.html",
    "docs/mockups/owner.calendar.html",
  ]);
  assert.deepEqual(plan.excluded, []);
});

test("planRepoDocs con workdir sin docs/ devuelve plan vacío y reporta los declarados", () => {
  const wd = makeWorkdir({});
  const plan = planRepoDocs(wd, ["docs/PRD.md"], []);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.missingDeclared, ["docs/PRD.md"]);
});

// ── exclusión: mínima, SIEMPRE reportada (falla hacia lo visible) ───────────────
test("planRepoDocs excluye dotfiles y oversize CON motivo, nunca en silencio", () => {
  const wd = makeWorkdir({
    "docs/PRD.md": "ok",
    "docs/.DS_Store": "junk",
    "docs/gigante.bin": "x".repeat(MAX_DOC_BYTES + 1),
  });
  const plan = planRepoDocs(wd, [], []);
  assert.deepEqual(plan.files, ["docs/PRD.md"]);
  assert.equal(plan.excluded.length, 2);
  const reasons = Object.fromEntries(plan.excluded.map((e) => [e.path, e.reason]));
  assert.equal(reasons["docs/.DS_Store"], "dotfile");
  assert.match(reasons["docs/gigante.bin"], /supera/);
});

// ── intención (workflow) vs realidad (workdir) ─────────────────────────────────
test("planRepoDocs reporta outputs declarados ausentes y calla cuando están", () => {
  const wd = makeWorkdir({ "docs/PRD.md": "p", "docs/mockups/index.html": "<html/>" });
  const plan = planRepoDocs(wd, ["docs/PRD.md", "docs/mockups/index.html", "docs/UI_SCREENS.md"], []);
  assert.deepEqual(plan.missingDeclared, ["docs/UI_SCREENS.md"]);
});

test("planRepoDocs ignora outputs declarados fuera de docs/ (no son del handoff)", () => {
  const wd = makeWorkdir({ "docs/PRD.md": "p" });
  const plan = planRepoDocs(wd, ["src/algo.ts"], []);
  assert.deepEqual(plan.missingDeclared, []);
});

// ── guard del art-director: story con screen_key ⇒ mockup presente ─────────────
test("planRepoDocs reporta stories con screen_key sin su mockup", () => {
  const wd = makeWorkdir({ "docs/mockups/owner.calendar.html": "<html/>" });
  const stories = [
    { key: "S4-18", screen_key: "owner.calendar", lane: "react-dev" }, // tiene mockup
    { key: "S2-08", screen_key: "owner.onboarding", lane: "react-dev" }, // NO tiene
    { key: "S1-01", screen_key: undefined, lane: "supabase-dev" }, // sin screen_key: no aplica
  ];
  const plan = planRepoDocs(wd, [], stories);
  assert.deepEqual(plan.missingMockups, [
    { story: "S2-08", screenKey: "owner.onboarding", path: "docs/mockups/owner.onboarding.html" },
  ]);
});

// ── declaredOutputs contra el registry REAL: el contract test que faltó al nacer ─
// Si mañana una fase nueva declara `output: docs/X`, este assert obliga a que el
// handoff la verifique — y el walk ya la commitea sin cambios de código.
test("declaredOutputs(design.yaml) incluye los docs conocidos Y el output de mockups", () => {
  const wf = loadWorkflow(registryDir, "design");
  const outs = declaredOutputs(wf);
  for (const expected of ["docs/BRIEF.md", "docs/PRD.md", "docs/UI_SCREENS.md", "docs/mockups/index.html", "docs/backlog.yaml"]) {
    assert.ok(outs.includes(expected), `falta ${expected} en ${outs.join(", ")}`);
  }
});
