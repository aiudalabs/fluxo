"use client";

import Link from "next/link";
import { useLocale } from "@/lib/locale";

const devProject = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;

export default function Home() {
  const { t } = useLocale();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "3rem 1.25rem" }}>
      <h1>{t("app.title")}</h1>
      <p style={{ color: "var(--muted)" }}>{t("app.tagline")}</p>
      <p>
        {devProject ? (
          <Link href={`/brain/${devProject}`}>{t("home.openBrain")}</Link>
        ) : (
          <span style={{ color: "var(--muted)" }}>{t("home.configure")}</span>
        )}
      </p>
    </main>
  );
}
