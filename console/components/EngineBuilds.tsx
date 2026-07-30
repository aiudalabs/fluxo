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
  story_keys: string[] | null; created_at: string;
}
const DOT: Record<string, string> = { running: "#0e8a16", done: "#5319e7", failed: "#d4183a", cancelling: "#c97c1a", pending: "#9c95a6" };

export function useBuildJobs() {
  const { projectId, supabase } = useProject();
  const uid = useId(); // canal ÚNICO por instancia del hook (Agents + EngineBuilds lo usan a la vez →
                       // dos canales con el mismo nombre rompían Realtime con una excepción de cliente).
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      const { data } = await supabase.from("build_jobs")
        .select("id,label,status,pr_url,log,progress,cost_usd,error,story_keys,created_at")
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
    <div style={{ border: "1px solid var(--stroke)", borderRadius: 10, overflow: "hidden", background: "var(--bg2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: j.log ? "pointer" : "default" }} onClick={() => j.log && setOpen((v) => !v)}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: DOT[j.status] ?? "#999", boxShadow: running ? `0 0 0 3px ${DOT.running}22` : "none", flexShrink: 0 }} />
        <b style={{ fontSize: 13 }}>{j.label}</b>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{j.status}</span>
        <span className="sp" style={{ flex: 1 }} />
        <span style={{ fontSize: 12, opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>
          {p.turns ? `${p.turns} turns · ` : ""}{p.edits ? `${p.edits} edits · ` : ""}{cost ? `$${Number(cost).toFixed(2)}` : ""}
        </span>
        {j.pr_url && <a href={j.pr_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }} onClick={(e) => e.stopPropagation()}>PR ↗</a>}
        {running && <button className="btn ghost sm" disabled={stopping} onClick={(e) => { e.stopPropagation(); void stop(); }} title="Detener en el VPS">{stopping ? "…" : "⏹ Detener"}</button>}
        {j.log && <span style={{ fontSize: 13, opacity: 0.6, width: 14, textAlign: "center" }}>{open ? "▾" : "▸"}</span>}
      </div>
      {open && p.last && running && <div style={{ padding: "0 12px 6px", fontSize: 12.5, opacity: 0.85 }}>💬 {p.last}</div>}
      {open && j.log && (
        <pre style={{ margin: 0, padding: "8px 12px", maxHeight: 460, overflow: "auto", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          {j.log}
        </pre>
      )}
      {j.error && <div style={{ padding: "6px 12px", fontSize: 12, color: "#d4183a" }}>✗ {j.error}</div>}
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
    <section style={{ marginBottom: only ? 8 : 16 }}>
      {!only && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 2px 10px" }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>⚙ Motor Fluxo — builds en el VPS</h3>
          <span style={{ fontSize: 12, opacity: 0.6 }}>corren en tu engine (sin Actions) — clic para ver el log</span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {shown.map((j) => <BuildCard key={j.id} j={j} projectId={projectId} />)}
      </div>
    </section>
  );
}
