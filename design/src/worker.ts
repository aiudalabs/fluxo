// F5-P9 · El WORKER de Fluxo — el reconciler que faltaba corriendo. Un solo proceso que, en
// cada tick, hace DOS cosas:
//   1. DISEÑO: un proyecto SIN design_run y SIN stories (recién creado) → arranca su diseño
//      (spawnea main.ts). Esto es lo que hacía falta para que "crear proyecto → arranca el
//      diseño" funcione sin pasos manuales.
//   2. BUILD: por proyecto con repo, promueve backlog→ready (deps done) y despacha ready→
//      running (workflow_dispatch a claude.yml).
//
// Es infra backend (service_role, cross-tenant). Debe estar CORRIENDO para que el sistema
// reaccione — por eso ahora es parte de "correr Fluxo" (scripts/dev.sh + npm run worker).
//
// Uso: set -a; source .env; set +a
//      node --experimental-strip-types design/src/worker.ts [--workflow=design] [--max=3] [--interval=15] [--dry-run] [--no-build]

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runAssistant, sseEvent, type ChatMsg } from "./assistant.ts";
import { buildAssistantTools, ASSISTANT_TOOL_IDS } from "./assistantTools.ts";
import { GithubApp, GithubRepo } from "./github.ts";
import { Projector, type MirroredStory } from "./projection.ts";
import { candidates, storyPrompt, sprintPrompt, docsGuardOk, sprintToPlan, sprintToReview, sprintToRetro, type Policy, type DStory, type DSprint } from "./dispatch.ts";
import { AutoMerger, prNumFromUrl } from "./automerge.ts";
import { Approver } from "./approve.ts";
import { resolveProjectCapabilities, computeCapabilityGate } from "./capabilities.ts";
import { usageFromActionLog } from "./costFromLog.ts";
import { priceForModel, costUSD } from "./pricing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mainScript = resolve(here, "main.ts");
const registryDir = resolve(here, "..", "..", "registry");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (source .env)"); process.exit(1); }

const arg = (f: string) => process.argv.find((a) => a.startsWith(`--${f}=`))?.split("=")[1];
const dryRun = process.argv.includes("--dry-run");
const noBuild = process.argv.includes("--no-build");
const workflow = arg("workflow") ?? "design";
const MAX = Number(arg("max") ?? 3);
const intervalMs = Number(arg("interval") ?? 15) * 1000;

