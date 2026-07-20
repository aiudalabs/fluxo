import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planRepoDocs, parseScreenIds, MAX_DOC_BYTES } from "./repodocs.ts";
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

// ── P8-B · cobertura de UI: pantalla de UI_SCREENS.md sin story ni out_of_scope ──
// Fixture con la FORMA real de un UI_SCREENS.md (secciones de tokens/nav/componentes/
// flujos que NO son pantallas + una sección de pantallas con headers `<ID> — <título>`).
// Reproduce el caso MiSalon (panel del dueño S.6–S.14 comprimido fuera del backlog).
const UI_SCREENS_FIXTURE = `# UI Screens — Demo

## 1. Navigation Graph
\`\`\`
P.1  /directorio → S.5  /panel/calendar
\`\`\`

## 2. Design Tokens
### 2.1 Color
### 2.2 Typography

## 3. Inventario de Componentes
### C-01 Button

## 4. Screens

### P.1 — Directorio Público
**Ruta:** /directorio

### S.5 — Calendario de Citas
**Ruta:** /panel/calendar

### S.11 — Gestión de Prestadores
**Ruta:** /panel/providers

### S.14 — QR y Link
**Ruta:** /panel/qr

### A.2 — Dashboard de Métricas
**Ruta:** /admin/dashboard

## 5. User Flows
### Flujo A — reserva
`;

test("parseScreenIds extrae solo los headers de pantalla, ignorando tokens/componentes/flujos", () => {
  const ids = parseScreenIds(UI_SCREENS_FIXTURE);
  assert.deepEqual(ids, ["P.1", "S.5", "S.11", "S.14", "A.2"]);
});

test("parseScreenIds sobre doc sin sección de pantallas devuelve vacío (degrada con gracia)", () => {
  assert.deepEqual(parseScreenIds("# Solo tokens\n\n## Design Tokens\n### 2.1 Color\n"), []);
});

test("planRepoDocs reporta pantallas de UI_SCREENS.md sin story ni out_of_scope", () => {
  // El backlog cubre P.1, S.5, A.2; marca S.14 out_of_scope; OMITE S.11 (el bug MiSalon).
  const backlog = `epic: { id: E1, title: Demo }
stories:
  - id: S1-01
    title: Directorio
coverage:
  - screen: "P.1"
    story: S1-01
  - screen: "S.5"
    story: S1-01
  - screen: "A.2"
    story: S1-01
out_of_scope:
  - screen: "S.14"
    reason: "QR diferido a v1.1"
`;
  const wd = makeWorkdir({ "docs/UI_SCREENS.md": UI_SCREENS_FIXTURE, "docs/backlog.yaml": backlog });
  const plan = planRepoDocs(wd, [], []);
  // Solo S.11 queda sin story ni marca: es la pantalla silenciosamente dropeada.
  assert.deepEqual(plan.uncoveredScreens, ["S.11"]);
});

test("planRepoDocs: backlog SIN matriz de cobertura reporta TODAS las pantallas (caso MiSalon)", () => {
  // Un backlog viejo (sin coverage/out_of_scope) contra un UI_SCREENS con pantallas: el check
  // demuestra que HABRÍA cachado el panel del dueño (S.11/S.14) que nunca tuvo story.
  const wd = makeWorkdir({ "docs/UI_SCREENS.md": UI_SCREENS_FIXTURE, "docs/backlog.yaml": "stories: []\n" });
  const plan = planRepoDocs(wd, [], []);
  assert.deepEqual(plan.uncoveredScreens, ["P.1", "S.5", "S.11", "S.14", "A.2"]);
});

test("planRepoDocs sin UI_SCREENS.md no reporta pantallas (degrada con gracia)", () => {
  const wd = makeWorkdir({ "docs/PRD.md": "p", "docs/backlog.yaml": "stories: []\n" });
  const plan = planRepoDocs(wd, [], []);
  assert.deepEqual(plan.uncoveredScreens, []);
});

test("planRepoDocs: toda pantalla cubierta o out_of_scope ⇒ nada reportado", () => {
  const backlog = `stories: []
coverage:
  - screen: "P.1"
    story: S1-01
  - screen: "S.5"
    story: S1-01
  - screen: "S.11"
    story: S1-02
  - screen: "A.2"
    story: S1-03
out_of_scope:
  - screen: "S.14"
    reason: "diferido"
`;
  const wd = makeWorkdir({ "docs/UI_SCREENS.md": UI_SCREENS_FIXTURE, "docs/backlog.yaml": backlog });
  const plan = planRepoDocs(wd, [], []);
  assert.deepEqual(plan.uncoveredScreens, []);
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
