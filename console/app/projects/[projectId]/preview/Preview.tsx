"use client";

// "App en vivo" (release v2 · docs/14) — el disparador + monitor del PREVIEW EFÍMERO. El usuario pide
// ver la app corriendo navegable; se encola en preview_requests (RLS por tenant); el preview-runner
// (HOST-level, con docker) la levanta en un contenedor descartable + túnel público y estampa preview_url.
// Mismo patrón que IncrementRequest (P5-2): supabase.from + realtime + insert con tenant_id. Motor nuevo
// (scripts/preview-runner.sh); esto es el trigger + la vista de la URL.

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { useLocale } from "@/lib/locale";
import { activeToken } from "@/lib/supabaseClient";

type Preview = { id: string; ref: string | null; status: string; preview_url: string | null; error: string | null; expires_at: string | null; created_at: string };
const ACTIVE = new Set(["pending", "building", "live"]);

export default function Preview() {
  const { projectId, supabase, project } = useProject();
  const { t } = useLocale();
  const [latest, setLatest] = useState<Preview | null>(null);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("main");

  // Ramas reales del repo → dropdown (para elegir la rama de un build del engine y verla antes de mergear).
  useEffect(() => {
    let dead = false;
    const tok = activeToken();
    void fetch(`/api/projects/${projectId}/branches`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} })
      .then((r) => r.json()).then((d) => { if (!dead) { setBranches(d.branches ?? []); setDefaultBranch(d.defaultBranch ?? "main"); } })
      .catch(() => {});
    return () => { dead = true; };
  }, [projectId]);

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

      <div className="pv-stack">
        {/* Control: rama/sprint opcional + generar/regenerar */}
        <div className="pv-panel pv-control">
          <label className="pv-field">
            <span className="eyebrow acc">{t("preview.refLabel")}</span>
            <select className="pv-select" value={ref} onChange={(e) => setRef(e.target.value)}>
              <option value="">{defaultBranch} (default)</option>
              {branches.filter((b) => b !== defaultBranch).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <button className="btn primary" disabled={inFlight || !project} onClick={generate}>
            {inFlight ? "…" : latest ? t("preview.regenerate") : t("preview.generate")}
          </button>
        </div>

        {err && <p className="pv-err">{err}</p>}

        {/* Estado */}
        {building && (
          <div className="pv-panel pv-state">
            <span className="spin" />
            <span className="pv-state-tx">
              {t(status === "pending" ? "preview.status.pending" : "preview.status.building")}
            </span>
          </div>
        )}

        {status === "failed" && (
          <div className="pv-panel fail">
            <div className="pv-fail-t">{t("preview.status.failed")}</div>
            <div className="pv-fail-m">{latest?.error ?? "—"}</div>
          </div>
        )}

        {status === "expired" && (
          <div className="pv-panel"><span className="pv-state-tx">{t("preview.status.expired")}</span></div>
        )}

        {live && (
          <div className="pv-live">
            <div className="pv-live-bar">
              <span className="pv-dot" />
              <span className="pv-live-t">{t("preview.status.live")}</span>
              <a className="pv-url" href={latest!.preview_url!} target="_blank" rel="noreferrer">
                {latest!.preview_url}
              </a>
              <span className="pv-spacer" />
              {expiresLabel && <span className="pv-exp">{expiresLabel}</span>}
              <a className="btn tonal" href={latest!.preview_url!} target="_blank" rel="noreferrer">{t("preview.open")}</a>
            </div>
            {/* La app embebida. Algunas apps setean X-Frame-Options y no se dejan enmarcar → el link de
                arriba es el camino seguro; el iframe es el "en vivo" cuando la app lo permite. */}
            <iframe className="pv-frame" src={latest!.preview_url!} title={t("preview.title")} />
          </div>
        )}

        {!latest && !building && (
          <div className="pv-empty">
            <div className="pv-empty-t">{t("preview.empty")}</div>
            <div className="pv-empty-s">{t("preview.emptyHint")}</div>
          </div>
        )}

        <p className="pv-note">{t("preview.disclaimer")}</p>
      </div>
    </div>
  );
}
