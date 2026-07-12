"use client";

// Projects list / switcher (F5-P1) — el entry point del IA project-first. Ahora lee la
// tabla `projects` real (RLS-scoped por tenant), en vez de la env var del dev-shim. El
// `/` entry inserta acá; esta lista los muestra. Realtime → aparece solo al crearse.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/locale";
import { browserClient } from "@/lib/supabaseClient";

type Project = { id: string; name: string; description: string | null; org: string | null; created_at: string };

export default function ProjectsPage() {
  const { t } = useLocale();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = browserClient();
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("projects")
        .select("id,name,description,org,created_at")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setProjects((data as Project[]) ?? []);
      setLoading(false);
    };
    void load();
    const ch = supabase
      .channel("projects-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => void load())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
  }, []);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2.5rem 1.25rem" }}>
      <h1 style={{ marginBottom: 4 }}>{t("projects.title")}</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>{t("projects.tagline")}</p>

      <div style={{ marginTop: 16 }}>
        <Link href="/" className="btn primary sm" style={{ textDecoration: "none", display: "inline-block", marginBottom: 16 }}>
          + {t("projects.new") === "projects.new" ? "Nuevo proyecto" : t("projects.new")}
        </Link>
      </div>

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>
      ) : projects.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>{t("projects.none")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}/overview`} style={{
              display: "block", border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 10,
              padding: "0.9rem 1.1rem", textDecoration: "none", color: "inherit",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <strong style={{ fontSize: 15 }}>{p.name}</strong>
                {p.org && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--muted)" }}>{p.org}</span>}
              </div>
              {p.description && (
                <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.description}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
