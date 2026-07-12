#!/usr/bin/env node
// F6-03 verification (dev tool): seed one of each brain kind — including a two-step
// provenance chain for a requirement — and read them back the way the explorer does,
// asserting the requirement→issue→PR trail reconstructs. Exercises the data the richer
// per-kind rendering + ProvenanceTrail consume. Reads NEXT_PUBLIC_* from console/.env.local.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const token = process.env.NEXT_PUBLIC_DEV_TENANT_JWT;
const projectId = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;
const tenantId = process.env.VERIFY_TENANT_ID;
if (!url || !anon || !token || !projectId || !tenantId) {
  console.error("missing env (source console/.env.local + VERIFY_TENANT_ID=<dev tenant>)");
  process.exit(1);
}
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const supabase = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, accessToken: async () => token });
const scope = { tenant_id: tenantId, project_id: projectId };
const req = `FR-${process.env.RUN_STAMP ?? Math.floor(Date.now() / 1000)}`;

const { error: sErr } = await supabase.from("brain_events").insert([
  { ...scope, kind: "decision", actor: "architect", payload: { title: "Supabase managed", decision: "Alquilar el sustrato", rationale: "baterías vs DIY", alternatives_rejected: ["self-host"] } },
  { ...scope, kind: "gate_answer", actor: "human:studio", payload: { gate: "discovery_gate", outcome: "changes-requested", feedback: "faltan métricas", answered: [{ q: "¿seña?", a: "30%" }] } },
  { ...scope, kind: "rejected_design", actor: "architect", payload: { what: "conductor serial 25s", why_rejected: "flap (L-ARCH-4)", chosen_instead: "webhooks + Realtime" } },
  { ...scope, kind: "provenance", actor: "system", payload: { requirement: req, issue: "acme/salon#42", stage: "published" } },
  { ...scope, kind: "provenance", actor: "system", payload: { requirement: req, issue: "acme/salon#42", pr: "acme/salon#57", stage: "merged" } },
]);
if (sErr) die(`seed failed: ${sErr.message}`);
console.log(`✓ seeded decision, gate_answer, rejected_design, and a 2-step provenance chain for ${req}`);

// Read back the way BrainExplorer does.
const { data, error } = await supabase.from("brain_events").select("*").eq("project_id", projectId).order("ts", { ascending: false }).limit(200);
if (error) die(`read failed: ${error.message}`);
for (const k of ["decision", "gate_answer", "rejected_design", "provenance"]) {
  if (!data.some((e) => e.kind === k)) die(`no ${k} event read back`);
}
console.log("✓ all four kinds read back under RLS");

// The trail: provenance events for the requirement reconstruct requirement → issue → PR.
const chain = data.filter((e) => e.kind === "provenance" && e.payload.requirement === req);
if (chain.length !== 2) die(`expected 2 provenance events for ${req}, got ${chain.length}`);
const merged = chain.find((e) => e.payload.stage === "merged");
if (!merged || !merged.payload.issue || !merged.payload.pr) die("merged provenance is missing issue/pr — trail cannot reconstruct");
console.log(`✓ trail reconstructs: ${merged.payload.requirement} → ${merged.payload.issue} → ${merged.payload.pr} (${merged.payload.stage})`);

console.log("\n✓ F6-03 brain trail data path verified (per-kind events + requirement→issue→PR chain)");
process.exit(0);
