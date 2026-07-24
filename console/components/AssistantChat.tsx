"use client";

// P5-1 · AI Assistant (chat). UI portada de v1 (clases .brain* de globals.css) → look pulido + el
// bubble del asistente se renderiza como MARKDOWN (react-markdown), no texto crudo. Manda la historia
// a /api/projects/[id]/assistant (proxy → worker, donde corre el agent-loop con el token).
//
// P5-4 · MEMORIA: las conversaciones se PERSISTEN en Supabase (assistant_conversations +
// assistant_messages, RLS por tenant) — sobreviven reload/navegación y viven por Realtime. Hay una
// lista de hilos + "nueva conversación". La escritura es 100% del lado console; el worker sigue
// recibiendo {messages} y no persiste nada.

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProject } from "@/lib/project";
import { freshToken } from "@/lib/supabaseClient";

type Msg = { id: string; role: "user" | "assistant"; content: string };
type Conv = { id: string; title: string | null; created_at: string };
type ActionProposal = { type: string; summary?: string; instructions?: string; target?: string; outcome?: string };
type ActState = "idle" | "busy" | "done" | "error" | "dismissed";

const SUGGESTIONS = [
  "¿Cómo va el proyecto y qué está trabado?",
  "¿Cuánto se gastó hasta ahora y en qué?",
  "Quiero agregar una feature: pantalla de \"Mis citas\" para el cliente.",
];

// parseAction extrae el bloque ```fluxo-action {json}``` de una respuesta del asistente (P5-1): el bot
// PROPONE, la UI lo muestra como tarjeta confirmable y ejecuta al confirmar.
function parseAction(content: string): { text: string; action: ActionProposal | null } {
  const m = content.match(/```fluxo-action\s*([\s\S]*?)```/);
  if (!m) return { text: content, action: null };
  let action: ActionProposal | null = null;
  try { action = JSON.parse(m[1].trim()) as ActionProposal; } catch { /* bloque malformado: ignorá */ }
  return { text: content.replace(m[0], "").trim(), action };
}

// isAuthError · detecta sesión vencida (401 del proxy o "JWT expired" de Supabase) para mostrar un
// aviso claro de re-login en vez de un error mudo (Pieza 4).
function isAuthError(e: unknown, status?: number): boolean {
  if (status === 401) return true;
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return msg.includes("jwt") || msg.includes("expired") || msg.includes("no session") || msg.includes("401");
}

// Título del hilo = las primeras palabras del primer mensaje (para la lista de conversaciones).
function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

// consumeSse (Pieza 2) · lee el stream SSE del proxy: cada `data:{"delta":…}` va al bubble en vivo;
// `data:{"done":true,"text":…}` trae el texto completo (fuente para parsear fluxo-action); `{"error":…}`
// aborta. Devuelve el texto final. Si el worker cayó al fallback JSON, el caller lo maneja aparte.
async function consumeSse(r: Response, onDelta: (d: string) => void): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let buf = "", streamed = "", final = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let obj: { delta?: string; done?: boolean; text?: string; error?: string };
      try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (obj.error) throw new Error(obj.error);
      if (obj.delta) { streamed += obj.delta; onDelta(obj.delta); }
      else if (obj.done) final = obj.text ?? streamed;
    }
  }
  return final || streamed;
}

