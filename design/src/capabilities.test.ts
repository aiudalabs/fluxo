import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCapability,
  stackCapabilities,
  parseAccountCapabilities,
  resolveFrontierMarkers,
  parseStack,
  resolveProjectCapabilities,
  storyNeedsCapabilities,
  computeCapabilityGate,
  type ResolvedCapability,
} from "./capabilities.ts";
import { candidates, type DStory } from "./dispatch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry");

function makeWorkdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "caps-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// ── la capability firebase existe como DATA con markers de provisioning ─────────
test("loadCapability(firebase) trae la capability con markers de provisioning no vacíos", () => {
  const cap = loadCapability(registryDir, "firebase");
  assert.ok(cap, "registry/capabilities/firebase.yaml debe existir");
  assert.equal(cap!.id, "firebase");
  assert.ok((cap!.provisioning?.markers ?? []).length > 0, "firebase debe declarar markers de provisioning");
  assert.equal(cap!.emulator, true, "firebase permite build/test contra el emulador");
});

test("loadCapability de una id inexistente ⇒ null (degrada con gracia)", () => {
  assert.equal(loadCapability(registryDir, "no-existe"), null);
});

// ── el stack declara qué capabilities necesita ──────────────────────────────────
test("stackCapabilities(aiuda-flutter-firebase) incluye firebase", () => {
  assert.ok(stackCapabilities(registryDir, "aiuda-flutter-firebase").includes("firebase"));
});

test("stackCapabilities de un stack sin manifest ⇒ [] (degrada con gracia)", () => {
  assert.deepEqual(stackCapabilities(registryDir, "stack-inexistente"), []);
});

// ── parseAccountCapabilities: la grada 'accounts' del contrato de frontera ───────
test("parseAccountCapabilities lee los capability ids del bloque accounts", () => {
  const prov = "version: 1\nstack: aiuda-flutter-firebase\naccounts:\n  - capability: firebase\n    human: crear proyecto\n";
  assert.deepEqual(parseAccountCapabilities(prov), ["firebase"]);
});

test("parseAccountCapabilities sobre provisioning sin accounts ⇒ [] (proyecto viejo)", () => {
  assert.deepEqual(parseAccountCapabilities("version: 1\nstack: x\nroles: []\n"), []);
  assert.deepEqual(parseAccountCapabilities("{{{ malformado"), []);
});

// ── resolveFrontierMarkers: accounts ∪ stack-caps → markers desde el registry ────
test("resolveFrontierMarkers desde provisioning.yaml con accounts:firebase resuelve markers", () => {
  const wd = makeWorkdir({
    "docs/provisioning.yaml": "version: 1\nstack: aiuda-flutter-firebase\naccounts:\n  - capability: firebase\n",
  });
  const m = resolveFrontierMarkers(registryDir, wd);
  assert.ok(m.firebase && m.firebase.length > 0);
});

test("resolveFrontierMarkers resuelve por el stack aunque falte el bloque accounts (robustez)", () => {
  // Aun si el architect olvidó accounts, el stack declara firebase → el gate igual scannea.
  const wd = makeWorkdir({ "docs/provisioning.yaml": "version: 1\nstack: aiuda-flutter-firebase\nroles: []\n" });
  const m = resolveFrontierMarkers(registryDir, wd);
  assert.ok(m.firebase && m.firebase.length > 0);
});

test("resolveFrontierMarkers sin provisioning.yaml ⇒ {} (gate off, degrada con gracia)", () => {
  const wd = makeWorkdir({});
  assert.deepEqual(resolveFrontierMarkers(registryDir, wd), {});
});

// ── parseStack: la llave de resolución del stack ────────────────────────────────
test("parseStack lee el stack declarado; degrada a null si falta/malformado", () => {
  assert.equal(parseStack("version: 1\nstack: aiuda-flutter-firebase\n"), "aiuda-flutter-firebase");
  assert.equal(parseStack("version: 1\nroles: []\n"), null);
  assert.equal(parseStack("{{{ malformado"), null);
});

// ── resolveProjectCapabilities: la resolución self-serve contra el registry REAL ──
test("resolveProjectCapabilities(aiuda-flutter-firebase) resuelve firebase con su secret+guía", () => {
  const prov = "version: 1\nstack: aiuda-flutter-firebase\naccounts:\n  - capability: firebase\n";
  const caps = resolveProjectCapabilities(registryDir, prov);
  const fb = caps.find((c) => c.id === "firebase");
  assert.ok(fb, "debe resolver la capability firebase del stack");
  assert.equal(fb!.secret, "FIREBASE_SERVICE_ACCOUNT", "aporta el nombre del Actions secret BYO");
  assert.equal(fb!.name, "Firebase");
  assert.ok(fb!.summary && fb!.summary.length > 0, "aporta el summary de provisioning");
  assert.ok(fb!.guide && fb!.guide.startsWith("http"), "aporta el link guiado de provisioning");
});

