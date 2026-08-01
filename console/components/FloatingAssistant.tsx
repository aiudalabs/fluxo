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
      <button className="sh-fab" type="button" aria-label="AI Assistant" onClick={() => setOpen((o) => !o)}>
        {open ? "✕" : "✦"}
      </button>
      {open && (
        <div className="sh-astpanel">
          <div className="sh-astpanel-h">
            <span className="t">✦ AI Assistant</span>
            <button className="x" type="button" aria-label="Cerrar" onClick={() => setOpen(false)}>✕</button>
          </div>
          <AssistantChat />
        </div>
      )}
    </>
  );
}
