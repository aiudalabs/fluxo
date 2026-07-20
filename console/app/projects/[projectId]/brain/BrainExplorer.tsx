"use client";

// Observabilidad (P4-2) — reencuadre del "Brain" como TRAZAS estilo Langfuse/Arize. El store sigue
// siendo brain_events (golden rule 7); acá cambia la presentación: (a) Dashboard de totales, (b) tab
// Trazas = run→fases (duración+costo por fase, instrumentado P4-2) + builds (run_costs) con los
// eventos semánticos como anotaciones en el span, (c) tab Eventos = el log append-only (auditoría).

import { useEffect, useMemo, useState } from "react";
import { DocView } from "@/components/DocView";
import { type BrainEvent } from "@/lib/supabaseClient";
import { useProject } from "@/lib/project";
import { useLocale } from "@/lib/locale";

const KIND_COLOR: Record<string, string> = {
  decision: "#a371f7",
  gate_answer: "#3fb950",
  rejected_design: "#f85149",
  provenance: "#58a6ff",
};

type P = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v));

type PhaseRow = {
  phase_id: string; label: string | null; status: string; ord: number;
  created_at: string; updated_at: string; artifacts: unknown[] | null;
  usd: number | null; input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; duration_ms: number | null; model: string | null;
};
type CostRow = { run_id: string; issues: string | null; usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; created_at: string };

