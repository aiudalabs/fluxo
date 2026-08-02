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

// ── FASE 3b: forma de `lanes` = { rol: { agent, platform? } }. `platform` (mobile|web) es PER-LANE
// (propiedad de la SUPERFICIE, no del stack): un stack multi-superficie —app Flutter mobile + admin
// React web— framea cada superficie correctamente. Solo las lanes de FRONTEND llevan platform; las de
// BACKEND no (no tienen UI). El sets cerrados de platform/backend que fijan el contrato.
const PLATFORMS = ["mobile", "web"];
const BACKENDS = ["firebase", "supabase", "fastapi"];

type LaneCfg = { agent?: string; platform?: string };
const lanesOf = (id: string): Record<string, LaneCfg> =>
  (yaml.load(readFileSync(join(registryDir, "stacks", `${id}.yaml`), "utf8")) as { lanes?: Record<string, LaneCfg> }).lanes ?? {};

// ── consistencia lanes↔agentes (docs/18 §9 pto3 / §10 pto4): el mapeo `lanes:` de cada stack
// manifest es la FUENTE DE VERDAD del ruteo de owner + del encuadre por superficie. Cada lane es un
// objeto `{ agent, platform? }`; su `agent` debe (a) EXISTIR en el catálogo (.md + .yaml) y (b) estar
// tagueado con ESE stack (artifactStacks incluye el stack, salvo core compartido ["*"]). Su `platform`,
// cuando está presente (lane de frontend), debe ∈ {mobile,web}. Caza el drift: una lane a un agente
// inexistente/mal-tagueado, o un platform inválido.
test("stacks.lanes: cada lane {agent,platform?} — agent existe+tagueado, platform (si hay) es válido", () => {
  const agentFiles = readdirSync(join(registryDir, "agents"));
  const stackFiles = readdirSync(join(registryDir, "stacks")).filter((n) => /\.ya?ml$/.test(n));
  let lanesSeen = 0;
  let frontendLanesSeen = 0;
  for (const f of stackFiles) {
    const doc = yaml.load(readFileSync(join(registryDir, "stacks", f), "utf8")) as
      | { id?: string; lanes?: Record<string, LaneCfg> }
      | null;
    if (!doc?.lanes) continue;
    const stackId = doc.id ? String(doc.id) : "";
    for (const [lane, cfgRaw] of Object.entries(doc.lanes)) {
      lanesSeen++;
      // La lane es un objeto { agent, platform? } — NO ya un string (Fase 3b cambia el schema).
      assert.ok(
        cfgRaw && typeof cfgRaw === "object" && !Array.isArray(cfgRaw),
        `${stackId}.lanes.${lane}: esperaba un objeto { agent, platform? }, vi ${JSON.stringify(cfgRaw)}`,
      );
      const agent = String(cfgRaw.agent);
      assert.ok(cfgRaw.agent, `${stackId}.lanes.${lane}: falta el campo agent`);
      assert.ok(agentFiles.includes(`${agent}.md`), `${stackId}.lanes.${lane} → ${agent}: falta ${agent}.md en el catálogo`);
      assert.ok(agentFiles.includes(`${agent}.yaml`), `${stackId}.lanes.${lane} → ${agent}: falta ${agent}.yaml en el catálogo`);
      const tags = artifactStacks(readFileSync(join(registryDir, "agents", `${agent}.yaml`), "utf8"));
      assert.ok(
        tags.includes("*") || tags.includes(stackId),
        `${stackId}.lanes.${lane} → ${agent}: tagueado ${JSON.stringify(tags)}, no incluye «${stackId}» (ni es core ["*"])`,
      );
      // platform es una obligación SOLO de las lanes de frontend; cuando está, ∈ {mobile,web}.
      if (cfgRaw.platform !== undefined) {
        frontendLanesSeen++;
        assert.ok(
          PLATFORMS.includes(String(cfgRaw.platform)),
          `${stackId}.lanes.${lane}.platform inválido: «${cfgRaw.platform}» (∉ ${JSON.stringify(PLATFORMS)})`,
        );
      }
    }
  }
  // los 3 stacks reales declaran lanes (3 + 2 + 2 = 7) → el drift de "manifest sin lanes" también se caza.
  assert.ok(lanesSeen >= 7, `esperaba ≥7 lanes declaradas en los manifests, vi ${lanesSeen}`);
  // cada stack tiene al menos una superficie de frontend con platform (mobile≥1 + web≥3 = ≥4).
  assert.ok(frontendLanesSeen >= 4, `esperaba ≥4 lanes de frontend con platform, vi ${frontendLanesSeen}`);
});

