"use client";

// Board (F6P-01/05) · el TicketsView de v1, PORTADO: shell full-bleed (head + toolbar +
// canvas) con tabs Kanban / Tabla / Sprints y filtros por faceta (búsqueda/estado/sprint/
// lane), estilo JIRA. KanbanBoard + LaneChip + statusToken + las clases .tickets-*/.kb-*/
// .ttable/.sprint-* del globals.css de v1, verbatim. Lo ÚNICO distinto vs v1: la data sale
// de Supabase (RLS + Realtime); el adaptador mapea el schema v2 (uuids, review/blocked) a
// OrchestratorTicket (ids/deps/sprint por KEY; review→in_review).

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";
import { KanbanBoard } from "@/components/tickets/KanbanBoard";
import { LaneChip } from "@/components/tickets/LaneChip";
import { TicketDetail } from "@/components/tickets/TicketDetail";
import { DepGraph } from "@/components/tickets/DepGraph";
import { statusToken } from "@/lib/statusToken";
import type { OrchestratorTicket, TicketStatus } from "@/lib/types";

type ViewKind = "kanban" | "tabla" | "sprints" | "grafo";
const VIEWS: ViewKind[] = ["kanban", "tabla", "sprints", "grafo"];
type SprintMeta = { id: string; name: string; goal: string };

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
  const [sprintMeta, setSprintMeta] = useState<SprintMeta[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<ViewKind>("kanban");
  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState<TicketStatus | "all">("all");
  const [fSprint, setFSprint] = useState("all");
  const [fLane, setFLane] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: rows, error }, { data: sprints }] = await Promise.all([
        supabase.from("stories").select("*").eq("project_id", projectId),
        supabase.from("sprints").select("id,key,title,goal").eq("project_id", projectId),
      ]);
      if (cancelled) return;
      if (error) { setState("error"); return; }
      const sprintKey = new Map((sprints ?? []).map((s) => [s.id as string, s.key as string]));
      const keyById = new Map((rows ?? []).map((s) => [s.id as string, s.key as string]));
      // Meta de sprint keyed por KEY (el sprint_id del ticket es la KEY): name + goal.
      setSprintMeta((sprints ?? []).map((s) => ({
        id: s.key as string, name: (s.title as string) || (s.key as string), goal: (s.goal as string) ?? "",
      })));
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
  const sprintOpts = useMemo(() => [...new Set(tickets.map((tk) => tk.sprint_id).filter(Boolean) as string[])].sort(), [tickets]);
  const laneOpts = useMemo(() => [...new Set(tickets.map((tk) => tk.owner).filter(Boolean) as string[])].sort(), [tickets]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tickets.filter((tk) => {
      if (fStatus !== "all" && tk.status !== fStatus) return false;
      if (fSprint !== "all" && (tk.sprint_id || "") !== fSprint) return false;
      if (fLane !== "all" && (tk.owner || "") !== fLane) return false;
      if (needle && !`${tk.id} ${tk.title} ${tk.body ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [tickets, fStatus, fSprint, fLane, q]);

  const hasFilter = q.trim() !== "" || fStatus !== "all" || fSprint !== "all" || fLane !== "all";
  const viewDesc = t(`tickets.desc.${view}`);

  return (
    <div className="tickets-shell">
      <div className="tickets-head">
        <h2>{t("tickets.title")}</h2>
        <span className="c">{viewDesc}</span>
        <span className="sp" />
        <div style={{ display: "flex", gap: 2, background: "var(--bg2)", border: "1px solid var(--stroke)", borderRadius: 10, padding: 3 }}>
          {VIEWS.map((v) => (
            <button key={v} className={`btn sm${view === v ? " primary" : " ghost"}`}
              style={{ borderRadius: 7, border: "none", boxShadow: "none" }} onClick={() => setView(v)}>
              {t(`tickets.tab.${v}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="tickets-toolbar">
        <input className="inp" style={{ width: 220 }} placeholder={t("tickets.toolbar.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="inp" style={{ width: "auto" }} value={fStatus} onChange={(e) => setFStatus(e.target.value as TicketStatus | "all")}>
          <option value="all">{t("tickets.toolbar.allStatuses")}</option>
          {(["backlog", "ready", "running", "in_review", "done", "failed"] as TicketStatus[]).map((s) => (
            <option key={s} value={s}>{t(`tickets.statusLabel.${s}`)}</option>
          ))}
        </select>
        {sprintOpts.length > 0 && (
          <select className="inp" style={{ width: "auto" }} value={fSprint} onChange={(e) => setFSprint(e.target.value)}>
            <option value="all">{t("tickets.toolbar.allSprints")}</option>
            {sprintOpts.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {laneOpts.length > 0 && (
          <select className="inp" style={{ width: "auto" }} value={fLane} onChange={(e) => setFLane(e.target.value)}>
            <option value="all">{t("tickets.toolbar.allLanes")}</option>
            {laneOpts.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        {hasFilter && (
          <button className="btn ghost sm" onClick={() => { setQ(""); setFStatus("all"); setFSprint("all"); setFLane("all"); }}>
            {t("tickets.toolbar.clear")}
          </button>
        )}
        <span className="sp" style={{ flex: 1 }} />
        <span className="tickets-count">
          {hasFilter ? `${filtered.length}/${tickets.length}` : tickets.length}
        </span>
      </div>

      {state === "loading" ? (
        <div className="tickets-canvas pad"><div className="placeholder"><span className="spin" /></div></div>
      ) : state === "error" ? (
        <div className="tickets-canvas pad"><div className="placeholder err">{t("common.error")}</div></div>
      ) : view === "tabla" ? (
        <div className="tickets-canvas pad"><TicketsTable tickets={filtered} gates={gates} onOpenTicket={setOpenId} onOpenRun={() => {}} /></div>
      ) : view === "sprints" ? (
        <div className="tickets-canvas pad"><SprintsView tickets={filtered} meta={sprintMeta} onOpenTicket={setOpenId} /></div>
      ) : view === "grafo" ? (
        <div className="tickets-canvas"><DepGraph tickets={filtered} onOpenTicket={setOpenId} /></div>
      ) : (
        <div className="tickets-canvas">
          <KanbanBoard tickets={filtered} gates={gates} onOpenTicket={setOpenId} onOpenRun={() => {}} />
        </div>
      )}

      <TicketDetail
        ticket={openId ? tickets.find((tk) => tk.id === openId) ?? null : null}
        onClose={() => setOpenId(null)}
        onOpenTicket={setOpenId}
      />
    </div>
  );
}

// ── Vista Tabla — lista densa: lane, sprint, deps, estado, PR, run (portada de v1) ──
function TicketsTable({ tickets, gates, onOpenTicket, onOpenRun }: {
  tickets: OrchestratorTicket[]; gates: Map<string, string[]>;
  onOpenTicket: (id: string) => void; onOpenRun: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="ttable">
      <div className="trow">
        <span>{t("tickets.col.id")}</span><span>{t("tickets.col.title")}</span>
        <span>{t("tickets.col.lane")}</span><span>{t("tickets.col.sprint")}</span>
        <span>{t("tickets.col.deps")}</span><span>{t("tickets.col.status")}</span>
        <span>{t("tickets.col.pr")}</span><span>{t("tickets.col.run")}</span>
      </div>
      {tickets.map((tk) => {
        const gate = tk.sprint_id ? gates.get(tk.sprint_id) : undefined;
        const gated = !!gate?.length && (tk.status === "ready" || tk.status === "backlog");
        return (
          <div key={tk.id} className="trow click" onClick={() => onOpenTicket(tk.id)}>
            <span className="id">{tk.id}</span>
            <span className="ttl">{tk.title}</span>
            <span>{tk.owner ? <LaneChip lane={tk.owner} /> : <span style={{ color: "var(--ink4)", fontSize: 12 }}>—</span>}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink4)" }}>{tk.sprint_id || "—"}</span>
            <span className="dep">{tk.deps && tk.deps.length > 0 ? tk.deps.join(", ") : "—"}</span>
            <span>
              <span className={`pill ${statusToken(tk.status).pill}`} style={gated ? { opacity: 0.55 } : undefined}>
                {t(`tickets.status.${tk.status}`)}
              </span>
            </span>
            <span>
              {tk.pr_url ? (
                <a className="kb-pr" href={tk.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR ↗</a>
              ) : <span style={{ color: "var(--ink4)", fontSize: 12 }}>—</span>}
            </span>
            <span>
              {tk.run_id ? (
                <button className="kb-run" onClick={(e) => { e.stopPropagation(); onOpenRun(tk.run_id!); }}>{tk.run_id.slice(0, 10)}…</button>
              ) : <span style={{ color: "var(--ink4)", fontSize: 12 }}>—</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Vista Sprints — el plan como sprints colapsables (JIRA Backlog), portada de v1 ──
function sprintNum(id: string): number {
  const n = parseInt(id.replace(/\D/g, ""), 10);
  return isNaN(n) ? 999 : n;
}
function sprintState(statuses: TicketStatus[]): TicketStatus {
  for (const s of ["failed", "running", "in_review", "ready", "backlog", "done"] as TicketStatus[]) {
    if (statuses.includes(s)) return s;
  }
  return "done";
}
function SprintsView({ tickets, meta, onOpenTicket }: {
  tickets: OrchestratorTicket[]; meta: SprintMeta[]; onOpenTicket: (id: string) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const metaById = new Map(meta.map((s) => [s.id, s]));
    const sprintOf = new Map(tickets.map((tk) => [tk.id, tk.sprint_id || ""]));
    const doneIds = new Set(tickets.filter((tk) => tk.status === "done").map((tk) => tk.id));
    const by = new Map<string, OrchestratorTicket[]>();
    for (const tk of tickets) {
      const sid = tk.sprint_id || "—";
      (by.get(sid) ?? by.set(sid, []).get(sid)!).push(tk);
    }
    const out = [] as { id: string; name: string; goal: string; stories: OrchestratorTicket[]; done: number; state: TicketStatus; waitingOn: string[] }[];
    for (const [id, stories] of by) {
      const waiting = new Set<string>();
      for (const tk of stories) for (const d of tk.deps ?? []) {
        const depSprint = sprintOf.get(d);
        if (depSprint && depSprint !== id && !doneIds.has(d)) waiting.add(depSprint);
      }
      const m = metaById.get(id);
      out.push({
        id, name: m?.name ?? id, goal: m?.goal ?? "", stories,
        done: stories.filter((tk) => tk.status === "done").length,
        state: sprintState(stories.map((tk) => tk.status)),
        waitingOn: [...waiting].sort((a, b) => sprintNum(a) - sprintNum(b)),
      });
    }
    return out.sort((a, b) => sprintNum(a.id) - sprintNum(b.id));
  }, [tickets, meta]);

  const isOpen = (g: { id: string; state: TicketStatus }) => (g.id in collapsed ? !collapsed[g.id] : g.state !== "done");
  if (groups.length === 0) return <div className="placeholder">{t("tickets.sprints.empty")}</div>;

  return (
    <div className="sprints">
      {groups.map((g) => {
        const open = isOpen(g);
        const pct = g.stories.length ? Math.round((g.done / g.stories.length) * 100) : 0;
        return (
          <section key={g.id} className="sprint-card">
            <button className="sprint-head" onClick={() => setCollapsed((c) => ({ ...c, [g.id]: open }))} aria-expanded={open}>
              <span className="sprint-caret">{open ? "▾" : "▸"}</span>
              <span className="sprint-id">{g.id}</span>
              <span className="sprint-name">{g.name.replace(/^Sprint\s+\d+\s*[—-]\s*/, "")}</span>
              <span className="sprint-bar"><span className={`sprint-fill st-${g.state}`} style={{ width: `${pct}%` }} /></span>
              <span className="sprint-count">{g.done}/{g.stories.length}</span>
              <span className={`sprint-tag st-${g.state}`}>{t(`tickets.statusLabel.${g.state}`)}</span>
            </button>
            {open && (
              <div className="sprint-body">
                {g.goal && <p className="sprint-goal">🎯 {g.goal}</p>}
                {g.waitingOn.length > 0 && g.state !== "done" && (
                  <p className="sprint-waiting">{t("tickets.sprints.waitingOn", { list: g.waitingOn.join(", ") })}</p>
                )}
                <div className="sprint-stories">
                  {g.stories.map((story) => {
                    const gated = g.waitingOn.length > 0 && (story.status === "ready" || story.status === "backlog");
                    return (
                      <button key={story.id} className="sprint-story" onClick={() => onOpenTicket(story.id)}>
                        <span className="sprint-story-id">{story.id}</span>
                        <span className="sprint-story-ttl">{story.title}</span>
                        {story.owner && <LaneChip lane={story.owner} />}
                        <span className={`pill ${statusToken(story.status).pill}`} style={gated ? { opacity: 0.55 } : undefined}>
                          {t(`tickets.statusLabel.${story.status}`)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
