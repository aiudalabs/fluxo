"use client";

// Pasos 2-3 del onboarding (F6P-07) · después del login. Paso 2: conectar GitHub — elegís
// la org donde Fluxo va a trabajar (instalar la App si falta). Paso 3: semáforos de
// capacidades. "Ir a mis proyectos" → el panel. Si no hay sesión, vuelve al login.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { browserClient, sessionToken } from "@/lib/supabaseClient";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [login, setLogin] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  // Cuentas/orgs DONDE la App está instalada (autoritativo). Solo ahí se puede crear.
  const [orgs, setOrgs] = useState<Array<{ login: string; type: string }>>([]);

  useEffect(() => {
    const s = sessionToken();
    if (!s) { router.replace("/login"); return; }
    // Usuario que vuelve y ya tiene proyectos → ya está seteado, saltamos al panel.
    void browserClient().from("projects").select("id").limit(1)
      .then(({ data }) => { if (data && data.length > 0) router.replace("/projects"); });
    const headers = { Authorization: `Bearer ${s}` };
    void fetch("/auth/github/status", { headers }).then((r) => r.json()).then((d) => { setLogin(d.login ?? null); setInstallUrl(d.installUrl ?? ""); }).catch(() => {});
    void fetch("/api/github/installations", { headers }).then((r) => r.json()).then((d) => {
      if (Array.isArray(d.installations)) setOrgs(d.installations);
      if (d.installUrl) setInstallUrl(d.installUrl);
    }).catch(() => {});
  }, [router]);

  return (
    <div className="ob">
      <ThemeToggle className="ob-theme" />
      <div className="ob-stage">
        <div className="ob-brand">{"{"}<span className="b">Fluxo</span>{"}"}</div>
        <div className="ob-byline">by aiuda labs</div>
        <div className="ob-steps"><span className="d done" /><span className={`d ${step === 1 ? "on" : "done"}`} /><span className={`d ${step === 2 ? "on" : ""}`} /></div>

        {step === 1 ? (
          <div className="ob-card">
            <div className="ob-eye">Paso 2 · Conectar GitHub</div>
            <h1>¿Dónde va a trabajar Fluxo?</h1>
            <p className="ob-lead">Fluxo trabaja <b>dentro de tus repos</b>: crea el repo del proyecto, abre PRs y corre el build. Elegí la organización.</p>
            {orgs.length === 0 && <p className="ob-fine tight">Aún no detectamos la app instalada en ninguna cuenta. Instalala abajo 👇</p>}
            {orgs.map((o) => (
              <button key={o.login} className="ob-org" onClick={() => setStep(2)}>
                <span className="av">{o.login.slice(0, 1).toUpperCase()}</span>
                <span className="n">{o.login}{o.type === "User" ? " (personal)" : ""}</span>
                <span className="st ok">✓ lista</span>
              </button>
            ))}
            {installUrl && (
              <a className="ob-ghost outlined" href={installUrl} target="_blank" rel="noreferrer">
                ＋ Instalar Fluxo en otra organización
              </a>
            )}
            <p className="ob-fine">Al instalar, GitHub te deja elegir los repos (todos o algunos).</p>
          </div>
        ) : (
          <div className="ob-card">
            <div className="ob-eye">Paso 3 · Casi listo</div>
            <h1>Tu fábrica está lista</h1>
            <p className="ob-lead">Fluxo diseña y construye con la infra de tu repo. Esto es lo que detectamos:</p>
            <div className="ob-check ok"><span className="ic">✓</span><div className="t"><b>GitHub conectado</b><span>{login ?? "—"} · {orgs.length} organización(es)</span></div></div>
            <div className="ob-check ok"><span className="ic">✓</span><div className="t"><b>La App puede crear repos, issues y PRs</b><span>en las orgs donde la instalaste</span></div></div>
            <div className="ob-check pend"><span className="ic">!</span><div className="t"><b>Canal de build · Claude / Copilot</b><span>opcional — se configura por proyecto, cuando lo necesites</span></div></div>
            <Link className="ob-pri" href="/">Ir a mis proyectos →</Link>
            <Link className="ob-ghost" href="/">Lo configuro después</Link>
          </div>
        )}
      </div>
    </div>
  );
}
