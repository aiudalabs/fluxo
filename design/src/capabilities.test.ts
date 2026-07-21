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
