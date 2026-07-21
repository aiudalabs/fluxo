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

type CatalogItem = { id: string; summary: string | null; model: string | null };
type Catalog = Record<string, CatalogItem[]>;
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
        const data = (await res.json()) as { catalog: Catalog; templates: string[] };
        if (cancelled) return;
        setCatalog(data.catalog ?? {});
        setTemplates(data.templates ?? []);
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
  const items = catalog?.[tab] ?? [];

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
          {loading ? (
            <div className="placeholder"><span className="spin" /></div>
          ) : tab === "prompts" ? (
            <PromptsPane data={prompts} t={t} />
          ) : tab === "templates" ? (
            <TemplatesPane templates={templates} t={t} />
          ) : sel ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <button className="reg-back" onClick={() => { setSel(null); setDetail(null); }}>← {t("registry.count", { n: items.length })}</button>
              <h3 style={{ margin: 0 }}>{sel.id}</h3>
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
                  <div className="rid">{tab}/{it.id}{it.model && <span className="tag">{it.model}</span>}</div>
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

function TemplatesPane({ templates, t }: { templates: string[]; t: (k: string, v?: Record<string, string | number>) => string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <p className="c" style={{ margin: "0 0 8px" }}>{t("registry.templates.intro")}</p>
      {templates.map((p) => (
        <div key={p} className="tag" style={{ fontFamily: "var(--mono, monospace)", fontSize: 12, alignSelf: "flex-start" }}>{p}</div>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <p className="c" style={{ margin: 0 }}>{t("registry.prompts.intro")}</p>

      <div>
        <div className="eyebrow acc" style={{ marginBottom: 8 }}>{t("registry.prompts.sprints")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.sprints.filter((s) => s.prompt).map((s) => (
            <details key={s.key} open={data.executionUnit === "sprint"}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                {s.key}{s.title ? ` — ${s.title}` : ""} <span className="tag" style={{ fontSize: 10 }}>{s.storyKeys.join(", ")}</span>
              </summary>
              <div style={{ marginTop: 8 }}><DocView content={s.prompt} path="prompt.txt" /></div>
            </details>
          ))}
        </div>
      </div>

      <div>
        <div className="eyebrow acc" style={{ marginBottom: 8 }}>{t("registry.prompts.stories")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.stories.map((s) => (
            <details key={s.key} open={data.executionUnit !== "sprint"}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                {s.key} — {s.title} <span className="tag" style={{ fontSize: 10 }}>{s.status}</span>
              </summary>
              <div style={{ marginTop: 8 }}><DocView content={s.prompt} path="prompt.txt" /></div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
