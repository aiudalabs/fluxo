// F5-P2 · El worker del motor de diseño: dado un project_id, corre el workflow `design`
// de punta a punta con el Agent SDK real (workdir-harvest) sobre los ports de Supabase.
// Las fases se llenan EN VIVO en el Studio (running→done, docs cosechados), y cada gate
// CONGELA el run hasta que el humano lo resuelve en el Studio (approve/revise/answer).
//
// Uso:  set -a; source .env; set +a
//       node --experimental-strip-types design/src/main.ts <project_id> ["idea override"]
//
// Envs: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY
//       (para leer el proyecto → tenant + idea) y CLAUDE_CODE_OAUTH_TOKEN (el Agent SDK).

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadWorkflow, designPhases, declaredOutputs, type Workflow } from "./workflow.ts";
import { runDesign, type ResumeState } from "./engine.ts";
import { recordOutput, type StepContext } from "./resolve.ts";
import { makeSdkRunner } from "./sdkRunner.ts";
import { SupabaseDesignStore } from "./supabase.ts";
import { makeHandoff, type GithubTarget } from "./handoff.ts";
import { GithubApp } from "./github.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry");

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const projectId = process.argv[2];
const args = process.argv.slice(3);
const wfArg = args.find((a) => a.startsWith("--workflow="));
let workflowId = wfArg ? wfArg.split("=")[1] : "design"; // demo-design = lean (3 fases)
const ideaOverride = args.find((a) => !a.startsWith("--"));
// --resume=<runId>: re-adopt un run CAÍDO (crash-resume, Opción B) en vez de crear uno nuevo.
// El worker lo pasa cuando detecta un run huérfano (status no terminal, sin proceso vivo).
const resumeRunId = args.find((a) => a.startsWith("--resume="))?.split("=")[1];

if (!url || !anonKey || !jwtSecret || !serviceKey) {
  console.error("need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY (source .env)");
  process.exit(1);
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set (source .env)");
  process.exit(1);
}
if (!projectId) {
  console.error("usage: main.ts <project_id> [\"idea override\"]");
  process.exit(1);
}

// 1) Leer el proyecto con service_role (el worker es backend/confiable) → tenant + idea.
const base = url.replace(/\/$/, "") + "/rest/v1";
const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const pres = await fetch(`${base}/projects?id=eq.${projectId}&select=tenant_id,name,description,org,owner_id`, {
  headers: svcHeaders,
});
if (!pres.ok) {
  console.error(`no pude leer el proyecto: ${pres.status} ${await pres.text()}`);
  process.exit(1);
}
const [project] = (await pres.json()) as Array<{ tenant_id: string; name: string; description: string | null; org: string | null; owner_id: string | null }>;

// Token OAuth del dueño (para crear el repo COMO él — cuenta personal u org). Lo lee por
// owner_id de github_tokens (service_role). Sin él, el handoff cae al installation token.
let ownerToken: string | undefined;
if (project?.owner_id) {
  const tr = await fetch(`${base}/github_tokens?user_id=eq.${project.owner_id}&select=access_token`, { headers: svcHeaders });
  if (tr.ok) ownerToken = ((await tr.json()) as Array<{ access_token: string }>)[0]?.access_token;
}
if (!project) {
  console.error(`proyecto ${projectId} no existe`);
  process.exit(1);
}
const idea = ideaOverride ?? project.description ?? project.name;

// 2) Store primero (mintea su propio tenant JWT → RLS real, sin service_role). En un resume
//    leemos el run para usar SU workflow (el del run caído), no el default del worker.
const store = new SupabaseDesignStore({ url, anonKey, jwtSecret, tenant: project.tenant_id, project: projectId });
if (resumeRunId) {
  const run = await store.loadRun(resumeRunId);
  if (!run) { console.error(`resume: el run ${resumeRunId} no existe`); process.exit(1); }
  if (run.status === "done" || run.status === "failed") { console.log(`resume: el run ${resumeRunId} ya está ${run.status} — nada que reanudar`); process.exit(0); }
  workflowId = run.workflow;
}

// 3) Cargar el workflow + sembrar las fases (todas las de tipo design, en orden).
const wf = loadWorkflow(registryDir, workflowId);
const phaseSeeds = designPhases(wf).map((p, i) => ({ phase_id: p.id, label: p.label, ord: i }));
const workdir = mkdtempSync(join(tmpdir(), "fluxo-design-"));
const runner = makeSdkRunner(registryDir, workdir);

// 4) Fresh → createRun (inserta run + fases). Resume → adoptRun + re-hidratar ctx/workdir
//    desde el estado durable (design_phases.artifacts) y calcular dónde reanudar (Opción B).
let runId: string;
let resumeState: ResumeState | undefined;
if (resumeRunId) {
  store.adoptRun(resumeRunId);
  runId = resumeRunId;
  resumeState = await buildResumeState(store, wf, workdir, { instructions: idea, project_id: projectId, repo: "" });
  console.log(`↻ resume run ${runId}: ${Object.keys(resumeState.phaseRuns).length} fase(s) done, reanudo en step #${resumeState.startIndex}`);
} else {
  runId = await store.createRun(workflowId, phaseSeeds);
  // P5-2 · iterate: sembrá el workdir con los docs de diseño YA producidos (PRD/arquitectura/backlog)
  // para que el iteration-planner los lea y emita un DELTA (no re-genere de cero). Un design fresco
  // arranca con workdir vacío (los agentes crean los docs); iterate necesita el estado existente.
  if (workflowId === "iterate") {
    const docs = await store.loadProjectDocs();
    for (const a of docs) {
      const abs = join(workdir, a.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content);
    }
    console.log(`  ↪ iterate: workdir sembrado con ${docs.length} doc(s) del diseño existente`);
  }
}