const base = url.replace(/\/$/, "") + "/rest/v1";
const svc = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json", "Content-Type": "application/json" };
// 5xx/429 transitorios (incl. 525 SSL de Cloudflare↔Supabase): hipos de infra, no fallas reales.
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527, 530]);
const rest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, { ...init, headers: svc });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
    // Un blip de infra no debe cortar un reconcile — backoff (0.6s, 1.2s, 2.4s, 4.8s) y reintentá.
    if (TRANSIENT_HTTP.has(res.status) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
      continue;
    }
    throw new Error(`supabase ${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
};

const ghAppId = process.env.GITHUB_APP_ID;
const ghKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const ghKey = process.env.GITHUB_APP_PRIVATE_KEY;
const app = ghAppId && (ghKeyPath || ghKey) ? new GithubApp({ appId: ghAppId, privateKeyPath: ghKeyPath, privateKey: ghKey }) : null;

const designing = new Set<string>(); // proyectos con un main.ts que lanzamos y sigue vivo
const STALE_MS = 90_000; // heartbeat vencido → el run está huérfano (proceso muerto)
// Ceremonias: corren por-sprint (--sprint). Su resume NO va por reconcileDesign (que reanudaría con
// el trigger de diseño, sin sprint) — un run de ceremonia huérfano se marca failed y el reloj
// (reconcileCeremonies) lo re-planea fresco sobre el sprint aún sin planear.
const CEREMONY_WORKFLOWS = new Set(["sprint-planning", "sprint-review", "retro"]);
// El secret del CANAL de build (no una capability del registry) — sin él la Action arranca y falla.
const CHANNEL_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";

// spawnDesign lanza main.ts para un proyecto: diseño FRESCO (sin resumeRunId) o RESUME de un
// run caído (con --resume=<runId>, Opción B). Al salir, quita el proyecto de `designing` para
// que un hijo que crasheó pueda re-adoptarse en el próximo tick (con guardia de heartbeat).
function spawnDesign(projectId: string, name: string, resumeRunId?: string, wf: string = workflow) {
  const tag = resumeRunId ? "↻ resume" : "▶ diseño";
  if (dryRun) { console.log(`[dry] ${tag}: "${name}" (${projectId})${resumeRunId ? ` run ${resumeRunId}` : ` [${wf}]`}`); return; }
  console.log(`${tag}: "${name}" (${projectId})${resumeRunId ? ` run ${resumeRunId}` : ` [${wf}]`}`);
  // Resume: main.ts usa el workflow DEL RUN (ignora --workflow); fresh: el del proyecto (P5-3).
  const argv = ["--experimental-strip-types", mainScript, projectId, `--workflow=${wf}`];
  if (resumeRunId) argv.push(`--resume=${resumeRunId}`);
  const child = spawn("node", argv, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => { console.log(`  ${resumeRunId ? "resume" : "diseño"} de ${projectId} terminó (code ${code})`); designing.delete(projectId); });
}

// spawnIterate lanza main.ts para un CHANGE-REQUEST (P5-2): --workflow=iterate + las instrucciones
// como idea override. main.ts siembra el workdir con los docs existentes → el iteration-planner emite
// un DELTA → handoff APPENDea las stories nuevas. Al salir, marca el pedido done/failed.
function spawnIterate(reqId: string, projectId: string, name: string, instructions: string) {
  if (dryRun) { console.log(`[dry] ⟳ iterate: "${name}" (${projectId}) req ${reqId}`); return; }
  console.log(`⟳ iterate: "${name}" (${projectId}) — ${instructions.slice(0, 80)}${instructions.length > 80 ? "…" : ""}`);
  const argv = ["--experimental-strip-types", mainScript, projectId, instructions, "--workflow=iterate"];
  const child = spawn("node", argv, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    console.log(`  iterate de ${projectId} terminó (code ${code})`);
    designing.delete(projectId);
    void rest(`/increment_requests?id=eq.${reqId}`, { method: "PATCH", body: JSON.stringify({ status: code === 0 ? "done" : "failed", updated_at: new Date().toISOString() }) }).catch(() => {});
  });
}

// spawnCeremony lanza main.ts para una ceremonia sobre UN sprint (--sprint=<key>). main.ts arma el
// trigger de ceremonia (goal + backlog_snapshot + doc paths). Al salir, libera `designing`.
function spawnCeremony(projectId: string, name: string, sprintKey: string, wf: string) {
  if (dryRun) { console.log(`[dry] ◆ ${wf}: "${name}" (${projectId}) sprint ${sprintKey}`); return; }
  console.log(`◆ ${wf}: "${name}" (${projectId}) sprint ${sprintKey}`);
  const argv = ["--experimental-strip-types", mainScript, projectId, `--workflow=${wf}`, `--sprint=${sprintKey}`];
  const child = spawn("node", argv, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => { console.log(`  ${wf} de ${projectId} sprint ${sprintKey} terminó (code ${code})`); designing.delete(projectId); });
}

// ── 1b) Reconcile CHANGE-REQUESTS (P5-2) ─────────────────────────────────────────
// Un pedido de incremento pending → spawn iterate. Guard `designing`: no correr diseño e iterate a
// la vez en el mismo proyecto. Marca running ANTES de spawnear (evita doble-levantar en el próximo tick).
async function reconcileIncrements() {
  const reqs = await rest<Array<{ id: string; project_id: string; instructions: string }>>(`/increment_requests?status=eq.pending&select=id,project_id,instructions&order=created_at.asc`);
  if (!reqs.length) return;
  const nameById = new Map((await rest<Array<{ id: string; name: string }>>(`/projects?select=id,name`)).map((p) => [p.id, p.name]));
  for (const req of reqs) {
    if (designing.has(req.project_id)) continue;
    designing.add(req.project_id);
    await rest(`/increment_requests?id=eq.${req.id}`, { method: "PATCH", body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() }) });
    spawnIterate(req.id, req.project_id, nameById.get(req.project_id) ?? req.project_id, req.instructions);
  }
}

// ── 1) Reconcile DISEÑO ─────────────────────────────────────────────────────────
async function reconcileDesign() {
  const [projects, runs, stories] = await Promise.all([
    rest<Array<{ id: string; name: string; settings: { workflow?: string } | null }>>(`/projects?select=id,name,settings`),
    rest<Array<{ id: string; project_id: string; status: string; heartbeat_at: string | null; workflow: string }>>(`/design_runs?select=id,project_id,status,heartbeat_at,workflow`),
    rest<Array<{ project_id: string }>>(`/stories?select=project_id`),
  ]);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const withRun = new Set(runs.map((r) => r.project_id));
  const withStories = new Set(stories.map((s) => s.project_id)); // ya tiene backlog → NO re-diseñar

  // Fresh: proyecto recién creado (sin run y sin backlog) → arranca su diseño.
  for (const p of projects) {
    if (withRun.has(p.id) || withStories.has(p.id) || designing.has(p.id)) continue;
    designing.add(p.id);
    spawnDesign(p.id, p.name, undefined, p.settings?.workflow || workflow); // P5-3: workflow del proyecto
  }

  // Resume (Opción B): run HUÉRFANO = status no terminal + heartbeat vencido. Los hijos main.ts
  // no mueren atómicamente con el worker (spawn no-detached), así que el lease —no el mero
  // "existe un run"— es lo que distingue un proceso vivo (heartbeat fresco → NO tocar) de uno
  // caído (heartbeat viejo → re-adoptar y reanudar desde el estado durable). `designing` evita
  // re-spawn del que lanzamos nosotros. (A escala N-workers: hace falta un claim atómico.)
  const now = Date.now();
  for (const r of runs) {
    if (r.status === "done" || r.status === "failed") continue;
    if (designing.has(r.project_id)) continue;
    const beat = r.heartbeat_at ? new Date(r.heartbeat_at).getTime() : 0;
    if (now - beat < STALE_MS) continue; // heartbeat fresco → el proceso sigue vivo
    // Ceremonia huérfana: NO reanudar por acá (correría sin --sprint). Marcala failed → el reloj la
    // re-planea fresco sobre el sprint que quedó sin planear.
    if (CEREMONY_WORKFLOWS.has(r.workflow)) {
      await rest(`/design_runs?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed" }) }).catch(() => {});
      continue;
    }
    designing.add(r.project_id);
    spawnDesign(r.project_id, nameById.get(r.project_id) ?? r.project_id, r.id);
  }
}

