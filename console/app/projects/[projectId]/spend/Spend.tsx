"use client";

// Spend (F-spend) · el gasto real del proyecto. Junta DOS fuentes de costo (RLS-scoped al tenant):
//   1. run_costs — el BUILD (agentes en las Actions del cliente): usd + tokens del comentario fluxo:cost.
//   2. design_phases — el DISEÑO y las CEREMONIAS (agentes en el worker): usd + tokens por fase, que
//      agregamos por run. Antes solo se leía run_costs → el gasto de diseño/planning/review/retro no
//      aparecía (parecía "$0" aunque estaba registrado). KPIs (total, # runs, tokens) + tabla por run.

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";

type Row = {
  id: string;              // run id
  label: string;           // "#12, #13" (build) · "Sprint Planning"/"Incremento"/"Diseño" (worker)
  kind: "build" | "design";
  usd: number; inTok: number; outTok: number; cacheRead: number; at: string;
};

// Nombre amable del workflow del run de worker (diseño/ceremonia).
const WF_LABEL: Record<string, string> = {
  design: "Diseño", "demo-design": "Diseño (demo)", iterate: "Incremento",
  "sprint-planning": "Sprint Planning", "sprint-review": "Sprint Review", retro: "Retrospectiva",
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

type RcRow = { run_id: string; issues: string | null; usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; created_at: string };
type DpRow = { run_id: string; usd: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null };
type DrRow = { id: string; workflow: string; created_at: string };

export default function Spend() {
  const { projectId, supabase } = useProject();
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: rc, error: e1 }, { data: dp }, { data: dr }] = await Promise.all([
        supabase.from("run_costs").select("run_id,issues,usd,input_tokens,output_tokens,cache_read_tokens,created_at").eq("project_id", projectId),
        supabase.from("design_phases").select("run_id,usd,input_tokens,output_tokens,cache_read_tokens").eq("project_id", projectId),
        supabase.from("design_runs").select("id,workflow,created_at").eq("project_id", projectId),
      ]);
      if (cancelled) return;
      if (e1) { setState("error"); return; }

      // 1) BUILD (run_costs) — una fila por run de Actions.
      const build: Row[] = ((rc as RcRow[]) ?? []).map((r) => ({
        id: r.run_id,
        label: r.issues ? `#${String(r.issues).replace(/\s/g, "").split(",").join(", #")}` : "build",
        kind: "build",
        usd: Number(r.usd) || 0, inTok: Number(r.input_tokens) || 0, outTok: Number(r.output_tokens) || 0,
        cacheRead: Number(r.cache_read_tokens) || 0, at: r.created_at,
      }));

      // 2) DISEÑO/CEREMONIAS (design_phases) — agregado por run (una fila por run de worker).
      const meta = new Map(((dr as DrRow[]) ?? []).map((r) => [r.id, r]));
      const agg = new Map<string, { usd: number; inTok: number; outTok: number; cacheRead: number }>();
      for (const p of (dp as DpRow[]) ?? []) {
        const a = agg.get(p.run_id) ?? { usd: 0, inTok: 0, outTok: 0, cacheRead: 0 };
        a.usd += Number(p.usd) || 0; a.inTok += Number(p.input_tokens) || 0;
        a.outTok += Number(p.output_tokens) || 0; a.cacheRead += Number(p.cache_read_tokens) || 0;
        agg.set(p.run_id, a);
      }
      const design: Row[] = [...agg.entries()].filter(([, a]) => a.usd > 0).map(([runId, a]) => {
        const m = meta.get(runId);
        return {
          id: runId, label: WF_LABEL[m?.workflow ?? ""] ?? m?.workflow ?? "diseño", kind: "design" as const,
          usd: a.usd, inTok: a.inTok, outTok: a.outTok, cacheRead: a.cacheRead, at: m?.created_at ?? "",
        };
      });

      setRows([...build, ...design].sort((x, y) => (y.at || "").localeCompare(x.at || "")));
      setState("ready");
    };
    void load();
    const ch = supabase
      .channel(`spend:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "run_costs", filter: `project_id=eq.${projectId}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "design_phases", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  const totals = useMemo(() => ({
    usd: rows.reduce((s, r) => s + r.usd, 0),
    tokens: rows.reduce((s, r) => s + r.inTok + r.outTok, 0),
    cacheRead: rows.reduce((s, r) => s + r.cacheRead, 0),
  }), [rows]);

  return (
    <div className="wrap">
      <div className="sectitle">
        <h2>{t("spend.title")}</h2>
        <span className="c">{t("spend.subtitle")}</span>
      </div>

      {state === "loading" ? (
        <div className="placeholder"><span className="spin" /></div>
      ) : state === "error" ? (
        <div className="placeholder err">{t("spend.error")}</div>
      ) : rows.length === 0 ? (
        <div className="placeholder"><div className="ph-ic">$</div>Todavía no hay costos registrados. Aparecen cuando corre el diseño/una ceremonia (worker) o el build (Actions).</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14, marginBottom: 20 }}>
            <Kpi value={usd(totals.usd)} label={t("spend.kpi.total")} sub={t("spend.kpi.total.sub")} strong />
            <Kpi value={String(rows.length)} label={t("spend.kpi.runsDone")} sub={t("spend.kpi.agentCalls.sub")} />
            <Kpi value={tok(totals.tokens)} label="Tokens (in+out)" sub={`${tok(totals.cacheRead)} cache read`} />
          </div>

          <div className="ttable">
            <div className="trow" style={{ gridTemplateColumns: "90px 1fr 90px 90px 130px" }}>
              <span>Tipo</span><span>Detalle</span><span>Costo</span><span>Tokens</span><span>Fecha</span>
            </div>
            {rows.map((r) => (
              <div key={`${r.kind}:${r.id}`} className="trow" style={{ gridTemplateColumns: "90px 1fr 90px 90px 130px" }}>
                <span className="mono" style={{ fontSize: 10.5, color: r.kind === "design" ? "var(--navy)" : "var(--ink4)" }}>
                  {r.kind === "design" ? "◆ worker" : "▤ build"}
                </span>
                <span style={{ fontSize: 12.5 }}>{r.label}</span>
                <span style={{ fontWeight: 600 }}>{usd(r.usd)}</span>
                <span style={{ color: "var(--ink3)", fontSize: 12 }}>{tok(r.inTok + r.outTok)}</span>
                <span style={{ color: "var(--ink4)", fontSize: 11 }}>{r.at ? new Date(r.at).toLocaleString() : "—"}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ value, label, sub, strong }: { value: string; label: string; sub: string; strong?: boolean }) {
  return (
    <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: strong ? "var(--emerald)" : "var(--ink1)" }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <div className="c" style={{ fontSize: 11 }}>{sub}</div>
    </div>
  );
}
