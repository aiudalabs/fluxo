// El stack como CONCEPTO DE PRIMERA CLASE: tests del kernel puro que la API de registry (console)
// y el fail-loud del scaffold consumen. (a) listStacks/artifactStacks = lo que /api/registry devuelve
// (stacks + `stacks` por artefacto); (b) un stack fuera de registry/stacks/*.yaml → fail-loud.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { listStacks, knownStackIds, artifactStacks } from "./capabilities.ts";
import { buildScaffold } from "./scaffold.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry"); // design/src → fluxo/registry

// ── listStacks: los 3 stacks reales, con label + description (data para la UI) ──────────────────
test("listStacks devuelve los 3 stacks reales con label + description no vacíos", () => {
  const stacks = listStacks(registryDir);
  const ids = stacks.map((s) => s.id);
  for (const must of ["aiuda-flutter-firebase", "react-supabase", "python-fastapi-react"]) {
    assert.ok(ids.includes(must), `falta el stack ${must}`);
  }
  for (const s of stacks) {
    assert.ok(s.label.trim().length > 0, `${s.id} sin label`);
    assert.ok(s.description.trim().length > 0, `${s.id} sin description`);
  }
  // label/description concretos del stack Flutter (español criollo).
  const flutter = stacks.find((s) => s.id === "aiuda-flutter-firebase")!;
  assert.equal(flutter.label, "Flutter + Firebase");
  assert.match(flutter.description, /Firebase/);
  // capabilities del stack se transportan (firebase para el stack Flutter).
  assert.deepEqual(flutter.capabilities, ["firebase"]);
});

// ── artifactStacks: el tag `stacks` por artefacto (default ["*"] = COMPARTIDO) ───────────────────
test("artifactStacks: un agent -dev stack-específico declara su stack; uno sin campo es compartido", () => {
  const flutterDev = readFileSync(join(registryDir, "agents", "flutter-dev.yaml"), "utf8");
  assert.deepEqual(artifactStacks(flutterDev), ["aiuda-flutter-firebase"]);

  // react-dev es el admin dashboard Firebase-integrated → SOLO el stack Flutter+Firebase.
  const reactDev = readFileSync(join(registryDir, "agents", "react-dev.yaml"), "utf8");
  assert.deepEqual(artifactStacks(reactDev), ["aiuda-flutter-firebase"]);

  // analyst no lleva `stacks:` → COMPARTIDO (["*"]).
  const analyst = readFileSync(join(registryDir, "agents", "analyst.yaml"), "utf8");
  assert.deepEqual(artifactStacks(analyst), ["*"]);
});

// ── arreglos de base (docs/18 §9): los agentes/lanes de las web-stacks dejan de estar rotos ──────
// supabase-dev EXISTE y es dueño del backend Supabase; react-web-dev es el frontend web GENÉRICO
// (react-supabase + python); react-dev queda SOLO como admin Firebase.
test("base-agents: supabase-dev / react-web-dev existen y están tagueados al stack correcto", () => {
  const supabaseDev = readFileSync(join(registryDir, "agents", "supabase-dev.yaml"), "utf8");
  assert.deepEqual(artifactStacks(supabaseDev), ["react-supabase"]);

  const reactWebDev = readFileSync(join(registryDir, "agents", "react-web-dev.yaml"), "utf8");
  assert.deepEqual(artifactStacks(reactWebDev), ["react-supabase", "python-fastapi-react"]);

  const reactDev = readFileSync(join(registryDir, "agents", "react-dev.yaml"), "utf8");
  assert.deepEqual(artifactStacks(reactDev), ["aiuda-flutter-firebase"]);
});

test("base-agents: el catálogo del registry incluye supabase-dev y react-web-dev (con .md + .yaml)", () => {
  const files = readdirSync(join(registryDir, "agents"));
  for (const id of ["supabase-dev", "react-web-dev"]) {
    assert.ok(files.includes(`${id}.md`), `falta ${id}.md en el catálogo del registry`);
    assert.ok(files.includes(`${id}.yaml`), `falta ${id}.yaml en el catálogo del registry`);
  }
});

