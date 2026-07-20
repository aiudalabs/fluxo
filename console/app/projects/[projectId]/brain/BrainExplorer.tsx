"use client";

// Observabilidad (P4-2, rediseño Langfuse-style). Modelo copiado de Langfuse/Arize: TABLA de TRAZAS
// (un run = una traza; más nuevas arriba, ordenable) → DETALLE con WATERFALL de spans, cada uno
// LINKEADO a su trabajo (fase → artefacto; story → PR). El store sigue siendo brain_events; acá se
// unen design_phases (traza de diseño) + run_costs/stories/sprints (trazas de build). Reemplaza al
// Spend (fusionado). Tab Eventos = el log append-only (auditoría).

import { useEffect, useMemo, useState } from "react";
import { DocView } from "@/components/DocView";
import { type BrainEvent } from "@/lib/supabaseClient";
import { useProject } from "@/lib/project";
import { useLocale } from "@/lib/locale";

const KIND_COLOR: Record<string, string> = { decision: "#a371f7", gate_answer: "#3fb950", rejected_design: "#f85149", provenance: "#58a6ff" };
type P = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v));

const fmtUsd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const fmtTok = (n: number | null | undefined) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtDur = (ms: number) => (ms <= 0 ? "—" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const fmtWhen = (ms: number) => (ms <= 0 ? "—" : new Date(ms).toLocaleString());

type Artifact = { path: string; content: string; kind?: string };
type PhaseRow = { phase_id: string; label: string | null; status: string; ord: number; created_at: string; updated_at: string; artifacts: Artifact[] | null; usd: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; duration_ms: number | null; model: string | null };
type CostRow = { run_id: string; issues: string | null; usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; created_at: string };
type StoryRow = { key: string; title: string; status: string; external_ref: string | null; sprint_id: string | null; pr_url: string | null };
type SprintRow = { id: string; key: string; title: string };

type Span = { id: string; name: string; startMs: number; endMs: number; cost: number | null; inTok: number | null; outTok: number | null; status: string; artifact?: Artifact | null; href?: string; note?: string };
type Trace = { id: string; type: "design" | "build"; name: string; whenMs: number; durMs: number; cost: number; inTok: number; outTok: number; status: string; spans: Span[] };

const primaryDoc = (arts: Artifact[] | null): Artifact | null => {
  if (!arts?.length) return null;
  return arts.find((a) => a.path.toLowerCase().endsWith(".md")) ?? arts.find((a) => !a.path.split("/").pop()!.startsWith(".")) ?? arts[0];
};

export default function BrainExplorer() {
  const { projectId, supabase } = useProject();
  const { t } = useLocale();
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [phases, setPhases] = useState<PhaseRow[]>([]);
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [stories, setStories] = useState<StoryRow[]>([]);
  const [sprints, setSprints] = useState<SprintRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [tab, setTab] = useState<"traces" | "events">("traces");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [sortCol, setSortCol] = useState<"when" | "dur" | "cost">("when");
  const [openId, setOpenId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [ev, ph, co, stq, spq] = await Promise.all([
        supabase.from("brain_events").select("*").eq("project_id", projectId).order("ts", { ascending: false }).limit(300),
        supabase.from("design_phases").select("phase_id,label,status,ord,created_at,updated_at,artifacts,usd,input_tokens,output_tokens,cache_read_tokens,duration_ms,model").eq("project_id", projectId).order("ord", { ascending: true }),
        supabase.from("run_costs").select("run_id,issues,usd,input_tokens,output_tokens,cache_read_tokens,created_at").eq("project_id", projectId).order("created_at", { ascending: false }),
        supabase.from("stories").select("key,title,status,external_ref,sprint_id,pr_url").eq("project_id", projectId),
        supabase.from("sprints").select("id,key,title").eq("project_id", projectId),
      ]);
      if (cancelled) return;
      if (ev.error) { setError(ev.error.message); setStatus("error"); return; }
      setEvents((ev.data as BrainEvent[]) ?? []);
      setPhases((ph.data as PhaseRow[]) ?? []);
      setCosts((co.data as CostRow[]) ?? []);
      setStories((stq.data as StoryRow[]) ?? []);
      setSprints((spq.data as SprintRow[]) ?? []);
      setStatus("ready");
    };
    void load();
    const ch = supabase.channel(`obs:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "brain_events", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "design_phases", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "run_costs", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  // ── Construir las trazas (una traza = un run) ──────────────────────────────────
  const traces = useMemo<Trace[]>(() => {
    const out: Trace[] = [];

    // Traza de DISEÑO: las fases como spans (waterfall: cada fase arranca donde terminó la anterior).
    if (phases.length) {
      const runStart = Math.min(...phases.map((p) => new Date(p.created_at).getTime()));
      let cursor = runStart;
      const gateByPhase = new Map<string, BrainEvent>();
      for (const e of events) {
        if (e.kind !== "gate_answer") continue;
        const g = str(e.payload.gate).toLowerCase();
        for (const ph of phases) if ((g.includes(ph.phase_id.toLowerCase()) || ph.phase_id.toLowerCase().includes(g.replace(/[-_]?gate$/, ""))) && !gateByPhase.has(ph.phase_id)) gateByPhase.set(ph.phase_id, e);
      }
      const spans: Span[] = phases.map((p) => {
        const end = new Date(p.updated_at).getTime();
        const startMs = cursor; cursor = Math.max(cursor, end);
        const gate = gateByPhase.get(p.phase_id);
        return { id: `ph:${p.phase_id}`, name: p.label || p.phase_id, startMs, endMs: end, cost: p.usd, inTok: p.input_tokens, outTok: p.output_tokens, status: p.status, artifact: primaryDoc(p.artifacts), note: gate ? `gate ${str(gate.payload.outcome)}${str(gate.payload.feedback) ? " · " + str(gate.payload.feedback).slice(0, 100) : ""}` : undefined };
      });
      const endMs = Math.max(...phases.map((p) => new Date(p.updated_at).getTime()));
      out.push({ id: "trace:design", type: "design", name: "Diseño del producto", whenMs: runStart, durMs: endMs - runStart, cost: phases.reduce((s, p) => s + (p.usd ?? 0), 0), inTok: phases.reduce((s, p) => s + (p.input_tokens ?? 0), 0), outTok: phases.reduce((s, p) => s + (p.output_tokens ?? 0), 0), status: phases.every((p) => p.status === "done") ? "done" : phases.some((p) => p.status === "failed") ? "failed" : "running", spans });
    }

    // Trazas de BUILD: una por run_costs. Nombre humano = sprint + story keys (mapeo issue#→story).
    const byIssue = new Map<string, StoryRow>();
    for (const s of stories) { const m = /#(\d+)$/.exec(s.external_ref ?? ""); if (m) byIssue.set(m[1], s); }
    const sprintById = new Map(sprints.map((s) => [s.id, s]));
    for (const c of costs) {
      const issues = (c.issues ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const sts = issues.map((n) => byIssue.get(n)).filter((x): x is StoryRow => !!x);
      const sprintIds = new Set(sts.map((s) => s.sprint_id).filter(Boolean));
      const keys = sts.map((s) => s.key).join(", ");
      let name: string;
      if (sts.length && sprintIds.size === 1) { const sp = sprintById.get([...sprintIds][0] as string); name = `${sp?.title ?? "Sprint"}${keys ? ` · ${keys}` : ""}`; }
      else if (keys) name = keys;
      else name = `Build · issues ${issues.join(", ")}`;
      const pr = sts.find((s) => s.pr_url)?.pr_url ?? undefined;
      const spans: Span[] = sts.map((s) => ({ id: `st:${s.key}`, name: `${s.key} · ${s.title}`, startMs: 0, endMs: 0, cost: null, inTok: null, outTok: null, status: s.status, href: s.pr_url ?? (s.external_ref?.startsWith("github:") ? `https://github.com/${s.external_ref.slice(7).replace("#", "/issues/")}` : undefined) }));
      out.push({ id: `trace:build:${c.run_id}`, type: "build", name, whenMs: new Date(c.created_at).getTime(), durMs: 0, cost: c.usd, inTok: c.input_tokens, outTok: c.output_tokens, status: sts.length && sts.every((s) => s.status === "done") ? "done" : "running", spans, ...(pr ? { pr } : {}) } as Trace);
    }
    return out;
  }, [phases, costs, stories, sprints, events]);

  const sorted = useMemo(() => {
    const key = (tr: Trace) => (sortCol === "when" ? tr.whenMs : sortCol === "dur" ? tr.durMs : tr.cost);
    return [...traces].sort((a, b) => (sortDir === "desc" ? key(b) - key(a) : key(a) - key(b)));
  }, [traces, sortCol, sortDir]);

  const totals = useMemo(() => {
    const design = traces.filter((t) => t.type === "design").reduce((s, t) => s + t.cost, 0);
    const build = traces.filter((t) => t.type === "build").reduce((s, t) => s + t.cost, 0);
    return { total: design + build, design, build, inTok: traces.reduce((s, t) => s + t.inTok, 0), outTok: traces.reduce((s, t) => s + t.outTok, 0), n: traces.length };
  }, [traces]);

  const setSort = (col: "when" | "dur" | "cost") => { if (col === sortCol) setSortDir((d) => (d === "desc" ? "asc" : "desc")); else { setSortCol(col); setSortDir("desc"); } };
  const arrow = (col: string) => (sortCol === col ? (sortDir === "desc" ? " ↓" : " ↑") : "");

  if (status === "loading") return <p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>;
  if (status === "error") return <p style={{ color: "#f85149" }}>{t("brain.readError", { msg: error })}</p>;

  return (
    <div style={{ margin: "1rem 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <Stat label="Costo total" value={fmtUsd(totals.total)} accent />
        <Stat label="Diseño" value={fmtUsd(totals.design)} />
        <Stat label="Build" value={fmtUsd(totals.build)} />
        <Stat label="Tokens in / out" value={`${fmtTok(totals.inTok)} / ${fmtTok(totals.outTok)}`} />
        <Stat label="Trazas" value={String(totals.n)} />
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={`btn ghost sm${tab === "traces" ? " on" : ""}`} onClick={() => setTab("traces")}>Trazas ({traces.length})</button>
        <button className={`btn ghost sm${tab === "events" ? " on" : ""}`} onClick={() => setTab("events")}>Eventos ({events.length})</button>
      </div>

      {tab === "events" ? <Events events={events} t={t} /> : traces.length === 0 ? <p style={{ color: "var(--muted)" }}>{t("brain.empty")}</p> : (
        <div style={{ border: "1px solid var(--stroke)", borderRadius: 10, overflow: "hidden" }}>
          {/* Header de la tabla (ordenable) */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 120px 90px 90px 90px", gap: 8, padding: "8px 14px", background: "var(--bg2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted)" }}>
            <span>Traza</span><span>Tipo</span>
            <button onClick={() => setSort("when")} style={thBtn}>Cuándo{arrow("when")}</button>
            <button onClick={() => setSort("dur")} style={thBtn}>Duración{arrow("dur")}</button>
            <button onClick={() => setSort("cost")} style={thBtn}>Costo{arrow("cost")}</button>
            <span style={{ textAlign: "right" }}>Tokens</span>
          </div>
          {sorted.map((tr) => (
            <div key={tr.id}>
              <div onClick={() => setOpenId(openId === tr.id ? null : tr.id)} style={{ display: "grid", gridTemplateColumns: "1fr 90px 120px 90px 90px 90px", gap: 8, padding: "10px 14px", alignItems: "center", fontSize: 13, cursor: "pointer", borderTop: "1px solid var(--stroke)", background: openId === tr.id ? "var(--accent-soft)" : "transparent" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}><StatusDot status={tr.status} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tr.name}</span></span>
                <span style={{ fontSize: 11, color: "var(--muted)", border: "1px solid var(--stroke)", borderRadius: 999, padding: "1px 8px", justifySelf: "start" }}>{tr.type}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{fmtWhen(tr.whenMs)}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--muted)" }}>{tr.type === "design" ? fmtDur(tr.durMs) : "—"}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{fmtUsd(tr.cost)}</span>
                <span style={{ textAlign: "right", color: "var(--muted)", fontSize: 12 }}>{fmtTok(tr.inTok)}/{fmtTok(tr.outTok)}</span>
              </div>
              {openId === tr.id && <TraceDetail trace={tr} onArtifact={setArtifact} />}
            </div>
          ))}
        </div>
      )}

      {artifact && <ArtifactDrawer artifact={artifact} onClose={() => setArtifact(null)} />}
    </div>
  );
}

// ── Detalle: waterfall de spans, cada uno linkeado ────────────────────────────────
function TraceDetail({ trace, onArtifact }: { trace: Trace; onArtifact: (a: Artifact) => void }) {
  return (
    <div style={{ padding: "6px 14px 14px 32px", borderTop: "1px solid var(--stroke)", background: "var(--panel)" }}>
      {trace.spans.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>Sin spans.</p>}
      {trace.spans.map((s) => {
        const leftPct = trace.durMs > 0 ? ((s.startMs - trace.whenMs) / trace.durMs) * 100 : 0;
        const widthPct = trace.durMs > 0 ? Math.max(2, ((s.endMs - s.startMs) / trace.durMs) * 100) : 0;
        const clickable = !!s.artifact || !!s.href;
        return (
          <div key={s.id} style={{ padding: "5px 0", borderBottom: "1px solid var(--stroke)" }}>
            <div onClick={() => { if (s.artifact) onArtifact(s.artifact); else if (s.href) window.open(s.href, "_blank"); }}
              style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, cursor: clickable ? "pointer" : "default" }}>
              <StatusDot status={s.status} />
              <span style={{ minWidth: 150, fontWeight: 600, color: clickable ? "var(--accent)" : "var(--text)" }}>{s.name}{clickable ? " ↗" : ""}</span>
              {trace.type === "design" && (
                <span style={{ flex: 1, position: "relative", height: 8, background: "var(--bg2)", borderRadius: 999, minWidth: 60 }}>
                  <span style={{ position: "absolute", left: `${leftPct}%`, width: `${widthPct}%`, height: "100%", background: "var(--accent)", borderRadius: 999 }} />
                </span>
              )}
              {trace.type === "design" && <span style={{ color: "var(--muted)", minWidth: 52, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtDur(s.endMs - s.startMs)}</span>}
              <span style={{ minWidth: 60, textAlign: "right", color: s.cost == null ? "var(--muted)" : "var(--text)", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(s.cost)}</span>
              {trace.type === "build" && <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>{s.status}</span>}
            </div>
            {s.note && <div style={{ marginLeft: 20, marginTop: 3, paddingLeft: 8, borderLeft: "2px solid #3fb950", fontSize: 11.5, color: "var(--muted)" }}>{s.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ArtifactDrawer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(760px, 92vw)", height: "100%", background: "var(--panel)", borderLeft: "1px solid var(--stroke)", padding: 18, overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 13 }}>{artifact.path}</strong>
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={onClose}>Cerrar ✕</button>
        </div>
        <DocView content={artifact.content} path={artifact.path} kind={artifact.kind} />
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const c = status === "done" || status === "merged" ? "#3fb950" : status === "running" || status === "review" ? "#d29922" : status === "failed" ? "#f85149" : "var(--muted)";
  return <span title={status} style={{ width: 8, height: 8, borderRadius: 999, background: c, display: "inline-block", flexShrink: 0 }} />;
}
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ border: `1px solid ${accent ? "var(--accent-line)" : "var(--stroke)"}`, background: "var(--panel)", borderRadius: 10, padding: "8px 14px", minWidth: 100 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent ? "var(--accent)" : "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
const thBtn: React.CSSProperties = { cursor: "pointer", background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left", padding: 0 };

// ── Eventos (log append-only — auditoría, se conserva) ────────────────────────────
function Events({ events, t }: { events: BrainEvent[]; t: (k: string, v?: Record<string, string | number>) => string }) {
  const [filter, setFilter] = useState<string>("all");
  const kinds = useMemo(() => Array.from(new Set(events.map((e) => e.kind))).sort(), [events]);
  const shown = useMemo(() => (filter === "all" ? events : events.filter((e) => e.kind === filter)), [events, filter]);
  if (events.length === 0) return <p style={{ color: "var(--muted)" }}>{t("brain.empty")}</p>;
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <Chip label={`${t("brain.all")} (${events.length})`} active={filter === "all"} color="var(--accent)" onClick={() => setFilter("all")} />
        {kinds.map((k) => <Chip key={k} label={`${t(`kind.${k}`)} (${events.filter((e) => e.kind === k).length})`} active={filter === k} color={KIND_COLOR[k] ?? "var(--muted)"} onClick={() => setFilter(k)} />)}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map((e) => (
          <li key={e.id} style={{ border: "1px solid var(--stroke)", background: "var(--panel)", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: KIND_COLOR[e.kind] ?? "var(--text)", border: `1px solid ${KIND_COLOR[e.kind] ?? "var(--stroke)"}`, borderRadius: 999, padding: "1px 8px" }}>{t(`kind.${e.kind}`)}</span>
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
  if (kind === "decision") return (<>{payload.title != null && <strong style={{ fontSize: 13 }}>{str(payload.title)}</strong>}{payload.decision != null && <p style={bodyP}>{str(payload.decision)}</p>}{payload.rationale != null && <p style={{ ...bodyP, color: "var(--muted)" }}>{t("brain.why", { v: str(payload.rationale) })}</p>}</>);
  if (kind === "gate_answer") {
    const answered = Array.isArray(payload.answered) ? (payload.answered as Array<{ q: string; a: string }>) : [];
    const ok = str(payload.outcome).startsWith("approv");
    return (<><strong style={{ fontSize: 13 }}>{str(payload.gate)} — <span style={{ color: ok ? "#3fb950" : "#d29922" }}>{str(payload.outcome)}</span></strong>{payload.feedback != null && str(payload.feedback) && <p style={bodyP}>{str(payload.feedback)}</p>}{answered.map((qa, i) => (<p key={i} style={{ ...bodyP, color: "var(--muted)" }}><strong>{qa.q}</strong> → {qa.a}</p>))}</>);
  }
  if (kind === "rejected_design") return (<><strong style={{ fontSize: 13 }}>{str(payload.what)}</strong>{payload.why_rejected != null && <p style={bodyP}>{t("brain.whyNot", { v: str(payload.why_rejected) })}</p>}</>);
  if (kind === "provenance") return <p style={bodyP}>{[str(payload.requirement), str(payload.issue), str(payload.pr)].filter(Boolean).join(" → ")}</p>;
  return <DocView content={JSON.stringify(payload, null, 2)} path="event.json" />;
}

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return <button onClick={onClick} style={{ cursor: "pointer", fontSize: 12, borderRadius: 999, padding: "3px 10px", border: `1px solid ${active ? color : "var(--stroke)"}`, background: active ? color : "transparent", color: active ? "#0d1117" : "var(--muted)" }}>{label}</button>;
}
const bodyP: React.CSSProperties = { margin: "3px 0 0", fontSize: 13, color: "var(--text)", lineHeight: 1.5 };
