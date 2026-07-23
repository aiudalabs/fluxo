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
import { useRouter, useSearchParams } from "next/navigation";
import { DocView } from "@/components/DocView";
import { IncrementRequest } from "@/components/IncrementRequest";
import { useProject } from "@/lib/project";
import { freshToken } from "@/lib/supabaseClient";
import { useT } from "@/lib/i18n";

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
  if (DOC_META[name]) return DOC_META[name];
  // Docs de ceremonia (nombre variable por sprint: PLAN-SP1.md…) — reconocidos por prefijo para que
  // el Studio los muestre lindos cuando la corrida es una ceremonia (planning/review/retro).
  if (/^PLAN-/i.test(name)) return { titleKey: null, icon: "◷", order: 10 };
  if (/^REVIEW-/i.test(name)) return { titleKey: null, icon: "✦", order: 11 };
  if (/^CORRECTIONS-/i.test(name)) return { titleKey: null, icon: "✎", order: 11.5 };
  if (/^RETRO-/i.test(name)) return { titleKey: null, icon: "↻", order: 12 };
  return { titleKey: null, icon: "·", order: 99 };
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

// Workflows de ceremonia: para ellos el `label` del YAML (que ya es el nombre Scrum correcto:
// "Planificación del sprint", "Reporte del incremento"…) GANA sobre la clave i18n studio.phase.<id>.
// Si no, studio.phase.plan="Plan de cambio" (hecha para el iterate) secuestra la planificación del
// sprint y la muestra como "Change plan" — la confusión que reportó el usuario.
const CEREMONY_WORKFLOWS = new Set(["sprint-planning", "sprint-review", "retro"]);

function phaseTitle(t: (k: string) => string, workflow: string, phaseId: string, fallback: string) {
  if (CEREMONY_WORKFLOWS.has(workflow)) return fallback; // el label del YAML manda
  const k = `studio.phase.${phaseId}`;
  const v = t(k);
  return v === k ? fallback : v;
}

// Nombre de la ceremonia para el encuadre (eyebrow/banner). null = es un run de diseño, no ceremonia.
function ceremonyName(workflow: string): string | null {
  switch (workflow) {
    case "sprint-planning": return "Sprint Planning";
    case "sprint-review": return "Sprint Review";
    case "retro": return "Retrospectiva";
    default: return null;
  }
}

// Etiqueta del botón de aprobar, en términos Scrum según la ceremonia (más claro que "Aprobar fase").
function approveLabel(t: (k: string) => string, workflow: string): string {
  switch (workflow) {
    case "sprint-planning": return "Aprobar el plan";
    case "sprint-review": return "Aceptar el incremento";
    case "retro": return "Aprobar las mejoras";
    default: return t("studio.view.approve");
  }
}

