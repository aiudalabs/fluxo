"use client";

// Overview (F6P-05) · el home del proyecto de v1, PORTADO: specs (Confluence) + flujo
// (JIRA) de un vistazo — "¿qué construimos?" (docs) y "¿dónde va?" (progreso de sprints,
// qué corre). Lo ÚNICO distinto vs v1: la data sale de Supabase (stories + design_phases).
// El KPI de gasto muestra $0.00 mientras no haya telemetría de runs (backend F5).

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";
import type { OrchestratorTicket, TicketStatus } from "@/lib/types";

const DOC_TITLE_KEY: Record<string, string> = {
  "BRIEF.md": "overview.doc.brief",
  "PRD.md": "overview.doc.prd",
  "ARCHITECTURE.md": "overview.doc.architecture",
  "UI_SCREENS.md": "overview.doc.uiScreens",
  "backlog.yaml": "overview.doc.backlog",
  "SESSION.md": "overview.doc.session",
};
const STATUS_LABEL_KEY: Record<TicketStatus, string> = {
  backlog: "overview.status.backlog", ready: "overview.status.ready", running: "overview.status.running",
  in_review: "overview.status.in_review", done: "overview.status.done", failed: "overview.status.failed",
};

function mapStatus(s: string): TicketStatus {
  if (s === "review") return "in_review";
  if (s === "blocked") return "backlog";
  return s as TicketStatus;
}
function sprintState(statuses: TicketStatus[]): TicketStatus {
  for (const s of ["failed", "running", "in_review", "ready", "backlog", "done"] as TicketStatus[]) {
    if (statuses.includes(s)) return s;
  }
  return "done";
}
function sprintRows(tickets: OrchestratorTicket[]) {
  const by = new Map<string, OrchestratorTicket[]>();
  for (const t of tickets) {
    const sid = t.sprint_id || "—";
    (by.get(sid) ?? by.set(sid, []).get(sid)!).push(t);
  }
  return [...by.entries()].map(([id, ts]) => ({
    id, total: ts.length, done: ts.filter((t) => t.status === "done").length, state: sprintState(ts.map((t) => t.status)),
  })).sort((a, b) => {
    const na = parseInt(a.id.replace(/\D/g, ""), 10), nb = parseInt(b.id.replace(/\D/g, ""), 10);
    if (isNaN(na)) return 1; if (isNaN(nb)) return -1; return na - nb;
  });
}

