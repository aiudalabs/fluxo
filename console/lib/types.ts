// Tipos del backlog/board — portados de v1 (aiuda-forge). El board/kanban rinde estas
// shapes; en v2 salen de Supabase (map en el data-hook), no de un REST propio.

export type TicketStatus = "backlog" | "ready" | "running" | "in_review" | "done" | "failed";

export interface OrchestratorTicket {
  id: string;
  title: string;
  body?: string;
  acceptance?: string;
  status: TicketStatus;
  deps: string[];
  run_id?: string;
  sprint_id?: string;
  epic_id?: string;
  owner?: string;
  pr_url?: string;
  session_url?: string;
  external_ref?: string;
  repo?: string;
  kind?: string;
  screen_key?: string;
  agent_lost?: string;
}

export interface DispatchCandidate {
  kind: "story" | "sprint";
  id: string;
  title: string;
  stories: string[];
  lane: string;
  model: string;
  executor: string;
}

// ── Diseño / Flow (portados de v1) — el grafo /flow deriva de estas shapes ──────
export type DesignStepStatus = "QUEUED" | "RUNNING" | "DONE" | "AWAITING" | "FAILED";

export interface DesignPhase {
  stepId: string;  // "discovery" | "prd" | "architecture" | "ui" | "backlog" | "handoff"
  name: string;    // "Descubrimiento", "PRD", etc.
  gateId?: string; // id del human_gate de la fase; "" / undefined si no tiene
  designStatus: DesignStepStatus; // estado del paso de diseño (el agente)
  gateStatus: DesignStepStatus;   // estado del gate (human_gate)
}

// Sprint del backlog. Los sellos de ceremonia (unix-millis; 0/ausente = nunca):
// *_at = ceremonia aplicada; *_run_id = run de la ceremonia (feature-detect de Flow).
export interface Sprint {
  id: string;
  name: string;
  goal: string;
  project_id?: string;
  planned_at?: number;
  planning_run_id?: string;
  reviewed_at?: number;
  review_run_id?: string;
  retro_at?: number;
  retro_run_id?: string;
}
