"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabaseClient";

type Story = {
  id: string;
  project_id: string;
  key: string;
  title: string;
  lane: string;
  status: string;
  blocked_by: string[];
};

// The lifecycle columns (mirrors the DB status domain / state machine).
const COLUMNS = ["backlog", "ready", "running", "review", "done", "failed", "blocked"] as const;
const COLUMN_COLOR: Record<string, string> = {
  backlog: "#8b949e", ready: "#58a6ff", running: "#d29922", review: "#a371f7",
  done: "#3fb950", failed: "#f85149", blocked: "#f85149",
};

// Board is the deps-aware kanban that lives on Realtime. A 'ready' story with no
// unmet dependency can be dispatched with one click → the dispatch_story RPC
// (atomic: live-run guard + state machine, F6-01/F3-03).
export default function Board({ projectId }: { projectId: string }) {
  const [stories, setStories] = useState<Story[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const supabase = browserClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("stories")
        .select("*")
        .eq("project_id", projectId)
        .order("key", { ascending: true });
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setStatus("error");
        return;
      }
      setStories((data as Story[]) ?? []);
      setStatus("ready");
    })();

    const upsert = (row: Story) =>
      setStories((prev) => {
        const i = prev.findIndex((s) => s.id === row.id);
        if (i === -1) return [...prev, row];
        const next = [...prev];
        next[i] = row;
        return next;
      });

    const channel = supabase
      .channel(`board:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stories", filter: `project_id=eq.${projectId}` },
        (p) => {
          if (p.eventType === "DELETE") setStories((prev) => prev.filter((s) => s.id !== (p.old as Story).id));
          else upsert(p.new as Story);
        })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const dispatch = async (id: string) => {
    setBusy(id);
    const { error } = await browserClient().rpc("dispatch_story", { p_story_id: id });
    if (error) setError(error.message);
    setBusy(null);
    // The status change arrives via Realtime; no optimistic write needed.
  };

  if (status === "loading") return <p style={{ color: "var(--muted)" }}>Cargando…</p>;
  if (status === "error") return <p style={{ color: "#f85149" }}>No se pudo leer el board: {error}</p>;

  const byStatus = (s: string) => stories.filter((st) => st.status === s);

  return (
    <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 12 }}>
      {COLUMNS.map((col) => (
        <div key={col} style={{ minWidth: 200, flex: "1 0 200px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: COLUMN_COLOR[col] }} />
            <strong style={{ fontSize: 13, textTransform: "capitalize" }}>{col}</strong>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{byStatus(col).length}</span>
          </div>
          {byStatus(col).map((s) => (
            <div key={s.id} style={{ border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 8, padding: "0.6rem 0.7rem", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--muted)" }}>{s.key}</span>
                {s.lane && <span style={{ fontSize: 10, color: "var(--accent)" }}>{s.lane}</span>}
              </div>
              <div style={{ fontSize: 13, margin: "2px 0 6px" }}>{s.title || "—"}</div>
              {s.blocked_by?.length > 0 && (
                <div style={{ fontSize: 11, color: "#f85149" }}>⛔ blocked by {s.blocked_by.length}</div>
              )}
              {s.status === "ready" && (
                <button
                  onClick={() => dispatch(s.id)}
                  disabled={busy === s.id || s.blocked_by?.length > 0}
                  style={{
                    marginTop: 6, fontSize: 12, cursor: "pointer",
                    background: "var(--accent)", color: "#0d1117", border: "none",
                    borderRadius: 6, padding: "3px 10px", opacity: s.blocked_by?.length > 0 ? 0.4 : 1,
                  }}
                >
                  {busy === s.id ? "…" : "Despachar"}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
