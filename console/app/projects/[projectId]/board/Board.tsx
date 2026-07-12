"use client";

// Board (F6P-01) · el kanban JIRA de v1, PORTADO verbatim (KanbanBoard + LaneChip +
// statusToken + las clases .tickets-*/.kb-* del globals.css de v1). Lo ÚNICO distinto
// vs v1: la data sale de Supabase (RLS + Realtime) en vez del REST propio. El adaptador
// del data-hook mapea el schema v2 (uuids + estados `review`/`blocked`) a la shape
// `OrchestratorTicket` que el board espera (ids/deps/sprint por KEY; `review`→`in_review`).

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";
import { KanbanBoard } from "@/components/tickets/KanbanBoard";
import type { OrchestratorTicket, TicketStatus } from "@/lib/types";

// v2 usa `review` y `blocked`; el board (statusToken) usa `in_review`. Adaptamos.
function mapStatus(s: string): TicketStatus {
  if (s === "review") return "in_review";
  if (s === "blocked") return "backlog";
  return s as TicketStatus;
}

// Cross-sprint gating (portado de TicketsView.waitingBySprint): por sprint, qué sprints
// espera (deps cross-sprint no-done). El board pinta "⧗ waiting on SPn".
function waitingBySprint(tickets: OrchestratorTicket[]): Map<string, string[]> {
  const sprintOf = new Map(tickets.map((t) => [t.id, t.sprint_id || ""]));
  const doneIds = new Set(tickets.filter((t) => t.status === "done").map((t) => t.id));
  const waiting = new Map<string, Set<string>>();
  for (const t of tickets) {
    const sid = t.sprint_id || "";
    if (!sid) continue;
    for (const d of t.deps ?? []) {
      const depSprint = sprintOf.get(d);
      if (depSprint && depSprint !== sid && !doneIds.has(d)) {
        (waiting.get(sid) ?? waiting.set(sid, new Set()).get(sid)!).add(depSprint);
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const [sid, set] of waiting) out.set(sid, [...set].sort());
  return out;
}

export default function Board() {
  const { projectId, supabase } = useProject();
  const t = useT();
  const [tickets, setTickets] = useState<OrchestratorTicket[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: rows, error }, { data: sprints }] = await Promise.all([
        supabase.from("stories").select("*").eq("project_id", projectId),
        supabase.from("sprints").select("id,key").eq("project_id", projectId),
      ]);
      if (cancelled) return;
      if (error) { setState("error"); return; }
      const sprintKey = new Map((sprints ?? []).map((s) => [s.id as string, s.key as string]));
      const keyById = new Map((rows ?? []).map((s) => [s.id as string, s.key as string]));
      const mapped: OrchestratorTicket[] = (rows ?? []).map((s) => ({
        id: s.key,
        title: s.title,
        body: s.body ?? undefined,
        acceptance: s.acceptance ?? undefined,
        status: mapStatus(s.status),
        deps: ((s.blocked_by as string[] | null) ?? []).map((u) => keyById.get(u) ?? u),
        run_id: s.run_id ?? undefined,
        sprint_id: s.sprint_id ? sprintKey.get(s.sprint_id) : undefined,
        epic_id: s.epic_id ?? undefined,
        owner: s.lane ?? undefined,
        pr_url: s.pr_url ?? undefined,
        session_url: s.session_url ?? undefined,
        external_ref: s.external_ref ?? undefined,
        kind: s.kind ?? undefined,
        agent_lost: s.agent_lost ?? undefined,
      }));
      mapped.sort((a, b) => a.id.localeCompare(b.id));
      setTickets(mapped);
      setState("ready");
    };
    void load();
    // Realtime: cualquier cambio en stories del proyecto → recargar (RLS-scoped).
    const ch = supabase
      .channel(`board:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stories", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  const gates = useMemo(() => waitingBySprint(tickets), [tickets]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return tickets;
    return tickets.filter((tk) => `${tk.id} ${tk.title} ${tk.body ?? ""}`.toLowerCase().includes(needle));
  }, [tickets, q]);

  return (
    <div className="tickets-shell">
      <div className="tickets-head">
        <h2>{t("nav.tickets.title")}</h2>
        <span className="c">{t("tickets.desc.kanban")}</span>
      </div>
      <div className="tickets-toolbar">
        <input
          placeholder={t("tickets.toolbar.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 220 }}
        />
        <span className="sp" />
        <span className="tickets-count">
          {list.length === tickets.length ? tickets.length : `${list.length}/${tickets.length}`}
        </span>
      </div>
      <div className="tickets-canvas">
        {state === "loading" ? (
          <div className="placeholder"><span className="spin" /></div>
        ) : state === "error" ? (
          <div className="placeholder err">{t("common.error")}</div>
        ) : (
          <KanbanBoard
            tickets={list}
            gates={gates}
            onOpenTicket={() => {}}
            onOpenRun={() => {}}
          />
        )}
      </div>
    </div>
  );
}
