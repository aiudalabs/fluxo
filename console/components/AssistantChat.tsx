"use client";

// P5-1 · AI Assistant (chat). UI portada de v1 (clases .brain* de globals.css) → look pulido + el
// bubble del asistente se renderiza como MARKDOWN (react-markdown), no texto crudo. Manda la historia
// a /api/projects/[id]/assistant (proxy → worker, donde corre el agent-loop con el token). v1 read-only.

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProject } from "@/lib/project";
import { sessionToken } from "@/lib/supabaseClient";

type Msg = { role: "user" | "assistant"; content: string };
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

export function AssistantChat() {
  const { projectId, project, supabase } = useProject();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [acts, setActs] = useState<Record<number, ActState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  // Confirmar una acción propuesta → ejecutar por el path que ya existe (el bot nunca dispara solo).
  const confirmAction = async (idx: number, a: ActionProposal) => {
    setActs((s) => ({ ...s, [idx]: "busy" }));
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
      setActs((s) => ({ ...s, [idx]: "done" }));
    } catch {
      setActs((s) => ({ ...s, [idx]: "error" }));
    }
  };

  const ACTION_LABEL: Record<string, string> = { increment: "Pedir incremento", dispatch: "Despachar build", gate: "Aprobar gate" };
  const ACTION_OK: Record<string, string> = { increment: "✓ Encolado — aparecerá en el board tras el gate del Studio.", dispatch: "✓ Despachado — segui el run en Agentes/board.", gate: "✓ Gate aprobado — el diseño sigue a la próxima fase." };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      const tok = await sessionToken();
      const r = await fetch(`/api/projects/${projectId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ messages: next }),
      });
      const j = await r.json().catch(() => ({}));
      setMsgs((m) => [...m, { role: "assistant", content: r.ok ? (j.text ?? "(sin respuesta)") : `⚠ ${j.error ?? `error ${r.status}`}` }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `⚠ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally { setBusy(false); }
  };

  return (
    <div className="brain">
      <div className="brain-inner">
        <div className="brain-scroll" ref={scrollRef}>
          {msgs.length === 0 ? (
            <div className="brain-empty">
              <em>Soy el asistente de este proyecto.</em>
              <p>Preguntame por el estado, los costos, qué está trabado, o qué pedir como próximo incremento.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14, alignItems: "center" }}>
                {SUGGESTIONS.map((s) => <button key={s} className="btn ghost sm" onClick={() => void send(s)}>{s}</button>)}
              </div>
            </div>
          ) : (
            msgs.map((m, i) => {
              const parsed = m.role === "assistant" ? parseAction(m.content) : null;
              return (
                <div key={i} className={`brain-row${m.role === "user" ? " user" : ""}`}>
                  <div className={`brain-bubble ${m.role}`}>
                    {m.role !== "assistant" ? m.content : (
                      <>
                        {parsed!.text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed!.text}</ReactMarkdown>}
                        {parsed!.action && ["increment", "dispatch", "gate"].includes(parsed!.action.type) && acts[i] !== "dismissed" && (
                          <div className="brain-action">
                            <div className="h"><span className="tool">{ACTION_LABEL[parsed!.action.type] ?? parsed!.action.type}</span>{parsed!.action.summary ?? ""}</div>
                            {parsed!.action.instructions && <pre>{parsed!.action.instructions}</pre>}
                            <div className="acts">
                              {acts[i] === "done" ? <span style={{ color: "var(--emerald)", fontSize: 13 }}>{ACTION_OK[parsed!.action.type] ?? "✓ Hecho."}</span>
                              : acts[i] === "error" ? <span style={{ color: "var(--danger)", fontSize: 13 }}>Error al ejecutar. Probá de nuevo o hacelo desde la UI.</span>
                              : <>
                                  <button className="btn" disabled={acts[i] === "busy"} onClick={() => void confirmAction(i, parsed!.action!)}>{acts[i] === "busy" ? "Ejecutando…" : "Confirmar"}</button>
                                  <button className="btn ghost" onClick={() => setActs((s) => ({ ...s, [i]: "dismissed" }))}>Descartar</button>
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
