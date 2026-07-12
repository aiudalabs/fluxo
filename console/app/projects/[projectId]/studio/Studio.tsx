"use client";

// Studio (F6P-03) · el WORKSPACE de diseño de v1, PORTADO: shell = topbar fija ·
// cuerpo [riel | main]. El riel lista las FASES del run (stepper vertical) y los
// DOCUMENTOS cosechados; el main muestra el doc seleccionado (markdown + chips de
// VERSIÓN) o, si elegís una fase con gate pendiente, su panel de gate CONVERSACIONAL
// (aprobar / pedir cambios / responder preguntas).
//
// Lo ÚNICO distinto vs v1: la data sale de Supabase (RLS + Realtime) — design_runs/
// design_phases (artifacts cosechados) / design_gates —, y las versiones de un doc
// salen del brain (brain_events append-only, kind=artifact) en vez de la historia git.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

type Artifact = { path: string; kind: string; content: string };
type Run = { id: string; project_id: string; status: string; workflow: string; created_at: string };
type Phase = { id: string; run_id: string; phase_id: string; label: string; ord: number; status: string; artifacts: Artifact[] };
type Gate = {
  id: string; run_id: string; phase_id: string; gate_id: string; reason: string;
  open_questions: string[]; attempt: number; status: string; outcome: string | null;
};
type Version = { id: number; path: string; message: string; content: string; ts: string };

