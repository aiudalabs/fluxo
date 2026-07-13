"use client";

// Paso 1 del onboarding · Iniciar sesión (F6P-07). Pantalla DEDICADA: un botón grande
// "Continuar con GitHub" — imposible de no ver. Acá te logueás. Si ya hay sesión, redirige
// al panel.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { sessionToken } from "@/lib/supabaseClient";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export default function LoginPage() {
  const router = useRouter();
  useEffect(() => { if (sessionToken()) router.replace("/"); }, [router]);

  return (
    <div className="ob">
      <ThemeToggle className="ob-theme" />
      <div className="ob-stage">
        <div className="ob-brand">{"{"}<span className="b">Fluxo</span>{"}"}</div>
        <div className="ob-byline">by aiuda labs</div>
        <div className="ob-steps"><span className="d on" /><span className="d" /><span className="d" /></div>
        <div className="ob-card">
          <div className="ob-eye">Paso 1 · Ingresar</div>
          <h1>La fábrica de software gobernada</h1>
          <p className="ob-lead">De una idea a un repo con PRs de código real, en el GitHub de tu cliente. Entrá con tu cuenta para empezar.</p>
          <a className="ob-gh" href="/auth/github/start">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.7 2.6 1.2 3.3.9.1-.7.4-1.2.7-1.5-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11 11 0 0 1 6 0C18 4.7 19 5 19 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5Z" /></svg>
            Continuar con GitHub
          </a>
          <p className="ob-fine">Usamos GitHub para identificarte y trabajar dentro de tus repos.<br />Sin passwords que recordar.</p>
        </div>
      </div>
    </div>
  );
}
