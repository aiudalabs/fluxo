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
    let res = await fetch(`${this.base}${path}`, { ...rest, headers: this.headers(prefer) });
    // El JWT pudo vencer EN VUELO (fase larga entre el authToken() y el fetch): re-minteá y
    // reintentá UNA vez antes de rendirte. Sin esto, un 401 tardío mataba el run entero.
    if (res.status === 401) {
      this.remint();
      res = await fetch(`${this.base}${path}`, { ...rest, headers: this.headers(prefer) });
    }
    if (!res.ok) {
      throw new Error(`supabase ${init.method} ${path} → ${res.status} ${await res.text()}`);
    }
    return res;
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

  async setRunStatus(status: string): Promise<void> {
    await this.rest(`/design_runs?id=eq.${this.runId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
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
  async publishBacklog(sprints: SprintSeed[], stories: StorySeed[]): Promise<{ sprints: number; stories: number }> {
    const s = this.scope();

    // 1) sprints faltantes → luego mapa completo key→id
    const haveSprints = await this.keyMap("sprints");
    const newSprints = sprints.filter((sp) => !haveSprints.has(sp.key));
    if (newSprints.length) {
      await this.rest("/sprints", {
        method: "POST",
        body: JSON.stringify(newSprints.map((sp, i) => ({ ...s, key: sp.key, title: sp.title ?? sp.key, goal: sp.goal ?? "", position: sp.position ?? i }))),
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
    return { sprints: sprintKeyToId.size, stories: storyKeyToId.size };
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
