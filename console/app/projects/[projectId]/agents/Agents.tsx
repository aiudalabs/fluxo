"use client";

// Agents (F6b) · el MONITOR del conductor — la vista Agentes de v1 portada. Tres paneles:
//   1. Sesiones activas — stories `running` con su session_url (link "ver sesión" en GitHub Actions).
//   2. Cola de PRs — stories `review` con pr_url, deduplicadas por PR (un sprint = 1 PR cierra N
//      issues → se muestra una vez con sus stories).
//   3. Aprobar workflows — los runs `action_required` del repo (GET /runs, token del usuario) +
//      botón que aprueba (POST /runs). Es el "aprobar workflows" MANUAL de v1 (el auto_if_safe es F5).
//
// Data en vivo: Realtime de Supabase para las stories (RLS-scoped, igual que el board); poll para
// los runs de GitHub (no hay webhook en v2 todavía — poll primero, golden rule del plan).

import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/lib/project";
import { activeToken } from "@/lib/supabaseClient";
import { useT } from "@/lib/i18n";
import EngineBuilds from "@/components/EngineBuilds";

type Story = { id: string; key: string; title: string; status: string; session_url: string | null; pr_url: string | null };
type Run = { id: number; name: string; title: string; html_url: string; branch: string; event: string; created_at: string };

