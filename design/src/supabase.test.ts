import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mintTenantJwt } from "./supabase.ts";

// Pure test of the JWT minting — the network paths (createRun / resolver poll) are
// exercised end-to-end against local Supabase by scripts/verify-gate-loop.ts.
test("mintTenantJwt produces a valid HS256 tenant JWT (matches the RLS claim shape)", () => {
  const secret = "super-secret-jwt-token-with-at-least-32-characters-long";
  const tenant = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const jwt = mintTenantJwt(secret, tenant, 3600, 1_700_000_000);
  const [h, c, sig] = jwt.split(".");
  assert.equal(jwt.split(".").length, 3);

  const decode = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  assert.deepEqual(decode(h), { alg: "HS256", typ: "JWT" });
  const claims = decode(c);
  assert.equal(claims.role, "authenticated");
  assert.equal(claims.tenant, tenant); // this is what auth.jwt()->>'tenant' reads
  assert.equal(claims.exp - claims.iat, 3600);

  // Signature verifies with the same secret.
  const expected = createHmac("sha256", secret).update(`${h}.${c}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(sig, expected);
});
