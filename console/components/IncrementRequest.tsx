"use client";

// P5-2 · "Pedir incremento" — el disparador del change-request. El usuario describe qué agregar al
// producto YA construido; se encola en increment_requests (RLS por tenant); el worker lo levanta y
// corre iterate.yaml (iteration-planner → DELTA backlog → APPEND al board). Motor ya existente; esto
// es el trigger UI. Hogar futuro: el AI Assistant (P5-1); por ahora vive en el Overview.

import { useEffect, useState } from "react";
import { useProject } from "@/lib/project";

type Req = { id: string; instructions: string; status: string; created_at: string };
// El color del estado sale de una clase de rol M3 (globals.css), no de un hex/var inline.
const STATUS_CLASS: Record<string, string> = { pending: "inc-s-pending", running: "inc-s-running", done: "inc-s-done", failed: "inc-s-failed" };

export function IncrementRequest() {
  const { projectId, supabase, project } = useProject();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [showPast, setShowPast] = useState(false); // los pedidos done/failed se colapsan (no comen pantalla)

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const { data } = await supabase.from("increment_requests").select("id,instructions,status,created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(8);
      if (!dead) setReqs((data as Req[]) ?? []);
    };
    void load();
    const ch = supabase.channel(`inc:${projectId}`).on("postgres_changes", { event: "*", schema: "public", table: "increment_requests", filter: `project_id=eq.${projectId}` }, () => void load()).subscribe();
    return () => { dead = true; supabase.removeChannel(ch); };
  }, [projectId, supabase]);

  const submit = async () => {
    const instructions = text.trim();
    if (!instructions) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.from("increment_requests").insert({ project_id: projectId, tenant_id: project?.tenant_id, instructions });
    setBusy(false);
    if (error) { setMsg({ ok: false, text: error.message }); return; }
    setText(""); setOpen(false);
    setMsg({ ok: true, text: "Pedido encolado. El conductor va a planear el delta (nuevos sprints/stories) y aparecerá en el board tras aprobar el gate en el Studio." });
  };

  return (
    <div className="inc">
      <div className="inc-head">
        <div className="inc-title">Pedir incremento</div>
        <div className="inc-sub">Agregá features o mejoras al producto ya construido — Fluxo planea el delta y lo appendea al backlog.</div>
        {!open && <button className="btn tonal" onClick={() => setOpen(true)}>+ Nuevo</button>}
      </div>

      {open && (
        <div className="inc-form">
          <textarea
            className="inp inc-ta"
            value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={3}
            placeholder="Ej: agregá reservas recurrentes semanales y recordatorios por email 24h antes de la cita."
          />
          <div className="inc-actions">
            <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? "Enviando…" : "Pedir incremento"}</button>
            <button className="btn ghost" onClick={() => { setOpen(false); setText(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {msg && <p className={`inc-msg${msg.ok ? "" : " err"}`}>{msg.text}</p>}

      {reqs.length > 0 && (() => {
        const active = reqs.filter((r) => r.status === "pending" || r.status === "running");
        const past = reqs.filter((r) => r.status === "done" || r.status === "failed");
        const Row = (r: Req) => {
          const sc = STATUS_CLASS[r.status] ?? "inc-s-other";
          return (
            <div key={r.id} className="inc-row">
              <span className={`inc-dot ${sc}`} />
              <span className="inc-tx" title={r.instructions}>{r.instructions}</span>
              <span className={`inc-st ${sc}`}>{r.status}</span>
              <span className="inc-at">{new Date(r.created_at).toLocaleDateString()}</span>
            </div>
          );
        };
        return (
          <div className="inc-list">
            {active.length > 0 && <><div className="eyebrow acc">En curso</div>{active.map(Row)}</>}
            {past.length > 0 && (
              <>
                <button className="btn ghost sm inc-past" onClick={() => setShowPast((v) => !v)}>
                  {showPast ? "▾" : "▸"} {past.length} anterior{past.length > 1 ? "es" : ""} (completados)
                </button>
                {showPast && past.map(Row)}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
