"use client";

// Dashboard "mission control" (F6P-06) · el home después del login: TODOS tus proyectos con
// su estado VIVO (diseñando / building / progreso), y "Nuevo proyecto" siempre a la vista.
// Es el "ver de forma simple todo lo que la fábrica está haciendo". RLS lo scopea a tu tenant.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { browserClient } from "@/lib/supabaseClient";
import { TopBar } from "@/components/shell/TopBar";

type Project = { id: string; name: string; description: string | null; org: string | null; repo: string | null };
type Stat = { total: number; done: number; running: number; review: number };

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Map<string, Stat>>(new Map());
  const [designing, setDesigning] = useState<Set<string>>(new Set());
  const [gated, setGated] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supa = browserClient();
    let cancelled = false;
    const load = async () => {
      const [{ data: ps }, { data: st }, { data: runs }, { data: gates }] = await Promise.all([
        supa.from("projects").select("id,name,description,org,repo").order("created_at", { ascending: false }),
        supa.from("stories").select("project_id,status"),
        supa.from("design_runs").select("project_id,status"),
        supa.from("design_gates").select("project_id,status").eq("status", "pending"),
      ]);
      if (cancelled) return;
      const m = new Map<string, Stat>();
      for (const s of (st as { project_id: string; status: string }[]) ?? []) {
        const cur = m.get(s.project_id) ?? { total: 0, done: 0, running: 0, review: 0 };
        cur.total++;
        if (s.status === "done") cur.done++;
        else if (s.status === "running") cur.running++;
        else if (s.status === "review") cur.review++;
        m.set(s.project_id, cur);
      }
      setStats(m);
      setDesigning(new Set(((runs as { project_id: string; status: string }[]) ?? [])
        .filter((r) => r.status === "running" || r.status === "awaiting_gate").map((r) => r.project_id)));
      setGated(new Set(((gates as { project_id: string }[]) ?? []).map((g) => g.project_id)));
      setProjects((ps as Project[]) ?? []);
      setLoading(false);
    };
    void load();
  }, []);

  const active = useMemo(() => projects.filter((p) => designing.has(p.id) || (stats.get(p.id)?.total ?? 0) > 0).length, [projects, designing, stats]);
  const gatesWaiting = gated.size;

  return (
    <>
      <TopBar />
      <div className="dash">
        <div className="dash-head">
          <div>
            <div className="dash-eye">Panel</div>
            <h1>Tus proyectos</h1>
          </div>
          <span className="sub">{active} activos{gatesWaiting > 0 ? ` · ${gatesWaiting} esperando tu decisión` : ""}</span>
          <Link href="/" className="dash-cta">＋ Nuevo proyecto</Link>
        </div>

        {loading ? (
          <p style={{ color: "var(--ink4)" }}>Cargando…</p>
        ) : projects.length === 0 ? (
          <div className="pcard newp" style={{ maxWidth: 340 }}>
            <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>＋ Creá tu primer proyecto</Link>
          </div>
        ) : (
          <div className="dash-grid">
            {projects.map((p) => <Card key={p.id} p={p} st={stats.get(p.id)} designing={designing.has(p.id)} gate={gated.has(p.id)} />)}
            <Link href="/" className="pcard newp">＋ Nuevo proyecto</Link>
          </div>
        )}
      </div>
    </>
  );
}

function Card({ p, st, designing, gate }: { p: Project; st?: Stat; designing: boolean; gate: boolean }) {
  const total = st?.total ?? 0;
  const done = st?.done ?? 0;
  const pct = total ? Math.round((done / total) * 100) : (designing ? 12 : 0);
  // Estado dominante: building si hay backlog; si no, diseñando; si no, nuevo.
  let pill: { cls: string; label: string }, foot: string, barColor: string;
  if (total > 0) {
    pill = { cls: "run", label: "Building" };
    foot = `${done}/${total} stories${(st?.running ?? 0) > 0 ? ` · ${st!.running} corriendo` : ""}${(st?.review ?? 0) > 0 ? ` · ${st!.review} en review` : ""}`;
    barColor = "var(--emerald)";
  } else if (designing) {
    pill = gate ? { cls: "wait", label: "Gate" } : { cls: "des", label: "Diseñando" };
    foot = gate ? "esperando tu decisión" : "generando el diseño";
    barColor = "var(--accent)";
  } else {
    pill = { cls: "idle", label: "Nuevo" };
    foot = "sin backlog aún";
    barColor = "var(--ink4)";
  }
  return (
    <Link href={`/projects/${p.id}/overview`} className="pcard">
      <div className="pcard-top"><span className="nm">{p.name}</span>{p.org && <span className="org">{p.org}</span>}</div>
      <div className="desc">{p.description ?? ""}</div>
      <div className="pbar"><i style={{ width: `${pct}%`, background: barColor }} /></div>
      <div className="pcard-foot">
        <span className={`spill ${pill.cls}`}><span className="d" />{pill.label}</span>
        <span>{foot}</span>
      </div>
    </Link>
  );
}
