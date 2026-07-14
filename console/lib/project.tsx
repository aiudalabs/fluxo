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
import { browserClient, activeToken } from "./supabaseClient";
import { useLocale } from "./locale";
import { TopBar } from "@/components/shell/TopBar";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectMeta = { id: string; name: string; description: string | null; org: string | null; repo: string | null };
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
  { key: "brain", icon: "◈" },
  { key: "registry", icon: "▦" },
  { key: "spend", icon: "$" },
  { key: "settings", icon: "⚙" },
];

export function ProjectShell({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const supabase = useMemo(() => browserClient(), []);
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Arm the tenant token on the realtime socket once for the whole project context. The
  // feature views subscribe through the same client, so their streams are tenant-scoped.
  useEffect(() => {
    const tok = activeToken();
    if (tok) void supabase.realtime.setAuth(tok);
  }, [supabase]);

  // Cargar la metadata del proyecto (nombre/descr/org/repo) — RLS la scopea al tenant.
  useEffect(() => {
    let cancelled = false;
    void supabase.from("projects").select("id,name,description,org,repo").eq("id", projectId).single()
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
    </Ctx.Provider>
  );
}