export default function Agents() {
  const { projectId, supabase } = useProject();
  const t = useT();
  const [stories, setStories] = useState<Story[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [approving, setApproving] = useState<Set<number>>(new Set());
  const [stopping, setStopping] = useState<Set<string>>(new Set());

  // Detener un build: cancela el run de Actions + resetea la story a backlog (para "running" real o
  // el falso que quedó pegado cuando la Action falló). El realtime de stories recarga al cambiar.
  const stop = async (storyKey: string) => {
    setStopping((s) => new Set(s).add(storyKey));
    try {
      const tok = activeToken();
      await fetch(`/api/projects/${projectId}/runs/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ storyKey }),
      });
    } catch { /* el realtime refleja el resultado */ }
    finally { setStopping((s) => { const n = new Set(s); n.delete(storyKey); return n; }); }
  };

  // Runs de GitHub: token de la sesión (los endpoints actúan como el usuario). Poll (sin webhook).
  const loadRuns = useCallback(async () => {
    const tok = activeToken();
    try {
      const res = await fetch(`/api/projects/${projectId}/runs`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
      if (!res.ok) { setRuns([]); return; }
      const data = (await res.json()) as { runs: Run[] };
      setRuns(data.runs ?? []);
    } catch { setRuns([]); }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const loadStories = async () => {
      const { data, error } = await supabase
        .from("stories")
        .select("id,key,title,status,session_url,pr_url")
        .eq("project_id", projectId);
      if (cancelled) return;
      if (error) { setState("error"); return; }
      setStories((data as Story[]) ?? []);
      setState("ready");
    };
    void loadStories();
    void loadRuns();
    // Realtime: cualquier cambio en stories del proyecto → recargar (RLS-scoped).
    const ch = supabase
      .channel(`agents:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stories", filter: `project_id=eq.${projectId}` }, () => void loadStories())
      .subscribe();
    // Poll de runs cada 15s (los runs de GitHub no llegan por Realtime).
    const poll = setInterval(() => void loadRuns(), 15_000);
    return () => { cancelled = true; clearInterval(poll); void supabase.removeChannel(ch); };
  }, [projectId, supabase, loadRuns]);

  const approve = useCallback(async (runId: number) => {
    if (approving.has(runId)) return;
    setApproving((s) => new Set(s).add(runId));
    try {
      const tok = activeToken();
      const res = await fetch(`/api/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ runId }),
      });
      if (res.ok) setRuns((rs) => rs.filter((r) => r.id !== runId)); // optimista; el poll reconcilia
    } catch { /* el poll reconcilia */ }
    finally { setApproving((s) => { const n = new Set(s); n.delete(runId); return n; }); }
  }, [approving, projectId]);

  const sessions = stories.filter((s) => s.status === "running");
  // Cola de PRs: stories en review con PR, deduplicadas por pr_url (sprint = 1 PR cierra N issues).
  const prByUrl = new Map<string, Story[]>();
  for (const s of stories) {
    if (s.status !== "review" || !s.pr_url) continue;
    (prByUrl.get(s.pr_url) ?? prByUrl.set(s.pr_url, []).get(s.pr_url)!).push(s);
  }
  const prQueue = [...prByUrl.entries()].map(([url, sts]) => ({ url, stories: sts }));

  return (
    <div className="tickets-shell">
      <div className="tickets-head">
        <h2>{t("agents.title")}</h2>
        <span className="c">{t("agents.desc")}</span>
        <span className="sp" style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => { void loadRuns(); }}>{t("agents.refresh")}</button>
      </div>

      {state === "loading" ? (
        <div className="tickets-canvas pad"><div className="placeholder"><span className="spin" /></div></div>
      ) : state === "error" ? (
        <div className="tickets-canvas pad"><div className="placeholder err">{t("agents.error")}</div></div>
      ) : (
        <div className="tickets-canvas pad" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {/* ── Motor Fluxo · builds en el VPS con log en vivo (docs/17) ────── */}
          <EngineBuilds />
          {/* ── Panel 1 · Sesiones activas ─────────────────────────────────── */}
          <Panel title={t("agents.sessions.title")} count={t("agents.sessions.count", { n: sessions.length })}>
            {sessions.length === 0 ? (
              <Empty text={t("agents.sessions.empty")} />
            ) : (
              sessions.map((s) => (
                <div key={s.id} className="agent-row" style={rowStyle}>
                  <span className="pill run_" style={{ fontSize: 10.5 }}>{s.key}</span>
                  <span style={ttlStyle}>{s.title}</span>
                  <span className="sp" style={{ flex: 1 }} />
                  {s.session_url && (
                    <a className="kb-pr" href={s.session_url} target="_blank" rel="noreferrer" title={t("agents.sessions.openSession")}>{t("agents.sessions.session")} ↗</a>
                  )}
                  {s.pr_url && (
                    <a className="kb-pr" href={s.pr_url} target="_blank" rel="noreferrer" title={t("agents.sessions.openPR")}>{t("agents.sessions.pr")} ↗</a>
                  )}
                  <button className="btn ghost sm" disabled={stopping.has(s.key)} onClick={() => void stop(s.key)}
                    title="Detener este build y volver la story al backlog">
                    {stopping.has(s.key) ? "…" : "⏹ Detener"}
                  </button>
                </div>
              ))
            )}
          </Panel>

          {/* ── Panel 2 · Cola de PRs ──────────────────────────────────────── */}
          <Panel title={t("agents.prs.title")} count={t("agents.prs.count", { n: prQueue.length })}>
            {prQueue.length === 0 ? (
              <Empty text={t("agents.prs.empty")} />
            ) : (
              prQueue.map((pr) => (
                <div key={pr.url} className="agent-row" style={rowStyle}>
                  <span className="pill review" style={{ fontSize: 10.5 }}>{pr.stories.length === 1 ? pr.stories[0].key : `${pr.stories.length} stories`}</span>
                  <span style={ttlStyle}>
                    {t("agents.prs.stories")} {pr.stories.map((s) => s.key).join(", ")}
                  </span>
                  <span className="sp" style={{ flex: 1 }} />
                  <a className="kb-pr" href={pr.url} target="_blank" rel="noreferrer" title={t("agents.prs.openPR")}>{t("agents.sessions.pr")} ↗</a>
                </div>
              ))
            )}
          </Panel>

          {/* ── Panel 3 · Aprobar workflows ────────────────────────────────── */}
          <Panel title={t("agents.prs.approve")} count={String(runs.length)}>
            {runs.length === 0 ? (
              <Empty text={t("agents.prs.empty")} />
            ) : (
              runs.map((r) => (
                <div key={r.id} className="agent-row" style={rowStyle}>
                  <span className="pill queued" style={{ fontSize: 10.5 }}>{r.branch || r.event}</span>
                  <span style={ttlStyle}>{r.title || r.name}</span>
                  <span className="sp" style={{ flex: 1 }} />
                  {r.html_url && <a className="kb-pr" href={r.html_url} target="_blank" rel="noreferrer">run ↗</a>}
                  <button className="btn sm" disabled={approving.has(r.id)} onClick={() => void approve(r.id)}>
                    {approving.has(r.id) ? t("agents.prs.approving") : t("agents.prs.approve")}
                  </button>
                </div>
              ))
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
  border: "1px solid var(--stroke)", borderRadius: 10, background: "var(--bg2)",
};
const ttlStyle: React.CSSProperties = { fontSize: 13, color: "var(--ink2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function Panel({ title, count, children }: { title: string; count: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", margin: 0 }}>{title}</h3>
        <span style={{ fontSize: 12, color: "var(--ink4)" }}>{count}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ fontSize: 12.5, color: "var(--ink4)", padding: "6px 2px" }}>{text}</div>;
}
