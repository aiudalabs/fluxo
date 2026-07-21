import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mintTenantJwt, SupabaseDesignStore, type SprintSeed, type StorySeed } from "./supabase.ts";

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

// ── Fake PostgREST modelando sprints/stories con constraint UNIQUE (project_id,key) ──────────
// Un POST que reinserta una key existente responde 409 (como Postgres), para que el test FALLE
// si el código intentara re-insertar en un resume (el bug original). DELETE responde 403
// (revocado para authenticated, como en prod) — el fix NO debe depender de él.
const CFG = {
  url: "http://sb.test", anonKey: "anon", jwtSecret: "s".repeat(40),
  tenant: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", project: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
};
function fakePostgrest(seed?: { sprints?: Array<{ key: string }>; stories?: Array<{ key: string; blocked_by?: string[] }> }) {
  let n = 0;
  const uid = (k: string) => `id-${k}`;
  const sprints = new Map<string, { id: string; key: string }>();
  const stories = new Map<string, { id: string; key: string; blocked_by: string[] }>();
  for (const sp of seed?.sprints ?? []) sprints.set(sp.key, { id: uid(sp.key), key: sp.key });
  for (const st of seed?.stories ?? []) stories.set(st.key, { id: uid(st.key), key: st.key, blocked_by: st.blocked_by ?? [] });
  const calls: Array<{ method: string; path: string }> = [];
  const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    n++;
    const u = new URL(String(url));
    const table = u.pathname.split("/").pop()!;      // sprints | stories
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname + u.search });
    const tbl = table === "sprints" ? sprints : stories;

    if (method === "GET") return j([...tbl.values()].map((r) => ({ id: r.id, key: r.key })));
    if (method === "DELETE") return j({ code: "42501", message: "permission denied" }, 403); // revocado
    if (method === "POST") {
      const rows = JSON.parse(String(init!.body)) as Array<{ key: string; blocked_by?: string[] }>;
      for (const r of rows) {
        if (tbl.has(r.key)) return j({ code: "23505", message: `duplicate key value violates unique constraint "${table}_project_id_key_key"` }, 409);
      }
      for (const r of rows) tbl.set(r.key, { id: uid(r.key), key: r.key, blocked_by: (r as { blocked_by?: string[] }).blocked_by ?? [] } as never);
      return j([...rows.map((r) => ({ id: uid(r.key), key: r.key }))], 201);
    }
    if (method === "PATCH") {
      const key = decodeURIComponent(u.searchParams.get("key")?.replace("eq.", "") ?? "");
      const patch = JSON.parse(String(init!.body)) as { blocked_by?: string[] };
      const row = stories.get(key);
      if (row && patch.blocked_by) row.blocked_by = patch.blocked_by;
      return j([], 200);
    }
    return j({}, 500);
  };
  return { fetchFn, sprints, stories, calls, count: () => n };
}

const SPRINTS: SprintSeed[] = [{ key: "SP1", title: "S1" }, { key: "SP2", title: "S2" }];
const STORIES: StorySeed[] = [
  { key: "S1-01", title: "a", sprint: "SP1" },
  { key: "S1-02", title: "b", sprint: "SP1", deps: ["S1-01"] },
  { key: "S2-01", title: "c", sprint: "SP2", deps: ["S1-01", "S1-02"] },
];

async function withFetch<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("publishBacklog: primer handoff inserta sprints/stories y cablea todas las deps", async () => {
  await withFetch(async () => {
    const fake = fakePostgrest();
    globalThis.fetch = fake.fetchFn as typeof fetch;
    const store = new SupabaseDesignStore(CFG);
    const r = await store.publishBacklog(SPRINTS, STORIES);
    assert.equal(r.sprints, 2);
    assert.equal(r.stories, 3);
    assert.deepEqual(fake.stories.get("S1-02")!.blocked_by, ["id-S1-01"]);
    assert.deepEqual(fake.stories.get("S2-01")!.blocked_by, ["id-S1-01", "id-S1-02"]);
  });
});

test("publishBacklog: RESUME sobre estado parcial NO da 409 y COMPLETA las deps faltantes", async () => {
  await withFetch(async () => {
    // Estado de un run que crasheó (JWT vencido) tras insertar todo pero cablear solo S1-02.
    const fake = fakePostgrest({
      sprints: [{ key: "SP1" }, { key: "SP2" }],
      stories: [{ key: "S1-01" }, { key: "S1-02", blocked_by: ["id-S1-01"] }, { key: "S2-01" }],
    });
    globalThis.fetch = fake.fetchFn as typeof fetch;
    const store = new SupabaseDesignStore(CFG);
    // Con el bug viejo esto lanzaba (POST /sprints → 409). Ahora resuelve limpio.
    const r = await store.publishBacklog(SPRINTS, STORIES);
    assert.equal(r.sprints, 2);
    assert.equal(r.stories, 3);
    // Ningún POST se intentó (todo existía) → cero reinserción, cero 409.
    assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
    // La dep que faltaba (S2-01) quedó cableada.
    assert.deepEqual(fake.stories.get("S2-01")!.blocked_by, ["id-S1-01", "id-S1-02"]);
  });
});

test("rest reintenta UNA vez cuando el JWT vence en vuelo (401 → re-mint → 200)", async () => {
  await withFetch(async () => {
    const seen: string[] = [];
    let first = true;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)?.Authorization ?? "");
      if (first) { first = false; return new Response(JSON.stringify({ code: "PGRST303", message: "JWT expired" }), { status: 401 }); }
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const store = new SupabaseDesignStore(CFG);
    await store.publishBacklog([], []); // primer GET keyMap dispara el 401→retry
    assert.equal(seen.length >= 2, true, "debió reintentar tras el 401");
  });
});

// ── sink.onPhaseDone: hardening (deuda-chica 2026-07-20) ────────────────────────────────────────
// La VERSIÓN del doc (brainAppend) debe registrarse ANTES del write de costos. Antes, un drift de
// la columna cache_read_tokens hacía fallar el patch de costos y la versión del delta se perdía.
test("sink.onPhaseDone: la versión del doc se registra ANTES del write de costos; un fallo de costos NO la pierde", async () => {
  await withFetch(async () => {
    const brainAppends: Array<string> = [];
    let statusDone = false;
    let costWriteAttempted = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {} as Record<string, unknown>;
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/brain_events") && method === "POST") {
        brainAppends.push(((body.payload as { path?: string })?.path) ?? "");
        return j([], 201);
      }
      if (u.pathname.endsWith("/design_phases") && method === "PATCH") {
        if ("status" in body) { statusDone = body.status === "done"; return j([], 200); }
        if ("cache_read_tokens" in body) { costWriteAttempted = true; return j({ code: "PGRST204", message: "cache_read_tokens column not found" }, 400); } // drift simulado
        return j([], 200);
      }
      return j({}, 500);
    }) as typeof fetch;

    const store = new SupabaseDesignStore(CFG);
    store.runId = "run-1";
    // NO debe lanzar aunque el write de costos falle (drift de schema simulado).
    await store.sink.onPhaseDone!("scrum-master", {
      text: "backlog",
      artifacts: [{ path: "docs/backlog.yaml", content: "sprints: []" }],
      usage: { usd: 0.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, durationMs: 1000, model: "opus" },
    });
    assert.deepEqual(brainAppends, ["docs/backlog.yaml"], "la versión del doc DEBE registrarse (durable, antes de costos)");
    assert.ok(statusDone, "la fase debe quedar 'done'");
    assert.ok(costWriteAttempted, "el write de costos se intentó (y falló, pero no abortó onPhaseDone)");
  });
});
