"use client";

// F6 refactor · Project-first routing. This is the ONE place the console establishes a
// project's context: it holds the supabase client, arms the tenant token on the realtime
// socket ONCE (so RLS applies to the stream), and renders the nav between the project's
// views. The feature views (studio/board/brain) read the client from `useProject()` and
// never re-arm the tenant session — they just render their surface for `projectId`.
//
// No `projects` table exists yet (dev uses NEXT_PUBLIC_DEV_PROJECT_ID + a pre-minted
// tenant JWT), so "loading the project" here is establishing that shared context; real
// project metadata + a GitHub-OAuth session token land in this same spot later.

import { createContext, useContext, useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { browserClient, devTenantToken } from "./supabaseClient";
import { useLocale } from "./locale";
import type { SupabaseClient } from "@supabase/supabase-js";

type ProjectCtx = { projectId: string; supabase: SupabaseClient };
const Ctx = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}

const FEATURES = ["studio", "board", "brain"] as const;

export function ProjectShell({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const supabase = useMemo(() => browserClient(), []);

  // Arm the tenant token on the realtime socket once for the whole project context. The
  // feature views subscribe through the same client, so their streams are tenant-scoped.
  useEffect(() => {
    if (devTenantToken) void supabase.realtime.setAuth(devTenantToken);
  }, [supabase]);

  return (
    <Ctx.Provider value={{ projectId, supabase }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 20px", borderBottom: "1px solid var(--stroke)", background: "#fff", position: "sticky", top: 0, zIndex: 20 }}>
        <Link href="/projects" style={{ fontSize: 13, color: "var(--ink4)", textDecoration: "none" }}>← {t("nav.projects")}</Link>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink4)" }}>{projectId.slice(0, 8)}…</span>
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
