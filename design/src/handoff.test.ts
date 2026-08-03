// ── serializeBacklog ↔ parseBacklog round-trip + loadBacklog (deuda-chica 🟠 iterate) ────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBacklog, serializeBacklog } from "./handoff.ts";
import { SupabaseDesignStore } from "./supabase.ts";

test("serializeBacklog → parseBacklog round-trip preserva stories, sprint, deps, epic", () => {
  const sprints = [{ key: "SP1", title: "Sprint 1", goal: "g1", position: 0 }];
  const stories = [
    { key: "S1-01", title: "Login", lane: "frontend", sprint: "SP1", deps: [], epic_id: "E1", body: "como user…", acceptance: "AC1", screen_key: "auth.login" },
    { key: "S1-02", title: "Home", lane: "frontend", sprint: "SP1", deps: ["S1-01"], epic_id: "E1", kind: "story" },
  ];
  const back = parseBacklog(serializeBacklog(sprints, stories));
  assert.equal(back.sprints.length, 1);
  assert.equal(back.sprints[0].key, "SP1");
  assert.deepEqual(back.stories.map((s) => s.key), ["S1-01", "S1-02"]);
  const home = back.stories.find((s) => s.key === "S1-02")!;
  assert.deepEqual(home.deps, ["S1-01"]);
  assert.equal(home.sprint, "SP1");
  assert.equal(back.stories[0].epic_id, "E1");
  assert.equal(back.stories[0].screen_key, "auth.login");
});

test("loadBacklog reconstruye sprint (uuid→key) y deps (blocked_by uuid[]→keys) desde la DB", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
      const u = new URL(String(url));
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/sprints")) return j([{ id: "sp-uuid-1", key: "SP1", title: "S1", goal: "g", position: 0 }]);
      if (u.pathname.endsWith("/stories")) return j([
        { id: "st-uuid-1", key: "S1-01", title: "a", lane: "frontend", sprint_id: "sp-uuid-1", body: null, acceptance: null, epic_id: "E1", kind: null, screen_key: null, blocked_by: [] },
        { id: "st-uuid-2", key: "S1-02", title: "b", lane: "frontend", sprint_id: "sp-uuid-1", body: null, acceptance: null, epic_id: "E1", kind: null, screen_key: null, blocked_by: ["st-uuid-1"] },
      ]);
      return j([]);
    }) as typeof fetch;
    const store = new SupabaseDesignStore({ url: "http://sb.test", anonKey: "a", jwtSecret: "s".repeat(40), tenant: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", project: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    const { sprints, stories } = await store.loadBacklog();
    assert.deepEqual(sprints.map((s) => s.key), ["SP1"]);
    const s2 = stories.find((s) => s.key === "S1-02")!;
    assert.equal(s2.sprint, "SP1", "sprint uuid→key");
    assert.deepEqual(s2.deps, ["S1-01"], "blocked_by uuid→key");
  } finally { globalThis.fetch = real; }
});

// Idempotencia del handoff GitHub: loadStoryRefs devuelve SOLO las stories que ya tienen issue linkeado
// (external_ref no-null). El loop de publishToGithub saltea esas → un re-handoff no re-crea issues (era el
// bug que duplicó el board de YoMap 34→68). La story sin external_ref NO está en el mapa → se le crea el issue.
test("loadStoryRefs → key→external_ref solo de stories con issue (la sin ref se omite → se creará)", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
      const u = new URL(String(url));
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/stories")) return j([
        { key: "S1-01", external_ref: "github:acme/yomap#35" },
        { key: "S1-02", external_ref: null },
        { key: "S1-03", external_ref: "github:acme/yomap#37" },
      ]);
      return j([]);
    }) as typeof fetch;
    const store = new SupabaseDesignStore({ url: "http://sb.test", anonKey: "a", jwtSecret: "s".repeat(40), tenant: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", project: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    const refs = await store.loadStoryRefs();
    assert.equal(refs.size, 2, "solo las 2 stories con external_ref");
    assert.equal(refs.get("S1-01"), "github:acme/yomap#35");
    assert.equal(refs.has("S1-02"), false, "la story sin issue NO está → se le creará el issue");
    assert.equal(refs.get("S1-03"), "github:acme/yomap#37");
  } finally { globalThis.fetch = real; }
});
