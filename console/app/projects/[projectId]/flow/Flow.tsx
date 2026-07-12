"use client";

// Flow (F6P-04) · las dos vistas de /flow de v1, PORTADAS: la vista CICLO (el diagrama
// del ciclo Scrum, default) y la vista GRAFO (React Flow left-to-right). Ambas son
// renderers del MISMO FlowModel derivado por buildFlow() — código VERBATIM de v1
// (flowGraph/layout/nodes/cycleModel/FlowCycle). Lo ÚNICO distinto: el FlowInput se
// arma desde Supabase (sprints/stories/design_phases + design_gates) en vez del REST /flow.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";
import { phaseState } from "@/components/studio/phaseHelpers";
import { buildFlow, type CeremonyModes } from "@/components/flow/flowGraph";
import { layoutFlow } from "@/components/flow/layout";
import { NODE_TYPES } from "@/components/flow/nodes";
import { FlowCycle } from "@/components/flow/cycle/FlowCycle";
import type { DesignPhase, DesignStepStatus, Sprint, OrchestratorTicket, TicketStatus } from "@/lib/types";

type FlowTab = "cycle" | "graph";

type PhaseRow = { phase_id: string; label: string; status: string };
type GateRow = { phase_id: string; gate_id: string; status: string; outcome: string | null };
type SprintRow = {
  id: string; key: string; title: string | null; goal: string | null; position: number | null;
  planned_at: string | null; planning_run_id: string | null;
  reviewed_at: string | null; review_run_id: string | null;
  retro_at: string | null; retro_run_id: string | null;
};

// v2 review→in_review, blocked→backlog (mismo adaptador que el Board).
function mapStatus(s: string): TicketStatus {
  if (s === "review") return "in_review";
  if (s === "blocked") return "backlog";
  return s as TicketStatus;
}
const epoch = (ts: string | null): number | undefined => (ts ? Date.parse(ts) : undefined);

// design_phases (v2: un status + gates aparte) → DesignPhase (v1: designStatus + gateStatus).
function toDesignPhases(phases: PhaseRow[], gates: GateRow[]): DesignPhase[] {
  const designStatus: Record<string, DesignStepStatus> = {
    done: "DONE", running: "RUNNING", awaiting_gate: "DONE", failed: "FAILED", pending: "QUEUED",
  };
  return phases.map((p) => {
    const gate = gates.find((g) => g.phase_id === p.phase_id);
    return {
      stepId: p.phase_id,
      name: p.label || p.phase_id,
      gateId: gate?.gate_id,
      designStatus: designStatus[p.status] ?? "QUEUED",
      gateStatus: gate
        ? gate.status === "pending" ? "AWAITING" : gate.outcome === "approve" ? "DONE" : "RUNNING"
        : "QUEUED",
    };
  });
}

