"use client";

// Pasos 2-3 del onboarding (F6P-07) · después del login. Paso 2: conectar GitHub — elegís
// la org donde Fluxo va a trabajar (instalar la App si falta). Paso 3: semáforos de
// capacidades. "Ir a mis proyectos" → el panel. Si no hay sesión, vuelve al login.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient, sessionToken } from "@/lib/supabaseClient";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [login, setLogin] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [orgs, setOrgs] = useState<string[]>([]);

  useEffect(() => {
    const s = sessionToken();
    if (!s) { router.replace("/login"); return; }
    // Usuario que vuelve y ya tiene proyectos → ya está seteado, saltamos al panel.
    void browserClient().from("projects").select("id").limit(1)
      .then(({ data }) => { if (data && data.length > 0) router.replace("/projects"); });
    const headers = { Authorization: `Bearer ${s}` };
    void fetch("/auth/github/status", { headers }).then((r) => r.json()).then((d) => { setLogin(d.login ?? null); setInstallUrl(d.installUrl ?? ""); }).catch(() => {});
    void fetch("/api/github/orgs", { headers }).then((r) => r.json()).then((d) => setOrgs(Array.isArray(d.orgs) ? d.orgs : [])).catch(() => {});
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
            {orgs.length === 0 && <p className="ob-fine" style={{ marginBottom: 12 }}>Cargando tus organizaciones…</p>}
            {orgs.map((o, i) => (
              <button key={o} className="ob-org" onClick={() => setStep(2)}>
                <span className="av">{o.slice(0, 1).toUpperCase()}</span>
                <span className="n">{o}</span>
                <span className={`st ${i === 0 ? "ok" : ""}`}>{i === 0 ? "✓ lista" : "usar"}</span>
              </button>
            ))}
            {installUrl && (
              <a className="ob-ghost" href={installUrl} target="_blank" rel="noreferrer" style={{ border: "1px solid var(--stroke-strong)", borderRadius: 12, padding: 14, marginTop: 6, textDecoration: "none" }}>
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
            <a className="ob-pri" href="/" style={{ marginTop: 8 }}>Ir a mis proyectos →</a>
            <a className="ob-ghost" href="/">Lo configuro después</a>
          </div>
        )}
      </div>
    </div>
  );
}
