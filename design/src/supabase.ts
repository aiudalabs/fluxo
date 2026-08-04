// F6-02 · The Supabase-backed ports the design engine (F5-04) runs on. The engine is
// pure orchestration; THIS is where its state lands so Studio can render it and the human
// can resolve gates. It mirrors the Go brain writer (control/internal/brain): mint a
// short-lived tenant JWT (HS256, stdlib crypto) and talk to PostgREST as the authenticated
// role, so RLS is enforced for real — no service_role bypass. No supabase-js dep: plain
// fetch + node:crypto (design/ stays dep-light, like the brain-mcp tool).
//
//   • createRun / phase updates  → RunStore + EngineSink (design_runs, design_phases)
//   • gate insert + poll-to-resolve → GateResolver (design_gates)  ← the conversational
//     gate freezes the run until Studio flips the row to 'resolved'.

import { createHmac } from "node:crypto";
import { partitionFindings, type Finding } from "./reviewGate.ts";
import type { LiveStory, LiveSprint, StoreMutation } from "./planApply.ts";
import type {
  Artifact,
  EngineSink,
  GateResolver,
  GateRequest,
  GateDecision,
  PhaseResult,
} from "./engine.ts";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 5xx transitorios de Cloudflare↔origen (incl. 525 SSL handshake) + rate-limit: HIPOS de infra, no
// fallas del diseño. Fuente única para el retry del rest() y para clasificar el error de un run caído.
export const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527, 530]);

// classifyRunError distingue un fallo TRANSITORIO (un blip de infra que agotó los reintentos → reanudar
// tiene sentido) de uno FATAL (un error real del diseño). Lee el mensaje que tira rest(): o termina en
// "(agotados los reintentos transitorios)", o incluye "→ <status> …" con el código HTTP.
export function classifyRunError(message: string): "transient" | "fatal" {
  if (/agotados los reintentos transitorios/i.test(message)) return "transient";
  const m = message.match(/→\s*(\d{3})\b/);
  if (m && TRANSIENT_HTTP.has(Number(m[1]))) return "transient";
  return "fatal";
}

// mintTenantJwt mints an HS256 tenant JWT (role=authenticated, tenant claim) — the same
// shape the console dev-shim and the Go writer mint, so RLS scopes to this tenant.
export function mintTenantJwt(secret: string, tenant: string, ttlSeconds = 3600, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ role: "authenticated", aud: "authenticated", sub: "design-runtime", tenant, iat: now, exp: now + ttlSeconds }),
  );
  const signingInput = `${header}.${claims}`;
  const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export interface StoreConfig {
  url: string; // SUPABASE_URL
  anonKey: string; // apikey header (gateway passthrough)
  jwtSecret: string; // SUPABASE_JWT_SECRET (mints the tenant JWT)
  tenant: string; // tenant_id (uuid)
  project: string; // project_id (uuid)
  pollMs?: number; // gate poll interval (default 1500)
}

export interface PhaseSeed {
  phase_id: string;
  label: string;
  ord: number;
}

// El handoff (publishBacklog) consume estas shapes — las produce el parser de backlog.yaml.
export interface SprintSeed {
  key: string;        // "SP1"
  title?: string;     // nombre display
  goal?: string;
  position?: number;
}
export interface StorySeed {
  key: string;        // "S1-01"
  title: string;
  body?: string;      // user story ("Como X, quiero Y…")
  acceptance?: string; // criterios (líneas)
  lane?: string;      // owner/agente (flutter-dev, …)
  sprint?: string;    // KEY del sprint (SP1) — se resuelve a sprint_id
  deps?: string[];    // KEYs de stories (S1-02) — se resuelven a blocked_by (uuid[])
  epic_id?: string;
  kind?: string;      // default 'story'
  screen_key?: string;
  severity?: string;  // F4: 'P0'|'deferred' si la story nació de un finding del reviewer; null = normal
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SupabaseDesignStore realises the engine's ports against design_runs/phases/gates.
export class SupabaseDesignStore {
  private cfg: StoreConfig;
  private token = "";
  private tokenExp = 0; // epoch seconds en que vence el JWT minteado
  private base: string;
  runId = "";

  constructor(cfg: StoreConfig) {
    this.cfg = cfg;
    this.base = cfg.url.replace(/\/$/, "") + "/rest/v1";
    this.remint();
  }

