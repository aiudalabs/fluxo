"use client";

// Registry (F-registry) · lector read-only del MÉTODO. Cinco solapas de catálogo (agents/skills/
// workflows/providers/templates) leídas de registry/ vía GET /api/registry, + una solapa "Por
// corrida" que muestra el prompt EXACTO que el conductor manda al engine por sprint/story
// (GET /api/projects/[id]/prompts, reconstruido con el kernel de despacho). Sin CRUD (v1 lo tenía;
// diferido). Estilo: clases del board/wrap de v1; contenido crudo en <pre> (sin deps de markdown).

import { useCallback, useEffect, useState } from "react";
import { DocView } from "@/components/DocView";
import { useProject } from "@/lib/project";
import { activeToken } from "@/lib/supabaseClient";
import { useT } from "@/lib/i18n";

type CatalogItem = { id: string; summary: string | null; model: string | null; stacks?: string[]; wired?: boolean };
type Catalog = Record<string, CatalogItem[]>;
type StackInfo = { id: string; label: string; description: string };
type Detail = { yaml: string | null; md: string | null };
type PromptSprint = { key: string; title: string; storyKeys: string[]; prompt: string };
type PromptStory = { key: string; title: string; status: string; prompt: string };

const KIND_TABS = ["agents", "skills", "workflows", "providers", "templates"] as const;
type Tab = (typeof KIND_TABS)[number] | "prompts";

