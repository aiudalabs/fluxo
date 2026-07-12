"use client";

import Link from "next/link";
import { useLocale } from "@/lib/locale";

// Projects list / switcher — the entry point of the project-first IA. No `projects` table
// yet (dev uses NEXT_PUBLIC_DEV_PROJECT_ID + a pre-minted tenant JWT), so this lists the
// dev project; a real per-tenant list lands with GitHub-OAuth auth.
const devProject = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;

export default function ProjectsPage() {
  const { t } = useLocale();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2.5rem 1.25rem" }}>
      <h1 style={{ marginBottom: 4 }}>{t("projects.title")}</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>{t("projects.tagline")}</p>
      {devProject ? (
        <Link href={`/projects/${devProject}/brain`} style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 10,
          padding: "0.9rem 1rem", textDecoration: "none", marginTop: 16,
        }}>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{devProject}</span>
          <span style={{ color: "var(--accent)", fontSize: 13 }}>{t("projects.open")}</span>
        </Link>
      ) : (
        <p style={{ color: "var(--muted)", marginTop: 16 }}>{t("projects.none")}</p>
      )}
    </main>
  );
}
