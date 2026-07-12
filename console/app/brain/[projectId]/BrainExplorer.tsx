"use client";

import { useEffect, useState } from "react";
import { browserClient, type BrainEvent } from "@/lib/supabaseClient";

const KIND_COLOR: Record<string, string> = {
  decision: "#a371f7",
  gate_answer: "#3fb950",
  rejected_design: "#f85149",
  provenance: "#58a6ff",
};

// BrainExplorer renders a project's brain timeline (newest first) directly from
// Supabase — RLS scopes reads to the caller's tenant — and subscribes to Realtime
// so a new brain_write append (e.g. from brain-mcp) shows up with no polling. This
// is the moat's read surface (F1-04); it kills the 25s serial conductor (L-ARCH-4).
export default function BrainExplorer({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const supabase = browserClient();
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
  }, [projectId]);

  if (status === "loading") return <p style={{ color: "var(--muted)" }}>Cargando…</p>;
  if (status === "error")
    return <p style={{ color: "#f85149" }}>No se pudo leer el brain: {error}</p>;
  if (events.length === 0)
    return <p style={{ color: "var(--muted)" }}>Sin eventos todavía para este proyecto.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
      {events.map((e) => (
        <li
          key={e.id}
          style={{
            border: "1px solid var(--border)",
            background: "var(--panel)",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            marginBottom: 8,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: KIND_COLOR[e.kind] ?? "var(--text)",
                border: `1px solid ${KIND_COLOR[e.kind] ?? "var(--border)"}`,
                borderRadius: 999,
                padding: "1px 8px",
              }}
            >
              {e.kind}
            </span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.actor}</span>
            <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
              {new Date(e.ts).toLocaleString()}
            </span>
          </div>
          <pre
            style={{
              margin: "0.5rem 0 0",
              fontSize: 12,
              color: "var(--text)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </li>
      ))}
    </ul>
  );
}
