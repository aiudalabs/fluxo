"use client";

// P5-2 · "Pedir incremento" — el disparador del change-request. El usuario describe qué agregar al
// producto YA construido; se encola en increment_requests (RLS por tenant); el worker lo levanta y
// corre iterate.yaml (iteration-planner → DELTA backlog → APPEND al board). Motor ya existente; esto
// es el trigger UI. Hogar futuro: el AI Assistant (P5-1); por ahora vive en el Overview.

import { useEffect, useState } from "react";
import { useProject } from "@/lib/project";

type Req = { id: string; instructions: string; status: string; created_at: string };
const STATUS_COLOR: Record<string, string> = { pending: "var(--amber)", running: "var(--amber)", done: "var(--emerald)", failed: "var(--danger)" };

export function IncrementRequest() {
  const { projectId, supabase, project } = useProject();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);

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
    <div style={{ border: "1px solid var(--stroke)", background: "var(--panel)", borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Pedir incremento</div>
        <div style={{ fontSize: 12, color: "var(--muted)", flex: 1 }}>Agregá features o mejoras al producto ya construido — Fluxo planea el delta y lo appendea al backlog.</div>
        {!open && <button className="btn" onClick={() => setOpen(true)}>+ Nuevo</button>}
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={3}
            placeholder="Ej: agregá reservas recurrentes semanales y recordatorios por email 24h antes de la cita."
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--stroke)", background: "var(--bg2)", color: "var(--text)", fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn" disabled={busy || !text.trim()} onClick={submit}>{busy ? "Enviando…" : "Pedir incremento"}</button>
            <button className="btn ghost" onClick={() => { setOpen(false); setText(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {msg && <p style={{ marginTop: 10, fontSize: 12.5, color: msg.ok ? "var(--emerald)" : "var(--danger)" }}>{msg.text}</p>}

      {reqs.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="eyebrow acc">Pedidos</div>
          {reqs.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "6px 0", borderBottom: "1px solid var(--stroke)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_COLOR[r.status] ?? "var(--muted)", flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.instructions}</span>
              <span style={{ color: STATUS_COLOR[r.status] ?? "var(--muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: 0.4 }}>{r.status}</span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>{new Date(r.created_at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
