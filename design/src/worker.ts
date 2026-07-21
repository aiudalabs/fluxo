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
import { runAssistant, type ChatMsg } from "./assistant.ts";
import { GithubApp, GithubRepo } from "./github.ts";
import { Projector, type MirroredStory } from "./projection.ts";
import { candidates, storyPrompt, sprintPrompt, docsGuardOk, type Policy, type DStory, type DSprint } from "./dispatch.ts";
import { AutoMerger, prNumFromUrl } from "./automerge.ts";
import { Approver } from "./approve.ts";
import { resolveProjectCapabilities, computeCapabilityGate } from "./capabilities.ts";

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
const rest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${base}${path}`, { ...init, headers: svc });
  if (!res.ok) throw new Error(`supabase ${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
};

const ghAppId = process.env.GITHUB_APP_ID;
const ghKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const ghKey = process.env.GITHUB_APP_PRIVATE_KEY;
const app = ghAppId && (ghKeyPath || ghKey) ? new GithubApp({ appId: ghAppId, privateKeyPath: ghKeyPath, privateKey: ghKey }) : null;

const designing = new Set<string>(); // proyectos con un main.ts que lanzamos y sigue vivo
const STALE_MS = 90_000; // heartbeat vencido → el run está huérfano (proceso muerto)

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
    rest<Array<{ id: string; project_id: string; status: string; heartbeat_at: string | null }>>(`/design_runs?select=id,project_id,status,heartbeat_at`),
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
    modelByLane, channelByLane,
  };
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
    const sprintRows = await rest<Array<{ id: string; key: string; title: string | null }>>(`/sprints?project_id=eq.${p.id}&select=id,key,title`);
    const sprintsById = new Map<string, DSprint>(sprintRows.map((s) => [s.id, { id: s.id, key: s.key, title: s.title ?? "" }]));

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
  if (!noBuild) {
    // Orden del conductor de v1: PROYECTAR (GitHub = verdad) → APROBAR (auto_if_safe) → AUTO-MERGE
    // (gated) → DESPACHAR. Aprobar antes de mergear: destraba el CI para que los checks corran y el
    // auto-merge los vea CLEAN en el próximo tick.
    try { await reconcileProjection(); } catch (e) { console.error("reconcileProjection:", e instanceof Error ? e.message : e); }
    try { await reconcileCosts(); } catch (e) { console.error("reconcileCosts:", e instanceof Error ? e.message : e); }
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
  const [sprints, stories, costs, phases, incs] = await Promise.all([
    rest<Array<{ key: string; title: string }>>(`/sprints?project_id=eq.${projectId}&select=key,title&order=position`),
    rest<Array<{ key: string; title: string; status: string; lane: string | null; pr_url: string | null }>>(`/stories?project_id=eq.${projectId}&select=key,title,status,lane,pr_url&order=key`),
    rest<Array<{ usd: number; issues: string | null }>>(`/run_costs?project_id=eq.${projectId}&select=usd,issues`),
    rest<Array<{ phase_id: string; status: string; usd: number | null }>>(`/design_phases?project_id=eq.${projectId}&select=phase_id,status,usd&order=ord`),
    rest<Array<{ instructions: string; status: string }>>(`/increment_requests?project_id=eq.${projectId}&select=instructions,status&order=created_at.desc&limit=5`),
  ]);
  const byStatus = (s: string) => stories.filter((x) => x.status === s).length;
  const buildUsd = costs.reduce((a, c) => a + (c.usd ?? 0), 0);
  const designUsd = phases.reduce((a, p) => a + (p.usd ?? 0), 0);
  const lines = [
    `Proyecto: ${proj.name}${proj.repo ? ` · repo ${proj.repo}` : " · (sin repo aún)"}`,
    `Costo total: $${(buildUsd + designUsd).toFixed(2)} (build $${buildUsd.toFixed(2)}, diseño $${designUsd.toFixed(2)})`,
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
      try {
        const { projectId, messages } = JSON.parse(body) as { projectId: string; messages: ChatMsg[] };
        if (!projectId || !Array.isArray(messages)) { res.statusCode = 400; res.end(JSON.stringify({ error: "projectId + messages requeridos" })); return; }
        const st = await buildStateSummary(projectId);
        if (!st) { res.statusCode = 404; res.end(JSON.stringify({ error: "proyecto no encontrado" })); return; }
        const text = await runAssistant({ stateSummary: st.summary, messages: messages.slice(-12) });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ text }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
  }).listen(assistantPort, () => console.log(`  🤖 assistant http en :${assistantPort} (POST /assistant)`));
}
