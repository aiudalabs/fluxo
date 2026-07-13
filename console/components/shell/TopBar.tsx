"use client";

// TopBar (F6P-06) · la barra persistente del shell: logo → dashboard, switcher de proyecto
// (a cualquier proyecto en ≤2 clics), gasto (stub), y el menú de usuario (login, Canal
// Claude, instalar App, cerrar sesión). Vive arriba del dashboard Y del workspace.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserClient, sessionToken, clearSession } from "@/lib/supabaseClient";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

type Proj = { id: string; name: string; org: string | null };

export function TopBar({ currentProjectId }: { currentProjectId?: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Proj[]>([]);
  const [login, setLogin] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string>("");
  const [open, setOpen] = useState<"sw" | "user" | null>(null);

  useEffect(() => {
    const supa = browserClient();
    void supa.from("projects").select("id,name,org").order("created_at", { ascending: false })
      .then(({ data }) => setProjects((data as Proj[]) ?? []));
    const s = sessionToken();
    void fetch("/auth/github/status", { headers: s ? { Authorization: `Bearer ${s}` } : undefined })
      .then((r) => r.json()).then((d) => { setLogin(d.login ?? null); setInstallUrl(d.installUrl ?? ""); })
      .catch(() => {});
  }, []);

  const current = useMemo(() => projects.find((p) => p.id === currentProjectId) ?? null, [projects, currentProjectId]);
  const initials = (login ?? "·").slice(0, 2).toUpperCase();

  return (
    <header className="sh-top">
      <button className="sh-brand" onClick={() => router.push("/projects")} title="Todos los proyectos">
        {"{"}<span className="b">Fluxo</span>{"}"}
      </button>
      <div className="sh-sep" />

      <div className="sh-switcher">
        <button className="sh-switch" onClick={() => setOpen(open === "sw" ? null : "sw")}>
          <span className="d" style={{ background: current ? "var(--emerald)" : "var(--ink4)" }} />
          <span>{current?.name ?? "Todos los proyectos"}</span>
          <span className="ca">▾</span>
        </button>
        <div className={`sh-menu${open === "sw" ? " on" : ""}`}>
          <div className="sh-mh">Tus proyectos</div>
          {projects.length === 0 && <div className="sh-mi" style={{ color: "var(--ink4)" }}>Sin proyectos aún</div>}
          {projects.map((p) => (
            <button key={p.id} className="sh-mi" onClick={() => { setOpen(null); router.push(`/projects/${p.id}/overview`); }}>
              <span className="d" style={{ background: p.id === currentProjectId ? "var(--accent)" : "var(--emerald)" }} />
              <span className="grow">{p.name}</span>
              {p.org && <span className="mini">{p.org}</span>}
            </button>
          ))}
          <div className="sh-mdiv" />
          <Link className="sh-mi" href="/projects" onClick={() => setOpen(null)}><span className="grow">Ver todos los proyectos</span><span className="mini">⤢</span></Link>
          <Link className="sh-mi new" href="/" onClick={() => setOpen(null)}>＋ Nuevo proyecto</Link>
        </div>
      </div>

      <div className="sh-sp" />
      <div className="sh-spend" title="Gasto de hoy (próximamente)">◷ Hoy <b>$0.00</b></div>
      <LanguageSwitcher />

      <div className="sh-switcher">
        <button className="sh-ava" onClick={() => setOpen(open === "user" ? null : "user")} title={login ?? "Cuenta"}>{initials}</button>
        <div className={`sh-menu right${open === "user" ? " on" : ""}`}>
          <div className="sh-mh">{login ? `${login}` : "Sin sesión"}</div>
          {!login && <Link className="sh-mi new" href="/auth/github/start" onClick={() => setOpen(null)}>⚡ Continuar con GitHub</Link>}
          <button className="sh-mi"><span className="grow">⚙ Ajustes</span></button>
          <button className="sh-mi"><span className="grow">🔑 Canal Claude</span></button>
          {installUrl && <a className="sh-mi" href={installUrl} target="_blank" rel="noreferrer"><span className="grow">⬇ Instalar App en otra org</span></a>}
          {login && <>
            <div className="sh-mdiv" />
            <button className="sh-mi" onClick={() => { clearSession(); window.location.href = "/"; }}><span className="grow">↪ Cerrar sesión</span></button>
          </>}
        </div>
      </div>

      {open && <div className="sh-backdrop on" onClick={() => setOpen(null)} />}
    </header>
  );
}