export default function Flow() {
  const { projectId, supabase, project } = useProject();
  const t = useT();
  const router = useRouter();
  const [phases, setPhases] = useState<DesignPhase[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [tickets, setTickets] = useState<OrchestratorTicket[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tab, setTab] = useState<FlowTab>("cycle");
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: runs }, { data: sp }, { data: st }] = await Promise.all([
        supabase.from("design_runs").select("id").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1),
        supabase.from("sprints").select("*").eq("project_id", projectId),
        supabase.from("stories").select("*").eq("project_id", projectId),
      ]);
      if (cancelled) return;
      const runId = (runs as { id: string }[])?.[0]?.id ?? null;
      const [{ data: ph }, { data: gt }] = runId
        ? await Promise.all([
            supabase.from("design_phases").select("phase_id,label,status").eq("run_id", runId).order("ord", { ascending: true }),
            supabase.from("design_gates").select("phase_id,gate_id,status,outcome").eq("run_id", runId),
          ])
        : [{ data: [] }, { data: [] }];
      if (cancelled) return;

      setPhases(toDesignPhases((ph as PhaseRow[]) ?? [], (gt as GateRow[]) ?? []));
      setSprints(((sp as SprintRow[]) ?? [])
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.key.localeCompare(b.key))
        .map((s) => ({
          id: s.id, name: s.title || s.key, goal: s.goal ?? "", project_id: projectId,
          planned_at: epoch(s.planned_at), planning_run_id: s.planning_run_id ?? undefined,
          reviewed_at: epoch(s.reviewed_at), review_run_id: s.review_run_id ?? undefined,
          retro_at: epoch(s.retro_at), retro_run_id: s.retro_run_id ?? undefined,
        })));

      const keyById = new Map(((st as Record<string, unknown>[]) ?? []).map((s) => [s.id as string, s.key as string]));
      setTickets(((st as Record<string, unknown>[]) ?? []).map((s) => ({
        id: s.key as string,
        title: (s.title as string) ?? "",
        body: (s.body as string) ?? undefined,
        acceptance: (s.acceptance as string) ?? undefined,
        status: mapStatus(s.status as string),
        deps: (((s.blocked_by as string[] | null) ?? []).map((u) => keyById.get(u) ?? u)),
        run_id: (s.run_id as string) ?? undefined,
        sprint_id: (s.sprint_id as string) ?? undefined, // UUID: flowGraph matchea contra sprint.id
        epic_id: (s.epic_id as string) ?? undefined,
        owner: (s.lane as string) ?? undefined,
        pr_url: (s.pr_url as string) ?? undefined,
        session_url: (s.session_url as string) ?? undefined,
        kind: (s.kind as string) ?? undefined,
        agent_lost: (s.agent_lost as string) ?? undefined,
      })));
      setState("ready");
    };
    void load();
    const ch = supabase
      .channel(`flow:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stories", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "sprints", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "design_phases", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  // v2 no tiene tabla de settings de ceremonias → default "auto" (el scheduler no gatea).
  const modes: CeremonyModes = useMemo(() => ({ planning: "auto", review: "auto", retro: "auto" }), []);
  const model = useMemo(() => buildFlow({ phases, sprints, tickets, modes, stateOf: phaseState }), [phases, sprints, tickets, modes]);
  const laid = useMemo(() => layoutFlow(model), [model]);
  const rfNodes = useMemo(() => laid.nodes.map((n) => ({ ...n, selected: n.id === sel })), [laid, sel]);

  const goBoard = () => router.push(`/projects/${projectId}/board`);

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <h2 className="studio-proj">{project?.name ?? "…"}</h2>
        <div className="flow-tabs" style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {(["cycle", "graph"] as FlowTab[]).map((k) => (
            <button key={k} className={`btn ghost sm${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
              {t(`flow.tab.${k}`) === `flow.tab.${k}` ? (k === "cycle" ? "Ciclo" : "Grafo") : t(`flow.tab.${k}`)}
            </button>
          ))}
        </div>
        <div className="sp" />
        <Link href={`/projects/${projectId}/board`} className="btn primary sm" style={{ textDecoration: "none" }}>
          {t("nav.board.title")} →
        </Link>
      </header>

      <div className="studio-body" style={{ display: "block", position: "relative" }}>
        {state === "loading" ? (
          <div className="placeholder"><span className="spin" /></div>
        ) : tab === "cycle" ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "24px 16px", overflow: "auto" }}>
            <FlowCycle
              model={model}
              modes={modes}
              selected={sel}
              onSelect={setSel}
              onOpenBoard={goBoard}
              onOpenSprint={goBoard}
              onOpenPreview={goBoard}
              onOpenSettings={() => {}}
              onAddBacklog={goBoard}
              onOpenAbout={() => {}}
            />
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0 }}>
            <ReactFlow
              nodes={rfNodes}
              edges={laid.edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, n) => setSel(n.id)}
              fitView
              proOptions={{ hideAttribution: true }}
              minZoom={0.2}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        )}
      </div>
    </div>
  );
}
