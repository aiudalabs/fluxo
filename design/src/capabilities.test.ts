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
} from "./capabilities.ts";

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