// Títulos amables + orden de lectura de los artefactos conocidos (calcado de v1 StudioDocs).
const DOC_META: Record<string, { titleKey: string | null; icon: string; order: number }> = {
  "BRIEF.md": { titleKey: "studio.docs.title.brief", icon: "◈", order: 1 },
  "CONSTITUTION.md": { titleKey: "studio.docs.title.constitution", icon: "§", order: 1.5 },
  "PRD.md": { titleKey: "studio.docs.title.prd", icon: "◇", order: 2 },
  "DATA_MODEL.md": { titleKey: "studio.docs.title.dataModel", icon: "▦", order: 2.5 },
  "ARCHITECTURE.md": { titleKey: "studio.docs.title.architecture", icon: "◫", order: 3 },
  "UI_SCREENS.md": { titleKey: "studio.docs.title.uiScreens", icon: "▢", order: 4 },
  "DESIGN_SYSTEM.md": { titleKey: "studio.docs.title.designSystem", icon: "❖", order: 5 },
  "backlog.yaml": { titleKey: "studio.docs.title.backlog", icon: "☰", order: 6 },
  "SESSION.md": { titleKey: "studio.docs.title.session", icon: "◷", order: 7 },
};
function meta(name: string) {
  return DOC_META[name] ?? { titleKey: null, icon: "·", order: 99 };
}
function baseName(path: string) {
  return path.replace(/^.*\//, "");
}

// Estado de fase v2 → estado compuesto de v1 (glifo del stepper).
type PhaseState = "pending" | "running" | "awaiting" | "approved" | "failed";
function phaseState(status: string): PhaseState {
  return (({ done: "approved", running: "running", awaiting_gate: "awaiting", failed: "failed" } as const)[status] ?? "pending");
}
const PHASE_ICON: Record<PhaseState, string> = { pending: "", running: "●", awaiting: "⏸", approved: "✓", failed: "✕" };

function phaseTitle(t: (k: string) => string, phaseId: string, fallback: string) {
  const k = `studio.phase.${phaseId}`;
  const v = t(k);
  return v === k ? fallback : v;
}

function upsertBy<T extends { id: string }>(setter: React.Dispatch<React.SetStateAction<T[]>>, row: T) {
  setter((prev) => {
    const i = prev.findIndex((r) => r.id === row.id);
    if (i === -1) return [...prev, row];
    const next = [...prev];
    next[i] = row;
    return next;
  });
}

export default function Studio() {
  const { projectId, supabase } = useProject();
  const t = useT();
  const [run, setRun] = useState<Run | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  const [selected, setSelected] = useState<string | null>(null); // doc path
  const [selPhase, setSelPhase] = useState<number | null>(null); // phase index
  const [ver, setVer] = useState<number | null>(null); // brain_event id, null = última
  const [railOpen, setRailOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: runs, error: rErr } = await supabase
        .from("design_runs").select("*").eq("project_id", projectId)
        .order("created_at", { ascending: false }).limit(1);
      if (cancelled) return;
      if (rErr) { setError(rErr.message); setStatus("error"); return; }
      const latest = (runs as Run[])?.[0] ?? null;
      setRun(latest);
      if (latest) {
        const [{ data: ph }, { data: gt }, { data: ev }] = await Promise.all([
          supabase.from("design_phases").select("*").eq("run_id", latest.id).order("ord", { ascending: true }),
          supabase.from("design_gates").select("*").eq("run_id", latest.id).order("created_at", { ascending: true }),
          supabase.from("brain_events").select("id,payload,ts").eq("project_id", projectId).eq("kind", "artifact").order("ts", { ascending: true }),
        ]);
        if (cancelled) return;
        setPhases((ph as Phase[]) ?? []);
        setGates((gt as Gate[]) ?? []);
        setVersions(((ev as { id: number; payload: Record<string, string>; ts: string }[]) ?? []).map((e) => ({
          id: e.id, path: e.payload.path ?? "", message: e.payload.message ?? "", content: e.payload.content ?? "", ts: e.ts,
        })));
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
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [projectId, supabase]);

  // Documentos = artifacts cosechados de todas las fases, aplanados y ordenados por DOC_META.
  const files = useMemo(() => {
    const seen = new Set<string>();
    const list: (Artifact & { name: string })[] = [];
    for (const p of phases) for (const a of p.artifacts ?? []) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
      list.push({ ...a, name: baseName(a.path) });
    }
    return list.sort((a, b) => meta(a.name).order - meta(b.name).order);
  }, [phases]);

  // Versiones por path (del brain, ya ordenadas asc por ts). Cada brain_event = una versión.
  const versionsByPath = useMemo(() => {
    const m = new Map<string, Version[]>();
    for (const v of versions) {
      if (!v.path) continue;
      const arr = m.get(v.path) ?? [];
      arr.push(v);
      m.set(v.path, arr);
    }
    return m;
  }, [versions]);

  const active = selected ?? files.find((f) => f.name === "PRD.md")?.path ?? files[0]?.path ?? null;
  useEffect(() => setVer(null), [active]);

  function pickDoc(path: string) { setSelected(path); setSelPhase(null); }
  function pickPhase(i: number) { setSelPhase(i); }

  const pendingGate = useMemo(() => gates.find((g) => g.status === "pending") ?? null, [gates]);
  const awaitingCount = phases.filter((p) => p.status === "awaiting_gate").length;
  const isTerminal = run ? run.status === "done" || run.status === "failed" : false;

  if (status === "loading") return <div className="studio-shell"><div className="placeholder"><span className="spin" /> {t("studio.docs.loadingProject")}</div></div>;
  if (status === "error") return <div className="studio-shell"><div className="placeholder err">{t("studio.docs.readError")}: {error}</div></div>;
  if (!run) return <div className="studio-shell"><div className="placeholder">{t("studio.docs.empty.line1")}</div></div>;

  const viewPhase = selPhase != null ? phases[selPhase] : null;
  const viewGate = viewPhase ? gates.find((g) => g.phase_id === viewPhase.phase_id && g.status === "pending") ?? null : null;

  // Doc activo + sus versiones (newest-first para los chips).
  const activeFile = files.find((f) => f.path === active) ?? null;
  const activeVersions = active ? [...(versionsByPath.get(active) ?? [])].reverse() : [];
  const shownContent = ver != null
    ? activeVersions.find((v) => v.id === ver)?.content ?? ""
    : activeVersions[0]?.content ?? activeFile?.content ?? "";
  const activeStep = phases.find((p) => (p.artifacts ?? []).some((a) => a.path === active));
  const approved = activeStep ? phaseState(activeStep.status) === "approved" : false;

  return (
    <div className={`studio-shell${fullscreen ? " doc-full" : ""}${!railOpen ? " rail-collapsed" : ""}`}>
      {/* ── Topbar ── */}
      <header className="studio-topbar">
        <h2 className="studio-proj">Rosa la peluquería</h2>
        <span className="studio-branch"><span className="d" /> {t("studio.docs.onBranch")}</span>
        {!isTerminal && (
          <button className="studio-runchip" onClick={() => pickPhase(phases.findIndex((p) => p.status === "awaiting_gate"))}>
            <span className="d" style={{ background: awaitingCount > 0 ? "var(--accent)" : "var(--navy)" }} />
            {awaitingCount > 0 ? t("studio.docs.awaitingN", { n: awaitingCount }) : t("studio.docs.runActive")}
          </button>
        )}
        <div className="sp" />
        <LanguageSwitcher />
        {(phases.length > 0 || files.length > 0) && !fullscreen && (
          <button className={`btn ghost sm${!railOpen ? " on" : ""}`} onClick={() => setRailOpen((v) => !v)} title={t("studio.docs.railToggle")}>
            ⇤ {t("studio.docs.railToggle")}
          </button>
        )}
        <Link href={`/projects/${projectId}/board`} className="btn primary sm" style={{ textDecoration: "none" }}>
          {t("nav.board.title")} →
        </Link>
      </header>

      {/* ── Cuerpo: riel | main ── */}
      <div className="studio-body">
        <aside className="studio-rail">
          {phases.length > 0 && (
            <div className="rail-sec">
              <div className="rail-h">{t("studio.docs.phasesSec")}</div>
              {phases.map((p, i) => {
                const st = phaseState(p.status);
                return (
                  <button key={p.phase_id} className={`v-phase v-${st}${selPhase === i ? " on" : ""}`} onClick={() => pickPhase(i)} title={p.label}>
                    <span className="v-g">{PHASE_ICON[st]}</span>
                    <span className="v-lbl">{phaseTitle(t, p.phase_id, p.label)}</span>
                    {i < phases.length - 1 && <span className="v-conn" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="rail-sec">
            <div className="rail-h">{t("studio.docs.pages")}</div>
            {files.length === 0 ? (
              <div className="docs-tree-empty">{t("studio.docs.empty.line1")}<br />{t("studio.docs.empty.line2")}</div>
            ) : (
              <nav>
                {files.map((f) => {
                  const sel = selPhase == null && active === f.path;
                  return (
                    <button key={f.path} className={`rail-doc${sel ? " on" : ""}`} onClick={() => pickDoc(f.path)}>
                      <span className="pi">{meta(f.name).icon}</span>
                      <span className="lbl">{f.name}</span>
                      <span className="badge">✓</span>
                    </button>
                  );
                })}
              </nav>
            )}
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="studio-main">
          {viewPhase ? (
            <div className="studio-doc-scroll">
              <div className="studio-doc-inner">
                <PhasePanel phase={viewPhase} gate={viewGate} onError={setError} />
              </div>
            </div>
          ) : (
            <>
              <div className="studio-doc-head">
                <span className="eyebrow">
                  {activeFile ? (meta(activeFile.name).titleKey ? t(meta(activeFile.name).titleKey!) : activeFile.name) : t("studio.docs.eyebrow")}
                </span>
                {approved && <span className="doc-okchip">{t("studio.docs.approved")}</span>}
                {activeVersions.length > 0 && (
                  <span className="doc-verchip">
                    v{ver == null ? activeVersions.length : activeVersions.length - activeVersions.findIndex((h) => h.id === ver)}
                  </span>
                )}
                <div className="sp" />
                {active && (
                  <button className="btn ghost sm" onClick={() => setFullscreen((f) => !f)}>
                    ⛶ {fullscreen ? t("studio.docs.exitFull") : t("studio.docs.fullscreen")}
                  </button>
                )}
              </div>
              <div className="studio-doc-scroll">
                <div className="studio-doc-inner">
                  {activeVersions.length > 1 && (
                    <div className="chips" style={{ marginBottom: 14 }}>
                      {activeVersions.map((h, i) => {
                        const vnum = activeVersions.length - i;
                        const isLatest = i === 0;
                        const on = isLatest ? ver === null || ver === h.id : ver === h.id;
                        return (
                          <button key={h.id} className={`chip${on ? " on" : ""}`}
                            style={{ fontFamily: "var(--mono)", fontSize: 11.5, padding: "4px 10px" }}
                            title={`${h.message} · ${new Date(h.ts).toLocaleString()}`}
                            onClick={() => setVer(isLatest ? null : h.id)}>
                            v{vnum}
                          </button>
                        );
                      })}
                      {ver !== null && <span style={{ color: "var(--ink4)", fontSize: 12, alignSelf: "center" }}>{t("studio.docs.viewingOld")}</span>}
                    </div>
                  )}
                  {!active ? (
                    <div className="placeholder">{t("studio.docs.selectPage")}</div>
                  ) : (
                    <article className="docs-md artifact-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{shownContent}</ReactMarkdown>
                    </article>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {/* Banner de gate pendiente (cuando no estás mirando esa fase) */}
      {pendingGate && !viewGate && (
        <button className="studio-runchip" style={{ position: "fixed", right: 20, bottom: 20, zIndex: 30 }}
          onClick={() => pickPhase(phases.findIndex((p) => p.phase_id === pendingGate.phase_id))}>
          <span className="d" style={{ background: "var(--accent)" }} /> {t("studio.docs.reviewChanges")}
        </button>
      )}
    </div>
  );
}

// PhasePanel · la vista de una fase: su documento + el gate CONVERSACIONAL de v1
// (aprobar / pedir cambios / responder las preguntas abiertas). Cualquiera resuelve el
// gate row (design_gates); el motor de diseño lo levanta y avanza o repite la fase.
function PhasePanel({ phase, gate, onError }: { phase: Phase; gate: Gate | null; onError: (m: string) => void }) {
  const { supabase } = useProject();
  const t = useT();
  const [mode, setMode] = useState<"none" | "reject" | "answer">("none");
  const [feedback, setFeedback] = useState("");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const doc = (phase.artifacts ?? [])[0] ?? null;

  const resolve = async (patch: Record<string, unknown>, tag: string) => {
    if (!gate) return;
    setBusy(tag);
    const { error } = await supabase.from("design_gates")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), ...patch })
      .eq("id", gate.id);
    if (error) onError(error.message);
    setBusy(null);
  };
  const hasAnswers = !!gate && gate.open_questions.length > 0 && gate.open_questions.every((_, i) => (answers[i] ?? "").trim());

  return (
    <>
      <div className="studio-doc-head" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <span className="eyebrow">{phaseTitle(t, phase.phase_id, phase.label)}</span>
        {phaseState(phase.status) === "approved" && <span className="doc-okchip">{t("studio.docs.approved")}</span>}
      </div>

      {doc && (
        <article className="docs-md artifact-md" style={{ marginBottom: 18 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
        </article>
      )}

      {gate && (
        <div style={{ border: "1px solid var(--accent-line)", background: "var(--accent-soft)", borderRadius: 14, padding: "16px 18px" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--accent)", marginBottom: 6 }}>
            {gate.gate_id} · #{gate.attempt}
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 14.5, color: "var(--ink)" }}>{gate.reason}</p>

          {gate.open_questions.length > 0 && mode === "answer" && (
            <div style={{ marginBottom: 12 }}>
              {gate.open_questions.map((q, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 13.5, display: "block", marginBottom: 4, color: "var(--ink2)" }}>{q}</label>
                  <input value={answers[i] ?? ""} onChange={(e) => setAnswers((p) => ({ ...p, [i]: e.target.value }))}
                    placeholder={t("studio.view.answerPlaceholder")} style={inp} />
                </div>
              ))}
              <button className="btn primary sm" disabled={!hasAnswers || busy !== null}
                onClick={() => resolve({ outcome: "revise", answers: gate.open_questions.map((q, i) => ({ q, a: (answers[i] ?? "").trim() })) }, "answer")}>
                {busy === "answer" ? t("studio.view.answering") : t("studio.view.answer")}
              </button>
            </div>
          )}

          {mode === "reject" && (
            <div style={{ marginBottom: 12 }}>
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3}
                placeholder={t("studio.view.rejectPlaceholder")} style={{ ...inp, resize: "vertical" }} />
              <button className="btn primary sm" style={{ marginTop: 8 }} disabled={!feedback.trim() || busy !== null}
                onClick={() => resolve({ outcome: "revise", feedback: feedback.trim() }, "reject")}>
                {busy === "reject" ? "…" : t("studio.view.sendFeedback")}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary sm" disabled={busy !== null} onClick={() => resolve({ outcome: "approve" }, "approve")}>
              ✓ {t("studio.view.approve")}
            </button>
            {gate.open_questions.length > 0 && (
              <button className={`btn ghost sm${mode === "answer" ? " on" : ""}`} onClick={() => setMode(mode === "answer" ? "none" : "answer")}>
                {t("studio.view.answer")}
              </button>
            )}
            <button className={`btn ghost sm${mode === "reject" ? " on" : ""}`} onClick={() => setMode(mode === "reject" ? "none" : "reject")}>
              {t("studio.view.reject")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const inp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 13.5,
  background: "#fff", color: "var(--ink)", border: "1px solid var(--stroke-strong)", borderRadius: 10,
  fontFamily: "var(--display)",
};