test("resolveProjectCapabilities resuelve por el stack aunque falte accounts (robustez)", () => {
  const caps = resolveProjectCapabilities(registryDir, "version: 1\nstack: aiuda-flutter-firebase\n");
  assert.ok(caps.some((c) => c.id === "firebase"));
});

test("resolveProjectCapabilities no duplica cuando accounts y stack declaran la misma capability", () => {
  const prov = "version: 1\nstack: aiuda-flutter-firebase\naccounts:\n  - capability: firebase\n";
  const caps = resolveProjectCapabilities(registryDir, prov);
  assert.equal(caps.filter((c) => c.id === "firebase").length, 1);
});

test("resolveProjectCapabilities sin stack ni accounts ⇒ [] (proyecto sin provisioning)", () => {
  assert.deepEqual(resolveProjectCapabilities(registryDir, "version: 1\nroles: []\n"), []);
  assert.deepEqual(resolveProjectCapabilities(registryDir, "{{{ malformado"), []);
});

test("resolveProjectCapabilities saltea capabilities que no existen en el registry", () => {
  const prov = "version: 1\naccounts:\n  - capability: no-existe\n";
  assert.deepEqual(resolveProjectCapabilities(registryDir, prov), []);
});

// ── P6-2b · Paso 3 · storyNeedsCapabilities: qué capabilities REFERENCIA una story (por su secret) ─
const CAPS: ResolvedCapability[] = [
  { id: "firebase", name: "Firebase", secret: "FIREBASE_SERVICE_ACCOUNT" },
  { id: "stripe", name: "Stripe", secret: "STRIPE_SECRET_KEY" },
  { id: "emu-only", name: "Emu", secret: null }, // sin secret que sembrar → nunca gatea
];

test("storyNeedsCapabilities: story que referencia el secret en el body → necesita esa capability", () => {
  const s = { body: "Deploy a producción usando $FIREBASE_SERVICE_ACCOUNT del cliente.", acceptance: null };
  assert.deepEqual(storyNeedsCapabilities(CAPS, s), ["firebase"]);
});

test("storyNeedsCapabilities: la referencia también cuenta si está en la acceptance", () => {
  const s = { body: "Función de pago.", acceptance: "- El deploy inyecta STRIPE_SECRET_KEY como env" };
  assert.deepEqual(storyNeedsCapabilities(CAPS, s), ["stripe"]);
});

test("storyNeedsCapabilities: story de emulador (no referencia ningún secret) → [] (no gatea)", () => {
  const s = { body: "Construí la lógica y testeala contra el emulador de Firestore.", acceptance: "- tests verdes" };
  assert.deepEqual(storyNeedsCapabilities(CAPS, s), []);
});

test("storyNeedsCapabilities: match conservador (case-sensitive del nombre exacto del secret)", () => {
  // 'firebase' suelto NO gatea — solo el nombre EXACTO del secret (minimiza falsos positivos).
  const s = { body: "Configurá firebase y el firebase_service_account en minúsculas.", acceptance: null };
  assert.deepEqual(storyNeedsCapabilities(CAPS, s), []);
});

test("storyNeedsCapabilities: capability sin secret nunca se reporta (nada que sembrar)", () => {
  const s = { body: "usa emu-only y Emu por todos lados", acceptance: "emu-only" };
  assert.deepEqual(storyNeedsCapabilities(CAPS, s), []);
});

test("storyNeedsCapabilities: varias capabilities referenciadas → todas, en orden del registro", () => {
  const s = { body: "STRIPE_SECRET_KEY y FIREBASE_SERVICE_ACCOUNT", acceptance: null };
  assert.deepEqual(storyNeedsCapabilities(CAPS, s), ["firebase", "stripe"]);
});

