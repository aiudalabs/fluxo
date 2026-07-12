"use client";

// `/` — el entry conversacional "¿qué querés construir?", PORTADO verbatim de v1
// (StudioEntry): el punto de arranque imposible-de-perder. Describís la idea, le ponés
// nombre y repo, y un botón crea el proyecto y arranca el design run.
//
// Data re-point vs v1: el launch CREA un proyecto real (tabla projects, F5-P1) — RLS pone
// el tenant_id desde el JWT — y aterriza en su Overview. El arranque del design run (motor
// Agent SDK) entra en la siguiente tajada de F5; por ahora el proyecto nace vacío.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { browserClient } from "@/lib/supabaseClient";
import { Logo } from "@/components/Logo";

const DEV_ORG = "aiudalabs";

// Slugify una idea/nombre a un repo válido (minúsculas, guiones) — calcado de v1.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const EXAMPLES = [
  "Un marketplace que conecta clientes con proveedores de servicios locales verificados.",
  "Una app de tareas colaborativa para equipos pequeños, con tableros y recordatorios.",
  "Un CRM simple para freelancers: contactos, propuestas y seguimiento de pagos.",
];

export default function HomePage() {
  const t = useT();
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [projectName, setProjectName] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [touchedRepo, setTouchedRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // El repo se auto-deriva del nombre del proyecto (slug) hasta que el usuario lo edita.
  const repoName = touchedRepo ? repoInput : slugify(projectName);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedIdea = idea.trim();
    const finalProjectName = projectName.trim();
    const finalRepo = slugify(repoName);
    if (!trimmedIdea) {
      setError(t("studio.entry.validation.idea"));
      return;
    }
    if (!finalProjectName || !finalRepo) {
      setError(t("studio.entry.validation.name"));
      return;
    }
    setBusy(true);
    // Crea el proyecto real (tenant_id lo pone el default del JWT vía RLS) y navega a su
    // Overview. El design run se arranca en la próxima tajada de F5.
    const supabase = browserClient();
    const { data, error: insErr } = await supabase
      .from("projects")
      .insert({ name: finalProjectName, description: trimmedIdea, org: DEV_ORG })
      .select("id")
      .single();
    if (insErr || !data) {
      setError(insErr?.message ?? String(insErr));
      setBusy(false);
      return;
    }
    router.push(`/projects/${data.id}/overview`);
  }

  return (
    <div className="entry">
      <div className="entry-inner">
        <div className="entry-brand">
          <Logo size="lg" />
        </div>
        <h1 className="entry-h1">{t("studio.entry.h1")}</h1>
        <p className="entry-sub">{t("studio.entry.sub")}</p>

        <form className="entry-form" onSubmit={launch}>
          <textarea
            className="entry-idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder={t("studio.entry.ideaPlaceholder")}
            autoFocus
            rows={3}
          />

          <div className="entry-examples">
            {EXAMPLES.map((ex, i) => (
              <button key={i} type="button" className="entry-chip" onClick={() => setIdea(ex)}>
                {ex.split(",")[0].slice(0, 42)}…
              </button>
            ))}
          </div>

          <input
            className="entry-name-inp"
            style={{ width: "100%", padding: "12px 14px", border: "1px solid var(--stroke-strong)", borderRadius: 12, fontFamily: "var(--display)", fontSize: 14, background: "#fff", color: "var(--ink)" }}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={t("studio.entry.projectNamePlaceholder")}
            spellCheck={false}
          />

          <div className="entry-row">
            <div className="entry-name">
              <span className="entry-name-pre">{DEV_ORG}</span>
              <span className="entry-name-pre" style={{ padding: "0 2px" }}>/</span>
              <input
                className="entry-name-inp"
                value={repoName}
                onChange={(e) => {
                  setTouchedRepo(true);
                  setRepoInput(e.target.value);
                }}
                placeholder={t("studio.entry.namePlaceholder")}
                spellCheck={false}
              />
            </div>
            <button type="submit" className="entry-go" disabled={busy}>
              {busy ? t("studio.entry.launching") : t("studio.entry.start")}
            </button>
          </div>

          {error && <div className="entry-err">{error}</div>}
        </form>
      </div>
    </div>
  );
}
