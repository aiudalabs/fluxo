"use client";

// "App en vivo" (release v2 · docs/14) — el disparador + monitor del PREVIEW EFÍMERO. El usuario pide
// ver la app corriendo navegable; se encola en preview_requests (RLS por tenant); el preview-runner
// (HOST-level, con docker) la levanta en un contenedor descartable + túnel público y estampa preview_url.
// Mismo patrón que IncrementRequest (P5-2): supabase.from + realtime + insert con tenant_id. Motor nuevo
// (scripts/preview-runner.sh); esto es el trigger + la vista de la URL.

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useLocale } from "@/lib/locale";

type Preview = { id: string; ref: string | null; status: string; preview_url: string | null; error: string | null; expires_at: string | null; created_at: string };
const ACTIVE = new Set(["pending", "building", "live"]);

export default function Preview() {
  const { projectId, supabase, project } = useProject();
  const { t } = useLocale();
  const [latest, setLatest] = useState<Preview | null>(null);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const { data, error } = await supabase
        .from("preview_requests")
        .select("id,ref,status,preview_url,error,expires_at,created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (dead) return;
      if (error) { setErr(t("preview.readError", { msg: error.message })); return; }
      setErr(null);
      setLatest(((data as Preview[]) ?? [])[0] ?? null);
    };
    void load();
    const ch = supabase
      .channel(`preview:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "preview_requests", filter: `project_id=eq.${projectId}` }, () => void load())
      .subscribe();
    return () => { dead = true; supabase.removeChannel(ch); };
  }, [projectId, supabase, t]);

  const generate = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("preview_requests").insert({
      project_id: projectId,
      tenant_id: project?.tenant_id,
      ref: ref.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(t("preview.requestError", { msg: error.message })); return; }
    setRef("");
  };

  const status = latest?.status;
  const building = status === "pending" || status === "building";
  const live = status === "live" && !!latest?.preview_url;
  // El botón queda desactivado mientras hay uno en curso (evita levantar dos a la vez).
  const inFlight = busy || (latest ? ACTIVE.has(status ?? "") && !live : false);

  const expiresLabel = useMemo(() => {
    if (!latest?.expires_at) return null;
    const d = new Date(latest.expires_at);
    return t("preview.expires", { when: d.toLocaleString() });
  }, [latest?.expires_at, t]);

  return (
    <div className="wrap">
      <div className="sectitle">
        <h2>{t("preview.title")}</h2>
        <span className="c">{t("preview.subtitle")}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
        {/* Control: rama/sprint opcional + generar/regenerar */}
        <div style={{ border: "1px solid var(--stroke)", background: "var(--panel)", borderRadius: 12, padding: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 220 }}>
            <span className="eyebrow acc">{t("preview.refLabel")}</span>
            <input
              value={ref} onChange={(e) => setRef(e.target.value)} placeholder={t("preview.refPlaceholder")}
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--stroke)", background: "var(--bg2)", color: "var(--text)", fontSize: 13, fontFamily: "inherit" }}
            />
          </label>
          <button className="btn" disabled={inFlight || !project} onClick={generate}>
            {inFlight ? "…" : latest ? t("preview.regenerate") : t("preview.generate")}
          </button>
        </div>

        {err && <p style={{ fontSize: 12.5, color: "var(--danger)" }}>{err}</p>}

        {/* Estado */}
        {building && (
          <div style={{ border: "1px solid var(--stroke)", background: "var(--panel)", borderRadius: 12, padding: 20, display: "flex", alignItems: "center", gap: 12 }}>
            <span className="spin" />
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              {t(status === "pending" ? "preview.status.pending" : "preview.status.building")}
            </span>
          </div>
        )}

        {status === "failed" && (
          <div style={{ border: "1px solid var(--danger)", background: "var(--panel)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: "var(--danger)", marginBottom: 4 }}>{t("preview.status.failed")}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "var(--mono, monospace)" }}>{latest?.error ?? "—"}</div>
          </div>
        )}

        {status === "expired" && (
          <div style={{ border: "1px solid var(--stroke)", background: "var(--panel)", borderRadius: 12, padding: 16, fontSize: 13, color: "var(--muted)" }}>
            {t("preview.status.expired")}
          </div>
        )}

        {live && (
          <div style={{ border: "1px solid var(--emerald)", background: "var(--panel)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--stroke)", flexWrap: "wrap" }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: "var(--emerald)", flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t("preview.status.live")}</span>
              <a href={latest!.preview_url!} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "var(--mono, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
                {latest!.preview_url}
              </a>
              <span style={{ flex: 1 }} />
              {expiresLabel && <span style={{ fontSize: 11, color: "var(--muted)" }}>{expiresLabel}</span>}
              <a className="btn" href={latest!.preview_url!} target="_blank" rel="noreferrer">{t("preview.open")}</a>
            </div>
            {/* La app embebida. Algunas apps setean X-Frame-Options y no se dejan enmarcar → el link de
                arriba es el camino seguro; el iframe es el "en vivo" cuando la app lo permite. */}
            <iframe src={latest!.preview_url!} title={t("preview.title")} style={{ width: "100%", height: 560, border: 0, background: "var(--bg2)" }} />
          </div>
        )}

        {!latest && !building && (
          <div style={{ border: "1px dashed var(--stroke)", borderRadius: 12, padding: 24, textAlign: "center" }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>{t("preview.empty")}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", maxWidth: 460, margin: "0 auto" }}>{t("preview.emptyHint")}</div>
          </div>
        )}

        <p style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>{t("preview.disclaimer")}</p>
      </div>
    </div>
  );
}