// ── 2) Reconcile BUILD ──────────────────────────────────────────────────────────
const issueNumOf = (ref: string | null): number | null => { const m = ref?.match(/#(\d+)$/); return m ? Number(m[1]) : null; };
const tokenByOrg = new Map<string, string>();
const repoTokenFor = async (org: string): Promise<string> => {
  let tok = tokenByOrg.get(org);
  if (!tok) { tok = await app!.installationToken(org); tokenByOrg.set(org, tok); }
  return tok;
};

// projectExternalStatus: escritura vía el RPC que bypassa el state machine (Fase 1). La usa la
// proyección (GitHub = verdad) Y el despacho (marcar running backlog→running directo, como v1
// SyncExternalStatus). Compartida para no duplicar el shape de la llamada.
const projectExternalStatus = async (storyId: string, status: string, prUrl: string | null = null, agentLost: string | null = null): Promise<void> => {
  await rest(`/rpc/project_external_status`, {
    method: "POST",
    body: JSON.stringify({ p_story_id: storyId, p_status: status, p_pr_url: prUrl, p_agent_lost: agentLost }),
  });
};

// projects.settings → Policy del despacho (Fase 2). Defaults: story mode, canal claude_action,
// concurrencia = el flag --max si el proyecto no la fija (0 explícito = ilimitado).
interface Settings {
  channel?: string;
  execution_unit?: "sprint" | "story";
  max_concurrency?: number;
  merge_mode?: "manual" | "auto";
  dispatch_mode?: "auto" | "manual";
  workflow_approval?: "off" | "auto_if_safe";
  planning_mode?: "ceremony" | "off";     // ceremony = un sprint no despacha hasta planearse
  review_mode?: "ceremony" | "off";        // ceremony = un sprint terminado se revisa antes de avanzar
  retro_mode?: "ceremony" | "off";         // ceremony = tras revisar, la retro puede editar el método
  lanes?: Record<string, { channel?: string; model?: string }>;
}
function policyFrom(settings: Settings): Policy {
  const modelByLane = new Map<string, string>();
  const channelByLane = new Map<string, string>();
  for (const [lane, cfg] of Object.entries(settings.lanes ?? {})) {
    if (cfg?.model) modelByLane.set(lane, cfg.model);
    if (cfg?.channel) channelByLane.set(lane, cfg.channel);
  }
  return {
    executionUnit: settings.execution_unit === "sprint" ? "sprint" : "story",
    channel: settings.channel || "claude_action",
    maxConcurrency: settings.max_concurrency != null ? settings.max_concurrency : MAX,
    planningRequired: settings.planning_mode === "ceremony",
    modelByLane, channelByLane,
  };
}

// ── 1c) Reconcile CEREMONIAS (el "reloj") ────────────────────────────────────────
// Con planning_mode=ceremony, dispara sprint-planning para el sprint FRONTIER: el de menor posición
// con trabajo sin terminar que aún NO está planeado (y cuyos anteriores ya están asentados). Es
// just-in-time — el candado (dispatch.planningRequired) frena el build hasta que planned_at se estampa.
async function reconcileCeremonies() {
  const projects = await rest<Array<{ id: string; name: string; settings: Settings | null }>>(`/projects?select=id,name,settings`);
  const ceremony = projects.filter((p) => p.settings?.review_mode === "ceremony" || p.settings?.retro_mode === "ceremony" || p.settings?.planning_mode === "ceremony");
  for (const p of ceremony) {
    if (designing.has(p.id)) continue;
    // Reservar SINCRÓNICO (antes del await) — igual que los otros reconcilers — o dos ticks solapados
    // pasan ambos el check y doble-spawnean (2× costo LLM + applies en conflicto). Se libera en el
    // finally salvo que hayamos spawneado (ahí lo libera el exit handler del hijo).
    designing.add(p.id);
    let spawned = false;
    try {
      const [sprints, stories] = await Promise.all([
        rest<Array<{ id: string; key: string; position: number | null; planned_at: string | null; reviewed_at: string | null; retro_at: string | null }>>(`/sprints?project_id=eq.${p.id}&select=id,key,position,planned_at,reviewed_at,retro_at&order=position`),
        rest<Array<{ sprint_id: string | null; status: string }>>(`/stories?project_id=eq.${p.id}&select=sprint_id,status`),
      ]);
      const total = new Map<string, number>();   // sprint_id → # stories
      const unbuilt = new Map<string, number>();  // sprint_id → stories sin terminar (status != done)
      for (const s of stories) {
        if (!s.sprint_id) continue;
        total.set(s.sprint_id, (total.get(s.sprint_id) ?? 0) + 1);
        if (s.status !== "done") unbuilt.set(s.sprint_id, (unbuilt.get(s.sprint_id) ?? 0) + 1);
      }
      // Orden Scrum: REVIEW(N) → RETRO(N) → PLANNING(N+1). El primero pendiente gana (uno por tick).
      const reviewTarget = p.settings?.review_mode === "ceremony" ? sprintToReview(sprints, total, unbuilt) : null;
      const retroTarget = !reviewTarget && p.settings?.retro_mode === "ceremony" ? sprintToRetro(sprints) : null;
      const planTarget = !reviewTarget && !retroTarget && p.settings?.planning_mode === "ceremony" ? sprintToPlan(sprints, unbuilt) : null;
      if (reviewTarget) { spawnCeremony(p.id, p.name, reviewTarget, "sprint-review"); spawned = true; }
      else if (retroTarget) { spawnCeremony(p.id, p.name, retroTarget, "retro"); spawned = true; }
      else if (planTarget) { spawnCeremony(p.id, p.name, planTarget, "sprint-planning"); spawned = true; }
    } finally {
      if (!spawned) designing.delete(p.id);
    }
  }
}

// ── 2a) Reconcile PROYECCIÓN (GitHub = verdad; corre ANTES del despacho) ──────────
const projector = new Projector({ write: projectExternalStatus, log: (m) => console.log(m) });

async function reconcileProjection() {
  if (!app) return;
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null }>>(`/projects?select=id,name,org,repo&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    const rows = await rest<Array<{ id: string; key: string; status: string; external_ref: string | null; pr_url: string | null }>>(
      `/stories?project_id=eq.${p.id}&select=id,key,status,external_ref,pr_url`,
    );
    const mirrored: MirroredStory[] = [];
    for (const r of rows) {
      const issue = issueNumOf(r.external_ref);
      if (!issue) continue; // no espejada en GitHub → no la proyecta
      mirrored.push({ id: r.id, key: r.key, status: r.status, issue, prUrl: r.pr_url });
    }
    if (mirrored.length === 0) continue;
    if (dryRun) { console.log(`[dry] proyección: ${p.name} (${mirrored.length} stories espejadas)`); continue; }
    try {
      const repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
      const { changes } = await projector.syncProject(repo, mirrored);
      if (changes.length) console.log(`⟳ proyección ${p.name}: ${changes.length} cambio(s)`);
    } catch (e) { console.error(`  proyección ${p.name} falló: ${e instanceof Error ? e.message : e}`); }
  }
}

// ── 2b) Reconcile AUTO-MERGE (gated por merge_mode:auto; corre ENTRE proyección y despacho) ──────
// Orden del conductor de v1: proyectar → auto-merge → despachar. Solo mergea; NO toca el estado de
// la story — el issue cierra al mergear y la PROYECCIÓN la marca `done` en el próximo tick, lo que
// desbloquea los sprints dependientes. Un solo AutoMerger (estado de retries entre ticks); las
// claves se scopean por proyecto porque los números de PR no son únicos entre repos.
const autoMerger = new AutoMerger({ log: (m) => console.log(m) });

async function reconcileAutoMerge() {
  if (!app) return;
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null; settings: Settings | null }>>(`/projects?select=id,name,org,repo,settings&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    if ((p.settings?.merge_mode ?? "manual") !== "auto") continue; // default manual = el humano mergea

    const rows = await rest<Array<{ pr_url: string | null }>>(`/stories?project_id=eq.${p.id}&status=eq.review&pr_url=not.is.null&select=pr_url`);
    const prNums = rows.map((r) => prNumFromUrl(r.pr_url)).filter((n): n is number => n != null);
    if (prNums.length === 0) continue;
    if (dryRun) { console.log(`[dry] auto-merge: ${p.name} (${new Set(prNums).size} PR/s en review)`); continue; }

    try {
      const repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
      const { merged } = await autoMerger.reconcile(repo, prNums, p.id);
      if (merged.length) console.log(`⤳ auto-merge ${p.name}: ${merged.length} PR(s) mergeado(s) [${merged.join(", ")}]`);
    } catch (e) { console.error(`  auto-merge ${p.name} falló: ${e instanceof Error ? e.message : e}`); }
  }
}

// ── 2c) Reconcile WORKFLOW APPROVAL (Fase 5; gated por workflow_approval:auto_if_safe) ──────────
// Los runs de CI de los PRs de agentes quedan `action_required`. Bajo auto_if_safe el conductor los
// aprueba SOLO si su diff no toca `.github/workflows/**` (approve.ts). Corre ANTES del auto-merge:
// aprobar destraba el CI → los checks corren → el próximo tick el auto-merge los ve CLEAN. Default
// (off / ausente) = el humano aprueba desde la vista Agentes. GithubRepo implementa WorkflowApprover.
const approver = new Approver({ log: (m) => console.log(m) });

async function reconcileApprovals() {
  if (!app) return;
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null; settings: Settings | null }>>(`/projects?select=id,name,org,repo,settings&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    if ((p.settings?.workflow_approval ?? "off") !== "auto_if_safe") continue; // default: aprueba el humano
    if (dryRun) { console.log(`[dry] approval sweep: ${p.name}`); continue; }
    try {
      const repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
      const { approved, blocked } = await approver.sweep(repo);
      if (approved.length) console.log(`✓ approve ${p.name}: ${approved.length} run(s) auto-aprobado(s) [${approved.join(", ")}]`);
      if (blocked.length) console.log(`⛔ approve ${p.name}: ${blocked.length} run(s) tocan workflows/sin-PR → quedan al humano [${blocked.join(", ")}]`);
    } catch (e) { console.error(`  approve ${p.name} falló: ${e instanceof Error ? e.message : e}`); }
  }
}

// ── 2d) Reconcile COSTOS (F-spend) ────────────────────────────────────────────────
// Lee los comentarios de issues del repo, extrae los marcadores fluxo:cost que postea el claude.yml
// (modelUsage/costUSD de claude-code-action) y hace UPSERT en run_costs (idempotente por run_id, via
// on_conflict ignore-duplicates). El tenant lo lee por RLS; escribimos con service_role.
const COST_RE = /<!--\s*fluxo:cost\s*(\{[\s\S]*?\})\s*-->/;

async function reconcileCosts() {
  if (!app) return;
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null; tenant_id: string }>>(`/projects?select=id,name,org,repo,tenant_id&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org || dryRun) continue;
    try {
      const repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
      const comments = await repo.listRepoIssueComments();
      let stored = 0;
      for (const c of comments) {
        const m = c.body.match(COST_RE);
        if (!m) continue;
        let data: { run?: unknown; usd?: unknown; in?: unknown; out?: unknown; cacheRead?: unknown; issues?: unknown };
        try { data = JSON.parse(m[1]); } catch { continue; }
        if (data.run == null) continue;
        const res = await fetch(`${base}/run_costs?on_conflict=project_id,run_id`, {
          method: "POST",
          headers: { ...svc, Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({
            tenant_id: p.tenant_id, project_id: p.id, run_id: String(data.run), issues: data.issues != null ? String(data.issues) : null,
            usd: Number(data.usd) || 0, input_tokens: Number(data.in) || 0, output_tokens: Number(data.out) || 0, cache_read_tokens: Number(data.cacheRead) || 0,
          }),
        });
        if (res.ok || res.status === 201) stored++;
      }
      if (stored) console.log(`💰 costos ${p.name}: ${stored} marcador(es) procesado(s) (upsert idempotente)`);
    } catch (e) { console.error(`  costos ${p.name} falló: ${e instanceof Error ? e.message : e}`); }
  }
}

