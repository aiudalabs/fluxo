"use client";

// `/` · router del onboarding (F6P-07): sin sesión → login; con sesión → el panel (dashboard).
// El chatbot de crear-proyecto se movió a /new; el sign-in a /login; conectar/instalar a
// /onboarding. Así cada paso hace UNA cosa (patrón estándar Vercel/Linear).

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { sessionToken } from "@/lib/supabaseClient";

const DEV = process.env.NEXT_PUBLIC_DEV_TENANT_JWT; // fallback local sin login

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    if (sessionToken() || DEV) router.replace("/projects");
    else router.replace("/login");
  }, [router]);
  return <div className="ob"><div className="ob-byline">Cargando…</div></div>;
}
