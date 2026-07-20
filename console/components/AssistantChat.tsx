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

const SUGGESTIONS = [
  "¿Cómo va el proyecto y qué está trabado?",
  "¿Cuánto se gastó hasta ahora y en qué?",
  "¿Qué me conviene pedir como próximo incremento?",
];

export function AssistantChat() {
  const { projectId } = useProject();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

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
            msgs.map((m, i) => (
              <div key={i} className={`brain-row${m.role === "user" ? " user" : ""}`}>
                <div className={`brain-bubble ${m.role}`}>
                  {m.role === "assistant"
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    : m.content}
                </div>
              </div>
            ))
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