const fmtUsd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(4)}`);
const fmtTok = (n: number | null | undefined) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtDur = (ms: number) => (ms <= 0 ? "—" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

export default function BrainExplorer() {
  const { projectId, supabase } = useProject();
  const { t } = useLocale();
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [phases, setPhases] = useState<PhaseRow[]>([]);
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [tab, setTab] = useState<"traces" | "events">("traces");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [ev, ph, co] = await Promise.all([
        supabase.from("brain_events").select("*").eq("project_id", projectId).order("ts", { ascending: false }).limit(300),
        supabase.from("design_phases").select("phase_id,label,status,ord,created_at,updated_at,artifacts,usd,input_tokens,output_tokens,cache_read_tokens,duration_ms,model").eq("project_id", projectId).order("ord", { ascending: true }),
        supabase.from("run_costs").select("run_id,issues,usd,input_tokens,output_tokens,cache_read_tokens,created_at").eq("project_id", projectId).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      if (ev.error) { setError(ev.error.message); setStatus("error"); return; }
      setEvents((ev.data as BrainEvent[]) ?? []);
      setPhases((ph.data as PhaseRow[]) ?? []); // si la migración de costos no está, las cols vienen null
      setCosts((co.data as CostRow[]) ?? []);
      setStatus("ready");
    };
    void load();
    const channel = supabase
      .channel(`obs:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "brain_events", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "design_phases", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "run_costs", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [projectId, supabase]);

  // Dashboard: costo de diseño (suma design_phases.usd) + build (run_costs) + tokens + conteos.
  const totals = useMemo(() => {
    const designUsd = phases.reduce((s, p) => s + (p.usd ?? 0), 0);
    const buildUsd = costs.reduce((s, c) => s + (c.usd ?? 0), 0);
    const inTok = phases.reduce((s, p) => s + (p.input_tokens ?? 0), 0) + costs.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
    const outTok = phases.reduce((s, p) => s + (p.output_tokens ?? 0), 0) + costs.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
    return { designUsd, buildUsd, total: designUsd + buildUsd, inTok, outTok, phases: phases.length, runs: costs.length };
  }, [phases, costs]);

  if (status === "loading") return <p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>;
  if (status === "error") return <p style={{ color: "#f85149" }}>{t("brain.readError", { msg: error })}</p>;

  return (
    <div style={{ margin: "1rem 0" }}>
      {/* Dashboard de totales */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <Stat label="Costo total" value={fmtUsd(totals.total)} accent />
        <Stat label="Diseño" value={fmtUsd(totals.designUsd)} />
        <Stat label="Build" value={fmtUsd(totals.buildUsd)} />
        <Stat label="Tokens in / out" value={`${fmtTok(totals.inTok)} / ${fmtTok(totals.outTok)}`} />
        <Stat label="Fases · Runs" value={`${totals.phases} · ${totals.runs}`} />
      </div>

      {/* Tabs Trazas / Eventos */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={`btn ghost sm${tab === "traces" ? " on" : ""}`} onClick={() => setTab("traces")}>Trazas</button>
        <button className={`btn ghost sm${tab === "events" ? " on" : ""}`} onClick={() => setTab("events")}>Eventos ({events.length})</button>
      </div>

      {tab === "traces"
        ? <Traces phases={phases} costs={costs} events={events} t={t} />
        : <Events events={events} t={t} />}
    </div>
  );
}

// ── Trazas ──────────────────────────────────────────────────────────────────────
function Traces({ phases, costs, events, t }: { phases: PhaseRow[]; costs: CostRow[]; events: BrainEvent[]; t: (k: string, v?: Record<string, string | number>) => string }) {
  // gate_answer events → anotación en el span de su fase (match por el gate/label, best-effort).
  const gateByPhase = useMemo(() => {
    const m = new Map<string, BrainEvent>();
    for (const e of events) {
      if (e.kind !== "gate_answer") continue;
      const g = str(e.payload.gate).toLowerCase();
      for (const ph of phases) {
        const pid = ph.phase_id.toLowerCase();
        if (g.includes(pid) || pid.includes(g.replace(/[-_]?gate$/, ""))) { if (!m.has(ph.phase_id)) m.set(ph.phase_id, e); }
      }
    }
    return m;
  }, [events, phases]);

  const maxDur = Math.max(1, ...phases.map((p) => durMs(p)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {phases.length > 0 && (
        <div>
          <div className="eyebrow acc" style={{ marginBottom: 8 }}>Traza de diseño — {phases.length} fases</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {phases.map((p) => {
              const d = durMs(p);
              const nArt = Array.isArray(p.artifacts) ? p.artifacts.length : 0;
              const gate = gateByPhase.get(p.phase_id);
              return (
                <div key={p.phase_id} style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <span style={{ fontWeight: 600, minWidth: 130 }}>{p.label || p.phase_id}</span>
                    {/* barra de duración */}
                    <span style={{ flex: 1, height: 8, background: "var(--bg2)", borderRadius: 999, overflow: "hidden", minWidth: 60 }}>
                      <span style={{ display: "block", height: "100%", width: `${Math.max(3, (d / maxDur) * 100)}%`, background: "var(--accent)", borderRadius: 999 }} />
                    </span>
                    <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", minWidth: 56, textAlign: "right" }}>{fmtDur(d)}</span>
                    <span style={{ minWidth: 64, textAlign: "right", color: p.usd == null ? "var(--muted)" : "var(--text)", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(p.usd)}</span>
                    <span style={{ color: "var(--muted)", minWidth: 70, textAlign: "right" }}>{p.input_tokens == null ? "—" : `${fmtTok(p.input_tokens)}/${fmtTok(p.output_tokens)}`}</span>
                    <StatusDot status={p.status} />
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>{nArt} art</span>
                  </div>
                  {gate && (
                    <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: "2px solid #3fb950", fontSize: 12 }}>
                      <span style={{ color: "#3fb950", fontWeight: 600 }}>gate {str(gate.payload.outcome)}</span>
                      {str(gate.payload.feedback) && <span style={{ color: "var(--muted)" }}> · {str(gate.payload.feedback).slice(0, 120)}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {costs.length > 0 && (
        <div>
          <div className="eyebrow acc" style={{ marginBottom: 8 }}>Trazas de build — {costs.length} runs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {costs.map((c, i) => (
              <div key={`${c.run_id}-${i}`} style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <span style={{ flex: 1, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.issues || c.run_id.slice(0, 8)}</span>
                <span style={{ minWidth: 64, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(c.usd)}</span>
                <span style={{ color: "var(--muted)", minWidth: 70, textAlign: "right" }}>{fmtTok(c.input_tokens)}/{fmtTok(c.output_tokens)}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{new Date(c.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {phases.length === 0 && costs.length === 0 && <p style={{ color: "var(--muted)" }}>{t("brain.empty")}</p>}
    </div>
  );
}

function durMs(p: PhaseRow): number {
  if (p.duration_ms != null && p.duration_ms > 0) return p.duration_ms;
  const a = new Date(p.created_at).getTime(); const b = new Date(p.updated_at).getTime();
  return b > a ? b - a : 0;
}

function StatusDot({ status }: { status: string }) {
  const c = status === "done" ? "#3fb950" : status === "running" ? "#d29922" : status === "failed" ? "#f85149" : "var(--muted)";
  return <span title={status} style={{ width: 8, height: 8, borderRadius: 999, background: c, display: "inline-block" }} />;
}
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ border: `1px solid ${accent ? "var(--accent-line)" : "var(--border)"}`, background: "var(--panel)", borderRadius: 10, padding: "8px 14px", minWidth: 110 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent ? "var(--accent)" : "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

// ── Eventos (el log append-only — auditoría; se conserva) ─────────────────────────
function Events({ events, t }: { events: BrainEvent[]; t: (k: string, v?: Record<string, string | number>) => string }) {
  const [filter, setFilter] = useState<string>("all");
  const kinds = useMemo(() => Array.from(new Set(events.map((e) => e.kind))).sort(), [events]);
  const shown = useMemo(() => (filter === "all" ? events : events.filter((e) => e.kind === filter)), [events, filter]);
  if (events.length === 0) return <p style={{ color: "var(--muted)" }}>{t("brain.empty")}</p>;
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <Chip label={`${t("brain.all")} (${events.length})`} active={filter === "all"} color="var(--accent)" onClick={() => setFilter("all")} />
        {kinds.map((k) => (
          <Chip key={k} label={`${t(`kind.${k}`)} (${events.filter((e) => e.kind === k).length})`} active={filter === k} color={KIND_COLOR[k] ?? "var(--muted)"} onClick={() => setFilter(k)} />
        ))}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map((e) => (
          <li key={e.id} style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: KIND_COLOR[e.kind] ?? "var(--text)", border: `1px solid ${KIND_COLOR[e.kind] ?? "var(--border)"}`, borderRadius: 999, padding: "1px 8px" }}>{t(`kind.${e.kind}`)}</span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.actor}</span>
              <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>{new Date(e.ts).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: 6 }}><EventBody kind={e.kind} payload={e.payload} /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventBody({ kind, payload }: { kind: string; payload: P }) {
  const { t } = useLocale();
  if (kind === "decision") {
    return (
      <>
        {payload.title != null && <strong style={{ fontSize: 13 }}>{str(payload.title)}</strong>}
        {payload.decision != null && <p style={bodyP}>{str(payload.decision)}</p>}
        {payload.rationale != null && <p style={{ ...bodyP, color: "var(--muted)" }}>{t("brain.why", { v: str(payload.rationale) })}</p>}
        {Array.isArray(payload.alternatives_rejected) && payload.alternatives_rejected.length > 0 && (
          <p style={{ ...bodyP, color: "var(--muted)" }}>{t("brain.rejected", { v: payload.alternatives_rejected.map(str).join(", ") })}</p>
        )}
      </>
    );
  }
  if (kind === "gate_answer") {
    const answered = Array.isArray(payload.answered) ? (payload.answered as Array<{ q: string; a: string }>) : [];
    const ok = str(payload.outcome).startsWith("approv");
    return (
      <>
        <strong style={{ fontSize: 13 }}>{str(payload.gate)} — <span style={{ color: ok ? "#3fb950" : "#d29922" }}>{str(payload.outcome)}</span></strong>
        {payload.feedback != null && str(payload.feedback) && <p style={bodyP}>{str(payload.feedback)}</p>}
        {answered.map((qa, i) => (<p key={i} style={{ ...bodyP, color: "var(--muted)" }}><strong>{qa.q}</strong> → {qa.a}</p>))}
      </>
    );
  }
  if (kind === "rejected_design") {
    return (
      <>
        <strong style={{ fontSize: 13 }}>{str(payload.what)}</strong>
        {payload.why_rejected != null && <p style={bodyP}>{t("brain.whyNot", { v: str(payload.why_rejected) })}</p>}
        {payload.chosen_instead != null && <p style={{ ...bodyP, color: "var(--muted)" }}>{t("brain.instead", { v: str(payload.chosen_instead) })}</p>}
      </>
    );
  }
  if (kind === "provenance") return <p style={bodyP}>{provenanceLine(payload)}</p>;
  return <DocView content={JSON.stringify(payload, null, 2)} path="event.json" />;
}

function provenanceLine(p: P): string {
  const chain = [str(p.requirement), str(p.issue), str(p.pr)].filter(Boolean).join(" → ");
  return p.stage ? `${chain}  ·  ${str(p.stage)}` : chain;
}

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return <button onClick={onClick} style={chipStyle(active, color)}>{label}</button>;
}
function chipStyle(active: boolean, color: string): React.CSSProperties {
  return { cursor: "pointer", fontSize: 12, borderRadius: 999, padding: "3px 10px", border: `1px solid ${active ? color : "var(--border)"}`, background: active ? color : "transparent", color: active ? "#0d1117" : "var(--muted)" };
}
const bodyP: React.CSSProperties = { margin: "3px 0 0", fontSize: 13, color: "var(--text)", lineHeight: 1.5 };
