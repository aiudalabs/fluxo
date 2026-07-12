#!/usr/bin/env node
// F1-04 verification (dev tool): exercise the EXACT data path BrainExplorer uses —
// the supabase-js client with a tenant token — to prove RLS-scoped reads and
// Realtime delivery against live Supabase. Route-independent (the UI route is now
// /projects/<projectId>/brain — project-first). Reads NEXT_PUBLIC_* from the env
// (source console/.env.local first). Exits non-zero on any failed assertion.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const token = process.env.NEXT_PUBLIC_DEV_TENANT_JWT;
const projectId = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;
const tenantId = process.env.VERIFY_TENANT_ID;
const otherProject = process.env.VERIFY_OTHER_PROJECT_ID;

if (!url || !anon || !token || !projectId || !tenantId) {
  console.error("missing env (source console/.env.local + VERIFY_TENANT_ID)");
  process.exit(1);
}

const fail = (m) => {
  console.error("✗ " + m);
  process.exitCode = 1;
};
const ok = (m) => console.log("✓ " + m);

const supabase = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
  accessToken: async () => token,
});

// 1. RLS read: the component's exact query returns only this tenant's rows.
const { data, error } = await supabase
  .from("brain_events")
  .select("*")
  .eq("project_id", projectId)
  .order("ts", { ascending: false })
  .limit(200);
if (error) fail("read failed: " + error.message);
else {
  ok(`read ${data.length} events for own project`);
  if (data.length < 2) fail(`expected >=2 seeded events, got ${data.length}`);
  if (data.some((e) => e.tenant_id !== tenantId)) fail("saw a row from another tenant (L-ARCH-1 leak!)");
  else ok("every row belongs to this tenant (RLS scoped read)");
}

// 2. RLS cross-tenant: the other tenant's project returns nothing.
if (otherProject) {
  const { data: cross } = await supabase.from("brain_events").select("*").eq("project_id", otherProject);
  if (cross && cross.length > 0) fail(`cross-tenant read returned ${cross.length} rows (leak!)`);
  else ok("cross-tenant project read returns nothing (RLS)");
}

// 3. Realtime: a new INSERT for this project is delivered without polling.
// The realtime socket must carry the tenant token, or it connects as anon and
// RLS delivers nothing.
await supabase.realtime.setAuth(token);
const got = new Promise((resolve) => {
  const channel = supabase
    .channel(`verify:${projectId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "brain_events", filter: `project_id=eq.${projectId}` },
      (payload) => resolve(payload.new),
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await supabase
          .from("brain_events")
          .insert({ tenant_id: tenantId, project_id: projectId, kind: "provenance", payload: { via: "verify" }, actor: "verify" });
      }
    });
});

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
try {
  const row = await Promise.race([got, timeout]);
  ok(`realtime delivered INSERT id=${row.id} kind=${row.kind}`);
} catch {
  fail("realtime did not deliver the INSERT within 8s");
}

await supabase.removeAllChannels();
process.exit(process.exitCode ?? 0);