// ── consistencia lanes↔agentes (docs/18 §9 pto3 / §10 pto4): el mapeo `lanes:` de cada stack
// manifest es la FUENTE DE VERDAD del ruteo de owner. Cada agente que una lane nombra debe (a)
// EXISTIR en el catálogo (.md + .yaml) y (b) estar tagueado con ESE stack (artifactStacks incluye
// el stack, salvo core compartido ["*"]). Caza el drift: una lane a un agente inexistente o
// mal-tagueado (ej. el seam react-dev/react-web-dev que la Fase 2 cierra).
test("stacks.lanes: cada agente referenciado existe y está tagueado con su stack", () => {
  const agentFiles = readdirSync(join(registryDir, "agents"));
  const stackFiles = readdirSync(join(registryDir, "stacks")).filter((n) => /\.ya?ml$/.test(n));
  let lanesSeen = 0;
  for (const f of stackFiles) {
    const doc = yaml.load(readFileSync(join(registryDir, "stacks", f), "utf8")) as
      | { id?: string; lanes?: Record<string, unknown> }
      | null;
    if (!doc?.lanes) continue;
    const stackId = doc.id ? String(doc.id) : "";
    for (const [lane, agentRaw] of Object.entries(doc.lanes)) {
      const agent = String(agentRaw);
      lanesSeen++;
      assert.ok(agentFiles.includes(`${agent}.md`), `${stackId}.lanes.${lane} → ${agent}: falta ${agent}.md en el catálogo`);
      assert.ok(agentFiles.includes(`${agent}.yaml`), `${stackId}.lanes.${lane} → ${agent}: falta ${agent}.yaml en el catálogo`);
      const tags = artifactStacks(readFileSync(join(registryDir, "agents", `${agent}.yaml`), "utf8"));
      assert.ok(
        tags.includes("*") || tags.includes(stackId),
        `${stackId}.lanes.${lane} → ${agent}: tagueado ${JSON.stringify(tags)}, no incluye «${stackId}» (ni es core ["*"])`,
      );
    }
  }
  // los 3 stacks reales declaran lanes (3 + 2 + 2 = 7) → el drift de "manifest sin lanes" también se caza.
  assert.ok(lanesSeen >= 7, `esperaba ≥7 lanes declaradas en los manifests, vi ${lanesSeen}`);
});

// El seam cerrado, explícito: el frontend WEB rutea a react-web-dev; react-dev queda SOLO como la
// lane admin (Firebase) de aiuda-flutter-firebase; el backend Supabase a supabase-dev.
test("stacks.lanes: el mapeo exacto por stack (web→react-web-dev, admin→react-dev, backend correcto)", () => {
  const lanesOf = (id: string) =>
    (yaml.load(readFileSync(join(registryDir, "stacks", `${id}.yaml`), "utf8")) as { lanes?: Record<string, string> }).lanes;
  assert.deepEqual(lanesOf("aiuda-flutter-firebase"), { mobile: "flutter-dev", backend: "firebase-dev", admin: "react-dev" });
  assert.deepEqual(lanesOf("react-supabase"), { web: "react-web-dev", backend: "supabase-dev" });
  assert.deepEqual(lanesOf("python-fastapi-react"), { backend: "python-dev", web: "react-web-dev" });
});

test("artifactStacks: contenido nulo/sin stacks/`stacks: []` → COMPARTIDO ['*']", () => {
  assert.deepEqual(artifactStacks(null), ["*"]);
  assert.deepEqual(artifactStacks("id: x\nversion: 1"), ["*"]);
  assert.deepEqual(artifactStacks("stacks: []"), ["*"]);
  assert.deepEqual(artifactStacks("stacks: [react-supabase]"), ["react-supabase"]);
});

// ── fail-loud: la AUTORIDAD del "stack real" es registry/stacks/*.yaml, no el dir de template ─────
test("buildScaffold: availableStacks = los ids de registry/stacks (no el dir de template)", () => {
  const { availableStacks } = buildScaffold(registryDir, { project_name: "Demo", stack: "react-supabase" });
  assert.deepEqual(availableStacks, knownStackIds(registryDir).sort());
  for (const must of ["aiuda-flutter-firebase", "react-supabase", "python-fastapi-react"]) {
    assert.ok(availableStacks.includes(must), `availableStacks debe incluir ${must}`);
  }
});

test("buildScaffold: un stack que NO está en registry/stacks/*.yaml → unknownStack (fail-loud, no silencio)", () => {
  const bad = buildScaffold(registryDir, { project_name: "Demo", stack: "django-htmx-postgres" });
  assert.equal(bad.unknownStack, "django-htmx-postgres", "un stack inexistente debe surface-arse (el handoff lo appendea al brain)");
  // los 3 stacks reales NO marcan unknownStack.
  for (const real of ["aiuda-flutter-firebase", "react-supabase", "python-fastapi-react"]) {
    assert.equal(buildScaffold(registryDir, { project_name: "Demo", stack: real }).unknownStack, null, `${real} es real → unknownStack null`);
  }
});