// Título amistoso de un doc de ceremonia (el nombre de archivo varía por sprint: PLAN-SP1.md…).
function ceremonyDocTitle(name: string): string | null {
  if (/^PLAN-/i.test(name)) return "Plan del sprint";
  if (/^REVIEW-/i.test(name)) return "Reporte del sprint";
  if (/^CORRECTIONS-/i.test(name)) return "Correcciones del sprint";
  if (/^RETRO-/i.test(name)) return "Retrospectiva";
  return null;
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
  const { projectId, supabase, project } = useProject();
  const t = useT();
  // ?run=<id> — Flow linkea acá al clickear una ceremonia/gate; cargamos ESE run. Sin el param,
  // el último (comportamiento de siempre). Así una ceremonia histórica abre SU run, no el más nuevo.
  const runParam = useSearchParams().get("run");
  const [run, setRun] = useState<Run | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [showInc, setShowInc] = useState(false); // overlay "Pedir incremento" (acción del topbar)

  const [resuming, setResuming] = useState(false); // reanudar un run failed
  const [selected, setSelected] = useState<string | null>(null); // doc path
  const [selPhase, setSelPhase] = useState<number | null>(null); // phase index
  const [ver, setVer] = useState<number | null>(null); // brain_event id, null = última
  const [railOpen, setRailOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Cargar SIEMPRE el run MÁS RECIENTE + sus fases/gates, y RE-CARGAR entero en cada cambio
    // Realtime. Así el Studio muestra UN SOLO run (el último) — sin acumular fases de runs
    // viejos y manejando bien los deletes (el bug de "varios árboles").
    const load = async () => {
      // Con ?run= cargamos ESE run (scopeado al proyecto por RLS); si no existe o no viene el param,
      // caemos al más reciente (comportamiento base).
      let latest: Run | null = null;
      let rErr: { message: string } | null = null;
      if (runParam) {
        const { data, error } = await supabase.from("design_runs").select("*")
          .eq("project_id", projectId).eq("id", runParam).maybeSingle();
        if (cancelled) return;
        rErr = error; latest = (data as Run) ?? null;
      }
      if (!latest) {
        const { data: runs, error } = await supabase.from("design_runs").select("*")
          .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1);
        if (cancelled) return;
        rErr = error ?? rErr; latest = (runs as Run[])?.[0] ?? null;
      }
      if (rErr && !latest) { setError(rErr.message); setStatus("error"); return; }
      setRun(latest);
      if (latest) {
        const [{ data: ph }, { data: gt }, { data: ev }] = await Promise.all([
          supabase.from("design_phases").select("*").eq("run_id", latest.id).order("ord", { ascending: true }),
          supabase.from("design_gates").select("*").eq("run_id", latest.id).order("created_at", { ascending: true }),
          // Los brain_events (kind=artifact) son project-wide y son la fuente VERSIONADA de los docs
          // (cada write de doc = una versión). Alcanza para el panel de documentos y sus chips vN.
          supabase.from("brain_events").select("id,payload,ts").eq("project_id", projectId).eq("kind", "artifact").order("ts", { ascending: true }),
        ]);
        if (cancelled) return;
        setPhases((ph as Phase[]) ?? []);
        setGates((gt as Gate[]) ?? []);
        setVersions(((ev as { id: number; payload: Record<string, string>; ts: string }[]) ?? []).map((e) => ({
          id: e.id, path: e.payload.path ?? "", message: e.payload.message ?? "", content: e.payload.content ?? "", ts: e.ts,
        })));
      } else {
        setPhases([]); setGates([]); setVersions([]);
      }
      setStatus("ready");
    };
    void load();

    const channel = supabase
      .channel(`studio:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "design_runs", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "design_phases", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "design_gates", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [projectId, supabase, runParam]);

  // Documentos = paths VERSIONADOS en el brain (fuente de verdad: cada doc de diseño se sube a git
  // y se registra como brain_event; los chips vN de cada doc salen de ahí). Última versión por path
  // para el contenido base. Antes derivaba de `phases` (solo el último run) → un iterate escondía los
  // docs del diseño original. Fallback a las fases del run actual si el brain está vacío (proyecto viejo).
  const files = useMemo(() => {
    const latest = new Map<string, Artifact & { name: string }>();
    for (const v of versions) { // `versions` viene asc por ts → la última gana
      if (!v.path || baseName(v.path).startsWith(".")) continue; // .vibeforge-gate & co. no son docs revisables
      latest.set(v.path, { path: v.path, kind: "", content: v.content, name: baseName(v.path) });
    }
    const list = [...latest.values()];
    if (list.length === 0) {
      const seen = new Set<string>();
      for (const p of phases) for (const a of p.artifacts ?? []) {
        if (seen.has(a.path) || baseName(a.path).startsWith(".")) continue;
        seen.add(a.path);
        list.push({ ...a, name: baseName(a.path) });
      }
    }
    return list.sort((a, b) => meta(a.name).order - meta(b.name).order);
  }, [versions, phases]);

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

  // Reanudar un run que quedó `failed` (p.ej. por un hipo transitorio de Supabase): el endpoint lo
  // repone a resumable → el worker lo re-resume desde donde quedó. El realtime de design_runs recarga.
  const resumeRun = async () => {
    setResuming(true);
    try {
      const tok = await freshToken();
      const r = await fetch(`/api/projects/${projectId}/design/resume`, { method: "POST", headers: tok ? { authorization: `Bearer ${tok}` } : {} });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error ?? `error ${r.status}`); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setResuming(false); }
  };

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
  // "Approved" solo si la fase terminó Y no tiene gate pendiente (si lo tiene, está ESPERANDO tu ok).
  const approved = activeStep
    ? phaseState(activeStep.status) === "approved" && !gates.some((g) => g.phase_id === activeStep.phase_id && g.status === "pending")
    : false;

  return (
    <div className={`studio-shell${fullscreen ? " doc-full" : ""}${!railOpen ? " rail-collapsed" : ""}`}>
      {/* ── Topbar ── */}
      {/* Barra propia del Studio: SOLO estado + control de fases (el nombre/nav vive en el
          TopBar del shell). Adelgazada para que el shell se sienta de una pieza. */}
      <header className="studio-topbar">
        <span className="studio-eyebrow">{ceremonyName(run.workflow) ?? "Diseño"}</span>
        <span className="studio-branch"><span className="d" /> {t("studio.docs.onBranch")}</span>
        {!isTerminal && (
          <button className="studio-runchip" onClick={() => pickPhase(phases.findIndex((p) => p.status === "awaiting_gate"))}>
            <span className="d" style={{ background: awaitingCount > 0 ? "var(--accent)" : "var(--navy)" }} />
            {awaitingCount > 0 ? t("studio.docs.awaitingN", { n: awaitingCount }) : t("studio.docs.runActive")}
          </button>
        )}
        <div className="sp" />
        <button className="btn sm" onClick={() => setShowInc(true)} title="Agregá una feature o mejora al producto ya construido">＋ Pedir incremento</button>
        {(phases.length > 0 || files.length > 0) && !fullscreen && (
          <button className={`btn ghost sm${!railOpen ? " on" : ""}`} onClick={() => setRailOpen((v) => !v)} title={t("studio.docs.railToggle")}>
            ⇤ {t("studio.docs.railToggle")}
          </button>
        )}
      </header>

      {/* ── Banner de estado VIVO ── el gap de v1: mostrar QUÉ está pasando en el diseño.
          `running` = el agente trabaja (esperá) · gate pendiente = te toca responder (clickeable
          para saltar) · done/failed = terminal. Se actualiza por Realtime como el resto. */}
      {(() => {
        const runningPhase = phases.find((p) => p.status === "running");
        const cer = ceremonyName(run.workflow);
        if (pendingGate) {
          const gi = phases.findIndex((p) => p.phase_id === pendingGate.phase_id);
          const gphase = phases.find((p) => p.phase_id === pendingGate.phase_id);
          const name = phaseTitle(t, run.workflow, pendingGate.phase_id, gphase?.label ?? pendingGate.phase_id);
          return (
            <button className="studio-livebanner awaiting" onClick={() => gi >= 0 && pickPhase(gi)}>
              <span className="lb-ic">⏸</span>
              <span>Te toca: hay una decisión para vos en <b>{name}</b>{cer ? <> ({cer})</> : ""}. Revisala para continuar.</span>
              <span className="lb-cta">Ir a revisar →</span>
            </button>
          );
        }
        if (run.status === "running") {
          return (
            <div className="studio-livebanner working">
              <span className="spin" />
              <span>{cer ? <>Preparando <b>{cer}</b></> : "El agente está diseñando"}{runningPhase ? <> — fase <b>{phaseTitle(t, run.workflow, runningPhase.phase_id, runningPhase.label)}</b></> : ""}… Esperá, esto puede tardar un par de minutos. La pantalla se actualiza sola.</span>
            </div>
          );
        }
        if (run.status === "done") {
          return <div className="studio-livebanner done"><span className="lb-ic">✓</span><span>{cer ? <><b>{cer}</b> completada.</> : "Diseño completo — el backlog quedó listo."}</span></div>;
        }
        if (run.status === "failed") {
          return (
            <div className="studio-livebanner failed">
              <span className="lb-ic">✕</span>
              <span>{cer ? <>La ceremonia <b>{cer}</b> falló — se re-planea sola (mirá el Flow).</> : <>El diseño se cortó. Puede haber sido un hipo transitorio — <b>reanudá</b> para seguir desde donde quedó.</>}</span>
              {!cer && (
                <button className="btn sm" disabled={resuming} onClick={() => void resumeRun()} style={{ marginLeft: "auto" }}>
                  {resuming ? "Reanudando…" : "↻ Reanudar"}
                </button>
              )}
            </div>
          );
        }
        return null;
      })()}

      {/* ── Cuerpo: riel | main ── */}
      <div className="studio-body">
        <aside className="studio-rail">
          {phases.length > 0 && (
            <div className="rail-sec">
              <div className="rail-h">{t("studio.docs.phasesSec")}</div>
              {phases.map((p, i) => {
                // Si la fase tiene un gate PENDIENTE, está ESPERANDO tu aprobación — no
                // "aprobada" (el agente terminó pero vos todavía no diste el ok). Fix del
                // bug "se ve ✓ arriba antes de aprobar abajo".
                const hasPendingGate = gates.some((g) => g.phase_id === p.phase_id && g.status === "pending");
                const st = hasPendingGate ? "awaiting" : phaseState(p.status);
                return (
                  <button key={p.phase_id} className={`v-phase v-${st}${selPhase === i ? " on" : ""}`} onClick={() => pickPhase(i)} title={p.label}>
                    <span className="v-g">{PHASE_ICON[st]}</span>
                    <span className="v-lbl">{phaseTitle(t, run.workflow, p.phase_id, p.label)}</span>
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
                <PhasePanel phase={viewPhase} gate={viewGate} workflow={run.workflow} onError={setError} />
              </div>
            </div>
          ) : (
            <>
              <div className="studio-doc-head">
                <span className="eyebrow">
                  {activeFile ? (meta(activeFile.name).titleKey ? t(meta(activeFile.name).titleKey!) : (ceremonyDocTitle(activeFile.name) ?? activeFile.name)) : t("studio.docs.eyebrow")}
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
                    <DocView content={shownContent} path={activeFile?.path ?? active ?? ""} kind={activeFile?.kind} />
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

      {/* Overlay "Pedir incremento": acción con espacio propio (no atrapada en el rail). */}
      {showInc && (
        <div onClick={() => setShowInc(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", overflow: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 640 }}>
            <IncrementRequest />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => setShowInc(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// PhasePanel · la vista de una fase: su documento + el gate CONVERSACIONAL de v1
// (aprobar / pedir cambios / responder las preguntas abiertas). Cualquiera resuelve el
// gate row (design_gates); el motor de diseño lo levanta y avanza o repite la fase.
function PhasePanel({ phase, gate, workflow, onError }: { phase: Phase; gate: Gate | null; workflow: string; onError: (m: string) => void }) {
  const { projectId, supabase } = useProject();
  const router = useRouter();
  const t = useT();
  const [mode, setMode] = useState<"none" | "reject" | "answer">("none");
  const [feedback, setFeedback] = useState("");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Mostrá el DOC de la fase (.md, p.ej. ARCHITECTURE.md), NO un archivo interno como
  // `.vibeforge-gate` (el comando de verificación de la fábrica) que ordena primero por empezar
  // con "." → confundía "arch falló" cuando en realidad el doc real estaba ahí.
  const arts = phase.artifacts ?? [];
  const doc = arts.find((a) => a.path.toLowerCase().endsWith(".md")) ?? arts.find((a) => !baseName(a.path).startsWith(".")) ?? arts[0] ?? null;

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
        <span className="eyebrow">{phaseTitle(t, workflow, phase.phase_id, phase.label)}</span>
        {phaseState(phase.status) === "approved" && !gate && <span className="doc-okchip">{t("studio.docs.approved")}</span>}
      </div>

      {doc && (
        <div style={{ marginBottom: 18 }}>
          <DocView content={doc.content} path={doc.path} kind={doc.kind} />
        </div>
      )}

      {gate && (
        <div style={{ border: "1px solid var(--accent-line)", background: "var(--accent-soft)", borderRadius: 14, padding: "16px 18px" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--accent)", marginBottom: 6 }}>
            {gate.attempt > 1 ? `Intento ${gate.attempt}` : "Tu decisión"}
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 14.5, color: "var(--ink)" }}>{gate.reason}</p>

          {/* Sprint Review = ver el incremento corriendo antes de aceptar → atajo a la pestaña "App en vivo". */}
          {workflow === "sprint-review" && (
            <button className="btn sm" style={{ marginBottom: 12 }}
              onClick={() => router.push(`/projects/${projectId}/preview`)}>
              ▶ Abrir preview ↗
            </button>
          )}

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
              ✓ {approveLabel(t, workflow)}
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
  background: "var(--panel)", color: "var(--ink)", border: "1px solid var(--stroke-strong)", borderRadius: 10,
  fontFamily: "var(--display)",
};
