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
import { sessionToken } from "@/lib/supabaseClient";

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

// Título del hilo = las primeras palabras del primer mensaje (para la lista de conversaciones).
function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

export function AssistantChat() {
  const { projectId, project, supabase } = useProject();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [acts, setActs] = useState<Record<string, ActState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

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
        const tok = await sessionToken();
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
      } else throw new Error("acción desconocida");
      setActs((s) => ({ ...s, [key]: "done" }));
    } catch {
      setActs((s) => ({ ...s, [key]: "error" }));
    }
  };

  const ACTION_LABEL: Record<string, string> = { increment: "Pedir incremento", dispatch: "Despachar build", gate: "Aprobar gate" };
  const ACTION_OK: Record<string, string> = { increment: "✓ Encolado — aparecerá en el board tras el gate del Studio.", dispatch: "✓ Despachado — segui el run en Agentes/board.", gate: "✓ Gate aprobado — el diseño sigue a la próxima fase." };

  // Inserta un mensaje persistido y devuelve su fila (para tener el id real en el estado).
  const insertMsg = async (conversationId: string, role: "user" | "assistant", content: string): Promise<Msg | null> => {
    const { data } = await supabase.from("assistant_messages").insert({ conversation_id: conversationId, project_id: projectId, tenant_id: project?.tenant_id, role, content }).select("id,role,content").single();
    return (data as Msg) ?? null;
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput(""); setBusy(true);
    try {
      // 1) Asegurar una conversación (crearla con el título del primer mensaje si es nueva).
      let cid = convId;
      if (!cid) {
        const { data, error } = await supabase.from("assistant_conversations").insert({ project_id: projectId, tenant_id: project?.tenant_id, title: titleFrom(content) }).select("id,title,created_at").single();
        if (error || !data) throw new Error(error?.message ?? "no se pudo crear la conversación");
        cid = (data as Conv).id;
        setConvId(cid);
      }
      // 2) Persistir el mensaje del usuario (optimista en estado + fila real).
      const userMsg = await insertMsg(cid, "user", content);
      const history: Msg[] = [...msgs, userMsg ?? { id: `tmp-${Date.now()}`, role: "user", content }];
      setMsgs(history);
      // 3) Pedir la respuesta al worker (vía proxy) con toda la historia.
      const tok = await sessionToken();
      const r = await fetch(`/api/projects/${projectId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
      });
      const j = await r.json().catch(() => ({}));
      const reply = r.ok ? (j.text ?? "(sin respuesta)") : `⚠ ${j.error ?? `error ${r.status}`}`;
      // 4) Persistir la respuesta del asistente (Realtime/load reconcilian la lista canónica).
      const asstMsg = await insertMsg(cid, "assistant", reply);
      setMsgs((m) => [...m, asstMsg ?? { id: `tmp-a-${Date.now()}`, role: "assistant", content: reply }]);
    } catch (e) {
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
          <select
            value={convId ?? ""} onChange={(e) => setConvId(e.target.value || null)}
            style={{ flex: 1, maxWidth: 420, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--stroke)", background: "var(--bg2)", color: "var(--text)", fontSize: 13, fontFamily: "inherit" }}
          >
            {convId === null && <option value="">Conversación nueva…</option>}
            {convs.map((c) => <option key={c.id} value={c.id}>{c.title ?? "Sin título"}</option>)}
          </select>
          <button className="btn ghost sm" onClick={newConversation} title="Nueva conversación">＋ Nueva</button>
          {convId && <button className="btn ghost sm" onClick={() => void deleteConversation(convId)} title="Borrar esta conversación">🗑</button>}
        </div>

        <div className="brain-scroll" ref={scrollRef}>
          {msgs.length === 0 && !busy ? (
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
                        {parsed!.action && ["increment", "dispatch", "gate"].includes(parsed!.action.type) && acts[m.id] !== "dismissed" && (
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
          {busy && <div className="brain-think"><span className="spin" /> pensando…</div>}
        </div>

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