export function AssistantChat() {
  const { projectId, project, supabase } = useProject();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null); // Pieza 2: bubble en vivo mientras llega el SSE.
  const [sessionExpired, setSessionExpired] = useState(false);     // Pieza 4: aviso de re-login.
  const [acts, setActs] = useState<Record<string, ActState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const convIdRef = useRef<string | null>(null); // convId vivo (el del closure de send() queda stale).
  useEffect(() => { convIdRef.current = convId; }, [convId]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy, streaming]);

  // Lista de conversaciones del proyecto (RLS scopea al tenant). Vive por Realtime; al arrancar
  // selecciona la más reciente para retomar donde quedó.
  useEffect(() => {
    let dead = false;
    const load = async () => {
      const { data } = await supabase.from("assistant_conversations").select("id,title,created_at").eq("project_id", projectId).order("created_at", { ascending: false });
      if (dead) return;
      const list = (data as Conv[]) ?? [];
      setConvs(list);
      setConvId((cur) => cur ?? list[0]?.id ?? null);
    };
    void load();
    const ch = supabase.channel(`asst-convs:${projectId}`).on("postgres_changes", { event: "*", schema: "public", table: "assistant_conversations", filter: `project_id=eq.${projectId}` }, () => void load()).subscribe();
    return () => { dead = true; void supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  // Mensajes de la conversación activa (RLS scopea). Vive por Realtime → sobrevive reload y multi-pestaña.
  useEffect(() => {
    if (!convId) { setMsgs([]); return; }
    let dead = false;
    const load = async () => {
      const { data } = await supabase.from("assistant_messages").select("id,role,content").eq("conversation_id", convId).order("created_at", { ascending: true });
      if (!dead) setMsgs((data as Msg[]) ?? []);
    };
    void load();
    const ch = supabase.channel(`asst-msgs:${convId}`).on("postgres_changes", { event: "*", schema: "public", table: "assistant_messages", filter: `conversation_id=eq.${convId}` }, () => void load()).subscribe();
    return () => { dead = true; void supabase.removeChannel(ch); };
  }, [convId, supabase]);

  // Confirmar una acción propuesta → ejecutar por el path que ya existe (el bot nunca dispara solo).
  const confirmAction = async (key: string, a: ActionProposal) => {
    setActs((s) => ({ ...s, [key]: "busy" }));
    try {
      if (a.type === "increment") {
        if (!a.instructions) throw new Error("sin instrucciones");
        const { error } = await supabase.from("increment_requests").insert({ project_id: projectId, tenant_id: project?.tenant_id, instructions: a.instructions });
        if (error) throw error;
      } else if (a.type === "dispatch") {
        const tok = await freshToken();
        const h = tok ? { authorization: `Bearer ${tok}` } : undefined;
        const cr = await fetch(`/api/projects/${projectId}/candidates`, { headers: h });
        const cands = ((await cr.json())?.candidates ?? []) as Array<{ kind: string; id: string; title: string }>;
        if (!cands.length) throw new Error("no hay nada listo para despachar");
        const target = (a.target ?? "").toLowerCase();
        const pick = (target && target !== "next" ? cands.find((c) => c.title.toLowerCase().includes(target)) : null) ?? cands[0];
        const dr = await fetch(`/api/projects/${projectId}/dispatch`, { method: "POST", headers: { "Content-Type": "application/json", ...(h ?? {}) }, body: JSON.stringify({ kind: pick.kind, id: pick.id }) });
        if (!dr.ok) throw new Error(((await dr.json().catch(() => ({})))?.error) ?? `dispatch ${dr.status}`);
      } else if (a.type === "gate") {
        const { data: g } = await supabase.from("design_gates").select("id").eq("project_id", projectId).eq("status", "pending").order("created_at", { ascending: true }).limit(1).maybeSingle();
        if (!g) throw new Error("no hay ningún gate esperando");
        const { error } = await supabase.from("design_gates").update({ status: "resolved", resolved_at: new Date().toISOString(), outcome: a.outcome ?? "approve" }).eq("id", (g as { id: string }).id);
        if (error) throw error;
      } else if (a.type === "resume") {
        // Reanudar un design-run cortado — reusa el endpoint /design/resume (repone el run failed →
        // el worker lo re-resume desde donde quedó). El bot propone; el usuario confirma acá.
        const tok = await freshToken();
        const rr = await fetch(`/api/projects/${projectId}/design/resume`, { method: "POST", headers: tok ? { authorization: `Bearer ${tok}` } : undefined });
        if (!rr.ok) throw new Error(((await rr.json().catch(() => ({})))?.error) ?? `resume ${rr.status}`);
      } else throw new Error("acción desconocida");
      setActs((s) => ({ ...s, [key]: "done" }));
    } catch {
      setActs((s) => ({ ...s, [key]: "error" }));
    }
  };

  const ACTION_LABEL: Record<string, string> = { increment: "Pedir incremento", dispatch: "Despachar build", gate: "Aprobar gate", resume: "Reanudar diseño" };
  const ACTION_OK: Record<string, string> = { increment: "✓ Encolado — aparecerá en el board tras el gate del Studio.", dispatch: "✓ Despachado — segui el run en Agentes/board.", gate: "✓ Gate aprobado — el diseño sigue a la próxima fase.", resume: "✓ Reanudado — el conductor lo retoma desde donde quedó (miralo en el Studio/Flow)." };

  // Inserta un mensaje persistido y devuelve su fila (con el id real). TIRA si falla — así la
  // persistencia no falla en silencio (P5-4: un mensaje que se muestra pero no se guardó, desaparece
  // al recargar → derrota la "memoria"). El caller decide si abortar o mostrar la respuesta con aviso.
  const insertMsg = async (conversationId: string, role: "user" | "assistant", content: string): Promise<Msg> => {
    const { data, error } = await supabase.from("assistant_messages").insert({ conversation_id: conversationId, project_id: projectId, tenant_id: project?.tenant_id, role, content }).select("id,role,content").single();
    if (error || !data) throw new Error(error?.message ?? "no se pudo guardar el mensaje");
    return data as Msg;
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput(""); setBusy(true); setSessionExpired(false);
    try {
      // 1) Asegurar una conversación (crearla con el título del primer mensaje si es nueva).
      let cid = convId;
      if (!cid) {
        const { data, error } = await supabase.from("assistant_conversations").insert({ project_id: projectId, tenant_id: project?.tenant_id, title: titleFrom(content) }).select("id,title,created_at").single();
        if (error || !data) throw new Error(error?.message ?? "no se pudo crear la conversación");
        cid = (data as Conv).id;
        setConvId(cid);
      }
      // 2) Persistir el mensaje del usuario ANTES de gastar en el worker (si no se guarda, abortá).
      const userMsg = await insertMsg(cid, "user", content);
      const history: Msg[] = [...msgs, userMsg];
      setMsgs(history);
      // 3) Pedir la respuesta al worker (vía proxy), consumiendo el stream SSE.
      const tok = await freshToken();
      const r = await fetch(`/api/projects/${projectId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
      });
      if (r.status === 401) { setSessionExpired(true); setStreaming(null); return; } // sesión vencida → aviso claro.
      // SSE (streaming) o JSON (fallback / error del worker) según content-type.
      const ct = r.headers.get("content-type") ?? "";
      let reply: string;
      if (ct.includes("text/event-stream")) {
        reply = await consumeSse(r, (d) => setStreaming((s) => (s ?? "") + d));
      } else {
        const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
        reply = r.ok ? (j.text ?? "(sin respuesta)") : `⚠ ${j.error ?? `error ${r.status}`}`;
      }
      // 4) Persistir la respuesta (best-effort: si falla, se muestra igual con aviso — no se pierde
      // la respuesta ya generada; Realtime/load reconcilian la lista canónica).
      let asstMsg: Msg | null = null;
      try { asstMsg = await insertMsg(cid, "assistant", reply); }
      catch { /* la mostramos optimista abajo con nota de no-guardado */ }
      setStreaming(null);
      // Guard anti bleed cross-conversación: solo appendeá si seguimos en el mismo hilo (convId vivo).
      const finalMsg: Msg = asstMsg ?? { id: `tmp-a-${Date.now()}`, role: "assistant", content: `${reply}\n\n_(no se pudo guardar en el historial)_` };
      setMsgs((m) => (cid === convIdRef.current ? [...m, finalMsg] : m));
    } catch (e) {
      setStreaming(null);
      // Sesión vencida (el insert a Supabase o el proxy fallan con JWT expired) → aviso de re-login,
      // no un error mudo (Pieza 4).
      if (isAuthError(e)) { setSessionExpired(true); return; }
      setMsgs((m) => [...m, { id: `tmp-e-${Date.now()}`, role: "assistant", content: `⚠ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally { setBusy(false); }
  };

  const newConversation = () => { setConvId(null); setMsgs([]); setInput(""); };
  const deleteConversation = async (id: string) => {
    await supabase.from("assistant_conversations").delete().eq("id", id);
    if (id === convId) { setConvId(null); setMsgs([]); }
  };

  return (
    <div className="brain">
      <div className="brain-inner">
        {/* Barra de conversaciones (P5-4): hilo activo + cambiar de hilo + nuevo. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 2px 10px", borderBottom: "1px solid var(--stroke)" }}>
          {/* Deshabilitado mientras responde: cambiar de hilo mid-stream mezclaría respuestas. */}
          <select
            value={convId ?? ""} onChange={(e) => setConvId(e.target.value || null)} disabled={busy}
            style={{ flex: 1, maxWidth: 420, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--stroke)", background: "var(--bg2)", color: "var(--text)", fontSize: 13, fontFamily: "inherit", opacity: busy ? 0.6 : 1 }}
          >
            {convId === null && <option value="">Conversación nueva…</option>}
            {convs.map((c) => <option key={c.id} value={c.id}>{c.title ?? "Sin título"}</option>)}
          </select>
          <button className="btn ghost sm" onClick={newConversation} disabled={busy} title="Nueva conversación">＋ Nueva</button>
          {convId && <button className="btn ghost sm" onClick={() => void deleteConversation(convId)} disabled={busy} title="Borrar esta conversación">🗑</button>}
        </div>

        <div className="brain-scroll" ref={scrollRef}>
          {msgs.length === 0 && !busy && streaming === null ? (
            <div className="brain-empty">
              <em>Soy el asistente de este proyecto.</em>
              <p>Preguntame por el estado, los costos, qué está trabado, o qué pedir como próximo incremento.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14, alignItems: "center" }}>
                {SUGGESTIONS.map((s) => <button key={s} className="btn ghost sm" onClick={() => void send(s)}>{s}</button>)}
              </div>
            </div>
          ) : (
            msgs.map((m) => {
              const parsed = m.role === "assistant" ? parseAction(m.content) : null;
              return (
                <div key={m.id} className={`brain-row${m.role === "user" ? " user" : ""}`}>
                  <div className={`brain-bubble ${m.role}`}>
                    {m.role !== "assistant" ? m.content : (
                      <>
                        {parsed!.text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed!.text}</ReactMarkdown>}
                        {parsed!.action && ["increment", "dispatch", "gate", "resume"].includes(parsed!.action.type) && acts[m.id] !== "dismissed" && (
                          <div className="brain-action">
                            <div className="h"><span className="tool">{ACTION_LABEL[parsed!.action.type] ?? parsed!.action.type}</span>{parsed!.action.summary ?? ""}</div>
                            {parsed!.action.instructions && <pre>{parsed!.action.instructions}</pre>}
                            <div className="acts">
                              {acts[m.id] === "done" ? <span style={{ color: "var(--emerald)", fontSize: 13 }}>{ACTION_OK[parsed!.action.type] ?? "✓ Hecho."}</span>
                              : acts[m.id] === "error" ? <span style={{ color: "var(--danger)", fontSize: 13 }}>Error al ejecutar. Probá de nuevo o hacelo desde la UI.</span>
                              : <>
                                  <button className="btn" disabled={acts[m.id] === "busy"} onClick={() => void confirmAction(m.id, parsed!.action!)}>{acts[m.id] === "busy" ? "Ejecutando…" : "Confirmar"}</button>
                                  <button className="btn ghost" onClick={() => setActs((s) => ({ ...s, [m.id]: "dismissed" }))}>Descartar</button>
                                </>}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {/* Bubble en vivo mientras el SSE llega (Pieza 2). El markdown parcial (bloques a medio cerrar)
              se muestra en crudo; al terminar, el mensaje persistido con su tarjeta lo reemplaza. */}
          {streaming !== null && (
            <div className="brain-row">
              <div className="brain-bubble assistant"><ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming}</ReactMarkdown></div>
            </div>
          )}
          {busy && streaming === null && <div className="brain-think"><span className="spin" /> pensando…</div>}
        </div>

        {sessionExpired && (
          <div className="brain-err" style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
            <span>⚠ Tu sesión venció. Volvé a iniciar sesión para seguir usando el asistente.</span>
            <a className="btn" href="/login">Iniciar sesión</a>
          </div>
        )}
        <form className="brain-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea
            value={input} onChange={(e) => setInput(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Escribí tu pregunta… (Enter para enviar)"
          />
          <button className="btn" type="submit" disabled={busy || !input.trim()}>Enviar</button>
        </form>
      </div>
    </div>
  );
}