// Heartbeat/lease (Opción B): renueva heartbeat_at cada 30s mientras este proceso vive, para
// que el worker NO re-adopte este run como huérfano. unref → no impide que el proceso termine.
const heartbeat = setInterval(() => { void store.heartbeat().catch(() => {}); }, 30_000);
heartbeat.unref?.();

console.log(`▶ design run ${runId} para "${project.name}" (${projectId})`);
console.log(`  tenant ${project.tenant_id} · ${phaseSeeds.length} fases · workdir ${workdir}`);
console.log(`  idea: ${idea.slice(0, 120)}${idea.length > 120 ? "…" : ""}`);
console.log(`  (cada gate CONGELA el run hasta que lo resuelvas en el Studio)`);

// 4) Correr. runDesign camina las fases, cosecha docs al workdir → design_phases, y
//    congela en cada gate hasta que el resolver (poll a design_gates) ve 'resolved'.
// Tramo GitHub del handoff: solo si hay credenciales de la App + org del proyecto. El
// handoff degrada con gracia si falta el permiso Administration (el board igual se publica).
let github: GithubTarget | undefined;
const ghAppId = process.env.GITHUB_APP_ID;
const ghKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const ghKey = process.env.GITHUB_APP_PRIVATE_KEY;
if (ghAppId && (ghKeyPath || ghKey) && project.org) {
  // El scaffold (canal de despacho + harness de verify) se CONSTRUYE en el handoff, cuando el workdir
  // ya tiene los docs (stack + lanes). Acá solo pasamos de dónde salen los templates + el nombre.
  github = {
    app: new GithubApp({ appId: ghAppId, privateKeyPath: ghKeyPath, privateKey: ghKey }),
    org: project.org,
    repoName: project.name,
    description: idea.slice(0, 200),
    registryDir,
    projectName: project.name,
    userToken: ownerToken,
    declaredOutputs: declaredOutputs(wf),
  };
  console.log(`  handoff GitHub: org ${project.org} · repo ${project.name} · owner-token ${ownerToken ? "sí" : "no"}`);
}
const handoff = makeHandoff(store, workdir, github);
try {
  const res = await runDesign(
    wf,
    { instructions: idea, project_id: projectId, repo: "" },
    { runner, resolver: store.resolver, sink: store.sink, handoff },
    resumeState,
  );
  clearInterval(heartbeat);
  await store.setRunStatus(res.status);
  console.log(`\n✓ design run ${runId} terminó: ${res.status}`);
  for (const [phase, n] of Object.entries(res.phaseRuns)) console.log(`  ${phase}: ${n} corrida(s)`);
} catch (err) {
  clearInterval(heartbeat);
  await store.setRunStatus("failed");
  console.error(`\n✗ design run ${runId} falló:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

// buildResumeState re-hidrata un run caído desde Postgres (Opción B): re-materializa los docs
// cosechados de cada fase DONE al workdir (los agentes y el handoff re-leen docs/), siembra el
// ctx con su output, y calcula el step donde reanudar = el primero NO satisfecho (fase no-done,
// gate no-aprobado —pending/ausente—, o el handoff si el run no terminó). En los workflows
// lineales esto cae exactamente en el punto del crash (fase corriendo o gate congelado).
async function buildResumeState(
  store: SupabaseDesignStore,
  wf: Workflow,
  workdir: string,
  trigger: Record<string, unknown>,
): Promise<ResumeState> {
  const [phases, gates] = await Promise.all([store.loadPhases(), store.loadGates()]);
  const doneP = new Set(phases.filter((p) => p.status === "done").map((p) => p.phase_id));
  const approvedGates = new Set(
    gates.filter((g) => g.status === "resolved" && g.outcome === "approve").map((g) => g.gate_id),
  );

  const ctx: StepContext = { trigger };
  const phaseRuns: Record<string, number> = {};
  for (const p of phases) {
    if (p.status !== "done") continue;
    phaseRuns[p.phase_id] = 1;
    for (const a of p.artifacts) {
      const abs = join(workdir, a.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content);
    }
    // El texto exacto del agente no se persiste (solo artifacts); el primer doc aproxima el
    // output para que $<fase>.output.text resuelva no-vacío. Igual los agentes RE-LEEN docs/
    // del workdir (bug #16/D2) — eso es lo que de verdad da el contexto.
    recordOutput(ctx, p.phase_id, p.artifacts[0]?.content ?? "");
  }

  let startIndex = wf.steps.length;
  for (let i = 0; i < wf.steps.length; i++) {
    const s = wf.steps[i];
    if (s.kind === "design") { if (doneP.has(s.id)) continue; startIndex = i; break; }
    if (s.kind === "gate") { if (approvedGates.has(s.id)) continue; startIndex = i; break; }
    if (s.kind === "validate") continue;
    startIndex = i; break; // handoff → reanudar aquí (re-publica; es idempotente)
  }
  return { ctx, phaseRuns, startIndex };
}
