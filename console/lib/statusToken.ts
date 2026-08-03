// statusToken — ÚNICA fuente de verdad del lenguaje visual de los 6 estados de una
// story. Antes había 5 maps divergentes (TicketsView, KanbanBoard, DepGraph,
// TicketDetail, SprintsView) que colapsaban ready=running y backlog=in_review al
// mismo color de pill. Todo call site importa de aquí.

import type { TicketStatus } from "./types";

export interface StatusToken {
  /** Modificador de .pill (globals.css): cada estado tiene el suyo. */
  pill: string;
  /** Color fuerte (headers de columna, conteos, leyenda). */
  color: string;
  /** Fondo suave (chips translúcidos sobre panel). */
  soft: string;
  /** Borde del nodo en el grafo. */
  border: string;
  /** Superficie SÓLIDA del nodo (par container M3 — los fondos translúcidos
      desaparecían sobre el canvas oscuro del grafo). */
  container: string;
  /** Texto sobre `container` (contraste garantizado en ambos temas). */
  onContainer: string;
  /** Glifo compacto (grafo / leyenda). */
  icon: string;
}

export const STATUS_ORDER: TicketStatus[] = [
  "backlog",
  "ready",
  "running",
  "in_review",
  "done",
  "failed",
];

export const STATUS_TOKENS: Record<TicketStatus, StatusToken> = {
  backlog: {
    pill: "queued",
    color: "var(--ink4)",
    soft: "var(--bg3)",
    border: "var(--stroke-strong)",
    container: "var(--md-surface-container-high)",
    onContainer: "var(--md-on-surface-variant)",
    icon: "⏳",
  },
  ready: {
    pill: "ready",
    color: "var(--cyan)",
    soft: "var(--cyan-soft)",
    border: "var(--cyan)",
    container: "var(--md-tertiary-container)",
    onContainer: "var(--md-on-tertiary-container)",
    icon: "⟳",
  },
  running: {
    pill: "run_",
    color: "var(--accent)",
    soft: "var(--accent-soft)",
    border: "var(--accent)",
    container: "var(--md-primary-container)",
    onContainer: "var(--md-on-primary-container)",
    icon: "⟳",
  },
  in_review: {
    pill: "review",
    color: "var(--amber)",
    soft: "var(--amber-soft)",
    border: "var(--amber)",
    container: "var(--md-warning-container)",
    onContainer: "var(--md-on-warning-container)",
    icon: "⌾",
  },
  done: {
    pill: "done",
    color: "var(--emerald)",
    soft: "var(--emerald-soft)",
    border: "var(--emerald)",
    container: "var(--md-success-container)",
    onContainer: "var(--md-on-success-container)",
    icon: "✓",
  },
  failed: {
    pill: "fail",
    color: "var(--danger)",
    soft: "var(--danger-soft)",
    border: "var(--danger)",
    container: "var(--md-error-container)",
    onContainer: "var(--md-on-error-container)",
    icon: "✗",
  },
};

export function statusToken(s: TicketStatus): StatusToken {
  return STATUS_TOKENS[s] ?? STATUS_TOKENS.backlog;
}

// AGENT_LOST_TOKEN — NO es un estado del ciclo (una story con la sesión perdida
// vuelve a `backlog`); es un OVERLAY que el conductor pone cuando declaró muerta
// la sesión del agente (task de Copilot purgada / label agent:running stale) y la
// devolvió al backlog para re-despacho. Vive aquí para que statusToken siga siendo
// la ÚNICA fuente del lenguaje visual: el badge "agente perdido" usa estos tokens.
export const AGENT_LOST_TOKEN: StatusToken = {
  pill: "lost",
  color: "var(--danger)",
  soft: "var(--danger-soft)",
  border: "var(--danger)",
  container: "var(--md-error-container)",
  onContainer: "var(--md-on-error-container)",
  icon: "⚠",
};