// El seam cerrado, explícito, con la forma per-lane: el frontend WEB rutea a react-web-dev con
// platform:web; la lane admin de flutter-firebase (react-dev) es platform:web (browser, NO teléfono —
// el bug que Fase 3b arregla); la app móvil es platform:mobile; las lanes de backend NO llevan platform.
test("stacks.lanes: el mapeo exacto por stack — agent + platform por superficie", () => {
  assert.deepEqual(lanesOf("aiuda-flutter-firebase"), {
    mobile: { agent: "flutter-dev", platform: "mobile" },
    backend: { agent: "firebase-dev" },
    admin: { agent: "react-dev", platform: "web" },
  });
  assert.deepEqual(lanesOf("react-supabase"), {
    web: { agent: "react-web-dev", platform: "web" },
    backend: { agent: "supabase-dev" },
  });
  assert.deepEqual(lanesOf("python-fastapi-react"), {
    backend: { agent: "python-dev" },
    web: { agent: "react-web-dev", platform: "web" },
  });
});

// ── backend a nivel STACK (un paradigma de datos por stack) — el data-modeler lo lee. platform YA NO
// vive a nivel stack (es per-lane, arriba). Estos tests fijan el contrato: cada stack declara SOLO
// backend∈{firebase,supabase,fastapi} arriba, y NO un platform a nivel stack.
test("stacks.backend: los valores esperados por stack, y platform NO vive a nivel stack", () => {
  const metaOf = (id: string) =>
    yaml.load(readFileSync(join(registryDir, "stacks", `${id}.yaml`), "utf8")) as { platform?: string; backend?: string };
  const expected: Record<string, string> = {
    "aiuda-flutter-firebase": "firebase",
    "react-supabase": "supabase",
    "python-fastapi-react": "fastapi",
  };
  for (const [id, wantBackend] of Object.entries(expected)) {
    const doc = metaOf(id);
    assert.equal(doc.backend, wantBackend, `${id}.backend esperado «${wantBackend}», vi «${doc.backend}»`);
    assert.equal(doc.platform, undefined, `${id}.platform NO debe existir a nivel stack (es per-lane), vi «${doc.platform}»`);
  }
});

// Contrato para TODO manifest (caza el drift de un stack nuevo mal formado): cada manifest con id
// declara backend∈{firebase,supabase,fastapi} a nivel stack, NO declara platform a nivel stack, y tiene
// al menos una lane de FRONTEND con platform∈{mobile,web}. Espeja el patrón de `lanesSeen >= 7`.
test("stacks.shape: todo manifest declara backend a nivel stack, sin platform de stack, con ≥1 lane frontend", () => {
  const stackFiles = readdirSync(join(registryDir, "stacks")).filter((n) => /\.ya?ml$/.test(n));
  let seen = 0;
  for (const f of stackFiles) {
    const doc = yaml.load(readFileSync(join(registryDir, "stacks", f), "utf8")) as
      | { id?: string; platform?: string; backend?: string; lanes?: Record<string, LaneCfg> }
      | null;
    if (!doc?.id) continue;
    seen++;
    assert.ok(BACKENDS.includes(String(doc.backend)), `${doc.id}.backend inválido: «${doc.backend}» (∉ ${JSON.stringify(BACKENDS)})`);
    assert.equal(doc.platform, undefined, `${doc.id}.platform NO debe vivir a nivel stack (es per-lane), vi «${doc.platform}»`);
    const frontendLanes = Object.values(doc.lanes ?? {}).filter((c) => c && c.platform !== undefined);
    assert.ok(frontendLanes.length >= 1, `${doc.id}: esperaba ≥1 lane de frontend con platform, vi ${frontendLanes.length}`);
    for (const c of frontendLanes) {
      assert.ok(PLATFORMS.includes(String(c.platform)), `${doc.id}: lane de frontend con platform inválido «${c.platform}»`);
    }
  }
  assert.ok(seen >= 3, `esperaba ≥3 manifests, vi ${seen}`);
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
