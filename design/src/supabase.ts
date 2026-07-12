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
  private token: string;
  private base: string;
  runId = "";

  constructor(cfg: StoreConfig) {
    this.cfg = cfg;
    this.token = mintTenantJwt(cfg.jwtSecret, cfg.tenant);
    this.base = cfg.url.replace(/\/$/, "") + "/rest/v1";
  }

  private headers(prefer = "return=minimal"): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: this.cfg.anonKey,
      Authorization: `Bearer ${this.token}`,
      Prefer: prefer,
    };
  }

  private async rest(path: string, init: RequestInit & { prefer?: string }): Promise<Response> {
    const { prefer, ...rest } = init;
    const res = await fetch(`${this.base}${path}`, { ...rest, headers: this.headers(prefer) });
    if (!res.ok) {
      throw new Error(`supabase ${init.method} ${path} → ${res.status} ${await res.text()}`);
    }
    return res;
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

  async setRunStatus(status: string): Promise<void> {
    await this.rest(`/design_runs?id=eq.${this.runId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
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
  // stories/sprints (RLS por tenant, como authenticated). Dos pasadas: (1) sprints → key→id,
  // (2) stories (nacen 'backlog', sprint_id resuelto) → key→id, (3) blocked_by = deps
  // resueltas key→uuid (blocked_by es uuid[] → stories.id). Idempotente por (project,key):
  // limpia antes las stories/sprints del proyecto para no duplicar en un re-handoff.
  async publishBacklog(sprints: SprintSeed[], stories: StorySeed[]): Promise<{ sprints: number; stories: number }> {
    const s = this.scope();
    // Limpieza previa (re-handoff): borrar stories del proyecto (blocked_by se va con ellas)
    // y luego sprints. DELETE está revocado para authenticated en algunas tablas; si falla,
    // seguimos (primer handoff no tiene qué borrar).
    try {
      await this.rest(`/stories?project_id=eq.${s.project_id}`, { method: "DELETE" });
      await this.rest(`/sprints?project_id=eq.${s.project_id}`, { method: "DELETE" });
    } catch {
      /* primer handoff: nada que limpiar (o delete revocado) */
    }

    // 1) sprints → key→id
    const sprintKeyToId = new Map<string, string>();
    if (sprints.length) {
      const res = await this.rest("/sprints", {
        method: "POST",
        prefer: "return=representation",
        body: JSON.stringify(sprints.map((sp, i) => ({ ...s, key: sp.key, title: sp.title ?? sp.key, goal: sp.goal ?? "", position: sp.position ?? i }))),
      });
      for (const row of (await res.json()) as Array<{ id: string; key: string }>) sprintKeyToId.set(row.key, row.id);
    }

    // 2) stories (nacen 'backlog') → key→id
    const storyKeyToId = new Map<string, string>();
    if (stories.length) {
      const res = await this.rest("/stories", {
        method: "POST",
        prefer: "return=representation",
        body: JSON.stringify(stories.map((st) => ({
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
      for (const row of (await res.json()) as Array<{ id: string; key: string }>) storyKeyToId.set(row.key, row.id);
    }

    // 3) blocked_by = deps (key→uuid); solo las que resuelven a una story existente.
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
        await this.patchPhase(phaseId, { status: "done", artifacts: result.artifacts ?? [] });
        // Cada doc cosechado → un evento artifact append-only en el brain: es la fuente de
        // las VERSIONES en el Studio (los chips vN). Re-correr la fase agrega otra versión.
        for (const a of result.artifacts ?? []) {
          await this.brainAppend("artifact", { path: a.path, content: a.content, message: `design: ${phaseId}` }, `agent:${phaseId}`);
        }
      },
      onHandoff: () => this.setRunStatus("awaiting_handoff"),
    };
  }

  // resolver inserts a gate row and polls until Studio resolves it (the F5-04 loop).
  get resolver(): GateResolver {
    return {
      resolve: async (req: GateRequest): Promise<GateDecision> => {
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
        const [row] = (await res.json()) as Array<{ id: string }>;
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
