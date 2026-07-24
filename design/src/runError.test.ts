import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRunError, TRANSIENT_HTTP } from "./supabase.ts";

test("classifyRunError: reintentos transitorios agotados → transient", () => {
  assert.equal(classifyRunError("supabase GET /design_phases?… → 525 (agotados los reintentos transitorios)"), "transient");
});

test("classifyRunError: un status transitorio en el mensaje → transient", () => {
  assert.equal(classifyRunError("supabase PATCH /design_runs → 503 Service Unavailable"), "transient");
  assert.equal(classifyRunError("supabase GET /x → 525 handshake failed"), "transient");
});

test("classifyRunError: un error real (4xx / no-HTTP) → fatal", () => {
  assert.equal(classifyRunError("supabase POST /stories → 400 duplicate key"), "fatal");
  assert.equal(classifyRunError("TypeError: cannot read properties of undefined"), "fatal");
  assert.equal(classifyRunError("applySprintPlan: sprint destino 'S9' no existe"), "fatal");
});

test("TRANSIENT_HTTP cubre los códigos de Cloudflare↔origen (incl. 525)", () => {
  for (const c of [429, 500, 502, 503, 504, 520, 525, 530]) assert.ok(TRANSIENT_HTTP.has(c), `${c} debe ser transitorio`);
  assert.ok(!TRANSIENT_HTTP.has(400));
  assert.ok(!TRANSIENT_HTTP.has(404));
});
