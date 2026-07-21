// Test del refresh silencioso (deuda-chica 🔴 2026-07-20): decodeExp + needsRefresh.
// Runner: node --test --experimental-strip-types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeExp, needsRefresh } from "./jwtRefresh.ts";

// JWT de juguete: header.payload.sig (solo el payload importa para exp).
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

test("decodeExp extrae exp; null si no parsea o no lo trae", () => {
  assert.equal(decodeExp(jwt({ exp: 1_700_000_000, tenant: "t" })), 1_700_000_000);
  assert.equal(decodeExp(jwt({ tenant: "t" })), null); // sin exp
  assert.equal(decodeExp("no-es-un-jwt"), null);
});

test("needsRefresh: true si vence dentro del umbral o ya venció; false si falta mucho", () => {
  const now = 1_700_000_000;
  const threshold = 3600; // 1h
  assert.equal(needsRefresh(jwt({ exp: now + 30 * 60 }), now, threshold), true, "vence en 30min < 1h → refrescar");
  assert.equal(needsRefresh(jwt({ exp: now - 10 }), now, threshold), true, "ya venció → refrescar (fallará el verify server, redirige a login)");
  assert.equal(needsRefresh(jwt({ exp: now + 5 * 3600 }), now, threshold), false, "vence en 5h → no tocar");
  assert.equal(needsRefresh(jwt({ tenant: "t" }), now, threshold), false, "sin exp → no refrescar (default seguro)");
});
