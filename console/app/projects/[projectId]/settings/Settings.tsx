"use client";

// Settings del proyecto (F6P-Settings) · las 4 secciones portadas de v1 (SettingsView):
//   1. Canal de build   — probe live (workflow+secret) + sembrar el CLAUDE_CODE_OAUTH_TOKEN.
//   2. Autonomía/merge  — presets (Manual/Asistido/Autónomo) sobre merge_mode + workflow_approval
//      + execution_unit + max_concurrency. Se guardan en projects.settings (jsonb, RLS por tenant).
//   3. GitHub del proyecto — org/repo, estado de la App instalada, instalar en más cuentas.
//   4. Executor/modelo por lane — canal + modelo por lane (las lanes salen de las stories).
// El token del canal NUNCA se guarda en Fluxo: va por /api/projects/[id]/channel a `gh secret set`.

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project";
import { sessionToken } from "@/lib/supabaseClient";

interface LaneCfg { channel?: string; model?: string }
interface ProjSettings {
  channel?: "claude_action" | "copilot";
  merge_mode?: "manual" | "auto";
  dispatch_mode?: "auto" | "manual";
  execution_unit?: "sprint" | "story";
  max_concurrency?: number;
  workflow_approval?: "manual" | "auto_if_safe";
  workflow?: "design" | "demo-design";  // P5-3: workflow de diseño (fresh only; el worker lo lee de acá)
  lanes?: Record<string, LaneCfg>;
}
// Los defaults DEBEN espejar los del motor (design/src/worker.ts policyFrom + el gate de dispatch):
// execution_unit ausente → "story", dispatch_mode ausente → "manual" (deuda-chica #3, 2026-07-21: un
// proyecto sin setting NO auto-despacha agentes pagos), max_concurrency → 3 (MAX). Si la UI muestra un
// default distinto al que el motor asume ante el campo ausente, MIENTE (bug: mostraba "Sprint" mientras
// el motor corría "story"). dispatch_mode se incluye acá para que Guardar lo PERSISTA (no lo borre).
const DEFAULTS: ProjSettings = { channel: "claude_action", merge_mode: "manual", dispatch_mode: "manual", execution_unit: "story", max_concurrency: 3, workflow_approval: "manual", workflow: "design", lanes: {} };
const MODELS = ["auto", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

interface ChannelInfo { id: string; available: boolean; reason: string; secretsPermMissing: boolean }
// Capability del proyecto (Firebase, Vercel…): data del registry resuelta server-side. status: "ready"
// = el Actions secret está presente (🟢) · "missing" = falta (⚪) · "n/a" = la capability no pide secret.
interface CapabilityInfo { id: string; name: string; secret: string | null; guide: string | null; summary: string | null; status: "ready" | "missing" | "n/a"; secretsPermMissing: boolean }
interface Probe { channels: ChannelInfo[]; capabilities?: CapabilityInfo[]; defaultChannel: string; permissionsUrl: string | null }

// Presets = azúcar sobre merge_mode + workflow_approval (como v1). No hay concepto de preset abajo.
const PRESETS: Record<string, Pick<ProjSettings, "merge_mode" | "workflow_approval">> = {
  manual: { merge_mode: "manual", workflow_approval: "manual" },
  asistido: { merge_mode: "manual", workflow_approval: "auto_if_safe" },
  autonomo: { merge_mode: "auto", workflow_approval: "auto_if_safe" },
};
function presetOf(s: ProjSettings): string {
  for (const [k, v] of Object.entries(PRESETS)) if (s.merge_mode === v.merge_mode && s.workflow_approval === v.workflow_approval) return k;
  return "custom";
}

export default function Settings() {
  const { projectId, supabase, project } = useProject();
  const [settings, setSettings] = useState<ProjSettings>(DEFAULTS);
  const [saved, setSaved] = useState<ProjSettings>(DEFAULTS);
  const [lanes, setLanes] = useState<string[]>([]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [token, setToken] = useState("");
  const [capTokens, setCapTokens] = useState<Record<string, string>>({}); // valor pegado por capability (no se persiste)
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [installedOrgs, setInstalledOrgs] = useState<string[] | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  // Workflows de diseño elegibles + sus fases DERIVADAS del YAML (no hardcodeadas). Fallback estático
  // con los ids/nombres (config de UI, estable); las fases se enriquecen al cargar /api/workflows.
  const [wfOpts, setWfOpts] = useState<Array<{ id: string; name: string; phases: string[] }>>([
    { id: "design", name: "Completo", phases: [] },
    { id: "demo-design", name: "Lean (demos)", phases: [] },
  ]);
  useEffect(() => {
    let dead = false;
    void fetch("/api/workflows").then((r) => r.json()).then((d) => {
      if (!dead && Array.isArray(d.workflows) && d.workflows.length) setWfOpts(d.workflows);
    }).catch(() => {});
    return () => { dead = true; };
  }, []);

  // Cargar settings + lanes (de las stories) + probe del canal + instalaciones.
  useEffect(() => {
    let dead = false;
    void supabase.from("projects").select("settings").eq("id", projectId).single().then(({ data }) => {
      if (dead) return;
      const s = { ...DEFAULTS, ...((data?.settings as ProjSettings) ?? {}) };
      setSettings(s); setSaved(s);
    });
    void supabase.from("stories").select("lane").eq("project_id", projectId).then(({ data }) => {
      if (dead) return;
      const set = new Set<string>();
      for (const r of (data as Array<{ lane: string | null }>) ?? []) if (r.lane) set.add(r.lane);
      setLanes([...set].sort());
    });
    const s = sessionToken();
    if (s) {
      const H = { Authorization: `Bearer ${s}` };
      void fetch(`/api/projects/${projectId}/channel`, { headers: H }).then((r) => r.json()).then((d) => { if (!dead) setProbe(d); }).catch(() => {});
      void fetch(`/api/github/installations`, { headers: H }).then((r) => r.json()).then((d) => {
        if (dead) return;
        if (Array.isArray(d.installations)) setInstalledOrgs(d.installations.map((i: { login: string }) => i.login));
        if (d.installUrl) setInstallUrl(d.installUrl);
      }).catch(() => { if (!dead) setInstalledOrgs([]); });
    }
    return () => { dead = true; };
  }, [supabase, projectId]);

  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(saved), [settings, saved]);
  const patch = (p: Partial<ProjSettings>) => setSettings((s) => ({ ...s, ...p }));
  const setLane = (lane: string, cfg: Partial<LaneCfg>) =>
    setSettings((s) => ({ ...s, lanes: { ...s.lanes, [lane]: { ...s.lanes?.[lane], ...cfg } } }));

  async function saveSettings() {
    setBusy("settings"); setMsg(null);
    const { error } = await supabase.from("projects").update({ settings }).eq("id", projectId);
    setBusy(null);
    if (error) { setMsg({ kind: "err", text: error.message }); return; }
    setSaved(settings); setMsg({ kind: "ok", text: "Configuración guardada." });
  }

  async function seedSecret() {
    setBusy("secret"); setMsg(null);
    const s = sessionToken();
    const res = await fetch(`/api/projects/${projectId}/channel`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s}` },
      body: JSON.stringify({ token: token.trim() }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setMsg({ kind: "err", text: d.error ?? "no se pudo guardar el secret" }); return; }
    setToken(""); setMsg({ kind: "ok", text: "Secret guardado en el repo. Verificando…" });
    // Re-probe para reflejar el nuevo estado.
    const H = { Authorization: `Bearer ${s}` };
    const p = await fetch(`/api/projects/${projectId}/channel`, { headers: H }).then((r) => r.json()).catch(() => null);
    if (p) setProbe(p);
  }

  // Sembrar el Actions secret de una capability (Firebase…). Mismo patrón BYO que el token de Claude:
  // va a `gh secret set` vía el PUT del canal (whitelist server-side), NO se guarda en Fluxo.
  async function seedCapability(cap: CapabilityInfo) {
    if (!cap.secret) return;
    const value = (capTokens[cap.id] ?? "").trim();
    if (value.length < 10) return;
    setBusy(`cap:${cap.id}`); setMsg(null);
    const s = sessionToken();
    const res = await fetch(`/api/projects/${projectId}/channel`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s}` },
      body: JSON.stringify({ secret: cap.secret, value }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setMsg({ kind: "err", text: d.error ?? "no se pudo guardar el secret" }); return; }
    setCapTokens((m) => ({ ...m, [cap.id]: "" }));
    setMsg({ kind: "ok", text: `${cap.name}: secret guardado en el repo. Verificando…` });
    const H = { Authorization: `Bearer ${s}` };
    const p = await fetch(`/api/projects/${projectId}/channel`, { headers: H }).then((r) => r.json()).catch(() => null);
    if (p) setProbe(p);
  }

  const claude = probe?.channels.find((c) => c.id === "claude_action");
  const orgInstalled = project?.org && installedOrgs ? installedOrgs.includes(project.org) : null;
  const preset = presetOf(settings);

  return (
    <div className="stg">
      <header className="stg-head">
        <div className="stg-eye">Configuración</div>
        <h1>Settings · {project?.name ?? "…"}</h1>
        <p>Cómo Fluxo construye y despacha en tu repo. Los cambios de autonomía se guardan en el proyecto; el token del canal se guarda como secret del repo, nunca en Fluxo.</p>
      </header>

      {msg && <div className={`stg-msg ${msg.kind}`}>{msg.text}</div>}

      {/* 1 · Canal de build */}
      <section className="stg-card">
        <div className="stg-card-h"><h2>🔑 Canal de build</h2><span>Quién escribe el código: Claude Code Action o Copilot, corriendo en las Actions de tu repo.</span></div>
        <div className="stg-chan">
          <div className="stg-chan-row">
            <span className={`stg-dot ${claude?.available ? "on" : "off"}`} />
            <b>Claude Code Action</b>
            <span className="stg-chan-reason">{claude?.reason ?? "verificando…"}</span>
          </div>
          {claude?.secretsPermMissing && probe?.permissionsUrl && (
            <a className="stg-perm" href={probe.permissionsUrl} target="_blank" rel="noreferrer">La app necesita el permiso «Secrets: Read & write» → agregarlo</a>
          )}
          <label className="stg-lbl">Pegá tu CLAUDE_CODE_OAUTH_TOKEN (no se guarda en Fluxo, va al secret del repo)</label>
          <div className="stg-secret">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" spellCheck={false} />
            <button disabled={busy === "secret" || token.trim().length < 10 || !project?.repo} onClick={seedSecret}>{busy === "secret" ? "Guardando…" : "Sembrar secret"}</button>
          </div>
          {!project?.repo && <p className="stg-fine">El repo se crea al publicar el backlog; después podés sembrar el secret.</p>}
        </div>
        <div className="stg-field">
          <label>Canal por defecto</label>
          <select value={settings.channel} onChange={(e) => patch({ channel: e.target.value as ProjSettings["channel"] })}>
            <option value="claude_action">Claude Code Action</option>
            <option value="copilot">GitHub Copilot (próximamente)</option>
          </select>
        </div>

        {/* Integraciones / Capabilities — las integraciones externas BYO que el stack del proyecto
            necesita (Firebase, Vercel…), resueltas del registry. El usuario hace el paso humano
            one-time (link guiado) y pega su secret → se siembra como Actions secret del repo. */}
        {probe?.capabilities && probe.capabilities.length > 0 && (
          <div className="stg-caps">
            <div className="stg-caps-h"><b>Integraciones</b><span>Las cuentas externas que tu app usa. Creá cada una una vez y pegá su credencial — se guarda como secret de tu repo, nunca en Fluxo.</span></div>
            {probe.capabilities.map((cap) => (
              <div key={cap.id} className="stg-cap">
                <div className="stg-cap-row">
                  <span className={`stg-dot ${cap.status === "ready" ? "on" : "off"}`} />
                  <b>{cap.name}</b>
                  <span className="stg-chan-reason">
                    {cap.status === "ready" ? "listo 🟢"
                      : cap.secretsPermMissing ? "la app necesita el permiso «Secrets: Read & write»"
                      : cap.status === "n/a" ? "sin credencial requerida"
                      : "falta la credencial ⚪"}
                  </span>
                </div>
                {cap.summary && <p className="stg-cap-guide">{cap.summary}{cap.guide && <> · <a href={cap.guide} target="_blank" rel="noreferrer">guía paso a paso</a></>}</p>}
                {cap.secret && (
                  <>
                    <label className="stg-lbl">Pegá tu <code>{cap.secret}</code> (no se guarda en Fluxo, va al secret del repo)</label>
                    <div className="stg-secret">
                      <input type="password" value={capTokens[cap.id] ?? ""} onChange={(e) => setCapTokens((m) => ({ ...m, [cap.id]: e.target.value }))} placeholder={cap.status === "ready" ? "•••••• (ya sembrado — pegá para reemplazar)" : "pegá la credencial…"} spellCheck={false} />
                      <button disabled={busy === `cap:${cap.id}` || (capTokens[cap.id] ?? "").trim().length < 10 || !project?.repo} onClick={() => seedCapability(cap)}>{busy === `cap:${cap.id}` ? "Guardando…" : "Sembrar secret"}</button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {!project?.repo && <p className="stg-fine">El repo se crea al publicar el backlog; después podés sembrar los secrets.</p>}
          </div>
        )}
      </section>

      {/* 2 · Autonomía / merge */}
      <section className="stg-card">
        <div className="stg-card-h"><h2>⚙ Autonomía</h2><span>Cuánto avanza Fluxo solo. Un preset setea el merge y la aprobación de workflows; lo demás es fino.</span></div>
        <div className="stg-presets">
          {[["manual", "Manual", "Vos mergeás cada PR."], ["asistido", "Asistido", "Aprueba workflows seguros; el merge lo hacés vos."], ["autonomo", "Autónomo", "Mergea y aprueba solo (si no toca .github/workflows)."]].map(([k, title, desc]) => (
            <button key={k} className={`stg-preset${preset === k ? " on" : ""}`} onClick={() => patch(PRESETS[k])}>
              <b>{title}</b><span>{desc}</span>
            </button>
          ))}
        </div>
        <div className="stg-grid">
          <div className="stg-field">
            <label>Merge</label>
            <select value={settings.merge_mode} onChange={(e) => patch({ merge_mode: e.target.value as ProjSettings["merge_mode"] })}>
              <option value="manual">Manual — vos mergeás</option>
              <option value="auto">Auto — Fluxo mergea el PR aprobado</option>
            </select>
          </div>
          <div className="stg-field">
            <label>Aprobación de workflows</label>
            <select value={settings.workflow_approval} onChange={(e) => patch({ workflow_approval: e.target.value as ProjSettings["workflow_approval"] })}>
              <option value="manual">Manual</option>
              <option value="auto_if_safe">Auto si es seguro (no toca .github/workflows)</option>
            </select>
          </div>
          <div className="stg-field">
            <label>Despacho</label>
            <select value={settings.dispatch_mode} onChange={(e) => patch({ dispatch_mode: e.target.value as ProjSettings["dispatch_mode"] })}>
              <option value="manual">Manual — solo con el botón ▶ del board</option>
              <option value="auto">Auto — Fluxo despacha lo que esté listo</option>
            </select>
          </div>
          <div className="stg-field">
            <label>Unidad de ejecución</label>
            <select value={settings.execution_unit} onChange={(e) => patch({ execution_unit: e.target.value as ProjSettings["execution_unit"] })}>
              <option value="story">Story — una story a la vez</option>
              <option value="sprint">Sprint — despacha el sprint completo</option>
            </select>
          </div>
          <div className="stg-field">
            <label>Workflow de diseño</label>
            <select value={settings.workflow} onChange={(e) => patch({ workflow: e.target.value as ProjSettings["workflow"] })}>
              {wfOpts.map((w) => (
                <option key={w.id} value={w.id}>{w.name}{w.phases.length ? ` — ${w.phases.join(" → ")}` : ""}</option>
              ))}
            </select>
          </div>
          <div className="stg-field">
            <label>Máx. agentes en paralelo (0 = sin límite)</label>
            <input type="number" min={0} max={20} value={settings.max_concurrency ?? 0}
              onChange={(e) => patch({ max_concurrency: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
        </div>
      </section>

      {/* 3 · GitHub del proyecto */}
      <section className="stg-card">
        <div className="stg-card-h"><h2>🐙 GitHub del proyecto</h2><span>Dónde vive el repo y si la app de Fluxo está instalada ahí.</span></div>
        <div className="stg-gh">
          <div className="stg-gh-row"><span className="k">Organización / cuenta</span><span className="v">{project?.org ?? "—"}</span></div>
          <div className="stg-gh-row"><span className="k">Repositorio</span><span className="v">{project?.repo ? <a href={project.repo} target="_blank" rel="noreferrer">{project.repo.replace(/^https?:\/\/github\.com\//, "")}</a> : "aún no creado"}</span></div>
          <div className="stg-gh-row">
            <span className="k">App instalada</span>
            <span className="v">{orgInstalled === null ? "verificando…" : orgInstalled ? <span className="stg-ok">✓ sí, en {project?.org}</span> : <span className="stg-warn">⚠ no está en {project?.org}</span>}</span>
          </div>
          {installUrl && <a className="stg-install" href={installUrl} target="_blank" rel="noreferrer">＋ Instalar / gestionar la app en otra cuenta u organización</a>}
        </div>
      </section>

      {/* 4 · Executor / modelo por lane */}
      <section className="stg-card">
        <div className="stg-card-h"><h2>🎛 Canal y modelo por lane</h2><span>Ruteo fino: qué canal y qué modelo usa cada agente. Vacío = usa el canal/modelo por defecto.</span></div>
        {lanes.length === 0 ? (
          <p className="stg-fine">Todavía no hay lanes — aparecen cuando el backlog se publica (cada story tiene su lane/agente).</p>
        ) : (
          <div className="stg-lanes">
            {lanes.map((lane) => (
              <div key={lane} className="stg-lane">
                <span className="stg-lane-n">{lane}</span>
                <select value={settings.lanes?.[lane]?.channel ?? ""} onChange={(e) => setLane(lane, { channel: e.target.value })}>
                  <option value="">canal por defecto</option>
                  <option value="claude_action">Claude</option>
                  <option value="copilot">Copilot</option>
                </select>
                <select value={settings.lanes?.[lane]?.model ?? "auto"} onChange={(e) => setLane(lane, { model: e.target.value })}>
                  {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="stg-save">
        <button className="stg-save-btn" disabled={!dirty || busy === "settings"} onClick={saveSettings}>
          {busy === "settings" ? "Guardando…" : dirty ? "Guardar cambios" : "Todo guardado"}
        </button>
      </div>
    </div>
  );
}
