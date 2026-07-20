"use client";

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

// Human-readable rendering per brain kind (payload shapes per registry/skills/brain-write).
// Falls back to the raw JSON for an unknown kind so nothing is ever hidden from the audit.
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
        <strong style={{ fontSize: 13 }}>
          {str(payload.gate)} — <span style={{ color: ok ? "#3fb950" : "#d29922" }}>{str(payload.outcome)}</span>
        </strong>
        {payload.feedback != null && str(payload.feedback) && <p style={bodyP}>{str(payload.feedback)}</p>}
        {answered.map((qa, i) => (
          <p key={i} style={{ ...bodyP, color: "var(--muted)" }}>
            <strong>{qa.q}</strong> → {qa.a}
          </p>
        ))}
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
  if (kind === "provenance") {
    return <p style={bodyP}>{provenanceLine(payload)}</p>;
  }
  // kind desconocido → JSON crudo con highlight (nada se oculta al audit; ahora legible).
  return <DocView content={JSON.stringify(payload, null, 2)} path="event.json" />;
}

function provenanceLine(p: P): string {
  const chain = [str(p.requirement), str(p.issue), str(p.pr)].filter(Boolean).join(" → ");
  return p.stage ? `${chain}  ·  ${str(p.stage)}` : chain;
}

// BrainExplorer renders a project's brain timeline (newest first) directly from Supabase —
// RLS scopes reads to the tenant — with a per-kind readable view + Realtime (F1-04). F6-03
// adds kind filters and the requirement→issue→PR trail (from `provenance` events; those are
// written on backlog publish / PR merge — F1-03/F5-03 — so the trail lights up once the
// client-repo handoff is live). This is the moat's read surface; kills L-ARCH-4.
export default function BrainExplorer() {
  const { projectId, supabase } = useProject();
  const { t } = useLocale();
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [filter, setFilter] = useState<string>("all");
  const [showTrail, setShowTrail] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("brain_events")
        .select("*")
        .eq("project_id", projectId)
        .order("ts", { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setStatus("error");
        return;
      }
      setEvents((data as BrainEvent[]) ?? []);
      setStatus("ready");
    })();

    const channel = supabase
      .channel(`brain:${projectId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "brain_events", filter: `project_id=eq.${projectId}` },
        (payload) => {
          const row = payload.new as BrainEvent;
          setEvents((prev) => (prev.some((e) => e.id === row.id) ? prev : [row, ...prev]));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [projectId, supabase]);

  const kinds = useMemo(() => Array.from(new Set(events.map((e) => e.kind))).sort(), [events]);
  const shown = useMemo(() => (filter === "all" ? events : events.filter((e) => e.kind === filter)), [events, filter]);
  const provenance = useMemo(() => events.filter((e) => e.kind === "provenance"), [events]);

  if (status === "loading") return <p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>;
  if (status === "error") return <p style={{ color: "#f85149" }}>{t("brain.readError", { msg: error })}</p>;
  if (events.length === 0) return <p style={{ color: "var(--muted)" }}>{t("brain.empty")}</p>;

  return (
    <div style={{ margin: "1rem 0" }}>
      {/* Filters + trail toggle */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <Chip label={`${t("brain.all")} (${events.length})`} active={filter === "all"} color="var(--accent)" onClick={() => setFilter("all")} />
        {kinds.map((k) => (
          <Chip key={k} label={`${t(`kind.${k}`)} (${events.filter((e) => e.kind === k).length})`} active={filter === k} color={KIND_COLOR[k] ?? "var(--muted)"} onClick={() => setFilter(k)} />
        ))}
        <button onClick={() => setShowTrail((s) => !s)} style={{ marginLeft: "auto", ...chipStyle(showTrail, "#58a6ff") }}>
          {t("brain.trailToggle")}
        </button>
      </div>

      {showTrail && <ProvenanceTrail events={provenance} />}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map((e) => (
          <li key={e.id} style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: KIND_COLOR[e.kind] ?? "var(--text)", border: `1px solid ${KIND_COLOR[e.kind] ?? "var(--border)"}`, borderRadius: 999, padding: "1px 8px" }}>
                {t(`kind.${e.kind}`)}
              </span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.actor}</span>
              <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>{new Date(e.ts).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: 6 }}>
              <EventBody kind={e.kind} payload={e.payload} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ProvenanceTrail reconstructs each requirement's chain (requirement → issue → PR) from the
// provenance events, newest stage last. Honest empty state until F5-03 writes them.
function ProvenanceTrail({ events }: { events: BrainEvent[] }) {
  const { t } = useLocale();
  const byReq = useMemo(() => {
    const m = new Map<string, BrainEvent[]>();
    for (const e of events) {
      const req = str(e.payload.requirement) || "(sin requisito)";
      const bucket = m.get(req);
      if (bucket) bucket.push(e);
      else m.set(req, [e]);
    }
    return m;
  }, [events]);

  return (
    <div style={{ border: "1px solid #58a6ff", background: "var(--panel)", borderRadius: 10, padding: "0.9rem 1rem", marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: "#58a6ff", marginBottom: 8 }}>{t("brain.trailTitle")}</div>
      {byReq.size === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("brain.trailEmpty")}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {Array.from(byReq.entries()).map(([req, evs]) => {
            const latest = evs[0];
            return (
              <li key={req} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
                {provenanceLine({ ...latest.payload, requirement: req })}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return <button onClick={onClick} style={chipStyle(active, color)}>{label}</button>;
}
function chipStyle(active: boolean, color: string): React.CSSProperties {
  return {
    cursor: "pointer", fontSize: 12, borderRadius: 999, padding: "3px 10px",
    border: `1px solid ${active ? color : "var(--border)"}`,
    background: active ? color : "transparent",
    color: active ? "#0d1117" : "var(--muted)",
  };
}
const bodyP: React.CSSProperties = { margin: "3px 0 0", fontSize: 13, color: "var(--text)", lineHeight: 1.5 };
