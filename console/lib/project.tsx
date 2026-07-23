"use client";

// F6 refactor · Project-first routing. This is the ONE place the console establishes a
// project's context: it holds the supabase client, arms the tenant token on the realtime
// socket ONCE (so RLS applies to the stream), and renders the nav between the project's
// views. The feature views (studio/board/brain) read the client from `useProject()` and
// never re-arm the tenant session — they just render their surface for `projectId`.
//
// La tabla `projects` (F5-P1) es la fuente del nombre/descripción: ProjectShell la carga
// una vez y la expone por contexto (useProject().project), así las vistas muestran el
// proyecto real en vez de un nombre hardcodeado.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { browserClient, activeToken, freshToken } from "./supabaseClient";
import { useLocale } from "./locale";
import { TopBar } from "@/components/shell/TopBar";
import { FloatingAssistant } from "@/components/FloatingAssistant";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectMeta = { id: string; name: string; description: string | null; org: string | null; repo: string | null; tenant_id: string | null };
type ProjectCtx = { projectId: string; supabase: SupabaseClient; project: ProjectMeta | null };
const Ctx = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}

const FEATURES: { key: string; icon: string }[] = [
  { key: "overview", icon: "◇" },
  { key: "studio", icon: "✎" },
  { key: "board", icon: "▤" },
  { key: "agents", icon: "◎" },
  { key: "flow", icon: "⟳" },
  { key: "preview", icon: "◉" },
  { key: "brain", icon: "◈" },
  { key: "assistant", icon: "✦" },
  { key: "registry", icon: "▦" },
  { key: "settings", icon: "⚙" },
];

export function ProjectShell({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const supabase = useMemo(() => browserClient(), []);
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Arm the tenant token on the realtime socket, and RE-arm it periodically. Sin esto el socket se
  // armaba una sola vez con el token de sesión y nunca se refrescaba → a las 8h el JWT vencía y el
  // realtime moría ("JWT expired"). freshToken() además refresca la sesión si está por vencer, así
  // mientras la pestaña esté abierta el token no expira. (Una sesión YA vencida → re-login: un JWT
  // vencido no se puede refrescar.) Las queries ya usan freshToken() vía el accessToken del cliente.
  useEffect(() => {
    let stopped = false;
    const arm = async () => {
      const tok = (await freshToken()) ?? activeToken();
      if (!stopped && tok) void supabase.realtime.setAuth(tok);
    };
    void arm();
    const iv = setInterval(() => void arm(), 20 * 60 * 1000); // cada 20 min (ventana de refresh = 60 min)
    return () => { stopped = true; clearInterval(iv); };
  }, [supabase]);

  // Cargar la metadata del proyecto (nombre/descr/org/repo) — RLS la scopea al tenant.
  useEffect(() => {
    let cancelled = false;
    void supabase.from("projects").select("id,name,description,org,repo,tenant_id").eq("id", projectId).single()
      .then(({ data }) => { if (!cancelled) setProject((data as ProjectMeta) ?? null); });
    return () => { cancelled = true; };
  }, [supabase, projectId]);

  return (
    <Ctx.Provider value={{ projectId, supabase, project }}>
      <TopBar currentProjectId={projectId} />
      <div className={`sh-shell${collapsed ? " collapsed" : ""}`}>
        <aside className="sh-rail">
          <div className="sh-rail-h">Proyecto</div>
          {FEATURES.map((f) => {
            const href = `/projects/${projectId}/${f.key}`;
            const active = pathname === href;
            return (
              <Link key={f.key} href={href} className={`sh-nav${active ? " on" : ""}`} title={t(`nav.${f.key}`)}>
                <span className="ic">{f.icon}</span>
                <span className="lb">{t(`nav.${f.key}`)}</span>
              </Link>
            );
          })}
          <button className="sh-nav" style={{ marginTop: 8 }} onClick={() => setCollapsed((c) => !c)} title="Colapsar">
            <span className="ic">⇤</span><span className="lb">Colapsar</span>
          </button>
          {project?.repo && (
            <div className="sh-rail-foot">Repo: <a href={project.repo} target="_blank" rel="noreferrer" style={{ color: "var(--ink3)" }}>{project.repo.replace(/^https?:\/\/github\.com\//, "")}</a></div>
          )}
        </aside>
        <main>{children}</main>
      </div>
      <FloatingAssistant />
    </Ctx.Provider>
  );
}