export default function Overview() {
  const { projectId, supabase } = useProject();
  const t = useT();
  const [tickets, setTickets] = useState<OrchestratorTicket[]>([]);
  const [docNames, setDocNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: rows }, { data: runs }] = await Promise.all([
        supabase.from("stories").select("key,title,status,sprint_id,blocked_by").eq("project_id", projectId),
        supabase.from("design_runs").select("id").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1),
      ]);
      if (cancelled) return;
      const sprintKeyRes = await supabase.from("sprints").select("id,key").eq("project_id", projectId);
      const sprintKey = new Map((sprintKeyRes.data ?? []).map((s) => [s.id as string, s.key as string]));
      setTickets(((rows as Record<string, unknown>[]) ?? []).map((s) => ({
        id: s.key as string, title: (s.title as string) ?? "", status: mapStatus(s.status as string),
        deps: (s.blocked_by as string[] | null) ?? [],
        sprint_id: s.sprint_id ? sprintKey.get(s.sprint_id as string) : undefined,
      })));
      const runId = (runs as { id: string }[])?.[0]?.id ?? null;
      if (runId) {
        const { data: ph } = await supabase.from("design_phases").select("artifacts").eq("run_id", runId);
        if (cancelled) return;
        const names = new Set<string>();
        for (const p of (ph as { artifacts: { path: string }[] }[]) ?? []) for (const a of p.artifacts ?? []) names.add(a.path.replace(/^.*\//, ""));
        setDocNames([...names]);
      }
      setLoading(false);
    };
    void load();
  }, [projectId, supabase]);

  const stats = useMemo(() => {
    const count = (s: TicketStatus) => tickets.filter((t) => t.status === s).length;
    const done = count("done");
    return {
      total: tickets.length, done, running: count("running"), inReview: count("in_review"),
      pct: tickets.length ? Math.round((done / tickets.length) * 100) : 0, sprints: sprintRows(tickets),
    };
  }, [tickets]);
  const sprintsDone = stats.sprints.filter((s) => s.state === "done" && s.total > 0).length;

  if (loading) return <div className="wrap"><div className="placeholder"><span className="spin" /> {t("overview.loading")}</div></div>;

  return (
    <div className="wrap">
      <div className="ov-hero">
        <div>
          <div className="eyebrow acc">{t("overview.eyebrow")}</div>
          <h2 className="ov-title">Rosa la peluquería</h2>
          <p className="ov-desc">Una app donde la clienta reserva sola y Rosa administra su agenda — con recordatorios por WhatsApp y seña online.</p>
        </div>
        <div className="ov-progress">
          <div className="ov-progress-top">
            <span className="ov-progress-pct serif">{stats.pct}%</span>
            <span className="ov-progress-sub">{t("overview.stories", { done: stats.done, total: stats.total })}</span>
          </div>
          <div className="ov-bar"><div className="ov-bar-fill" style={{ width: `${stats.pct}%` }} /></div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="eyebrow">{t("overview.kpi.sprintsDone")}</div>
          <div className="n serif">{sprintsDone}<span className="ov-of"> / {stats.sprints.length}</span></div>
        </div>
        <div className="stat">
          <div className="eyebrow">{t("overview.kpi.running")}</div>
          <div className="n serif" style={{ color: "var(--navy)" }}>{stats.running}</div>
          <div className="sub">{t("overview.kpi.running.sub")}</div>
        </div>
        <div className="stat">
          <div className="eyebrow">{t("overview.kpi.inReview")}</div>
          <div className="n serif" style={{ color: "#7a5d00" }}>{stats.inReview}</div>
          <div className="sub">{t("overview.kpi.inReview.sub")}</div>
        </div>
        <div className="stat">
          <div className="eyebrow">{t("overview.kpi.spend")}</div>
          <div className="n serif acc">$0.00</div>
          <div className="sub">{t("overview.kpi.spend.sub", { n: 0 })}</div>
        </div>
      </div>

      <div className="ov-cols">
        <section className="ov-card">
          <div className="ov-card-head">
            <span>{t("overview.spec")}</span>
            <Link href={`/projects/${projectId}/studio`} className="ov-link">{t("overview.spec.open")}</Link>
          </div>
          {docNames.length === 0 ? (
            <div className="ov-empty">{t("overview.spec.empty")}</div>
          ) : (
            <div className="ov-doclist">
              {docNames.map((name) => (
                <Link key={name} href={`/projects/${projectId}/studio`} className="ov-docitem">
                  <span className="ov-docname">{DOC_TITLE_KEY[name] ? t(DOC_TITLE_KEY[name]) : name}</span>
                  <span className="ov-docarrow">→</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="ov-card">
          <div className="ov-card-head">
            <span>{t("overview.flow")}</span>
            <Link href={`/projects/${projectId}/board`} className="ov-link">{t("overview.flow.open")}</Link>
          </div>
          {stats.sprints.length === 0 ? (
            <div className="ov-empty">{t("overview.flow.empty")}</div>
          ) : (
            <div className="ov-sprints">
              {stats.sprints.map((s) => (
                <div key={s.id} className="ov-sprint">
                  <span className="ov-sprint-id">{s.id}</span>
                  <div className="ov-sprint-bar">
                    <div className={`ov-sprint-fill st-${s.state}`} style={{ width: `${s.total ? (s.done / s.total) * 100 : 0}%` }} />
                  </div>
                  <span className="ov-sprint-count">{s.done}/{s.total}</span>
                  <span className={`ov-sprint-tag st-${s.state}`}>{t(STATUS_LABEL_KEY[s.state])}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
