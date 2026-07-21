// P6-2b · Paso 2 — test de la whitelist de secrets del PUT del canal (la guardia de seguridad) +
// el resolver corrido contra el registry REAL (mismo registryDir del console). Runner: node --test
// --experimental-strip-types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  secretWhitelist,
  isAllowedSecret,
  resolveProjectCapabilities,
  CLAUDE_SECRET,
  type ResolvedCapability,
} from "./capabilitiesData.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "..", "registry"); // console/lib/server → repo root

test("secretWhitelist siempre incluye el token de Claude (el canal de siempre)", () => {
  assert.ok(secretWhitelist([]).has(CLAUDE_SECRET));
});

test("secretWhitelist suma el secret de cada capability con secret; ignora las sin secret", () => {
  const caps: ResolvedCapability[] = [
    { id: "firebase", name: "Firebase", secret: "FIREBASE_SERVICE_ACCOUNT" },
    { id: "emu", name: "Emu", secret: null },
  ];
  const w = secretWhitelist(caps);
  assert.ok(w.has("FIREBASE_SERVICE_ACCOUNT"));
  assert.ok(w.has(CLAUDE_SECRET));
  assert.equal(w.size, 2, "solo Claude + firebase; la capability sin secret no agrega nada");
});

test("isAllowedSecret rechaza un secret arbitrario fuera del registry del proyecto", () => {
  const caps: ResolvedCapability[] = [{ id: "firebase", name: "Firebase", secret: "FIREBASE_SERVICE_ACCOUNT" }];
  assert.equal(isAllowedSecret(caps, "FIREBASE_SERVICE_ACCOUNT"), true);
  assert.equal(isAllowedSecret(caps, CLAUDE_SECRET), true);
  assert.equal(isAllowedSecret(caps, "AWS_SECRET_ACCESS_KEY"), false, "un secret ajeno se rechaza");
  assert.equal(isAllowedSecret(caps, "SOME_RANDOM"), false);
});

// Integración: resolver + whitelist contra el registry REAL, para un proyecto stack firebase.
test("un proyecto stack aiuda-flutter-firebase permite sembrar FIREBASE_SERVICE_ACCOUNT, no otro", () => {
  const prov = "version: 1\nstack: aiuda-flutter-firebase\naccounts:\n  - capability: firebase\n";
  const caps = resolveProjectCapabilities(registryDir, prov);
  assert.ok(caps.some((c) => c.id === "firebase" && c.secret === "FIREBASE_SERVICE_ACCOUNT"));
  assert.equal(isAllowedSecret(caps, "FIREBASE_SERVICE_ACCOUNT"), true);
  assert.equal(isAllowedSecret(caps, "MALICIOUS_SECRET"), false);
});

test("un proyecto sin provisioning ⇒ solo el token de Claude es sembrable", () => {
  const caps = resolveProjectCapabilities(registryDir, "version: 1\nroles: []\n");
  assert.deepEqual(caps, []);
  assert.equal(isAllowedSecret(caps, CLAUDE_SECRET), true);
  assert.equal(isAllowedSecret(caps, "FIREBASE_SERVICE_ACCOUNT"), false);
});
