"use client";

// `/new` · el chatbot "¿qué querés construir?" (F6P-07). Gate DURO de dos condiciones antes
// de dejar crear: (1) sesión GitHub, (2) la Fluxo App instalada en la org destino. El selector
// de org solo ofrece cuentas DONDE la App está instalada (fuente autoritativa: user/installations);
// si no hay ninguna, el form se bloquea y se muestra el CTA para instalarla. La creación va por
// POST /api/projects, que RE-valida ambas condiciones en el server (no confía en el cliente).
// Así el repo que el worker crea después nunca falla por "App no instalada" (lección Idearium).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { sessionToken } from "@/lib/supabaseClient";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

interface Installation { login: string; type: "User" | "Organization"; avatarUrl: string; }
interface Stack { id: string; label: string; description: string; }

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
  // null = cargando; [] = sin instalaciones (form bloqueado); [...] = cuentas donde crear.
  const [insts, setInsts] = useState<Installation[] | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [org, setOrg] = useState<string>("");
  // Stack: la receta tecnológica con la que Fluxo construye. "auto" (default) = Fluxo elige según el
  // brief; o el humano fija uno (lo ANCLA el architect → mata la alucinación de stack inexistente).
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [stack, setStack] = useState<string>("auto");
  const [stackHelp, setStackHelp] = useState(false);

  useEffect(() => {
    void fetch("/api/registry").then((r) => r.json()).then((d) => {
      if (Array.isArray(d.stacks)) setStacks(d.stacks);
    }).catch(() => {});
  }, []);

  function loadInstallations() {
    const s = sessionToken();
    if (!s) { router.replace("/login"); return; }
    setInsts(null);
    void fetch("/api/github/installations", { headers: { Authorization: `Bearer ${s}` } })
      .then((r) => r.json())
      .then((d) => {
        const list: Installation[] = Array.isArray(d.installations) ? d.installations : [];
        setInstallUrl(d.installUrl ?? "");
        setInsts(list);
        setOrg(list[0]?.login ?? "");
      })
      .catch(() => { setInsts([]); });
  }
  useEffect(loadInstallations, [router]);

  const repoName = touchedRepo ? repoInput : slugify(projectName);
  const canCreate = !busy && !!org && !!insts && insts.length > 0;

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedIdea = idea.trim();
    const finalName = projectName.trim();
    if (!trimmedIdea) { setError(t("studio.entry.validation.idea")); return; }
    if (!finalName || !slugify(repoName)) { setError(t("studio.entry.validation.name")); return; }
    if (!org) { setError("Elegí (o instalá la app en) una cuenta de GitHub."); return; }
    setBusy(true);
    const s = sessionToken();
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s}` },
      body: JSON.stringify({ name: finalName, description: trimmedIdea, org, stack }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error ?? "No se pudo crear el proyecto.");
      if (d.needsInstall && d.installUrl) setInstallUrl(d.installUrl);
      setBusy(false);
      return;
    }
    router.push(`/projects/${d.id}/overview`);
  }

  // Gate: sin ninguna instalación no se puede crear → tarjeta para instalar la app.
  const blocked = insts !== null && insts.length === 0;

  return (
    <div className="entry">
      <Link href="/" className="entry-back" title="Volver a mis proyectos">← Mis proyectos</Link>
      <ThemeToggle className="ob-theme" />
      <div className="entry-inner">
        <div className="entry-brand"><Logo size="lg" /></div>
        <h1 className="entry-h1">{t("studio.entry.h1")}</h1>
        <p className="entry-sub">{t("studio.entry.sub")}</p>

        {blocked ? (
          <div className="entry-gate">
            <div className="entry-gate-ic">⚙</div>
            <h2>Instalá la app de Fluxo para empezar</h2>
            <p>Fluxo trabaja <b>dentro de tu GitHub</b>: crea el repo del proyecto, abre PRs y corre el build.
              Para eso necesita que instales la app en tu cuenta u organización. Podés elegir todos los repos o solo algunos.</p>
            <a className="entry-gate-cta" href={installUrl} target="_blank" rel="noreferrer">Instalar la app de Fluxo en GitHub →</a>
            <button className="entry-gate-refresh" type="button" onClick={loadInstallations}>Ya la instalé — reintentar</button>
          </div>
        ) : (
          <form className="entry-form" onSubmit={launch}>
            <textarea className="entry-idea" value={idea} onChange={(e) => setIdea(e.target.value)}
              placeholder={t("studio.entry.ideaPlaceholder")} autoFocus rows={3} />
            <div className="entry-examples">
              {EXAMPLES.map((ex, i) => (
                <button key={i} type="button" className="entry-chip" onClick={() => setIdea(ex)}>{ex.split(",")[0].slice(0, 42)}…</button>
              ))}
            </div>
            <input className="entry-name-inp entry-inp-block"
              value={projectName} onChange={(e) => setProjectName(e.target.value)}
              placeholder={t("studio.entry.projectNamePlaceholder")} spellCheck={false} />
            <div className="entry-stack">
              <div className="entry-stack-lbl">
                <span>Stack</span>
                <button type="button" className="entry-stack-help-btn" onClick={() => setStackHelp((v) => !v)}>¿Qué es un stack?</button>
              </div>
              <select className="entry-stack-sel" value={stack} onChange={(e) => setStack(e.target.value)}>
                <option value="auto">Auto (Fluxo elige según el brief)</option>
                {stacks.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              {stackHelp && (
                <p className="entry-stack-help">
                  El stack es la receta tecnológica con la que Fluxo construye tu app (lenguaje, framework y
                  backend, más la CI y los agentes que siembra en tu repo). <b>Auto</b> deja que Fluxo elija el
                  más adecuado a tu idea; o elegí uno vos.
                </p>
              )}
              {stack !== "auto" && stacks.find((s) => s.id === stack)?.description && (
                <p className="entry-stack-desc">{stacks.find((s) => s.id === stack)!.description}</p>
              )}
            </div>
            <div className="entry-row">
              <div className="entry-name">
                {insts === null ? (
                  <span className="entry-name-pre">verificando tu acceso a GitHub…</span>
                ) : insts.length > 1 ? (
                  <select className="entry-org-sel" value={org} onChange={(e) => setOrg(e.target.value)} title="Cuenta u organización donde se crea el repo (donde la app está instalada)">
                    {insts.map((o) => <option key={o.login} value={o.login}>{o.login}{o.type === "User" ? " (personal)" : ""}</option>)}
                  </select>
                ) : (
                  <span className="entry-name-pre">{org}</span>
                )}
                <span className="entry-name-pre entry-slash">/</span>
                <input className="entry-name-inp" value={repoName}
                  onChange={(e) => { setTouchedRepo(true); setRepoInput(e.target.value); }}
                  placeholder={t("studio.entry.namePlaceholder")} spellCheck={false} />
              </div>
              <button type="submit" className="entry-go" disabled={!canCreate}>
                {busy ? t("studio.entry.launching") : t("studio.entry.start")}
              </button>
            </div>
            {installUrl && insts !== null && (
              <a className="entry-install-hint" href={installUrl} target="_blank" rel="noreferrer">
                ＋ ¿Falta una cuenta u organización? Instalá la app de Fluxo ahí
              </a>
            )}
            {error && <div className="entry-err">{error}</div>}
          </form>
        )}
      </div>
    </div>
  );
}
