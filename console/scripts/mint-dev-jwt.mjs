#!/usr/bin/env node
// DEV-ONLY (F1-04): mint an HS256 tenant JWT so the console can read brain_events
// under RLS before real GitHub-OAuth auth exists. Mirrors control/internal/brain/
// jwt.go. Never use in prod — the real path is a GitHub-OAuth session JWT.
//
// Usage: SUPABASE_JWT_SECRET=... node scripts/mint-dev-jwt.mjs <tenant-uuid>
import { createHmac } from "node:crypto";

const secret = process.env.SUPABASE_JWT_SECRET;
const tenant = process.argv[2];
if (!secret || !tenant) {
  console.error("usage: SUPABASE_JWT_SECRET=... node scripts/mint-dev-jwt.mjs <tenant-uuid>");
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT" };
const claims = {
  role: "authenticated",
  aud: "authenticated",
  sub: "dev-shim",
  tenant,
  iat: now,
  exp: now + 60 * 60 * 24 * 7, // 7 days — dev convenience
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());
process.stdout.write(`${signingInput}.${sig}\n`);