export default function Registry() {
  const t = useT();
  const { projectId } = useProject();
  const [tab, setTab] = useState<Tab>("agents");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [templates, setTemplates] = useState<string[]>([]);
  const [stacks, setStacks] = useState<StackInfo[]>([]);
  // Filtro por stack: null = "Todos". Filtra a los artefactos COMPARTIDOS (stacks incluye "*") + los
  // del stack elegido. Los templates se agrupan por stack (byStack) → se filtran igual.
  const [stackFilter, setStackFilter] = useState<string | null>(null);
  const [sel, setSel] = useState<{ kind: string; id: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [prompts, setPrompts] = useState<{ sprints: PromptSprint[]; stories: PromptStory[]; executionUnit: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // Catálogo (una vez): agents/skills/workflows/providers + árbol de templates.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/registry");
        const data = (await res.json()) as { catalog: Catalog; templates: string[]; stacks?: StackInfo[] };
        if (cancelled) return;
        setCatalog(data.catalog ?? {});
        setTemplates(data.templates ?? []);
        setStacks(Array.isArray(data.stacks) ? data.stacks : []);
      } catch { if (!cancelled) setCatalog({}); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const openItem = useCallback(async (kind: string, id: string) => {
    setSel({ kind, id });
    setDetail(null);
    try {
      const res = await fetch(`/api/registry?kind=${kind}&id=${encodeURIComponent(id)}`);
      setDetail(res.ok ? ((await res.json()) as Detail) : { yaml: null, md: null });
    } catch { setDetail({ yaml: null, md: null }); }
  }, []);

  // Prompts por corrida (lazy, al entrar a la solapa).
  useEffect(() => {
    if (tab !== "prompts" || prompts) return;
    (async () => {
      const tok = activeToken();
      try {
        const res = await fetch(`/api/projects/${projectId}/prompts`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
        if (res.ok) setPrompts(await res.json());
      } catch { /* deja el placeholder */ }
    })();
  }, [tab, prompts, projectId]);

  const isCatalog = (KIND_TABS as readonly string[]).includes(tab);
  // Un artefacto es visible bajo un stack si es COMPARTIDO (stacks incluye "*" o falta) o lo declara.
  const matchesStack = (its: string[] | undefined) =>
    !stackFilter || !its || its.includes("*") || its.includes(stackFilter);
  const items = (catalog?.[tab] ?? []).filter((it) => matchesStack(it.stacks));
  // La fila de chips aplica a las solapas de catálogo + templates (no a "prompts"), y solo cuando NO
  // hay un item abierto (drill-down).
  const showStackChips = stacks.length > 0 && tab !== "prompts" && !sel;

  return (
    <div className="wrap">
      <div className="sectitle">
        <h2>{t("registry.title")}</h2>
        <span className="c">{t("registry.subtitle")}</span>
      </div>

      <div className="reg-wrap">
        {/* Sidebar de categorías (composición del mockup) */}
        <div className="reg-cats">
          {(["agents", "skills", "workflows", "providers", "templates", "prompts"] as Tab[]).map((k) => (
            <button key={k} className={`reg-cat${tab === k ? " on" : ""}`}
              onClick={() => { setTab(k); setSel(null); setDetail(null); }}>
              {t(`registry.tab.${k}`)}
              {tab === k && k !== "prompts" && k !== "templates" && <span className="n">{items.length}</span>}
            </button>
          ))}
        </div>

        {/* Contenido: grid de cards (default) · detalle (drill-down) · panes especiales */}
        <div>
          {/* Chips de stack: "Todos" + un chip por stack. Filtran los artefactos a los COMPARTIDOS
              + los del stack elegido. El stack es el concepto de primera clase (data del registry). */}
          {showStackChips && !loading && (
            <div className="reg-stackchips">
              <button className={`reg-chip${!stackFilter ? " on" : ""}`} onClick={() => setStackFilter(null)}>Todos</button>
              {stacks.map((s) => (
                <button key={s.id} className={`reg-chip${stackFilter === s.id ? " on" : ""}`}
                  title={s.description} onClick={() => setStackFilter(stackFilter === s.id ? null : s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {loading ? (
            <div className="placeholder"><span className="spin" /></div>
          ) : tab === "prompts" ? (
            <PromptsPane data={prompts} t={t} />
          ) : tab === "templates" ? (
            <TemplatesPane templates={templates} stackFilter={stackFilter} t={t} />
          ) : sel ? (
            <div className="rg-detail">
              <button className="reg-back" onClick={() => { setSel(null); setDetail(null); }}>← {t("registry.count", { n: items.length })}</button>
              <h3>{sel.id}</h3>
              {!detail ? (
                <div className="placeholder"><span className="spin" /></div>
              ) : (
                <>
                  {detail.yaml && (<><div className="eyebrow acc">{t("registry.detail.meta")}</div><DocView content={detail.yaml} path={`${sel.id}.yaml`} /></>)}
                  {detail.md && (<><div className="eyebrow acc">{t("registry.detail.persona")}</div><DocView content={detail.md} path={`${sel.id}.md`} /></>)}
                </>
              )}
            </div>
          ) : (
            <div className="reg-grid">
              {items.map((it) => (
                <button key={it.id} className="reg-item" onClick={() => openItem(tab, it.id)}>
                  <div className="rid">{tab}/{it.id}{it.model && <span className="tag">{it.model}</span>}
                    {it.wired !== undefined && (
                      <span className={`tag rg-wired${it.wired ? " on" : ""}`} title={it.wired ? "Tiene un disparador vivo en v2" : "Método en data — todavía sin cablear a un disparador"}>
                        {it.wired ? "● cableado" : "○ solo-data"}
                      </span>
                    )}
                  </div>
                  <div className="rnm">{it.id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</div>
                  {it.summary && <div className="rds" title={it.summary}>{it.summary}</div>}
                </button>
              ))}
              {items.length === 0 && <div className="td-empty">—</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplatesPane({ templates, stackFilter, t }: { templates: string[]; stackFilter: string | null; t: (k: string, v?: Record<string, string | number>) => string }) {
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const open = useCallback(async (p: string) => {
    setSel(p); setContent(null);
    try {
      const res = await fetch(`/api/registry?kind=templates&path=${encodeURIComponent(p)}`);
      const d = (await res.json()) as { content?: string };
      setContent(res.ok ? (d.content ?? "") : "(no se pudo cargar el template)");
    } catch { setContent("(error al cargar)"); }
  }, []);

  // Drill-down: ver el contenido de un template (el CI/scaffold que Fluxo siembra en el repo).
  if (sel) {
    return (
      <div className="rg-detail">
        <button className="reg-back" onClick={() => { setSel(null); setContent(null); }}>← templates</button>
        <h3 className="rg-path">{sel}</h3>
        {content == null ? <div className="placeholder"><span className="spin" /></div> : <DocView content={content} path={sel} />}
      </div>
    );
  }
  // Agrupado por STACK (primer segmento del path) para que sea navegable — no 57 paths planos.
  // Con un stack elegido, mostramos `_common` (compartido, siempre) + el grupo de ese stack.
  const byStack: Record<string, string[]> = {};
  for (const p of templates) {
    const s = p.split("/")[0];
    if (stackFilter && s !== "_common" && s !== stackFilter) continue;
    (byStack[s] ??= []).push(p);
  }
  return (
    <div className="rg-stacks">
      <p className="rg-intro">{t("registry.templates.intro")} — la CI + scaffold que Fluxo siembra en el repo del cliente. Elegí el stack y clickeá un archivo para ver su contenido.</p>
      {Object.entries(byStack).map(([stack, files]) => (
        <div key={stack} className="rg-stack">
          <div className="eyebrow acc">{stack}</div>
          {files.map((p) => (
            <button key={p} className="rg-file" onClick={() => open(p)} title={p}>{p.slice(stack.length + 1)}</button>
          ))}
        </div>
      ))}
      {templates.length === 0 && <div className="td-empty">—</div>}
    </div>
  );
}

function PromptsPane({ data, t }: { data: { sprints: PromptSprint[]; stories: PromptStory[]; executionUnit: string } | null; t: (k: string, v?: Record<string, string | number>) => string }) {
  if (!data) return <div className="placeholder"><span className="spin" /></div>;
  const hasAny = data.sprints.some((s) => s.prompt) || data.stories.length > 0;
  if (!hasAny) return <div className="placeholder"><div className="ph-ic">◆</div>{t("registry.prompts.empty")}</div>;
  return (
    <div className="rg-prompts">
      <p className="rg-intro">{t("registry.prompts.intro")}</p>

      <div>
        <div className="eyebrow acc rg-group-h">{t("registry.prompts.sprints")}</div>
        <div className="rg-list">
          {data.sprints.filter((s) => s.prompt).map((s) => (
            <details key={s.key} className="rg-acc" open={data.executionUnit === "sprint"}>
              <summary>
                {s.key}{s.title ? ` — ${s.title}` : ""} <span className="tag">{s.storyKeys.join(", ")}</span>
              </summary>
              <div className="rg-acc-body"><DocView content={s.prompt} path="prompt.txt" /></div>
            </details>
          ))}
        </div>
      </div>

      <div>
        <div className="eyebrow acc rg-group-h">{t("registry.prompts.stories")}</div>
        <div className="rg-list">
          {data.stories.map((s) => (
            <details key={s.key} className="rg-acc" open={data.executionUnit !== "sprint"}>
              <summary>
                {s.key} — {s.title} <span className="tag">{s.status}</span>
              </summary>
              <div className="rg-acc-body"><DocView content={s.prompt} path="prompt.txt" /></div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