// ── computeCapabilityGate: needsByStoryId + green set (probe inyectado, fail-open on doubt) ────────
test("computeCapabilityGate: arma needs por story + green solo de las NECESITADAS con secret presente", async () => {
  const stories = [
    { id: "a", body: "usa $FIREBASE_SERVICE_ACCOUNT", acceptance: null },
    { id: "b", body: "emulador nomás", acceptance: null },
  ];
  const probed: string[] = [];
  const gate = await computeCapabilityGate(CAPS, stories, async (name) => {
    probed.push(name);
    return name === "FIREBASE_SERVICE_ACCOUNT"; // presente
  });
  assert.deepEqual([...gate.needsByStoryId.entries()], [["a", ["firebase"]]]); // b no tiene needs
  assert.deepEqual([...gate.green], ["firebase"]);
  assert.deepEqual(probed, ["FIREBASE_SERVICE_ACCOUNT"]); // SOLO se probea lo referenciado (barato)
});

test("computeCapabilityGate: secret CONFIRMADO ausente (false) → NO verde (gatea)", async () => {
  const stories = [{ id: "a", body: "$FIREBASE_SERVICE_ACCOUNT", acceptance: null }];
  const gate = await computeCapabilityGate(CAPS, stories, async () => false); // 404 = ausente
  assert.equal(gate.green.has("firebase"), false);
});

test("computeCapabilityGate: probe INDETERMINADO (null) → fail-open, verde (no gatea ante la duda)", async () => {
  const stories = [{ id: "a", body: "$FIREBASE_SERVICE_ACCOUNT", acceptance: null }];
  const gate = await computeCapabilityGate(CAPS, stories, async () => null); // 403/red/sin token
  assert.equal(gate.green.has("firebase"), true); // fail-open, como docsGuardOk(null)
});

test("computeCapabilityGate: sin capabilities resueltas → gate vacío, cero probes", async () => {
  const stories = [{ id: "a", body: "$FIREBASE_SERVICE_ACCOUNT", acceptance: null }];
  let probes = 0;
  const gate = await computeCapabilityGate([], stories, async () => { probes++; return true; });
  assert.equal(gate.needsByStoryId.size, 0);
  assert.equal(gate.green.size, 0);
  assert.equal(probes, 0);
});

// ── E2E de DATA contra el registry REAL: resolve firebase → needs → gate → candidates ──────────────
// El caso que probó el E2E (S-fbmig): una story que deploya referenciando $FIREBASE_SERVICE_ACCOUNT
// NO se despacha hasta que el secret esté 🟢; una story de emulador (no lo referencia) se despacha
// siempre. La capa GitHub (probe) se mockea; el kernel + el cómputo corren contra el registry real.
const dstory = (o: Partial<DStory> & { id: string }): DStory => ({
  id: o.id, key: o.key ?? "S-1", title: "t", lane: "", status: o.status ?? "backlog",
  sprintId: null, deps: [], issue: 1, body: o.body ?? null, acceptance: o.acceptance ?? null,
  needsCapabilities: o.needsCapabilities,
});

test("E2E-data: story que referencia $FIREBASE_SERVICE_ACCOUNT ⚪ NO es candidata; 🟢 sí; emulador siempre", async () => {
  // Registry real: stack aiuda-flutter-firebase declara la capability firebase (secret real).
  const prov = "version: 1\nstack: aiuda-flutter-firebase\naccounts:\n  - capability: firebase\n";
  const caps = resolveProjectCapabilities(registryDir, prov);
  assert.ok(caps.some((c) => c.id === "firebase" && c.secret === "FIREBASE_SERVICE_ACCOUNT"));

  const deploy = dstory({ id: "deploy", key: "S-fbmig-2", body: "Deploy a Firebase usando $FIREBASE_SERVICE_ACCOUNT." });
  const emu = dstory({ id: "emu", key: "S-fbmig-3", body: "Lógica de Firestore testeada contra el emulador." });
  const rows = [deploy, emu];

  // Probe que dice: el secret NO está sembrado (⚪).
  const absent = await computeCapabilityGate(caps, rows, async () => false);
  for (const s of rows) { const n = absent.needsByStoryId.get(s.id); if (n) s.needsCapabilities = n; }
  const ungated = candidates(rows, new Map(), { executionUnit: "story", channel: "claude_action", maxConcurrency: 0, modelByLane: new Map(), channelByLane: new Map() }, absent.green);
  assert.deepEqual(ungated.map((c) => c.id).sort(), ["emu"], "con firebase ⚪ solo la story de emulador es candidata");

  // Probe que dice: el secret SÍ está sembrado (🟢).
  const present = await computeCapabilityGate(caps, rows, async () => true);
  const green = candidates(rows, new Map(), { executionUnit: "story", channel: "claude_action", maxConcurrency: 0, modelByLane: new Map(), channelByLane: new Map() }, present.green);
  assert.deepEqual(green.map((c) => c.id).sort(), ["deploy", "emu"], "con firebase 🟢 ambas son candidatas");
});
