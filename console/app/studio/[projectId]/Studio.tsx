"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { browserClient } from "@/lib/supabaseClient";
import { useLocale } from "@/lib/locale";

type Artifact = { path: string; kind: string; content: string };
type Run = { id: string; project_id: string; status: string; workflow: string; created_at: string };
type Phase = {
  id: string;
  run_id: string;
  phase_id: string;
  label: string;
  ord: number;
  status: string;
  artifacts: Artifact[];
};
type QA = { q: string; a: string };
type Gate = {
  id: string;
  run_id: string;
  phase_id: string;
  gate_id: string;
  reason: string;
  open_questions: string[];
  attempt: number;
  status: string;
  outcome: string | null;
};

const PHASE_COLOR: Record<string, string> = {
  pending: "#8b949e", running: "#d29922", awaiting_gate: "#a371f7", done: "#3fb950", failed: "#f85149",
};

function upsertBy<T extends { id: string }>(setter: React.Dispatch<React.SetStateAction<T[]>>, row: T) {
  setter((prev) => {
    const i = prev.findIndex((r) => r.id === row.id);
    if (i === -1) return [...prev, row];
    const next = [...prev];
    next[i] = row;
    return next;
  });
}

// Studio · the gated design pipeline as a view over Supabase Realtime (F6-02). It walks
// the phases, shows the harvested docs/mockups, and lets the human resolve each gate
// conversationally (approve / pedir cambios / responder preguntas — F5-04). When the
// backlog is published the run reaches awaiting_handoff and Studio links to the board
// (it does not go mute — L-UX-1).
export default function Studio({ projectId }: { projectId: string }) {
  const { t } = useLocale();
  const [run, setRun] = useState<Run | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Artifact | null>(null);

  useEffect(() => {
    const supabase = browserClient();
    let cancelled = false;

    (async () => {
      const { data: runs, error: rErr } = await supabase
        .from("design_runs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      if (rErr) {
        setError(rErr.message);
        setStatus("error");
        return;
      }
      const latest = (runs as Run[])?.[0] ?? null;
      setRun(latest);
      if (latest) {
        const [{ data: ph }, { data: gt }] = await Promise.all([
          supabase.from("design_phases").select("*").eq("run_id", latest.id).order("ord", { ascending: true }),
          supabase.from("design_gates").select("*").eq("run_id", latest.id).order("created_at", { ascending: true }),
        ]);
        if (cancelled) return;
        setPhases((ph as Phase[]) ?? []);
        setGates((gt as Gate[]) ?? []);
      }
      setStatus("ready");
    })();

    const channel = supabase
      .channel(`studio:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "design_runs", filter: `project_id=eq.${projectId}` },
        (p) => { if (p.eventType !== "DELETE") setRun(p.new as Run); })
      .on("postgres_changes", { event: "*", schema: "public", table: "design_phases", filter: `project_id=eq.${projectId}` },
        (p) => { if (p.eventType !== "DELETE") upsertBy(setPhases, p.new as Phase); })
      .on("postgres_changes", { event: "*", schema: "public", table: "design_gates", filter: `project_id=eq.${projectId}` },
        (p) => { if (p.eventType !== "DELETE") upsertBy(setGates, p.new as Gate); })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const pendingGate = useMemo(() => gates.find((g) => g.status === "pending") ?? null, [gates]);
  const backlogDone = useMemo(() => phases.some((p) => p.phase_id === "backlog" && p.status === "done"), [phases]);
  const linkToExec = run?.status === "awaiting_handoff" || backlogDone;

  if (status === "loading") return <p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>;
  if (status === "error") return <p style={{ color: "#f85149" }}>{t("studio.readError", { msg: error })}</p>;
  if (!run) return <p style={{ color: "var(--muted)" }}>{t("studio.noRun")}</p>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", gap: 20, alignItems: "start" }}>
      {/* ── Left: pipeline of phases ─────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{t("studio.designState")}</span>
          <strong style={{ fontSize: 13 }}>{t(`studio.run.${run.status}`)}</strong>
        </div>

        {linkToExec && (
          <Link href={`/board/${projectId}`} style={{
            display: "block", marginBottom: 14, padding: "0.6rem 0.8rem", borderRadius: 8,
            background: "var(--accent)", color: "#0d1117", fontWeight: 600, fontSize: 13, textDecoration: "none",
          }}>
            {t("studio.backlogPublished")}
          </Link>
        )}

        <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {phases.map((p) => {
            const gate = gates.find((g) => g.phase_id === p.phase_id);
            return (
              <li key={p.id} style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 8, padding: "0.6rem 0.7rem", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: PHASE_COLOR[p.status] ?? "#8b949e" }} />
                  <strong style={{ fontSize: 13 }}>{p.label || p.phase_id}</strong>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>{p.status}</span>
                </div>
                {p.artifacts?.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {p.artifacts.map((a) => (
                      <button key={a.path} onClick={() => setSelected(a)} style={{
                        fontSize: 11, fontFamily: "ui-monospace, monospace", cursor: "pointer",
                        border: "1px solid var(--border)", background: selected?.path === a.path ? "var(--accent)" : "transparent",
                        color: selected?.path === a.path ? "#0d1117" : "var(--accent)", borderRadius: 6, padding: "2px 8px",
                      }}>
                        {a.kind === "mockup" ? "🖼 " : "📄 "}{a.path.replace(/^docs\//, "")}
                      </button>
                    ))}
                  </div>
                )}
                {gate && gate.status === "resolved" && (
                  <div style={{ marginTop: 6, fontSize: 11, color: gate.outcome === "approve" ? "#3fb950" : "#d29922" }}>
                    {gate.outcome === "approve" ? t("studio.gateApproved") : t("studio.gateChanges")}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* ── Right: gate panel + artifact viewer ──────────────────────────── */}
      <div>
        {pendingGate && <GatePanel gate={pendingGate} onError={setError} />}
        <ArtifactViewer artifact={selected} />
      </div>
    </div>
  );
}

// GatePanel · the conversational gate (F5-04): approve, pedir cambios (feedback), or
// responder the open questions the phase surfaced. Any of these resolves the gate row;
// the engine picks up the resolution and advances or loops the phase.
function GatePanel({ gate, onError }: { gate: Gate; onError: (m: string) => void }) {
  const { t } = useLocale();
  const [feedback, setFeedback] = useState("");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const resolve = async (patch: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    const { error } = await browserClient()
      .from("design_gates")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), ...patch })
      .eq("id", gate.id);
    if (error) onError(error.message);
    setBusy(null);
  };

  const hasAnswers = gate.open_questions.length > 0 && gate.open_questions.every((_, i) => (answers[i] ?? "").trim());

  return (
    <div style={{ border: "1px solid var(--accent)", background: "var(--panel)", borderRadius: 10, padding: "1rem", marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 4 }}>{t("gate.label", { gate: gate.gate_id, n: gate.attempt })}</div>
      <p style={{ marginTop: 0, fontSize: 14 }}>{gate.reason}</p>

      {gate.open_questions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>{t("gate.openQuestions")}</div>
          {gate.open_questions.map((q, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 13, display: "block", marginBottom: 3 }}>{q}</label>
              <input value={answers[i] ?? ""} onChange={(e) => setAnswers((p) => ({ ...p, [i]: e.target.value }))}
                placeholder={t("gate.answerPlaceholder")} style={inputStyle} />
            </div>
          ))}
          <button disabled={!hasAnswers || busy !== null}
            onClick={() => resolve({ outcome: "revise", answers: gate.open_questions.map((q, i) => ({ q, a: answers[i].trim() })) }, "answer")}
            style={{ ...btn("#a371f7"), opacity: hasAnswers ? 1 : 0.4 }}>
            {busy === "answer" ? "…" : t("gate.answerBtn")}
          </button>
        </div>
      )}

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>{t("gate.orFeedback")}</div>
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3}
          placeholder={t("gate.feedbackPlaceholder")} style={{ ...inputStyle, resize: "vertical" }} />
        <button disabled={!feedback.trim() || busy !== null}
          onClick={() => resolve({ outcome: "revise", feedback: feedback.trim() }, "revise")}
          style={{ ...btn("#d29922"), marginTop: 6, opacity: feedback.trim() ? 1 : 0.4 }}>
          {busy === "revise" ? "…" : t("gate.reviseBtn")}
        </button>
      </div>

      <button disabled={busy !== null} onClick={() => resolve({ outcome: "approve" }, "approve")} style={btn("#3fb950")}>
        {busy === "approve" ? "…" : t("gate.approveBtn")}
      </button>
    </div>
  );
}

function ArtifactViewer({ artifact }: { artifact: Artifact | null }) {
  const { t } = useLocale();
  if (!artifact) return <p style={{ color: "var(--muted)" }}>{t("studio.pickArtifact")}</p>;
  return (
    <div style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "0.5rem 0.8rem", borderBottom: "1px solid var(--border)", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
        {artifact.path}
      </div>
      {artifact.kind === "mockup" ? (
        <iframe title={artifact.path} srcDoc={artifact.content} sandbox="allow-same-origin"
          style={{ width: "100%", height: 560, border: "none", background: "#fff" }} />
      ) : (
        <pre style={{ margin: 0, padding: "0.9rem", overflowX: "auto", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
          {artifact.content}
        </pre>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 13,
  background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6,
};
const btn = (color: string): React.CSSProperties => ({
  cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#0d1117", background: color,
  border: "none", borderRadius: 6, padding: "6px 14px",
});
