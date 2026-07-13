"use client";

// `/` — el entry conversacional "¿qué querés construir?" (StudioEntry). Ahora AUTH-AWARE
// (F5-P8 A): si no hay sesión, el paso 1 es "Continuar con GitHub"; con sesión, mostramos el
// login + el picker de orgs REAL (donde el usuario puede crear repos) y el link para instalar
// la App. El launch crea el proyecto bajo el tenant del usuario (RLS por su JWT de sesión).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { browserClient, sessionToken, clearSession } from "@/lib/supabaseClient";
import { Logo } from "@/components/Logo";

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

export default function HomePage() {
  const t = useT();
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [projectName, setProjectName] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [touchedRepo, setTouchedRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Auth
  const [login, setLogin] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string>("");
  const [orgs, setOrgs] = useState<string[]>([]);
  const [org, setOrg] = useState<string>("");
  const hasSession = typeof window !== "undefined" && !!sessionToken();

  useEffect(() => {
    const s = sessionToken();
    const headers = s ? { Authorization: `Bearer ${s}` } : undefined;
    void fetch("/auth/github/status", { headers }).then((r) => r.json()).then((d) => {
      setLogin(d.login ?? null);
      setInstallUrl(d.installUrl ?? "");
    }).catch(() => {});
    if (s) {
      void fetch("/api/github/orgs", { headers }).then((r) => r.json()).then((d) => {
        const list: string[] = Array.isArray(d.orgs) ? d.orgs : [];
        setOrgs(list);
        setOrg((o) => o || list[0] || DEV_ORG);
      }).catch(() => {});
    } else {
      setOrgs([DEV_ORG]);
      setOrg(DEV_ORG);
    }
  }, []);

  const repoName = touchedRepo ? repoInput : slugify(projectName);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedIdea = idea.trim();
    const finalProjectName = projectName.trim();
    const finalRepo = slugify(repoName);
    if (!trimmedIdea) { setError(t("studio.entry.validation.idea")); return; }
    if (!finalProjectName || !finalRepo) { setError(t("studio.entry.validation.name")); return; }
    setBusy(true);
    // El proyecto nace bajo el tenant del usuario (default del JWT de sesión vía RLS).
    const supabase = browserClient();
    const { data, error: insErr } = await supabase
      .from("projects")
      .insert({ name: finalProjectName, description: trimmedIdea, org: org || DEV_ORG })
      .select("id").single();
    if (insErr || !data) { setError(insErr?.message ?? String(insErr)); setBusy(false); return; }
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

        {/* Auth strip */}
        {login ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center", margin: "0 0 18px", fontSize: 13, color: "var(--ink3)" }}>
            <span>✓ Conectado como <strong style={{ color: "var(--ink)" }}>{login}</strong></span>
            {installUrl && <a className="chip" href={installUrl} target="_blank" rel="noreferrer">Instalar la App en otra org</a>}
            <button className="chip" onClick={() => { clearSession(); window.location.reload(); }}>Salir</button>
          </div>
        ) : (
          <a href="/auth/github/start" style={{ display: "block", textDecoration: "none", margin: "0 0 20px", padding: "16px 18px", border: "1px solid var(--accent-line)", background: "var(--accent-soft)", borderRadius: 14 }}>
            <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>⚡ Continuar con GitHub</div>
            <div style={{ fontSize: 13, color: "var(--ink3)", marginTop: 4 }}>Conectá tu GitHub para crear repos en tus organizaciones.</div>
            <span className="btn primary sm" style={{ marginTop: 12, display: "inline-block" }}>Continuar con GitHub →</span>
          </a>
        )}

        <form className="entry-form" onSubmit={launch}>
          <textarea className="entry-idea" value={idea} onChange={(e) => setIdea(e.target.value)}
            placeholder={t("studio.entry.ideaPlaceholder")} autoFocus rows={3} />

          <div className="entry-examples">
            {EXAMPLES.map((ex, i) => (
              <button key={i} type="button" className="entry-chip" onClick={() => setIdea(ex)}>
                {ex.split(",")[0].slice(0, 42)}…
              </button>
            ))}
          </div>

          <input className="entry-name-inp"
            style={{ width: "100%", padding: "12px 14px", border: "1px solid var(--stroke-strong)", borderRadius: 12, fontFamily: "var(--display)", fontSize: 14, background: "#fff", color: "var(--ink)" }}
            value={projectName} onChange={(e) => setProjectName(e.target.value)}
            placeholder={t("studio.entry.projectNamePlaceholder")} spellCheck={false} />

          <div className="entry-row">
            <div className="entry-name">
              {orgs.length > 1 ? (
                <select value={org} onChange={(e) => setOrg(e.target.value)} title={t("studio.entry.orgTitle")}
                  style={{ border: "none", background: "transparent", fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink2)", cursor: "pointer", outline: "none", maxWidth: 160 }}>
                  {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <span className="entry-name-pre">{org || DEV_ORG}</span>
              )}
              <span className="entry-name-pre" style={{ padding: "0 2px" }}>/</span>
              <input className="entry-name-inp" value={repoName}
                onChange={(e) => { setTouchedRepo(true); setRepoInput(e.target.value); }}
                placeholder={t("studio.entry.namePlaceholder")} spellCheck={false} />
            </div>
            <button type="submit" className="entry-go" disabled={busy || (!hasSession && orgs.length === 0)}>
              {busy ? t("studio.entry.launching") : t("studio.entry.start")}
            </button>
          </div>

          {error && <div className="entry-err">{error}</div>}
        </form>
      </div>
    </div>
  );
}
