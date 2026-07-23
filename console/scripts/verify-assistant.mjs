#!/usr/bin/env node
// P5-4 verification (dev tool): exercise the EXACT data path AssistantChat uses — the supabase-js
// client with a tenant token — to prove RLS-scoped conversation/message persistence + Realtime
// delivery against live Supabase. Mirrors verify-brain.mjs. Source console/.env.local first.
// Exits non-zero on any failed assertion.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const token = process.env.NEXT_PUBLIC_DEV_TENANT_JWT;
const projectId = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;

if (!url || !anon || !token || !projectId) {
  console.error("missing env (source console/.env.local)");
  process.exit(1);
}

// El tenant sale del claim del JWT (así el script no depende de un env extra).
const tenantId = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).tenant;

const fail = (m) => { console.error("✗ " + m); process.exitCode = 1; };
const ok = (m) => console.log("✓ " + m);

const supabase = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
  accessToken: async () => token,
});

// 1. Crear una conversación (el cliente pasa tenant_id, igual que AssistantChat/IncrementRequest).
const { data: conv, error: cErr } = await supabase
  .from("assistant_conversations")
  .insert({ project_id: projectId, tenant_id: tenantId, title: "verify P5-4" })
  .select("id,tenant_id,title")
  .single();
if (cErr || !conv) { fail("crear conversación falló: " + (cErr?.message ?? "sin data")); process.exit(1); }
if (conv.tenant_id !== tenantId) fail(`tenant_id de la conversación (${conv.tenant_id}) != claim (${tenantId})`);
else ok(`conversación creada id=${conv.id} tenant scopeado`);

// 2. Persistir un par de mensajes (user + assistant).
const { error: mErr } = await supabase.from("assistant_messages").insert([
  { conversation_id: conv.id, project_id: projectId, tenant_id: tenantId, role: "user", content: "hola" },
  { conversation_id: conv.id, project_id: projectId, tenant_id: tenantId, role: "assistant", content: "qué tal" },
]);
if (mErr) fail("insert de mensajes falló: " + mErr.message);
else ok("2 mensajes persistidos");

// 3. Releer bajo RLS (la lista que carga el chat) — debe traer los 2, del tenant propio.
const { data: msgs } = await supabase
  .from("assistant_messages")
  .select("id,role,content,tenant_id")
  .eq("conversation_id", conv.id)
  .order("created_at", { ascending: true });
if (!msgs || msgs.length !== 2) fail(`esperaba 2 mensajes, leí ${msgs?.length ?? 0}`);
else if (msgs.some((m) => m.tenant_id !== tenantId)) fail("un mensaje es de otro tenant (leak!)");
else ok("relectura RLS-scopeada: 2 mensajes del tenant propio (sobrevive un reload)");

// 4. Realtime: un INSERT nuevo llega sin polling (el chat vive por Realtime).
await supabase.realtime.setAuth(token);
const got = new Promise((resolve) => {
  supabase
    .channel(`verify-asst:${conv.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "assistant_messages", filter: `conversation_id=eq.${conv.id}` }, (p) => resolve(p.new))
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // SUBSCRIBED puede dispararse justo antes de que el server esté listo — settle antes de mutar.
        await new Promise((r) => setTimeout(r, 800));
        await supabase.from("assistant_messages").insert({ conversation_id: conv.id, project_id: projectId, tenant_id: tenantId, role: "assistant", content: "por realtime" });
      }
    });
});
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
try {
  const row = await Promise.race([got, timeout]);
  ok(`realtime entregó el INSERT id=${row.id} (${row.content})`);
} catch {
  fail("realtime no entregó el INSERT en 8s");
}

// 5. Limpieza: borrar la conversación (cascade a los mensajes).
await supabase.from("assistant_conversations").delete().eq("id", conv.id);
const { data: after } = await supabase.from("assistant_messages").select("id").eq("conversation_id", conv.id);
if (after && after.length > 0) fail("el delete no cascadeó a los mensajes");
else ok("delete de la conversación cascadea a los mensajes (RLS delete OK)");

await supabase.removeAllChannels();
process.exit(process.exitCode ?? 0);
