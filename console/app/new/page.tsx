"use client";

// `/new` · el chatbot "¿qué querés construir?" (F6P-07). Se llega YA autenticado + con la
// App instalada (desde el dashboard o el switcher), así que acá NO hay login: solo describís
// la idea, elegís la org y creás. El botón nunca está deshabilitado sin razón. Sin sesión →
// vuelve al login.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { browserClient, sessionToken } from "@/lib/supabaseClient";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

const DEV_ORG = "aiudalabs";
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
const EXAMPLES = [
  "Un marketplace que conecta clientes con proveedores de servicios locales verificados.",
  "Una app de tareas colaborativa para equipos pequeños, con tableros y recordatorios.",
  "Un CRM simple para freelancers: contactos, propuestas y seguimiento de pagos.",
];

export default function NewProjectPage() {
  const t = useT();
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [projectName, setProjectName] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [touchedRepo, setTouchedRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState<string[]>([DEV_ORG]);
  const [org, setOrg] = useState<string>(DEV_ORG);

  useEffect(() => {
    const s = sessionToken();
    if (s) {
      void fetch("/api/github/orgs", { headers: { Authorization: `Bearer ${s}` } })
        .then((r) => r.json()).then((d) => {
          const list: string[] = Array.isArray(d.orgs) && d.orgs.length ? d.orgs : [DEV_ORG];
          setOrgs(list); setOrg(list[0]);
        }).catch(() => {});
    }
  }, []);

  const repoName = touchedRepo ? repoInput : slugify(projectName);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedIdea = idea.trim();
    const finalName = projectName.trim();
    if (!trimmedIdea) { setError(t("studio.entry.validation.idea")); return; }
    if (!finalName || !slugify(repoName)) { setError(t("studio.entry.validation.name")); return; }
    setBusy(true);
    const supabase = browserClient();
    const { data, error: insErr } = await supabase
      .from("projects").insert({ name: finalName, description: trimmedIdea, org }).select("id").single();
    if (insErr || !data) { setError(insErr?.message ?? String(insErr)); setBusy(false); return; }
    router.push(`/projects/${data.id}/overview`);
  }

  return (
    <div className="entry">
      <ThemeToggle className="ob-theme" />
      <div className="entry-inner">
        <div className="entry-brand"><Logo size="lg" /></div>
        <h1 className="entry-h1">{t("studio.entry.h1")}</h1>
        <p className="entry-sub">{t("studio.entry.sub")}</p>

        <form className="entry-form" onSubmit={launch}>
          <textarea className="entry-idea" value={idea} onChange={(e) => setIdea(e.target.value)}
            placeholder={t("studio.entry.ideaPlaceholder")} autoFocus rows={3} />
          <div className="entry-examples">
            {EXAMPLES.map((ex, i) => (
              <button key={i} type="button" className="entry-chip" onClick={() => setIdea(ex)}>{ex.split(",")[0].slice(0, 42)}…</button>
            ))}
          </div>
          <input className="entry-name-inp"
            style={{ width: "100%", padding: "12px 14px", border: "1px solid var(--stroke-strong)", borderRadius: 12, fontFamily: "var(--display)", fontSize: 14, background: "var(--panel)", color: "var(--ink)" }}
            value={projectName} onChange={(e) => setProjectName(e.target.value)}
            placeholder={t("studio.entry.projectNamePlaceholder")} spellCheck={false} />
          <div className="entry-row">
            <div className="entry-name">
              {orgs.length > 1 ? (
                <select value={org} onChange={(e) => setOrg(e.target.value)} title={t("studio.entry.orgTitle")}
                  style={{ border: "none", background: "transparent", fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink2)", cursor: "pointer", outline: "none", maxWidth: 160 }}>
                  {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : <span className="entry-name-pre">{org}</span>}
              <span className="entry-name-pre" style={{ padding: "0 2px" }}>/</span>
              <input className="entry-name-inp" value={repoName}
                onChange={(e) => { setTouchedRepo(true); setRepoInput(e.target.value); }}
                placeholder={t("studio.entry.namePlaceholder")} spellCheck={false} />
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
