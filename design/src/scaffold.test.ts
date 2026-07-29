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

// Vars para un proyecto del stack aiuda-flutter-firebase. app_path resuelto (la app primaria) — lo usan
// build-apk / ui-verify / deploy; los demás (path_map_*, design_tokens…) quedan sin generador y saltean.
const FLUTTER_VARS: ScaffoldVars = {
  project_name: "MiSalon", stack: "aiuda-flutter-firebase", language: "es",
  lanes: "- flutter\n- firebase", art_director: "on", app_path: "apps/customer",
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

test("buildScaffold (react-supabase) emite deploy.yml (última milla, P3) con workflow_dispatch", () => {
  const { files } = buildScaffold(registryDir, VARS);
  const dep = files.find((f) => f.path === ".github/workflows/deploy.yml");
  assert.ok(dep, "falta deploy.yml en el scaffold");
  assert.match(dep!.content, /workflow_dispatch/);
  const doc = yaml.load(dep!.content) as Record<string, unknown>;
  assert.ok("jobs" in doc, "deploy.yml sin jobs");
});

test("buildScaffold (aiuda-flutter-firebase) emite deploy.yml (Deploy A1) — Flutter-web → Firebase Hosting, preview+prod, skip-clean BYO", () => {
  const { files } = buildScaffold(registryDir, FLUTTER_VARS);
  const dep = files.find((f) => f.path === ".github/workflows/deploy.yml");
  assert.ok(dep, "falta deploy.yml en el scaffold del stack Flutter");
  const c = dep!.content;
  // Disparo manual + los dos modos declarativos (como react-supabase).
  assert.match(c, /workflow_dispatch/);
  assert.match(c, /options:\s*\[preview,\s*prod\]/);
  // Compila Flutter-web del app primario y publica a Firebase Hosting.
  assert.match(c, /flutter build web/);
  assert.match(c, /hosting:channel:deploy/);        // preview → URL temporal
  assert.match(c, /firebase deploy --only hosting/); // prod
  // BYO skip-clean: el tramo se salta sin el secret de la capability (aditivo, no rompe).
  assert.match(c, /FIREBASE_SERVICE_ACCOUNT/);
  assert.match(c, /on=false/);
  // app_path resuelto (no quedó ninguna var sin resolver) + YAML válido con jobs.
  assert.deepEqual(leftoverVars(c), [], "deploy.yml del stack Flutter tiene vars sin resolver");
  const doc = yaml.load(c) as Record<string, unknown>;
  assert.ok("jobs" in doc, "deploy.yml (Flutter) sin jobs");
});

test("buildScaffold (aiuda-flutter-firebase) emite device-verify.yml (Deploy A2) — Firebase Test Lab verify, manual, skip-clean BYO", () => {
  const { files } = buildScaffold(registryDir, FLUTTER_VARS);
  const dev = files.find((f) => f.path === ".github/workflows/device-verify.yml");
  assert.ok(dev, "falta device-verify.yml en el scaffold del stack Flutter");
  const c = dev!.content;
  // Disparo MANUAL: Test Lab corre sobre el Firebase del cliente (cuesta plata) → deliberado, no on-PR.
  assert.match(c, /workflow_dispatch/);
  // Compila los integration tests a APK y los corre en Firebase Test Lab (device farm de Google).
  assert.match(c, /integration_test/);
  assert.match(c, /assembleAndroidTest/);
  assert.match(c, /gcloud firebase test android run/);
  assert.match(c, /--type instrumentation/);
  // BYO skip-clean: el tramo se salta sin el secret umbrella de la capability (aditivo, no rompe).
  assert.match(c, /FIREBASE_SERVICE_ACCOUNT/);
  assert.match(c, /on=false/);
  // app_path resuelto (ninguna var sin resolver) + YAML válido con jobs.
  assert.deepEqual(leftoverVars(c), [], "device-verify.yml del stack Flutter tiene vars sin resolver");
  const doc = yaml.load(c) as Record<string, unknown>;
  assert.ok("jobs" in doc, "device-verify.yml (Flutter) sin jobs");
});

test("buildScaffold (aiuda-flutter-firebase) — build-apk.yml usa el secret UMBRELLA FIREBASE_SERVICE_ACCOUNT (no el _JSON legacy)", () => {
  const { files } = buildScaffold(registryDir, FLUTTER_VARS);
  const apk = files.find((f) => f.path === ".github/workflows/build-apk.yml");
  assert.ok(apk, "falta build-apk.yml en el scaffold del stack Flutter");
  const c = apk!.content;
  // Un solo nombre de secret de SA en todo el stack (capability + deploy A1 + device-verify A2 + build-apk).
  assert.match(c, /secrets\.FIREBASE_SERVICE_ACCOUNT\b/, "build-apk debe usar el secret umbrella");
  assert.doesNotMatch(c, /FIREBASE_SERVICE_ACCOUNT_JSON/, "build-apk no debe usar el nombre legacy _JSON");
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

// El gate visual GENÉRICO vive en _common (BYO-compose): CUALQUIER proyecto — incluso sin stack o
// con un stack sin template — recibe ui-verify. Único {{var}} = {{project_name}} (siempre resoluble),
// así nunca queda sin resolver. El kill-switch es data (.fluxo/screen-routes.json.art_director).
test("sin stack → _common trae el ui-verify GENÉRICO (no queda sin gate)", () => {
  const { files } = buildScaffold(registryDir, { project_name: "Demo" });
  const paths = new Set(files.map((f) => f.path));
  assert.ok(paths.has(".github/workflows/e2e-verify.yml"), "_common debe estar");
  assert.ok(paths.has(".github/workflows/ui-verify.yml"), "el ui-verify genérico de _common debe emitirse aun sin stack");
});

// Fail-loud (2026-07-29): un stack declarado que NO existe como template degradaba a `_common` en
// SILENCIO (sin ui-verify ni persona de frontend). Ahora se surface-a en el result.
test("buildScaffold: stack inexistente → unknownStack + availableStacks (no silencio); stack real → null", () => {
  const bad = buildScaffold(registryDir, { project_name: "Demo", stack: "nextjs-postgres-prisma-docker" });
  assert.equal(bad.unknownStack, "nextjs-postgres-prisma-docker", "el stack sin template debe surface-arse");
  assert.ok(bad.availableStacks.includes("react-supabase"), "debe listar los stacks reales para corregir");
  // Antes: un stack desconocido degradaba a _common SIN ui-verify. Ahora _common trae el gate genérico
  // → el proyecto degradado IGUAL recibe ui-verify (el hueco que reabría cada stack nuevo queda cerrado).
  assert.ok(new Set(bad.files.map((f) => f.path)).has(".github/workflows/ui-verify.yml"), "el ui-verify genérico de _common cubre el stack desconocido");
  const ok = buildScaffold(registryDir, VARS); // VARS.stack = react-supabase (real)
  assert.equal(ok.unknownStack, null, "un stack real no debe marcar unknownStack");
});
