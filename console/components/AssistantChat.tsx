"use client";

// P5-1 · AI Assistant (chat). Manda la historia a /api/projects/[id]/assistant (que proxea al worker,
// donde corre el agent-loop con el token de suscripción). v1 read-only: responde sobre el estado del
// proyecto y sugiere acciones (que confirmás desde la UI). El panel flotante + las tools de acción
// (con confirmación) son los próximos incrementos de P5-1.

import { useEffect, useRef, useState } from "react";
import { useProject } from "@/lib/project";
import { sessionToken } from "@/lib/supabaseClient";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "¿Cómo va el proyecto? ¿Qué está trabado?",
  "¿Cuánto se gastó hasta ahora y en qué?",
  "¿Qué me conviene pedir como próximo incremento?",
];

export function AssistantChat() {
  const { projectId, project } = useProject();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

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
    <div className="wrap" style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", height: "calc(100vh - 120px)" }}>
      <div style={{ marginBottom: 12 }}>
        <div className="eyebrow acc">AI Assistant</div>
        <h2 className="ov-title" style={{ margin: "2px 0 0" }}>{project?.name ?? "…"}</h2>
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}>
        {msgs.length === 0 && (
          <div style={{ margin: "auto", textAlign: "center", color: "var(--muted)", maxWidth: 520 }}>
            <p style={{ fontSize: 14 }}>Preguntame sobre este proyecto — estado, costos, qué está trabado, o qué pedir como incremento.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
              {SUGGESTIONS.map((s) => <button key={s} className="btn ghost sm" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.role === "user" ? "var(--accent-soft)" : "var(--panel)", border: `1px solid ${m.role === "user" ? "var(--accent-line)" : "var(--stroke)"}`, borderRadius: 12, padding: "10px 14px", fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {m.content}
          </div>
        ))}
        {busy && <div style={{ alignSelf: "flex-start", color: "var(--muted)", fontSize: 13 }}><span className="spin" /> pensando…</div>}
        <div ref={endRef} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "flex-end" }}>
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Escribí tu pregunta… (Enter para enviar, Shift+Enter para nueva línea)"
          style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--stroke)", background: "var(--bg2)", color: "var(--text)", fontSize: 13, fontFamily: "inherit", resize: "none" }}
        />
        <button className="btn" disabled={busy || !input.trim()} onClick={() => void send()}>Enviar</button>
      </div>
    </div>
  );
}
