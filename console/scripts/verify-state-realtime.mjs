#!/usr/bin/env node
// F3-04 verification (dev tool): prove a story status transition is projected to a
// tenant subscriber over Realtime — no polling. Uses the same supabase-js client the
// console board uses (route /projects/<projectId>/board — project-first; route-
// independent here). Reads NEXT_PUBLIC_* + VERIFY_TENANT_ID from env.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const token = process.env.NEXT_PUBLIC_DEV_TENANT_JWT;
const tenantId = process.env.VERIFY_TENANT_ID;
const projectId = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;
if (!url || !anon || !token || !tenantId || !projectId) {
  console.error("missing env (source console/.env.local + VERIFY_TENANT_ID)");
  process.exit(1);
}

const supabase = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
  accessToken: async () => token,
});
await supabase.realtime.setAuth(token);

const key = "RT-" + process.env.RUN_STAMP;
const { data: inserted, error: insErr } = await supabase
  .from("stories")
  .insert({ tenant_id: tenantId, project_id: projectId, key, title: "realtime probe", lane: "backend" })
  .select("id")
  .single();
if (insErr) {
  console.error("✗ insert failed:", insErr.message);
  process.exit(1);
}
console.log("✓ seeded story", inserted.id);

const got = new Promise((resolve) => {
  supabase
    .channel(`state:${projectId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "stories", filter: `project_id=eq.${projectId}` },
      (payload) => resolve(payload.new),
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // Let the server-side subscription settle before mutating, so the change
        // is captured (SUBSCRIBED can fire just before the server is ready).
        await new Promise((r) => setTimeout(r, 800));
        // A legal transition backlog -> ready (passes the state-machine trigger).
        const { error } = await supabase.from("stories").update({ status: "ready" }).eq("id", inserted.id);
        if (error) console.error("update error:", error.message);
      }
    });
});

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
try {
  const row = await Promise.race([got, timeout]);
  if (row.status === "ready" && row.id === inserted.id) {
    console.log(`✓ realtime delivered the status transition → ${row.status} (no polling)`);
  } else {
    console.error("✗ delivered row unexpected:", row.id, row.status);
    process.exitCode = 1;
  }
} catch {
  console.error("✗ realtime did not deliver the status transition within 8s");
  process.exitCode = 1;
}
await supabase.removeAllChannels();
process.exit(process.exitCode ?? 0);
