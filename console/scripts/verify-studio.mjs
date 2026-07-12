#!/usr/bin/env node
// F6-02 verification (dev tool): prove the Studio's data path over Supabase — the exact
// client the console uses (route /projects/<projectId>/studio — project-first).
// Seeds a design run (a done phase with a harvested doc + mockup,
// a pending gate with open questions) as the tenant, reads it back the way Studio queries,
// then flips the gate to resolved and confirms Realtime projects it (the conversational
// gate resolution the UI performs). Reads NEXT_PUBLIC_* from console/.env.local.
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

const supabase = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, accessToken: async () => token });
await supabase.realtime.setAuth(token);
const scope = { tenant_id: tenantId, project_id: projectId };
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

// ── Seed a design run the way the engine's Supabase sink would ─────────────────
const { data: run, error: rErr } = await supabase.from("design_runs").insert({ ...scope, workflow: "design", status: "awaiting_gate" }).select("id").single();
if (rErr) die(`seed run: ${rErr.message}`);
console.log("✓ seeded design_run", run.id);

const { error: pErr } = await supabase.from("design_phases").insert([
  { ...scope, run_id: run.id, phase_id: "discovery", label: "Descubrimiento", ord: 0, status: "done",
    artifacts: [
      { path: "docs/BRIEF.md", kind: "doc", content: "# Project Brief\n## 8. Open Questions\n- ¿Se cobra seña?" },
      { path: "docs/mockups/index.html", kind: "mockup", content: "<html><body><h1>Turnos</h1></body></html>" },
    ] },
  { ...scope, run_id: run.id, phase_id: "backlog", label: "Backlog", ord: 1, status: "pending", artifacts: [] },
]);
if (pErr) die(`seed phases: ${pErr.message}`);

const { data: gate, error: gErr } = await supabase.from("design_gates").insert({
  ...scope, run_id: run.id, phase_id: "discovery", gate_id: "discovery_gate",
  reason: "Revisa el brief. Aprobá, pedí cambios, o respondé las preguntas abiertas.",
  open_questions: ["¿Se cobra seña?"], attempt: 1, status: "pending",
}).select("id").single();
if (gErr) die(`seed gate: ${gErr.message}`);
console.log("✓ seeded a pending gate with an open question");

// ── Read it back exactly as Studio does ────────────────────────────────────────
const { data: runs } = await supabase.from("design_runs").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1);
if (runs?.[0]?.id !== run.id) die("Studio query did not return the latest run");
const { data: phases } = await supabase.from("design_phases").select("*").eq("run_id", run.id).order("ord", { ascending: true });
if (phases?.length !== 2 || phases[0].artifacts?.[0]?.path !== "docs/BRIEF.md") die("phases/artifacts not read back");
const mockup = phases[0].artifacts.find((a) => a.kind === "mockup");
if (!mockup?.content.includes("<h1>")) die("mockup artifact not readable");
console.log(`✓ Studio reads ${phases.length} phases; artifacts include a doc and a mockup`);

// ── Realtime: resolving the gate (what the UI does) projects to a subscriber ────
const got = new Promise((resolve) => {
  supabase
    .channel(`studio:${projectId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "design_gates", filter: `project_id=eq.${projectId}` }, (p) => resolve(p.new))
    .subscribe(async (st) => {
      if (st === "SUBSCRIBED") {
        await new Promise((r) => setTimeout(r, 800));
        // The exact conversational resolution GatePanel performs: answer the open question.
        const { error } = await supabase.from("design_gates")
          .update({ status: "resolved", outcome: "revise", answers: [{ q: "¿Se cobra seña?", a: "Sí, 30%." }], resolved_at: new Date().toISOString() })
          .eq("id", gate.id);
        if (error) console.error("update error:", error.message);
      }
    });
});
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
try {
  const row = await Promise.race([got, timeout]);
  if (row.status === "resolved" && row.answers?.[0]?.a === "Sí, 30%.") {
    console.log("✓ realtime projected the gate resolution (answered open question) — no polling");
  } else {
    die(`resolved row unexpected: ${row.status}`);
  }
} catch {
  die("realtime did not deliver the gate resolution within 8s");
}
await supabase.removeAllChannels();
console.log("\n✓ F6-02 Studio data path verified (read phases/artifacts + resolve gate over Realtime)");
process.exit(0);
