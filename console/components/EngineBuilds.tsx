"use client";

// Observabilidad del ExecEnv fluxo_engine (docs/17). UNA task por build (no doble): status + progreso,
// y un toggle para DESPLEGAR el log completo en vivo (el tailer fluxo-engine-tail llena
// build_jobs.log/progress; Realtime lo trae). Detener REAL: marca cancel → el tailer mata el proceso.
// `only` limita a un build_job (para reusar en el board sobre una story puntual).

import { useEffect, useId, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { activeToken } from "@/lib/supabaseClient";

interface Progress { turns?: number; bash?: number; edits?: number; reads?: number; cost?: number; last?: string }
export interface BuildJob {
  id: string; label: string; status: string; pr_url: string | null;
  log: string | null; progress: Progress | null; cost_usd: number | null; error: string | null;
  story_keys: string[] | null; created_at: string; kind: string | null;
}

export function useBuildJobs() {
  const { projectId, supabase } = useProject();
  const uid = useId(); // canal ÚNICO por instancia del hook (Agents + EngineBuilds lo usan a la vez →
                       // dos canales con el mismo nombre rompían Realtime con una excepción de cliente).
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      const { data } = await supabase.from("build_jobs")
        .select("id,label,status,pr_url,log,progress,cost_usd,error,story_keys,created_at,kind")
        .eq("project_id", projectId).order("created_at", { ascending: false }).limit(20);
      if (!dead) setJobs((data as BuildJob[]) ?? []);
    };
    void load();
    const ch = supabase.channel(`engine-builds:${projectId}:${uid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "build_jobs", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    const poll = setInterval(() => void load(), 5000);
    return () => { dead = true; clearInterval(poll); void supabase.removeChannel(ch); };
  }, [projectId, supabase, uid]);
  return jobs;
}

function BuildCard({ j, projectId }: { j: BuildJob; projectId: string }) {
  const running = j.status === "running";
  const [open, setOpen] = useState(false); // siempre colapsado por defecto (clic para abrir el log)
  const [stopping, setStopping] = useState(false);
  const p = j.progress ?? {};
  const cost = j.cost_usd ?? p.cost;

  const stop = async () => {
    if (stopping || !window.confirm(`¿Detener el build ${j.label}? El proceso en el VPS se corta y la story vuelve al backlog.`)) return;
    setStopping(true);
    try {
      const tok = activeToken();
      await fetch(`/api/projects/${projectId}/build-jobs/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ id: j.id }),
      });
    } catch { /* realtime refleja */ } finally { setStopping(false); }
  };

  return (
    <div className="eb-card">
      <div className={`eb-bar${j.log ? " click" : ""}`} onClick={() => j.log && setOpen((v) => !v)}>
        <span className={`eb-dot ${j.status}`} />
        {j.kind === "review" && <span className="kb-badge eb-kind-review" title="Review autónomo del reviewer (build+run del incremento)">review</span>}
        <b className="eb-label">{j.label}</b>
        <span className="eb-status">{j.status}</span>
        <span className="sp" />
        <span className="eb-metrics">
          {p.turns ? `${p.turns} turns · ` : ""}{p.edits ? `${p.edits} edits · ` : ""}{cost ? `$${Number(cost).toFixed(2)}` : ""}
        </span>
        {j.pr_url && <a className="kb-pr" href={j.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR ↗</a>}
        {running && <button className="btn ghost ag-stop" disabled={stopping} onClick={(e) => { e.stopPropagation(); void stop(); }} title="Detener en el VPS">{stopping ? "…" : "⏹ Detener"}</button>}
        {j.log && <span className="eb-caret">{open ? "▾" : "▸"}</span>}
      </div>
      {open && p.last && running && <div className="eb-last">💬 {p.last}</div>}
      {open && j.log && <pre className="eb-log">{j.log}</pre>}
      {j.error && <div className="eb-error">✗ {j.error}</div>}
    </div>
  );
}

// EngineBuilds (Agentes): muestra los builds RUNNING + los 3 más recientes no-running. `only` filtra a
// los build_jobs de una story (para el board).
export default function EngineBuilds({ only }: { only?: string } = {}) {
  const { projectId } = useProject();
  const jobs = useBuildJobs();
  const shown = useMemo(() => {
    let js = jobs;
    if (only) js = js.filter((j) => (j.story_keys ?? []).includes(only));
    const running = js.filter((j) => j.status === "running" || j.status === "cancelling");
    const rest = js.filter((j) => j.status !== "running" && j.status !== "cancelling").slice(0, only ? 2 : 3);
    return [...running, ...rest];
  }, [jobs, only]);

  if (shown.length === 0) return null;
  return (
    <section className={`eb-section${only ? " compact" : ""}`}>
      {!only && (
        <div className="eb-head">
          <h3>⚙ Motor Fluxo — builds en el VPS</h3>
          <span className="eb-hint">corren en tu engine (sin Actions) — clic para ver el log</span>
        </div>
      )}
      <div className="eb-list">
        {shown.map((j) => <BuildCard key={j.id} j={j} projectId={projectId} />)}
      </div>
    </section>
  );
}
