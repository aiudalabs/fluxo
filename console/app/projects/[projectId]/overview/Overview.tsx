"use client";

// Overview (F6P-05) · el home del proyecto de v1, PORTADO: specs (Confluence) + flujo
// (JIRA) de un vistazo — "¿qué construimos?" (docs) y "¿dónde va?" (progreso de sprints,
// qué corre). Lo ÚNICO distinto vs v1: la data sale de Supabase (stories + design_phases).
// El KPI de gasto muestra $0.00 mientras no haya telemetría de runs (backend F5).

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { IncrementRequest } from "@/components/IncrementRequest";
import { useT } from "@/lib/i18n";
import type { OrchestratorTicket, TicketStatus } from "@/lib/types";
import { statusToken } from "@/lib/statusToken";

// Actividad en vivo — cada story reciente como una línea del "glass box".
type Rec = { key: string; title: string; status: TicketStatus; pr: string | null; session: string | null; at: string };
function relTime(iso: string): string {
  const d = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(d / 60000), h = Math.floor(m / 60), day = Math.floor(h / 24);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  if (h < 24) return `hace ${h} h`;
  if (day === 1) return "ayer";
  return `hace ${day} d`;
}
function activityPhrase(s: TicketStatus, session: string | null): string {
  switch (s) {
    case "running": return session ? "un agente la está construyendo · sesión activa" : "un agente la está construyendo";
    case "in_review": return "PR abierto — esperando revisión";
    case "done": return "entregada — merge a main";
    case "ready": return "lista para despachar";
    case "failed": return "falló — vuelve al backlog";
    default: return "en el backlog";
  }
}

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
  const { projectId, supabase, project } = useProject();
  const t = useT();
  const [tickets, setTickets] = useState<OrchestratorTicket[]>([]);
  const [docNames, setDocNames] = useState<string[]>([]);
  const [recent, setRecent] = useState<Rec[]>([]);
  const [descOpen, setDescOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: rows }, { data: runs }, { data: rec }] = await Promise.all([
        supabase.from("stories").select("key,title,status,sprint_id,blocked_by").eq("project_id", projectId),
        supabase.from("design_runs").select("id").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1),
        supabase.from("stories").select("key,title,status,pr_url,session_url,updated_at").eq("project_id", projectId).order("updated_at", { ascending: false }).limit(6),
      ]);
      if (cancelled) return;
      setRecent(((rec as Record<string, unknown>[]) ?? []).map((s) => ({
        key: s.key as string, title: (s.title as string) ?? "", status: mapStatus(s.status as string),
        pr: (s.pr_url as string | null) ?? null, session: (s.session_url as string | null) ?? null, at: s.updated_at as string,
      })));
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
    // Tiempo real: cualquier cambio de estado de una story refresca la actividad (glass box).
    const ch = supabase
      .channel(`overview:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stories", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
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
          <h2 className="ov-title">{project?.name ?? "…"}</h2>
          {project?.repo && (
            <a className="ov-repo" href={project.repo} target="_blank" rel="noreferrer" title="Abrir el repo en GitHub">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              {project.repo.replace(/^https?:\/\/github\.com\//, "")}
            </a>
          )}
          {project?.description && (
            <>
              <p className={`ov-desc${descOpen ? " open" : ""}`}>{project.description}</p>
              {project.description.length > 220 && (
                <button className="ov-desc-more" onClick={() => setDescOpen((v) => !v)}>{descOpen ? "ver menos" : "ver más"}</button>
              )}
            </>
          )}
        </div>
        <div className="ov-progress">
          <div className="ov-progress-top">
            <span className="ov-progress-pct serif">{stats.pct}%</span>
            <span className="ov-progress-sub">{t("overview.stories", { done: stats.done, total: stats.total })}</span>
          </div>
          <div className="ov-bar"><div className="ov-bar-fill" style={{ width: `${stats.pct}%` }} /></div>
        </div>
      </div>

      {/* Actividad en vivo — el "glass box": qué está pasando en la fábrica ahora mismo. */}
      {recent.length > 0 && (
        <div className="ov-feed">
          <div className="ov-feed-h">
            <h3>Actividad en vivo</h3>
            <span className="ov-feed-sub mono">tiempo real</span>
          </div>
          {recent.map((r) => {
            const link = r.session ?? r.pr ?? null;
            return (
              <div key={r.key} className="ov-ev">
                <span className="ov-ev-dot" style={{ color: statusToken(r.status).color }} />
                <div className="ov-ev-tx">
                  <span><b className="mono">{r.key}</b> {r.title} — {activityPhrase(r.status, r.session)}</span>
                  <span className="ov-ev-t">{relTime(r.at)}{link && <a href={link} target="_blank" rel="noreferrer" className="ov-ev-lk"> · abrir ↗</a>}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Guía para no quedar en un dead-end: si todavía no hay backlog (stories), el proyecto está
          EN DISEÑO → el próximo paso es el Studio (responder gates, aprobar fases). CTA prominente. */}
      {stats.total === 0 && (
        <Link href={`/projects/${projectId}/studio`} className="ov-designcta">
          <span className="ov-designcta-ic">✎</span>
          <span className="ov-designcta-txt">
            <b>Tu producto está en diseño.</b> En el <b>Studio</b> respondés las preguntas del agente y aprobás cada fase
            (discovery → PRD → schema → UI → arquitectura → backlog).
            {docNames.length > 0 ? ` Ya hay ${docNames.length} documento${docNames.length === 1 ? "" : "s"} listo${docNames.length === 1 ? "" : "s"}.` : " Abrilo para ver el progreso en vivo."}
          </span>
          <span className="ov-designcta-cta">Abrir Studio →</span>
        </Link>
      )}

      {project?.repo && <div style={{ marginBottom: 18 }}><IncrementRequest /></div>}

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
          <div className="n serif" style={{ color: "var(--amber)" }}>{stats.inReview}</div>
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
