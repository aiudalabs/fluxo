"use client";

// Spend (F-spend) · el gasto real del proyecto. Lee run_costs por Supabase (RLS-scoped al tenant) —
// una fila por run del conductor, con usd + tokens que el worker guardó del comentario fluxo:cost.
// KPIs (total, # runs, tokens) + tabla por run. Realtime: se actualiza cuando aterriza un costo.

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useT } from "@/lib/i18n";

type Row = {
  id: string; run_id: string; issues: string | null; usd: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; created_at: string;
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function Spend() {
  const { projectId, supabase } = useProject();
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase.from("run_costs").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) { setState("error"); return; }
      setRows((data as Row[]) ?? []);
      setState("ready");
    };
    void load();
    const ch = supabase
      .channel(`spend:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "run_costs", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  const totals = useMemo(() => ({
    usd: rows.reduce((s, r) => s + Number(r.usd), 0),
    tokens: rows.reduce((s, r) => s + Number(r.input_tokens) + Number(r.output_tokens), 0),
    cacheRead: rows.reduce((s, r) => s + Number(r.cache_read_tokens), 0),
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
        <div className="placeholder"><div className="ph-ic">$</div>Todavía no hay costos registrados. Aparecen cuando un run del conductor reporta su costo (comentario fluxo:cost → worker → run_costs).</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14, marginBottom: 20 }}>
            <Kpi value={usd(totals.usd)} label={t("spend.kpi.total")} sub={t("spend.kpi.total.sub")} strong />
            <Kpi value={String(rows.length)} label={t("spend.kpi.runsDone")} sub={t("spend.kpi.agentCalls.sub")} />
            <Kpi value={tok(totals.tokens)} label="Tokens (in+out)" sub={`${tok(totals.cacheRead)} cache read`} />
          </div>

          <div className="ttable">
            <div className="trow" style={{ gridTemplateColumns: "120px 1fr 90px 90px 130px" }}>
              <span>Run</span><span>Issues</span><span>Costo</span><span>Tokens</span><span>Fecha</span>
            </div>
            {rows.map((r) => (
              <div key={r.id} className="trow" style={{ gridTemplateColumns: "120px 1fr 90px 90px 130px" }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink4)" }}>{r.run_id.slice(0, 12)}</span>
                <span className="mono" style={{ fontSize: 11 }}>{r.issues ? `#${r.issues.replace(/\s/g, "").split(",").join(", #")}` : "—"}</span>
                <span style={{ fontWeight: 600 }}>{usd(Number(r.usd))}</span>
                <span style={{ color: "var(--ink3)", fontSize: 12 }}>{tok(Number(r.input_tokens) + Number(r.output_tokens))}</span>
                <span style={{ color: "var(--ink4)", fontSize: 11 }}>{new Date(r.created_at).toLocaleString()}</span>
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