  // remint firma un JWT de tenant nuevo (HS256, local, sin red) y recuerda su vencimiento.
  private remint(ttlSeconds = 3600): void {
    const now = Math.floor(Date.now() / 1000);
    this.token = mintTenantJwt(this.cfg.jwtSecret, this.cfg.tenant, ttlSeconds, now);
    this.tokenExp = now + ttlSeconds;
  }

  // authToken devuelve un JWT vigente, re-minteando ANTES de que venza. Un design run dura
  // HORAS (8 fases de agente) y el token minteado una vez en el constructor vencía a la 1h →
  // todo write posterior daba 401 PGRST303 y CRASHEABA el proceso (bug: churn de resume de ~24h).
  private authToken(): string {
    if (Math.floor(Date.now() / 1000) >= this.tokenExp - 120) this.remint();
    return this.token;
  }

  private headers(prefer = "return=minimal"): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: this.cfg.anonKey,
      Authorization: `Bearer ${this.authToken()}`,
      Prefer: prefer,
    };
  }

  private async rest(path: string, init: RequestInit & { prefer?: string }): Promise<Response> {
    const { prefer, ...rest } = init;
    let reminted = false;
    let last = "";
    // Hasta 5 intentos: 401 → re-minteá el JWT (venció en vuelo) y reintentá inmediato UNA vez;
    // 5xx/429 → backoff (0.6s, 1.2s, 2.4s, 4.8s) y reintentá; otro !ok → error real, tirá.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${this.base}${path}`, { ...rest, headers: this.headers(prefer) });
      if (res.ok) return res;
      if (res.status === 401 && !reminted) { this.remint(); reminted = true; continue; }
      if (TRANSIENT_HTTP.has(res.status) && attempt < 4) {
        last = String(res.status);
        await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
        continue;
      }
      throw new Error(`supabase ${init.method} ${path} → ${res.status} ${await res.text()}`);
    }
    throw new Error(`supabase ${init.method} ${path} → ${last} (agotados los reintentos transitorios)`);
  }

  // keyMap lee key→id de una tabla scopeada al proyecto (para materializar idempotente sin
  // depender de DELETE, que está revocado para authenticated).
  private async keyMap(table: "sprints" | "stories"): Promise<Map<string, string>> {
    const res = await this.rest(`/${table}?project_id=eq.${this.cfg.project}&select=id,key`, { method: "GET", prefer: "count=none" });
    const m = new Map<string, string>();
    for (const r of (await res.json()) as Array<{ id: string; key: string }>) m.set(r.key, r.id);
    return m;
  }

  private scope() {
    return { tenant_id: this.cfg.tenant, project_id: this.cfg.project };
  }

  // createRun inserts the run + its phases (pending) and returns the run id.
  async createRun(workflow: string, phases: PhaseSeed[]): Promise<string> {
    const res = await this.rest("/design_runs", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({ ...this.scope(), workflow, status: "running" }),
    });
    const [row] = (await res.json()) as Array<{ id: string }>;
    this.runId = row.id;
    if (phases.length) {
      await this.rest("/design_phases", {
        method: "POST",
        body: JSON.stringify(phases.map((p) => ({ ...this.scope(), run_id: this.runId, ...p, status: "pending" }))),
      });
    }
    return this.runId;
  }

  // adoptRun re-attaches this store to an EXISTING run (crash-resume). No insert — the run +
  // its phases already live in the DB; we just point setRunStatus/patchPhase/resolver at it.
  adoptRun(runId: string): void {
    this.runId = runId;
  }

  // loadRun reads the run row (status + workflow) so a resume uses the run's OWN workflow.
  async loadRun(runId: string): Promise<{ status: string; workflow: string } | null> {
    const res = await this.rest(`/design_runs?id=eq.${runId}&select=status,workflow`, { method: "GET", prefer: "count=none" });
    const [row] = (await res.json()) as Array<{ status: string; workflow: string }>;
    return row ?? null;
  }

  // loadPhases returns each phase's status + harvested artifacts (the durable design output).
  async loadPhases(): Promise<Array<{ phase_id: string; status: string; artifacts: Artifact[] }>> {
    const res = await this.rest(`/design_phases?run_id=eq.${this.runId}&select=phase_id,status,artifacts,ord&order=ord`, { method: "GET", prefer: "count=none" });
    return ((await res.json()) as Array<{ phase_id: string; status: string; artifacts: Artifact[] | null; ord: number }>)
      .map((p) => ({ phase_id: p.phase_id, status: p.status, artifacts: p.artifacts ?? [] }));
  }

  // loadProjectDocs devuelve los artefactos de diseño YA producidos del PROYECTO (cualquier run
  // done), última versión por path. Es la semilla del workdir para un iterate (P5-2): el
  // iteration-planner necesita leer el PRD/arquitectura/backlog existentes para emitir un DELTA.
  async loadProjectDocs(): Promise<Artifact[]> {
    const res = await this.rest(`/design_phases?project_id=eq.${this.cfg.project}&status=eq.done&select=artifacts,updated_at&order=updated_at.asc`, { method: "GET", prefer: "count=none" });
    const rows = (await res.json()) as Array<{ artifacts: Artifact[] | null }>;
    const byPath = new Map<string, Artifact>();
    for (const r of rows) for (const a of r.artifacts ?? []) byPath.set(a.path, a); // orden asc → la última gana
    return [...byPath.values()];
  }

  // loadGates returns the run's gate rows (to know which gates were already approved).
  async loadGates(): Promise<Array<{ gate_id: string; status: string; outcome: string | null }>> {
    const res = await this.rest(`/design_gates?run_id=eq.${this.runId}&select=gate_id,status,outcome`, { method: "GET", prefer: "count=none" });
    return (await res.json()) as Array<{ gate_id: string; status: string; outcome: string | null }>;
  }

  // setRunStatus persiste el estado del run. Si falló, guarda TAMBIÉN el error + si fue transitorio o
  // fatal (para que el assistant/UI expliquen la causa y decidan si ofrecer "Reanudar"). Cualquier
  // estado NO-failed limpia un error viejo (el run progresó → la causa anterior ya no aplica).
  async setRunStatus(status: string, err?: { error: string; kind: "transient" | "fatal" }): Promise<void> {
    const body: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (status === "failed" && err) { body.error = err.error.slice(0, 2000); body.error_kind = err.kind; }
    else if (status !== "failed") { body.error = null; body.error_kind = null; }
    await this.rest(`/design_runs?id=eq.${this.runId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  // heartbeat renueva el lease del run (Opción B): mientras main.ts vive lo llama en timer;
  // el worker usa la frescura de heartbeat_at para no re-adoptar un proceso que sigue vivo.
  async heartbeat(): Promise<void> {
    await this.rest(`/design_runs?id=eq.${this.runId}`, {
      method: "PATCH",
      body: JSON.stringify({ heartbeat_at: new Date().toISOString() }),
    });
  }

  // setProjectRepo guarda la URL del repo creado en el handoff a GitHub.
  async setProjectRepo(repoUrl: string): Promise<void> {
    await this.rest(`/projects?id=eq.${this.cfg.project}`, {
      method: "PATCH",
      body: JSON.stringify({ repo: repoUrl, updated_at: new Date().toISOString() }),
    });
  }

  // setStoryRef vincula una story a su issue de GitHub (external_ref = github:owner/repo#N)
  // + el repo — así el board/drawer linkean al issue real.
  async setStoryRef(key: string, externalRef: string, repoUrl: string): Promise<void> {
    await this.rest(`/stories?project_id=eq.${this.cfg.project}&key=eq.${key}`, {
      method: "PATCH",
      body: JSON.stringify({ external_ref: externalRef, repo: repoUrl }),
    });
  }

  // loadStoryRefs: key→external_ref de las stories que YA tienen issue linkeado. Es la IDEMPOTENCIA del
  // handoff GitHub: un re-handoff (para re-aterrizar scaffold/docs faltantes) NO debe re-crear los issues
  // de las stories ya publicadas — antes duplicaba el board entero (34→68 en YoMap). Solo las que faltan.
  async loadStoryRefs(): Promise<Map<string, string>> {
    const res = await this.rest(`/stories?project_id=eq.${this.cfg.project}&select=key,external_ref`, { method: "GET", prefer: "count=none" });
    const m = new Map<string, string>();
    for (const r of (await res.json()) as Array<{ key: string; external_ref: string | null }>) if (r.external_ref) m.set(r.key, r.external_ref);
    return m;
  }

  // brainAppend writes one auditable event to the brain (F1-02) as the tenant. The gate
  // outcome is the highest-value provenance — the honest "why" the design is the way it
  // is (docs/00-vision) — so a resolved gate is recorded here (kind gate_answer, D5).
  async brainAppend(kind: string, payload: Record<string, unknown>, actor: string): Promise<void> {
    await this.rest("/brain_events", {
      method: "POST",
      body: JSON.stringify({ ...this.scope(), kind, payload, actor }),
    });
  }

  private async patchPhase(phaseId: string, patch: Record<string, unknown>): Promise<void> {
    await this.rest(`/design_phases?run_id=eq.${this.runId}&phase_id=eq.${phaseId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
  }

  // publishBacklog realiza el HANDOFF (F5-03): el backlog.yaml aprobado → filas reales en
  // stories/sprints (RLS por tenant, como authenticated). Tres pasadas: (1) sprints faltantes,
  // (2) stories faltantes (nacen 'backlog', sprint_id resuelto), (3) blocked_by = deps
  // resueltas key→uuid (blocked_by es uuid[] → stories.id).
  //
  // IDEMPOTENTE por (project,key) SIN depender de DELETE (revocado para authenticated: el intento
  // previo de "borrar-y-reinsertar" fallaba en silencio con un catch{} → el POST reinsertaba y
  // chocaba con un 409 duplicate-key que MATABA el resume, dejando el backlog a medio-cablear y
  // el repo sin crear). En su lugar: leé lo que YA existe e insertá solo lo que falta; re-cableá
  // deps SIEMPRE (una PATCH es idempotente) para completar lo que un resume anterior dejó sin deps.
  // Las stories ya existentes NO se tocan (no pisar status/sprint de una que ya se despachó).
  async publishBacklog(sprints: SprintSeed[], stories: StorySeed[], opts?: { full?: boolean }): Promise<{ sprints: number; stories: number; orphans: string[] }> {
    const s = this.scope();

    // 1) sprints faltantes → luego mapa completo key→id
    const haveSprints = await this.keyMap("sprints");
    const newSprints = sprints.filter((sp) => !haveSprints.has(sp.key));
    if (newSprints.length) {
      // Los sprints NUEVOS van DESPUÉS de los existentes: un delta (iterate) no debe colisionar en
      // position=0 con SP1 (rompería el orden del frontier de las ceremonias). base = max(pos)+1; en
      // un diseño fresco (sin sprints) base=0 → 0,1,2… como antes. sp.position explícita gana si viene.
      const posRes = await this.rest(`/sprints?project_id=eq.${this.cfg.project}&select=position`, { method: "GET", prefer: "count=none" });
      const positions = ((await posRes.json()) as Array<{ position: number | null }>).map((r) => r.position ?? 0);
      const base = positions.length ? Math.max(...positions) + 1 : 0;
      await this.rest("/sprints", {
        method: "POST",
        body: JSON.stringify(newSprints.map((sp, i) => ({ ...s, key: sp.key, title: sp.title ?? sp.key, goal: sp.goal ?? "", position: sp.position ?? (base + i) }))),
      });
    }
    const sprintKeyToId = await this.keyMap("sprints");

    // 2) stories faltantes (nacen 'backlog') → luego mapa completo key→id
    const haveStories = await this.keyMap("stories");
    const newStories = stories.filter((st) => !haveStories.has(st.key));
    if (newStories.length) {
      await this.rest("/stories", {
        method: "POST",
        body: JSON.stringify(newStories.map((st) => ({
          ...s,
          key: st.key,
          title: st.title,
          status: "backlog",
          lane: st.lane ?? "",
          sprint_id: st.sprint ? sprintKeyToId.get(st.sprint) ?? null : null,
          body: st.body ?? null,
          acceptance: st.acceptance ?? null,
          epic_id: st.epic_id ?? null,
          kind: st.kind ?? "story",
          screen_key: st.screen_key ?? null,
          severity: st.severity ?? null,
        }))),
      });
    }
    const storyKeyToId = await this.keyMap("stories");

    // 3) blocked_by = deps (key→uuid); solo las que resuelven a una story existente. Idempotente.
    for (const st of stories) {
      const deps = (st.deps ?? []).map((k) => storyKeyToId.get(k)).filter((x): x is string => !!x);
      if (deps.length) {
        await this.rest(`/stories?project_id=eq.${s.project_id}&key=eq.${st.key}`, {
          method: "PATCH",
          body: JSON.stringify({ blocked_by: deps }),
        });
      }
    }
    // 4) Huérfanos al ENCOGER (deuda-chica 2026-07-20): en un re-handoff FULL (design, no iterate),
    // una story que estaba en la DB pero YA NO está en el backlog aprobado, y que NUNCA se despachó
    // (status 'backlog'), quedó huérfana. NO se borra: DELETE está revocado para authenticated y
    // borrar una story ya despachada (ready/running/review/done) perdería trabajo real. Se REPORTAN
    // (patrón "report, don't destroy" de P8-B) para que sean visibles. En un iterate (full=false) el
    // backlog es un DELTA aditivo → NUNCA hay huérfanos (no computar, o archivaríamos todo el backlog).
    let orphans: string[] = [];
    if (opts?.full) {
      const newKeys = new Set(stories.map((st) => st.key));
      const res = await this.rest(`/stories?project_id=eq.${this.cfg.project}&status=eq.backlog&select=key`, { method: "GET", prefer: "count=none" });
      orphans = ((await res.json()) as Array<{ key: string }>).map((r) => r.key).filter((k) => !newKeys.has(k));
    }
    return { sprints: sprintKeyToId.size, stories: storyKeyToId.size, orphans };
  }

  // loadBacklog reconstruye el backlog COMPLETO del proyecto desde la DB (la verdad ya mergeada:
  // publishBacklog es aditivo). Devuelve el mismo shape que parseBacklog para que el handoff pueda
  // regenerar docs/backlog.yaml tras un iterate (donde el workdir trae SOLO el delta). Reconstruye
  // `sprint` (uuid→key) y `deps` (blocked_by uuid[]→keys) via los mapas id→key.
  async loadBacklog(): Promise<{ sprints: SprintSeed[]; stories: StorySeed[] }> {
    const proj = this.cfg.project;
    const sres = await this.rest(`/sprints?project_id=eq.${proj}&select=id,key,title,goal,position&order=position`, { method: "GET", prefer: "count=none" });
    const sprintRows = (await sres.json()) as Array<{ id: string; key: string; title: string | null; goal: string | null; position: number | null }>;
    const stres = await this.rest(`/stories?project_id=eq.${proj}&select=id,key,title,lane,sprint_id,body,acceptance,epic_id,kind,screen_key,severity,blocked_by&order=key`, { method: "GET", prefer: "count=none" });
    const storyRows = (await stres.json()) as Array<{ id: string; key: string; title: string | null; lane: string | null; sprint_id: string | null; body: string | null; acceptance: string | null; epic_id: string | null; kind: string | null; screen_key: string | null; severity: string | null; blocked_by: string[] | null }>;
    const sprintIdToKey = new Map(sprintRows.map((r) => [r.id, r.key]));
    const storyIdToKey = new Map(storyRows.map((r) => [r.id, r.key]));
    const sprints: SprintSeed[] = sprintRows.map((r, i) => ({ key: r.key, title: r.title ?? r.key, goal: r.goal ?? "", position: r.position ?? i }));
    const stories: StorySeed[] = storyRows.map((r) => ({
      key: r.key,
      title: r.title ?? r.key,
      body: r.body ?? undefined,
      acceptance: r.acceptance ?? undefined,
      lane: r.lane ?? "",
      sprint: r.sprint_id ? sprintIdToKey.get(r.sprint_id) : undefined,
      deps: (r.blocked_by ?? []).map((id) => storyIdToKey.get(id)).filter((k): k is string => !!k),
      epic_id: r.epic_id ?? undefined,
      kind: r.kind ?? undefined,
      screen_key: r.screen_key ?? undefined,
      severity: r.severity ?? undefined,
    }));
    return { sprints, stories };
  }

  // publishFindings (F4): el re-feed del REVIEWER al backlog. Toma los findings estructurados,
  // los particiona (design/src/reviewGate.ts) — P0 → MISMO sprint (→ el gate `unbuilt`/P0 re-bloquea
  // y re-despacha), deferred → sprint SIGUIENTE — y los persiste vía publishBacklog (aditivo,
  // idempotente por key = finding.id). Devuelve el conteo para que el conductor decida si el sprint
  // cierra (p0 === 0) o hay que loopear. `nextSprint` se crea si no existe (para las deferred).
  async publishFindings(
    findings: Finding[],
    ctx: { currentSprint: string; nextSprint: string },
  ): Promise<{ p0: number; deferred: number }> {
    const { stories, p0, deferred } = partitionFindings(findings, ctx);
    if (!stories.length) return { p0: 0, deferred: 0 };
    const sprintSeeds: SprintSeed[] = deferred > 0 ? [{ key: ctx.nextSprint }] : [];
    const storySeeds: StorySeed[] = stories.map((s) => ({
      key: s.id,
      title: s.title,
      body: s.body,
      acceptance: s.acceptance,
      lane: s.owner ?? "",
      sprint: s.sprint_id,
      kind: s.kind,
      screen_key: s.screen_key,
      severity: s.severity,
    }));
    await this.publishBacklog(sprintSeeds, storySeeds, { full: false });
    await this.brainAppend("findings_published", { p0, deferred, sprint: ctx.currentSprint }, "engine:review");
    return { p0, deferred };
  }

  // ── Sprint-planning (plan_apply) ──────────────────────────────────────────────────
  // loadLiveBacklog: el snapshot que computePlan valida contra la data VIVA (no docs/backlog.yaml).
  // Devuelve stories (key/status/sprintKey/deps-como-keys) y sprints (key/position).
  async loadLiveBacklog(): Promise<{ stories: LiveStory[]; sprints: LiveSprint[] }> {
    const proj = this.cfg.project;
    const [sres, stres] = await Promise.all([
      this.rest(`/sprints?project_id=eq.${proj}&select=id,key,position&order=position`, { method: "GET", prefer: "count=none" }),
      this.rest(`/stories?project_id=eq.${proj}&select=id,key,status,sprint_id,blocked_by`, { method: "GET", prefer: "count=none" }),
    ]);
    const sprintRows = (await sres.json()) as Array<{ id: string; key: string; position: number | null }>;
    const storyRows = (await stres.json()) as Array<{ id: string; key: string; status: string; sprint_id: string | null; blocked_by: string[] | null }>;
    const sprintIdToKey = new Map(sprintRows.map((r) => [r.id, r.key]));
    const storyIdToKey = new Map(storyRows.map((r) => [r.id, r.key]));
    const sprints: LiveSprint[] = sprintRows.map((r, i) => ({ key: r.key, position: r.position ?? i }));
    const stories: LiveStory[] = storyRows.map((r) => ({
      key: r.key,
      status: r.status,
      sprintKey: r.sprint_id ? sprintIdToKey.get(r.sprint_id) ?? null : null,
      deps: (r.blocked_by ?? []).map((id) => storyIdToKey.get(id)).filter((k): k is string => !!k),
    }));
    return { stories, sprints };
  }

  // applySprintPlan: aplica las mutaciones de un plan aprobado (ya validadas por computePlan) al
  // store y estampa planned_at + planning_run_id en el sprint (lo que DESTRABA el dispatch). Cambiar
  // sprint_id/campos/blocked_by NO toca status → la máquina de estados lo deja pasar (no-op status).
  // owner del DSL → columna `lane`. Los keys se resuelven a uuids con el keyMap.
  async applySprintPlan(muts: StoreMutation[], sprintKey: string): Promise<void> {
    const proj = this.cfg.project;
    const [storyKeyToId, sprintKeyToId] = await Promise.all([this.keyMap("stories"), this.keyMap("sprints")]);
    const patchStory = (key: string, patch: Record<string, unknown>) =>
      this.rest(`/stories?project_id=eq.${proj}&key=eq.${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(patch) });

    for (const m of muts) {
      if (m.kind === "setSprint") {
        const sid = sprintKeyToId.get(m.sprintKey);
        if (!sid) throw new Error(`applySprintPlan: sprint destino '${m.sprintKey}' no existe`);
        await patchStory(m.storyKey, { sprint_id: sid });
      } else if (m.kind === "patchFields") {
        const f = m.fields;
        const patch: Record<string, unknown> = {};
        if (f.title !== undefined) patch.title = f.title;
        if (f.body !== undefined) patch.body = f.body;
        if (f.acceptance !== undefined) patch.acceptance = f.acceptance;
        if (f.owner !== undefined) patch.lane = f.owner; // owner (DSL) → lane (columna)
        if (f.screen_key !== undefined) patch.screen_key = f.screen_key;
        if (Object.keys(patch).length) await patchStory(m.storyKey, patch);
      } else {
        // setDeps: reemplaza blocked_by (uuids). Keys que no resuelven a una story se descartan.
        const ids = m.depKeys.map((k) => storyKeyToId.get(k)).filter((x): x is string => !!x);
        await patchStory(m.storyKey, { blocked_by: ids });
      }
    }
    // Estampar planned_at → destraba el dispatch del sprint. planning_run_id = el run de esta ceremonia.
    await this.rest(`/sprints?project_id=eq.${proj}&key=eq.${encodeURIComponent(sprintKey)}`, {
      method: "PATCH",
      body: JSON.stringify({ planned_at: new Date().toISOString(), planning_run_id: this.runId || null }),
    });
  }

  // ── Sprint-review (review_close) ──────────────────────────────────────────────────
  // stampSprintReviewed: cierra la review de un sprint — estampa reviewed_at + review_run_id (lo que
  // DESTRABA el avance del ciclo: el reloj puede correr la retro, y el siguiente sprint su planning).
  // No toca status de stories → sin choque con la máquina de estados. sprintKey = KEY del sprint.
  async stampSprintReviewed(sprintKey: string): Promise<void> {
    await this.rest(`/sprints?project_id=eq.${this.cfg.project}&key=eq.${encodeURIComponent(sprintKey)}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewed_at: new Date().toISOString(), review_run_id: this.runId || null }),
    });
  }

  // ── Retro (registry_apply) ────────────────────────────────────────────────────────
  // stampSprintRetro: cierra la retro de un sprint — estampa retro_at + retro_run_id. Es el último
  // eslabón del ciclo (review→retro→planning del siguiente). Una retro sin cambios igual estampa.
  async stampSprintRetro(sprintKey: string): Promise<void> {
    await this.rest(`/sprints?project_id=eq.${this.cfg.project}&key=eq.${encodeURIComponent(sprintKey)}`, {
      method: "PATCH",
      body: JSON.stringify({ retro_at: new Date().toISOString(), retro_run_id: this.runId || null }),
    });
  }

  // sink wires phase lifecycle to design_phases and the handoff to the run status.
  get sink(): EngineSink {
    return {
      onPhaseStart: (phaseId) => this.patchPhase(phaseId, { status: "running" }),
      onPhaseDone: async (phaseId, result: PhaseResult) => {
        // DURABLE PRIMERO (hardening del sink): cada doc cosechado → un evento artifact append-only
        // en el brain (la fuente de las VERSIONES del Studio, chips vN). Se registra ANTES del write
        // de métricas: la versión del doc es lo que NO se puede perder, y un fallo de un dato
        // secundario (ej. drift de una columna de costos) NO debe abortar el guardado del doc.
        // (deuda-chica 2026-07-20: el drift de cache_read_tokens hizo fallar el patch de costos y la
        //  versión del delta nunca se registró — ahora el orden lo garantiza.)
        for (const a of result.artifacts ?? []) {
          await this.brainAppend("artifact", { path: a.path, content: a.content, message: `design: ${phaseId}` }, `agent:${phaseId}`);
        }
        // Estado + artifacts (durable): el mínimo para que la fase quede 'done' y un resume no la repita.
        await this.patchPhase(phaseId, { status: "done", artifacts: result.artifacts ?? [] });
        // Costo/tokens/latencia (P4-2) → best-effort: es MÉTRICA secundaria (vista Observabilidad).
        // Mismos nombres que run_costs → la vista une diseño+build uniforme. Si el write falla (ej.
        // drift de schema), se loguea y se sigue: la versión del doc y el estado ya están a salvo.
        const u = result.usage;
        if (u) {
          try {
            await this.patchPhase(phaseId, {
              usd: u.usd, input_tokens: u.inputTokens, output_tokens: u.outputTokens,
              cache_read_tokens: u.cacheReadTokens, duration_ms: u.durationMs, model: u.model,
            });
          } catch (e) {
            console.error(`onPhaseDone(${phaseId}): write de costos falló (métrica secundaria, se ignora):`, e instanceof Error ? e.message : e);
          }
        }
      },
      onHandoff: () => this.setRunStatus("awaiting_handoff"),
    };
  }

  // resolver inserts a gate row and polls until Studio resolves it (the F5-04 loop).
  // recordAutoGate: registra un gate AUTO-APROBADO (Fase 4, autonomía) como una fila design_gates ya
  // resuelta (status=resolved, outcome=approve) — para que el Flow/Studio lo muestre DONE y quede
  // auditable en la UI (no solo en el brain). El engine NO consultó al humano; esto deja el rastro.
  async recordAutoGate(req: GateRequest): Promise<void> {
    // Find-or-update (como el resolver humano): si ya hay una fila PENDING de este gate (un run que
    // parkeó en manual y se resume con el modo ya en auto), resolvela — NO insertes una segunda que
    // dejaría la pending colgada ("dos gates" en Studio). Fresh → insert resuelto.
    const existing = await this.rest(
      `/design_gates?run_id=eq.${this.runId}&gate_id=eq.${req.gateId}&status=eq.pending&select=id&order=created_at.desc&limit=1`,
      { method: "GET", prefer: "count=none" },
    );
    const pendingId = ((await existing.json()) as Array<{ id: string }>)[0]?.id;
    if (pendingId) {
      await this.rest(`/design_gates?id=eq.${pendingId}`, { method: "PATCH", body: JSON.stringify({ status: "resolved", outcome: "approve" }) });
    } else {
      await this.rest("/design_gates", {
        method: "POST",
        body: JSON.stringify({
          ...this.scope(), run_id: this.runId,
          phase_id: req.phaseId, gate_id: req.gateId, reason: req.reason,
          open_questions: req.openQuestions, attempt: req.attempt,
          status: "resolved", outcome: "approve",
        }),
      });
    }
    await this.brainAppend("gate_auto_approved", { gate: req.gateId, phase: req.phaseId }, "engine:autonomy");
  }

  get resolver(): GateResolver {
    return {
      resolve: async (req: GateRequest): Promise<GateDecision> => {
        // Find-or-create: on a crash-resume the run is frozen at a gate whose PENDING row
        // already exists — adopt it (poll it) instead of inserting a duplicate that would
        // show two gates in Studio. Fresh gates (no pending row) insert as before.
        const existing = await this.rest(
          `/design_gates?run_id=eq.${this.runId}&gate_id=eq.${req.gateId}&status=eq.pending&select=id&order=created_at.desc&limit=1`,
          { method: "GET", prefer: "count=none" },
        );
        let rowId = ((await existing.json()) as Array<{ id: string }>)[0]?.id;
        if (!rowId) {
          const res = await this.rest("/design_gates", {
            method: "POST",
            prefer: "return=representation",
            body: JSON.stringify({
              ...this.scope(),
              run_id: this.runId,
              phase_id: req.phaseId,
              gate_id: req.gateId,
              reason: req.reason,
              open_questions: req.openQuestions,
              attempt: req.attempt,
              status: "pending",
            }),
          });
          rowId = ((await res.json()) as Array<{ id: string }>)[0].id;
        }
        const row = { id: rowId };
        await this.setRunStatus("awaiting_gate");

        // Poll until the human resolves the gate in Studio.
        for (;;) {
          await delay(this.cfg.pollMs ?? 1500);
          const g = await this.rest(`/design_gates?id=eq.${row.id}&select=status,outcome,feedback,answers`, {
            method: "GET",
            prefer: "count=none",
          });
          const [cur] = (await g.json()) as Array<{
            status: string;
            outcome: GateDecision["outcome"] | null;
            feedback: string | null;
            answers: GateDecision["answers"] | null;
          }>;
          if (cur?.status === "resolved") {
            const decision: GateDecision = {
              outcome: cur.outcome ?? "approve",
              feedback: cur.feedback ?? undefined,
              answers: cur.answers ?? undefined,
            };
            // Record the gate outcome to the brain (kind gate_answer, per brain-write).
            await this.brainAppend(
              "gate_answer",
              {
                gate: req.gateId,
                outcome: decision.outcome === "approve" ? "approved" : "changes-requested",
                feedback: decision.feedback ?? "",
                answered: decision.answers ?? [],
              },
              "human:studio",
            );
            await this.setRunStatus("running");
            return decision;
          }
        }
      },
    };
  }
}