// ── 2d-bis) COSTO ESTIMADO de runs cancelados/timeout (F-spend) ────────────────────
// El happy-path (reconcileCosts) solo ve runs que TERMINARON (dejaron el marcador fluxo:cost). Un run
// cancelado/timeout gastó plata real pero no deja execution file → $0 invisible. Acá, por cada run de
// claude.yml que terminó en cancelled/failure/timed_out y NO tiene fila en run_costs, bajamos el LOG
// del job, sumamos los tokens del stream-json (dedup por message-id) y estimamos el USD con la tabla de
// precios de LiteLLM. Se guarda con estimated=true. Idempotente: una vez guardado (aunque sea $0), no
// se vuelve a bajar el log. Acotado a los últimos runs (per_page) para no barrer todo el historial.
const ORPHAN_CONCLUSIONS = new Set(["cancelled", "failure", "timed_out"]);

async function reconcileOrphanCosts() {
  if (!app || dryRun) return;
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null; tenant_id: string }>>(`/projects?select=id,name,org,repo,tenant_id&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    try {
      const repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
      const runs = await repo.listCompletedRuns("claude.yml", 20);
      const orphans = runs.filter((r) => r.conclusion && ORPHAN_CONCLUSIONS.has(r.conclusion));
      if (orphans.length === 0) continue;
      // ¿cuáles ya tienen fila? (una query por proyecto, no por run).
      const runIds = orphans.map((r) => String(r.id));
      const existing = await rest<Array<{ run_id: string }>>(`/run_costs?project_id=eq.${p.id}&run_id=in.(${runIds.join(",")})&select=run_id`);
      const seen = new Set(existing.map((e) => e.run_id));
      let estimated = 0;
      for (const run of orphans) {
        if (seen.has(String(run.id))) continue;
        const jobId = await repo.firstJobId(run.id);
        const log = jobId ? await repo.jobLogText(jobId) : "";
        const u = log ? usageFromActionLog(log) : { model: null, messages: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
        const price = priceForModel(u.model);
        const usd = price ? costUSD(u, price) : 0;
        // Guardar SIEMPRE (aun $0 / modelo desconocido) para no re-bajar el log en cada tick.
        const res = await fetch(`${base}/run_costs?on_conflict=project_id,run_id`, {
          method: "POST",
          headers: { ...svc, Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({
            tenant_id: p.tenant_id, project_id: p.id, run_id: String(run.id), issues: null,
            usd, input_tokens: u.inputTokens, output_tokens: u.outputTokens,
            cache_read_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens,
            model: u.model, estimated: true,
          }),
        });
        if (res.ok || res.status === 201) { estimated++; console.log(`  💸 ${p.name} run ${run.id} (${run.conclusion}): ~$${usd.toFixed(4)} estimado (${u.model ?? "modelo desconocido"}, ${u.messages} msgs)`); }
      }
      if (estimated) console.log(`💰 costos estimados ${p.name}: ${estimated} run(s) cancelado(s)/timeout costeado(s) del log`);
    } catch (e) { console.error(`  costos-estimados ${p.name} falló: ${e instanceof Error ? e.message : e}`); }
  }
}

// ── 2e) WATCHDOG de liveness de builds (increment 2) ───────────────────────────────
// GitHub no da el log en vivo (404 hasta que el job termina), así que la ÚNICA señal externa de "sigue
// trabajando" es lo que el agente EMPUJA: sus commits. Con el prompt de commits incrementales, una
// corrida sana pushea seguido; una colgada se queda muda. Por cada run vivo de claude.yml:
//   · techo duro (max_min): cancelá si el run superó ~2h (backstop del cap de 6h de GitHub) — por-run,
//     confiable (tenemos run_started_at).
//   · inactividad de commits (stale_min): si HAY rama de trabajo y su último commit envejeció, o no hay
//     NINGUNA rama tras una gracia larga (no_commit_min), cancelá — se colgó.
// Al cancelar, la Action corre sus pasos cancelled(): limpia agent:running + marca agent:failed → la
// proyección degrada la story a backlog, y reconcileOrphanCosts le estima el costo del log. Knobs por
// settings.watchdog (tuneables sin deploy). LIMITACIÓN v1: la señal de commits es a nivel repo, no
// por-run; con 2+ runs concurrentes los commits de uno tapan la inactividad de otro (el techo duro
// igual los corta). Fail-open: si la API falla, no se cancela nada.
const WATCHDOG = { MAX_MIN: 120, STALE_MIN: 30, GRACE_MIN: 20, NO_COMMIT_MIN: 40 };

async function reconcileWatchdog() {
  if (!app || dryRun) return;
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null; settings: { watchdog?: { max_min?: number; stale_min?: number; grace_min?: number; no_commit_min?: number } } | null }>>(`/projects?select=id,name,org,repo,settings&repo=not.is.null`);
  const now = Date.now();
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    try {
      const repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
      const live = await repo.listLiveRuns("claude.yml");
      if (live.length === 0) continue;
      const wd = p.settings?.watchdog ?? {};
      const maxMin = wd.max_min ?? WATCHDOG.MAX_MIN, staleMin = wd.stale_min ?? WATCHDOG.STALE_MIN;
      const graceMin = wd.grace_min ?? WATCHDOG.GRACE_MIN, noCommitMin = wd.no_commit_min ?? WATCHDOG.NO_COMMIT_MIN;
      const newest = await repo.newestWorkBranchCommit();
      const commitAgeMin = newest ? (now - newest.at) / 60000 : Infinity;
      for (const run of live) {
        const ageMin = (now - new Date(run.startedAt).getTime()) / 60000;
        let reason: string | null = null;
        if (ageMin > maxMin) reason = `techo duro (${maxMin}m)`;
        else if (newest && ageMin > graceMin && commitAgeMin > staleMin) reason = `sin commits nuevos hace ${Math.round(commitAgeMin)}m (rama ${newest.branch})`;
        else if (!newest && ageMin > noCommitMin) reason = `sin ningún commit tras ${Math.round(ageMin)}m`;
        if (!reason) continue;
        await repo.cancelRun(run.id);
        console.log(`⏱ watchdog ${p.name}: run ${run.id} CANCELADO — ${reason}; edad del run ${Math.round(ageMin)}m`);
      }
    } catch (e) { console.error(`  watchdog ${p.name} falló: ${e instanceof Error ? e.message : e}`); }
  }
}

// provisioningYamlFor: la última versión de docs/provisioning.yaml del proyecto desde el brain
// (brain_events kind=artifact, project-wide, versionado — la MISMA fuente que el channel route del
// console y el Studio). null si el diseño aún no la produjo (degrada: gate off).
async function provisioningYamlFor(projectId: string): Promise<string | null> {
  const rows = await rest<Array<{ payload: { content?: string } }>>(
    `/brain_events?project_id=eq.${projectId}&kind=eq.artifact&payload->>path=ilike.*provisioning.yaml&order=ts.desc&limit=1&select=payload`,
  );
  return rows[0]?.payload?.content ?? null;
}

// capabilityGateFor: el readiness gate por capability del proyecto (P6-2b Paso 3). Resuelve las
// capabilities del stack (registry) desde provisioning.yaml y probea qué Actions secret está presente
// en el repo (con el app token, Secrets:read). Sin provisioning / sin capabilities → gate vacío
// (no-op: candidates() se comporta igual que antes). En dry-run (repo null) el probe es fail-open.
async function capabilityGateFor(projectId: string, dstories: DStory[], repo: GithubRepo | null) {
  const empty = { needsByStoryId: new Map<string, string[]>(), green: new Set<string>() };
  const prov = await provisioningYamlFor(projectId);
  if (!prov) return empty;
  const caps = resolveProjectCapabilities(registryDir, prov);
  if (caps.length === 0) return empty;
  return computeCapabilityGate(caps, dstories, (name) => (repo ? repo.secretPresent(name) : Promise.resolve(null)));
}

async function reconcileBuild() {
  if (!app) return; // sin credenciales de la App no hay build
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null; settings: Settings | null }>>(`/projects?select=id,name,org,repo,settings&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;

    // dispatch_mode "manual" = botón-only: la UI (POST /api/projects/[id]/dispatch, F6a) despacha;
    // el worker NO auto-despacha. "auto" = el worker despacha por tick. DEFAULT = "manual" (deuda-chica
    // #3, 2026-07-21): un proyecto sin setting explícito NO dispara agentes pagos solo — el humano toca
    // ▶ en el board. El `auto` ya sorprendió una vez con costo; quien lo quiera lo activa en Settings.
    // La PROYECCIÓN y el AUTO-MERGE no se ven afectados (corren en sus propios reconcilers): en
    // modo manual el worker sigue moviendo review→done y mergeando; solo cede el disparo al humano.
    if ((p.settings?.dispatch_mode ?? "manual") === "manual") continue;

    // Guard docs-on-main (Fase 5): no despachar si el PRD del proyecto no está en `main` (evita
    // arrancar agentes sobre un repo sin el contrato de diseño publicado). Fail-open: un error de
    // red al chequear NO frena el build (docsGuardOk(null) === true).
    let prdOnMain: boolean | null = null;
    try { prdOnMain = await GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo).fileOnRef("docs/PRD.md", "main"); }
    catch (e) { console.warn(`  docs-guard ${p.name}: chequeo falló (${e instanceof Error ? e.message : e}) → fail-open`); }
    if (!docsGuardOk(prdOnMain)) { console.log(`  ⏸ ${p.name}: docs/PRD.md no está en main → no despacho (guard docs-on-main)`); continue; }

    const pol = policyFrom(p.settings ?? {});

    // Stories + sprints del proyecto → el shape que el kernel de despacho (dispatch.ts) espera.
    const rows = await rest<Array<{ id: string; key: string; title: string; lane: string | null; status: string; sprint_id: string | null; blocked_by: string[] | null; external_ref: string | null; body: string | null; acceptance: string | null; screen_key: string | null }>>(
      `/stories?project_id=eq.${p.id}&select=id,key,title,lane,status,sprint_id,blocked_by,external_ref,body,acceptance,screen_key`,
    );
    const dstories: DStory[] = rows.map((r) => ({
      id: r.id, key: r.key, title: r.title, lane: r.lane ?? "", status: r.status,
      sprintId: r.sprint_id, deps: r.blocked_by ?? [], issue: issueNumOf(r.external_ref),
      body: r.body, acceptance: r.acceptance, screenKey: r.screen_key,
    }));
    const sprintRows = await rest<Array<{ id: string; key: string; title: string | null; planned_at: string | null }>>(`/sprints?project_id=eq.${p.id}&select=id,key,title,planned_at`);
    const sprintsById = new Map<string, DSprint>(sprintRows.map((s) => [s.id, { id: s.id, key: s.key, title: s.title ?? "", plannedAt: s.planned_at }]));

    // Pre-check barato: sin candidatos siquiera SIN el gate por capability, no hay nada que gatear →
    // evitá el I/O del gate (brain read + probe de secrets) en los proyectos ociosos de este tick. El
    // gate solo QUITA candidatos, así que un set ungated vacío ya es final.
    if (candidates(dstories, sprintsById, pol).length === 0) continue;

    // Readiness gate por capability (P6-2b Paso 3): una story que referencia el secret de una
    // capability (ej. $FIREBASE_SERVICE_ACCOUNT) NO se auto-despacha hasta que su Actions secret esté
    // 🟢. El estado 🟢 es network → se resuelve acá (probe con el app token) y entra al kernel como
    // green set + needs por-story. El repo se construye ACÁ (antes que candidates) para poder probear.
    const byId = new Map(dstories.map((s) => [s.id, s]));
    let repo: GithubRepo | null = null;
    if (!dryRun) repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
    // Gate del CANAL de build: no auto-despachar si falta el secret CLAUDE_CODE_OAUTH_TOKEN en el repo —
    // la Action arrancaría y fallaría, y con la degradación agent:failed→backlog re-despacharía en LOOP.
    // Fail-open ante null (no se pudo chequear) o dry-run (repo null).
    if (repo && (await repo.secretPresent(CHANNEL_SECRET)) === false) {
      console.log(`  ⏸ ${p.name}: falta el secret ${CHANNEL_SECRET} en el repo → no auto-despacho (canal no listo)`);
      continue;
    }
    const gate = await capabilityGateFor(p.id, dstories, repo);
    for (const s of dstories) { const needs = gate.needsByStoryId.get(s.id); if (needs) s.needsCapabilities = needs; }

    const cands = candidates(dstories, sprintsById, pol, gate.green);
    if (cands.length === 0) continue; // todo lo despachable quedó gateado por una capability aún ⚪

    // Slots: cuántas stories running podemos SUMAR este tick (una unidad sprint puede pasarse del
    // cupo, como en v1 — pero ninguna unidad nueva arranca una vez alcanzado). 0 = ilimitado.
    const inFlight = dstories.filter((s) => s.status === "running").length;
    let slots = pol.maxConcurrency > 0 ? Math.max(0, pol.maxConcurrency - inFlight) : Infinity;
    if (slots <= 0) continue;

    for (const c of cands) {
      if (slots <= 0) break;
      const members = c.stories.map((id) => byId.get(id)!).filter(Boolean);
      if (members.length === 0) continue;
      const prompt = c.kind === "sprint" ? sprintPrompt(c.title, members) : storyPrompt(members[0]);
      const issuesCsv = c.issues.join(",");

      // Canal por lane: hoy solo claude_action está cableado en v2 (copilot = permiso pendiente en
      // el cliente). Respetamos el setting: si pide copilot, se avisa y se omite (no se finge).
      if (c.channel !== "claude_action") {
        console.log(`  ⚠ ${p.name}/${c.id}: canal "${c.channel}" no implementado aún en v2 (solo claude_action) — omitido`);
        continue;
      }
      if (dryRun) {
        console.log(`[dry] build ${pol.executionUnit}: ${p.name}/${c.title} → issues ${issuesCsv} (${members.length} story/s)`);
        slots -= members.length; continue;
      }

      // Marcá running ANTES de disparar: la unidad sale del set despachable de inmediato → nunca un
      // doble-dispatch (doble run pago). Bypass del state machine (backlog→running directo, como v1
      // SyncExternalStatus); limpia agent_lost al re-despachar. Si el DISPARO falla, se revierte.
      try {
        for (const m of members) await projectExternalStatus(m.id, "running");
        await repo!.dispatchWorkflow("claude.yml", { prompt, issues: issuesCsv });
      } catch (e) {
        console.error(`  build ${p.name}/${c.id} falló al disparar: ${e instanceof Error ? e.message : e} — revirtiendo a backlog`);
        for (const m of members) { try { await projectExternalStatus(m.id, "backlog"); } catch { /* best-effort */ } }
        continue;
      }
      // PUNTO DE NO RETORNO: el run YA se disparó (money-critical). Nada de acá en adelante puede
      // revertir a backlog — hacerlo re-despacharía y pagaría un segundo run. session_url es
      // best-effort: un fallo se loguea pero NO toca el estado.
      console.log(`▶ build ${pol.executionUnit}: ${p.name}/${c.title} despachado (issues ${issuesCsv})`);
      slots -= members.length;
      const sessionUrl = `${repo!.htmlUrl}/actions/workflows/claude.yml`;
      for (const m of members) {
        try { await rest(`/stories?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ session_url: sessionUrl }) }); }
        catch (e) { console.error(`  session_url ${m.key}: ${e instanceof Error ? e.message : e}`); }
      }
    }
  }
}

async function tick() {
  try { await reconcileDesign(); } catch (e) { console.error("reconcileDesign:", e instanceof Error ? e.message : e); }
  try { await reconcileIncrements(); } catch (e) { console.error("reconcileIncrements:", e instanceof Error ? e.message : e); }
  try { await reconcileCeremonies(); } catch (e) { console.error("reconcileCeremonies:", e instanceof Error ? e.message : e); }
  if (!noBuild) {
    // Orden del conductor de v1: PROYECTAR (GitHub = verdad) → APROBAR (auto_if_safe) → AUTO-MERGE
    // (gated) → DESPACHAR. Aprobar antes de mergear: destraba el CI para que los checks corran y el
    // auto-merge los vea CLEAN en el próximo tick.
    try { await reconcileProjection(); } catch (e) { console.error("reconcileProjection:", e instanceof Error ? e.message : e); }
    try { await reconcileWatchdog(); } catch (e) { console.error("reconcileWatchdog:", e instanceof Error ? e.message : e); }
    try { await reconcileCosts(); } catch (e) { console.error("reconcileCosts:", e instanceof Error ? e.message : e); }
    try { await reconcileOrphanCosts(); } catch (e) { console.error("reconcileOrphanCosts:", e instanceof Error ? e.message : e); }
    try { await reconcileApprovals(); } catch (e) { console.error("reconcileApprovals:", e instanceof Error ? e.message : e); }
    try { await reconcileAutoMerge(); } catch (e) { console.error("reconcileAutoMerge:", e instanceof Error ? e.message : e); }
    try { await reconcileBuild(); } catch (e) { console.error("reconcileBuild:", e instanceof Error ? e.message : e); }
  }
}

// Preflight de schema (deuda-chica 🔴 2026-07-20): el drift local↔prod (una migración aplicada a un
// entorno pero no al otro) mató el worker DOS veces a mitad de run — 42P01 (increment_requests) y
// PGRST204 (design_phases.cache_read_tokens) — y en un caso abortó un iteration-planner grande YA
// PAGADO (el PATCH de costos falló al escribir). Chequeá al ARRANCAR que el schema esperado existe;
// si falta algo, fallá rápido con un mensaje accionable en vez de un 400 a mitad de un run pago.
const SCHEMA_PROBES: Array<{ table: string; column: string; migration: string }> = [
  { table: "increment_requests", column: "id", migration: "20260719140000_increment_requests.sql" },
  { table: "design_phases", column: "cache_read_tokens", migration: "20260719120000_design_phase_costs.sql" },
  { table: "run_costs", column: "estimated", migration: "20260724120000_run_costs_estimated.sql" },
];
async function preflightSchema(): Promise<void> {
  const missing: string[] = [];
  for (const p of SCHEMA_PROBES) {
    try {
      const res = await fetch(`${base}/${p.table}?select=${p.column}&limit=0`, { headers: svc });
      if (!res.ok) missing.push(`  · ${p.table}.${p.column} (migración ${p.migration}) → ${res.status} ${(await res.text()).slice(0, 140)}`);
    } catch (e) {
      missing.push(`  · ${p.table}.${p.column} (migración ${p.migration}) → ${e instanceof Error ? e.message : e}`);
    }
  }
  if (missing.length) {
    console.error(
      `✖ schema drift — el worker espera tablas/columnas que NO existen en ${url}:\n${missing.join("\n")}\n` +
      `→ aplicá las migraciones faltantes a ESTE entorno (supabase db push, o las de supabase/migrations/) antes de arrancar.`,
    );
    process.exit(1);
  }
}

await preflightSchema();
console.log(`⚙  worker Fluxo · tick ${intervalMs / 1000}s · workflow=${workflow} · build=${!noBuild && !!app ? "on" : "off"}${dryRun ? " · DRY-RUN" : ""}`);
tokenByOrg.clear();
await tick();
setInterval(() => { tokenByOrg.clear(); void tick(); }, intervalMs);

// ── AI Assistant (P5-1) · HTTP endpoint interno ──────────────────────────────────
// El console PROXEA acá (red interna del compose). Corre el agent-loop con el token de suscripción
// en el ambiente PROBADO del worker (no el alpine/root del console). v1 read-only.
async function buildStateSummary(projectId: string): Promise<{ name: string; summary: string } | null> {
  const [proj] = await rest<Array<{ name: string; repo: string | null }>>(`/projects?id=eq.${projectId}&select=name,repo`);
  if (!proj) return null;
  const [sprints, stories, costs, phases, incs, runs] = await Promise.all([
    rest<Array<{ key: string; title: string }>>(`/sprints?project_id=eq.${projectId}&select=key,title&order=position`),
    rest<Array<{ key: string; title: string; status: string; lane: string | null; pr_url: string | null }>>(`/stories?project_id=eq.${projectId}&select=key,title,status,lane,pr_url&order=key`),
    rest<Array<{ usd: number; issues: string | null }>>(`/run_costs?project_id=eq.${projectId}&select=usd,issues`),
    rest<Array<{ phase_id: string; status: string; usd: number | null }>>(`/design_phases?project_id=eq.${projectId}&select=phase_id,status,usd&order=ord`),
    rest<Array<{ instructions: string; status: string }>>(`/increment_requests?project_id=eq.${projectId}&select=instructions,status&order=created_at.desc&limit=5`),
    rest<Array<{ status: string; workflow: string; error: string | null; error_kind: string | null }>>(`/design_runs?project_id=eq.${projectId}&select=status,workflow,error,error_kind&order=created_at.desc&limit=1`),
  ]);
  const byStatus = (s: string) => stories.filter((x) => x.status === s).length;
  const buildUsd = costs.reduce((a, c) => a + (c.usd ?? 0), 0);
  const designUsd = phases.reduce((a, p) => a + (p.usd ?? 0), 0);
  const run = runs[0];
  // El "por qué" de un diseño cortado (Addendum): el assistant lo usa para explicar y proponer resume.
  const runLine = !run
    ? "Último design-run: — (ninguno)"
    : run.status === "failed"
      ? `Último design-run: FAILED (${run.workflow}${run.error_kind ? `, ${run.error_kind}` : ""})${run.error ? ` — ${run.error.slice(0, 300)}` : ""}`
      : `Último design-run: ${run.status} (${run.workflow})`;
  const lines = [
    `Proyecto: ${proj.name}${proj.repo ? ` · repo ${proj.repo}` : " · (sin repo aún)"}`,
    `Costo total: $${(buildUsd + designUsd).toFixed(2)} (build $${buildUsd.toFixed(2)}, diseño $${designUsd.toFixed(2)})`,
    runLine,
    `Diseño: ${phases.length} fases (${phases.filter((p) => p.status === "done").length} done)`,
    `Sprints: ${sprints.map((s) => `${s.key} ${s.title}`).join(" · ") || "—"}`,
    `Stories: ${stories.length} total — backlog ${byStatus("backlog")}, running ${byStatus("running")}, review ${byStatus("review")}, done ${byStatus("done")}`,
    `Stories detalle:`,
    ...stories.map((s) => `  - ${s.key} [${s.status}${s.lane ? `·${s.lane}` : ""}] ${s.title}${s.pr_url ? ` (PR: ${s.pr_url})` : ""}`),
    incs.length ? `Pedidos de incremento: ${incs.map((i) => `[${i.status}] ${i.instructions.slice(0, 80)}`).join(" · ")}` : "Pedidos de incremento: ninguno",
  ];
  return { name: proj.name, summary: lines.join("\n") };
}

const assistantPort = Number(arg("http-port") ?? process.env.WORKER_HTTP_PORT ?? 0);
if (assistantPort > 0) {
  createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/assistant") { res.statusCode = 404; res.end("not found"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 200_000) req.destroy(); });
    req.on("end", async () => {
      // Pieza 2: streaming SSE si el cliente lo pide (Accept: text/event-stream); si no, JSON (fallback).
      const wantsSse = (req.headers.accept ?? "").includes("text/event-stream");
      try {
        const { projectId, messages } = JSON.parse(body) as { projectId: string; messages: ChatMsg[] };
        if (!projectId || !Array.isArray(messages)) { res.statusCode = 400; res.end(JSON.stringify({ error: "projectId + messages requeridos" })); return; }
        const st = await buildStateSummary(projectId);
        if (!st) { res.statusCode = 404; res.end(JSON.stringify({ error: "proyecto no encontrado" })); return; }

        // Pieza 3: tools READ scopeadas a ESTE proyecto (backlog/story/sprints/doc del brain). El bot
        // lee lo que necesita; las mutaciones siguen confirmables en la UI (nada ejecuta acá).
        const tools = buildAssistantTools({ projectId, rest });
        const withTools = { mcpServers: { fluxo: tools }, allowedTools: ASSISTANT_TOOL_IDS, maxTurns: 6 };

        if (!wantsSse) {
          const text = await runAssistant({ stateSummary: st.summary, messages: messages.slice(-12), ...withTools });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ text }));
          return;
        }

        // SSE: por cada delta `data: {"delta":…}`; al cerrar `data: {"done":true,"text":…}` (el texto
        // completo va acá para que el cliente parsee el bloque fluxo-action sobre la respuesta entera).
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        const text = await runAssistant({
          stateSummary: st.summary,
          messages: messages.slice(-12),
          ...withTools,
          onDelta: (delta) => res.write(sseEvent({ delta })),
        });
        res.write(sseEvent({ done: true, text }));
        res.end();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (wantsSse && res.headersSent) { res.write(sseEvent({ error: msg })); res.end(); return; }
        res.statusCode = 500;
        res.end(JSON.stringify({ error: msg }));
      }
    });
  }).listen(assistantPort, () => console.log(`  🤖 assistant http en :${assistantPort} (POST /assistant)`));
}
