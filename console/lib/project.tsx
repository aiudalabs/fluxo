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
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectMeta = { id: string; name: string; description: string | null; org: string | null; repo: string | null };
type ProjectCtx = { projectId: string; supabase: SupabaseClient; project: ProjectMeta | null };
const Ctx = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}

const FEATURES = ["overview", "studio", "board", "flow", "brain"] as const;

export function ProjectShell({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const supabase = useMemo(() => browserClient(), []);
  const [project, setProject] = useState<ProjectMeta | null>(null);

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
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 20px", borderBottom: "1px solid var(--stroke)", background: "#fff", position: "sticky", top: 0, zIndex: 20 }}>
        <Link href="/projects" style={{ fontSize: 13, color: "var(--ink4)", textDecoration: "none" }}>← {t("nav.projects")}</Link>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{project?.name ?? `${projectId.slice(0, 8)}…`}</span>
        <nav style={{ display: "flex", gap: 4, marginLeft: 12 }}>
          {FEATURES.map((f) => {
            const href = `/projects/${projectId}/${f}`;
            const active = pathname === href;
            return (
              <Link key={f} href={href} style={{
                fontSize: 14, fontWeight: 600, padding: "18px 12px", textDecoration: "none",
                color: active ? "var(--ink)" : "var(--ink4)",
                borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`, marginBottom: -1,
              }}>
                {t(`nav.${f}`)}
              </Link>
            );
          })}
        </nav>
      </header>
      <main>{children}</main>
    </Ctx.Provider>
  );
}
