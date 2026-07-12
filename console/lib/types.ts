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
