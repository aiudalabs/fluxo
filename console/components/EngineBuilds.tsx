"use client";

// Observabilidad del ExecEnv fluxo_engine (docs/17). Muestra los build_jobs del proyecto (los que
// corren en el VPS) con su progreso + log EN VIVO — el tailer host-level (fluxo-engine-tail) llena
// build_jobs.log/progress mientras el agente trabaja, y acá lo mostramos por Realtime. Reemplaza la
// "ceguera" de correr en el engine (en Actions se veía el log; acá no había nada).

import { useEffect, useState } from "react";
import { useProject } from "@/lib/project";

interface Progress { turns?: number; bash?: number; edits?: number; reads?: number; cost?: number; last?: string }
interface BuildJob {
  id: string; label: string; status: string; pr_url: string | null;
  log: string | null; progress: Progress | null; cost_usd: number | null; error: string | null;
  created_at: string;
}

const DOT: Record<string, string> = { running: "#0e8a16", done: "#5319e7", failed: "#d4183a", pending: "#9c95a6" };

export default function EngineBuilds() {
  const { projectId, supabase } = useProject();
  const [jobs, setJobs] = useState<BuildJob[]>([]);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const { data } = await supabase
        .from("build_jobs")
        .select("id,label,status,pr_url,log,progress,cost_usd,error,created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(12);
      if (!dead) setJobs((data as BuildJob[]) ?? []);
    };
    void load();
    const ch = supabase
      .channel(`engine-builds:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "build_jobs", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    // fallback poll (por si el Realtime de build_jobs no está en la publicación)
    const poll = setInterval(() => void load(), 6000);
    return () => { dead = true; clearInterval(poll); void supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  if (jobs.length === 0) return null;

  return (
    <section style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 2px 10px" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>⚙ Motor Fluxo — builds en el VPS</h3>
        <span style={{ fontSize: 12, opacity: 0.6 }}>corren en tu engine (sin GitHub Actions) — log en vivo</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {jobs.map((j) => {
          const p = j.progress ?? {};
          const running = j.status === "running";
          return (
            <div key={j.id} style={{ border: "1px solid var(--stroke)", borderRadius: 10, overflow: "hidden", background: "var(--bg2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: j.log ? "1px solid var(--stroke)" : "none" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: DOT[j.status] ?? "#999", boxShadow: running ? `0 0 0 3px ${DOT.running}22` : "none", flexShrink: 0 }} />
                <b style={{ fontSize: 13 }}>{j.label}</b>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{j.status}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>
                  {p.turns ? `${p.turns} turns · ` : ""}{p.bash ? `${p.bash} cmd · ` : ""}{p.edits ? `${p.edits} edits · ` : ""}{(j.cost_usd ?? p.cost) ? `$${(j.cost_usd ?? p.cost)?.toFixed?.(2) ?? j.cost_usd}` : ""}
                </span>
                {j.pr_url && <a href={j.pr_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>PR ↗</a>}
              </div>
              {p.last && running && <div style={{ padding: "6px 12px", fontSize: 12.5, color: "var(--fg)", opacity: 0.85 }}>💬 {p.last}</div>}
              {j.log && (
                <pre style={{ margin: 0, padding: "8px 12px", maxHeight: running ? 240 : 120, overflow: "auto", fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {j.log}
                </pre>
              )}
              {j.error && <div style={{ padding: "6px 12px", fontSize: 12, color: "#d4183a" }}>✗ {j.error}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
