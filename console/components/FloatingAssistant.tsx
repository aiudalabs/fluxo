"use client";

// P5-1 · Panel flotante del AI Assistant — el mismo chat, disponible sobre cualquier vista (board,
// studio, etc.) desde un botón fijo. Reusa <AssistantChat/> (el `.brain` flex:1 llena el panel).
// Se oculta en la página dedicada /assistant (ahí ya está el chat a pantalla completa).

import { useState } from "react";
import { usePathname } from "next/navigation";
import { AssistantChat } from "./AssistantChat";

export function FloatingAssistant() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  if (pathname?.endsWith("/assistant")) return null; // no duplicar en la página dedicada

  return (
    <>
      <button
        aria-label="AI Assistant" onClick={() => setOpen((o) => !o)}
        style={{ position: "fixed", bottom: 22, right: 22, zIndex: 950, width: 52, height: 52, borderRadius: 999, border: "1px solid var(--accent-line)", background: "var(--accent)", color: "#fff", fontSize: 21, cursor: "pointer", boxShadow: "var(--shadow-accent)", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        {open ? "✕" : "✦"}
      </button>
      {open && (
        <div style={{ position: "fixed", bottom: 84, right: 22, zIndex: 950, width: "min(440px, 94vw)", height: "min(600px, 78vh)", display: "flex", flexDirection: "column", background: "var(--panel)", border: "1px solid var(--stroke-strong)", borderRadius: 18, boxShadow: "var(--shadow-soft)", overflow: "hidden" }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--stroke)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 13.5 }}>✦ AI Assistant</span>
            <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(false)}>✕</button>
          </div>
          <AssistantChat />
        </div>
      )}
    </>
  );
}
