"use client";

// TopBar (F6P-06) · la barra persistente del shell: logo → dashboard, switcher de proyecto
// (a cualquier proyecto en ≤2 clics), gasto (stub), y el menú de usuario (login, Canal
// Claude, instalar App, cerrar sesión). Vive arriba del dashboard Y del workspace.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserClient, sessionToken, clearSession } from "@/lib/supabaseClient";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

type Proj = { id: string; name: string; org: string | null };

export function TopBar({ currentProjectId }: { currentProjectId?: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Proj[]>([]);
  const [login, setLogin] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string>("");
  const [open, setOpen] = useState<"sw" | "user" | null>(null);
  const [spend, setSpend] = useState<number | null>(null);

  useEffect(() => {
    const supa = browserClient();
    void supa.from("projects").select("id,name,org").order("created_at", { ascending: false })
      .then(({ data }) => setProjects((data as Proj[]) ?? []));
    const s = sessionToken();
    void fetch("/auth/github/status", { headers: s ? { Authorization: `Bearer ${s}` } : undefined })
      .then((r) => r.json()).then((d) => { setLogin(d.login ?? null); setInstallUrl(d.installUrl ?? ""); })
      .catch(() => {});
  }, []);

  // Gasto de HOY del proyecto activo: build (run_costs) + diseño (design_phases). Día local.
  useEffect(() => {
    if (!currentProjectId) { setSpend(null); return; }
    const supa = browserClient();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const iso = start.toISOString();
    let alive = true;
    const load = async () => {
      const [{ data: rc }, { data: dp }] = await Promise.all([
        supa.from("run_costs").select("usd").eq("project_id", currentProjectId).gte("created_at", iso),
        supa.from("design_phases").select("usd").eq("project_id", currentProjectId).gte("updated_at", iso),
      ]);
      if (!alive) return;
      const sum = (rows: { usd: number | null }[] | null) => (rows ?? []).reduce((a, r) => a + (r.usd ?? 0), 0);
      setSpend(sum(rc as { usd: number | null }[]) + sum(dp as { usd: number | null }[]));
    };
    void load().catch(() => setSpend(null));
    const ch = supa.channel(`spend:${currentProjectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "run_costs", filter: `project_id=eq.${currentProjectId}` }, () => void load())
      .subscribe();
    return () => { alive = false; void supa.removeChannel(ch); };
  }, [currentProjectId]);

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
          <span className="d" style={{ background: current ? "var(--md-success)" : "var(--md-outline)" }} />
          <span>{current?.name ?? "Todos los proyectos"}</span>
          <span className="ca">▾</span>
        </button>
        <div className={`sh-menu${open === "sw" ? " on" : ""}`}>
          <div className="sh-mh">Tus proyectos</div>
          {projects.length === 0 && <div className="sh-mi muted">Sin proyectos aún</div>}
          {projects.map((p) => (
            <button key={p.id} className="sh-mi" onClick={() => { setOpen(null); router.push(`/projects/${p.id}/overview`); }}>
              <span className="d" style={{ background: p.id === currentProjectId ? "var(--md-primary)" : "var(--md-success)" }} />
              <span className="grow">{p.name}</span>
              {p.org && <span className="mini">{p.org}</span>}
            </button>
          ))}
          <div className="sh-mdiv" />
          <Link className="sh-mi" href="/projects" onClick={() => setOpen(null)}><span className="grow">Ver todos los proyectos</span><span className="mini">⤢</span></Link>
          <Link className="sh-mi new" href="/new" onClick={() => setOpen(null)}>＋ Nuevo proyecto</Link>
        </div>
      </div>

      <div className="sh-sp" />
      <div className="sh-spend" title="Gasto de hoy (build + diseño) del proyecto activo">◷ Hoy <b>${(spend ?? 0).toFixed(2)}</b></div>
      <ThemeToggle />
      <LanguageSwitcher />

      <div className="sh-switcher">
        <button className="sh-ava" onClick={() => setOpen(open === "user" ? null : "user")} title={login ?? "Cuenta"}>{initials}</button>
        <div className={`sh-menu right${open === "user" ? " on" : ""}`}>
          <div className="sh-mh">{login ? `${login}` : "Sin sesión"}</div>
          {!login && <Link className="sh-mi new" href="/auth/github/start" onClick={() => setOpen(null)}>⚡ Continuar con GitHub</Link>}
          {currentProjectId ? (
            <>
              <Link className="sh-mi" href={`/projects/${currentProjectId}/settings`} onClick={() => setOpen(null)}><span className="grow">⚙ Settings del proyecto</span></Link>
              <Link className="sh-mi" href={`/projects/${currentProjectId}/settings`} onClick={() => setOpen(null)}><span className="grow">🔑 Canal de build</span></Link>
            </>
          ) : (
            <div className="sh-mi off"><span className="grow">⚙ Settings (abrí un proyecto)</span></div>
          )}
          {login && <Link className="sh-mi" href="/account/credentials" onClick={() => setOpen(null)}><span className="grow">🔐 Mis credenciales</span></Link>}
          {installUrl && <a className="sh-mi" href={installUrl} target="_blank" rel="noreferrer"><span className="grow">⬇ Instalar App en otra org</span></a>}
          {login && <>
            <div className="sh-mdiv" />
            <button className="sh-mi" onClick={() => { clearSession(); window.location.href = "/login"; }}><span className="grow">↪ Cerrar sesión</span></button>
          </>}
        </div>
      </div>

      {open && <div className="sh-backdrop on" onClick={() => setOpen(null)} />}
    </header>
  );
}
