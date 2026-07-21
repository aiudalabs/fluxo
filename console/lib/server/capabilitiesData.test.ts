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
  githubSecretProbe,
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

// ── P6-2b · Paso 3 · githubSecretProbe: el probe tri-estado del readiness gate ────
test("githubSecretProbe: sin token → null (indeterminado, fail-open) sin llamar a la red", async () => {
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; return new Response("", { status: 200 }); }) as typeof fetch;
  try {
    assert.equal(await githubSecretProbe("o/r", null)("FIREBASE_SERVICE_ACCOUNT"), null);
    assert.equal(called, false, "sin token no debe tocar la red");
  } finally { globalThis.fetch = orig; }
});

test("githubSecretProbe: 200 → true (🟢), 404 → false (ausente, gatea), 403 → null (fail-open)", async () => {
  const orig = globalThis.fetch;
  const withStatus = async (status: number) => {
    globalThis.fetch = (async () => new Response("", { status })) as typeof fetch;
    return githubSecretProbe("o/r", "tok")("FIREBASE_SERVICE_ACCOUNT");
  };
  try {
    assert.equal(await withStatus(200), true);
    assert.equal(await withStatus(404), false);
    assert.equal(await withStatus(403), null);
    assert.equal(await withStatus(500), null);
  } finally { globalThis.fetch = orig; }
});

test("githubSecretProbe: error de red → null (fail-open, no gatea ante la duda)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as typeof fetch;
  try {
    assert.equal(await githubSecretProbe("o/r", "tok")("FIREBASE_SERVICE_ACCOUNT"), null);
  } finally { globalThis.fetch = orig; }
});
