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
import { runDesign, resumeStartIndex, type ResumeState } from "./engine.ts";
import { autoResolver } from "./autonomy.ts";
import { recordOutput, type StepContext } from "./resolve.ts";
import { makeSdkRunner } from "./sdkRunner.ts";
import { SupabaseDesignStore, classifyRunError } from "./supabase.ts";
import { type GithubTarget } from "./handoff.ts";
import { makeEffectExecutor } from "./effects.ts";
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
// --sprint=<key>: corre una ceremonia (sprint-planning/review/retro) sobre ESE sprint. Cambia el
// trigger (sprint_id/goal/backlog_snapshot/plan) en vez del de diseño (instructions).
const sprintArg = args.find((a) => a.startsWith("--sprint="))?.split("=")[1];

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
const pres = await fetch(`${base}/projects?id=eq.${projectId}&select=tenant_id,name,description,org,owner_id,repo,settings`, {
  headers: svcHeaders,
});
if (!pres.ok) {
  console.error(`no pude leer el proyecto: ${pres.status} ${await pres.text()}`);
  process.exit(1);
}
const [project] = (await pres.json()) as Array<{ tenant_id: string; name: string; description: string | null; org: string | null; owner_id: string | null; repo: string | null; settings: { gate_autonomy?: "manual" | "auto_if_safe"; stack?: string } | null }>;

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

// 2b) El TRIGGER del run. Ceremonia (--sprint): sprint_id(key)/goal/backlog_snapshot/plan doc —
//     lo que los pasos de sprint-planning/review/retro referencian. Diseño/iterate: instructions.
let trigger: Record<string, unknown>;
if (sprintArg) {
  const [sres, stres] = await Promise.all([
    fetch(`${base}/sprints?project_id=eq.${projectId}&select=id,key,goal,position&order=position`, { headers: svcHeaders }),
    fetch(`${base}/stories?project_id=eq.${projectId}&select=id,key,title,status,sprint_id,lane,kind,screen_key,blocked_by,pr_url,agent_lost`, { headers: svcHeaders }),
  ]);
  const sprintRows = (await sres.json()) as Array<{ id: string; key: string; goal: string | null; position: number | null }>;
  const storyRows = (await stres.json()) as Array<{ id: string; key: string; title: string | null; status: string; sprint_id: string | null; lane: string | null; kind: string | null; screen_key: string | null; blocked_by: string[] | null; pr_url: string | null; agent_lost: string | null }>;
  const sprintIdToKey = new Map(sprintRows.map((r) => [r.id, r.key]));
  const storyIdToKey = new Map(storyRows.map((r) => [r.id, r.key]));
  const snapshot = storyRows.map((r) => ({
    id: r.key, title: r.title ?? r.key, status: r.status,
    sprint: r.sprint_id ? sprintIdToKey.get(r.sprint_id) ?? null : null,
    owner: r.lane ?? null, kind: r.kind ?? null, screen_key: r.screen_key ?? null,
    deps: (r.blocked_by ?? []).map((id) => storyIdToKey.get(id)).filter((k): k is string => !!k),
  }));
  const goal = sprintRows.find((r) => r.key === sprintArg)?.goal ?? "";
  // telemetry (para la retro): el desenlace de las stories DE ESTE sprint — qué falló/reintentó, por
  // lane — señal para que el retro-analyst encuentre causas-en-el-método. v1 a nivel story.
  const curSprintId = sprintRows.find((r) => r.key === sprintArg)?.id;
  const telemetry = storyRows
    .filter((r) => r.sprint_id === curSprintId)
    .map((r) => ({ key: r.key, status: r.status, lane: r.lane ?? null, kind: r.kind ?? null, agent_lost: r.agent_lost ?? null, pr_url: r.pr_url ?? null }));
  // next_sprint: a dónde el reject-path de review appendea las correcciones. El sprint siguiente por
  // posición; si el revisado es el último, incrementá el número de su key (el corrections agent lo
  // crea vía su bloque sprints: si no existe). sprintRows ya viene ordenado por position.
  const curIdx = sprintRows.findIndex((r) => r.key === sprintArg);
  const bumpKey = (k: string) => { const m = k.match(/^(.*?)(\d+)$/); return m ? `${m[1]}${Number(m[2]) + 1}` : `${k}-2`; };
  const nextSprint = curIdx >= 0 && sprintRows[curIdx + 1] ? sprintRows[curIdx + 1].key : bumpKey(sprintArg);
  trigger = {
    project_id: projectId, sprint_id: sprintArg, sprint_goal: goal, next_sprint: nextSprint,
    repo: project.repo ?? "",
    backlog_snapshot: JSON.stringify(snapshot),
    telemetry: JSON.stringify(telemetry),
    plan: `docs/PLAN-${sprintArg}.md`,
    review: `docs/REVIEW-${sprintArg}.md`, corrections: `docs/CORRECTIONS-${sprintArg}.md`,
    retro: `docs/RETRO-${sprintArg}.md`,
  };
} else {
  // stack: la elección del humano (settings.stack) o "auto" si no eligió → llega a los agentes de
  // diseño (principles/architect vía $trigger.stack en design.yaml). Un stack concreto ANCLA el
  // diseño; "auto" deja que el architect elija de la lista cerrada — nunca inventa uno inexistente.
  const stack = typeof project.settings?.stack === "string" && project.settings.stack.trim()
    ? project.settings.stack.trim() : "auto";
  trigger = { instructions: idea, project_id: projectId, repo: "", stack };
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
  resumeState = await buildResumeState(store, wf, workdir, trigger);
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
// full=true salvo iterate: solo un re-handoff completo (design) puede ENCOGER el backlog y dejar
// huérfanos; el iterate publica un DELTA aditivo (marcarlo full archivaría todo lo no-delta).
const handoff = makeEffectExecutor(store, workdir, { github, full: workflowId !== "iterate", repo: project.repo ?? undefined, registryDir });
// Fase 4 · autonomía: en modo auto_if_safe, los gates seguros (sin preguntas abiertas, y que no sean
// review/retro) se auto-aprueban → el ciclo corre sin humano donde el riesgo es bajo. Campo DEDICADO
// `gate_autonomy` (NO se reusa workflow_approval, que es la autonomía del build/CI — son decisiones
// distintas y no deben acoplarse). El resolver humano queda intacto para todo lo demás.
const gateMode = project.settings?.gate_autonomy === "auto_if_safe" ? "auto_if_safe" : "off";
const resolver = autoResolver(store.resolver, {
  mode: gateMode, workflowId,
  // El registro es SECUNDARIO: un blip de Supabase no debe abortar el run autónomo (best-effort).
  onAuto: async (req) => {
    try { await store.recordAutoGate(req); }
    catch (e) { console.error(`gate auto-aprobado pero el registro falló (secundario, se ignora): ${e instanceof Error ? e.message : e}`); }
  },
});
if (gateMode === "auto_if_safe") console.log(`⚡ autonomía ON: los gates seguros de ${workflowId} se auto-aprueban (review y retro siempre humanas)`);
try {
  const res = await runDesign(
    wf,
    trigger,
    { runner, resolver, sink: store.sink, handoff },
    resumeState,
  );
  clearInterval(heartbeat);
  await store.setRunStatus(res.status);
  console.log(`\n✓ design run ${runId} terminó: ${res.status}`);
  for (const [phase, n] of Object.entries(res.phaseRuns)) console.log(`  ${phase}: ${n} corrida(s)`);
} catch (err) {
  clearInterval(heartbeat);
  // Persistir el PORQUÉ (antes se perdía en stdout): mensaje + si fue transitorio (blip de infra que
  // agotó reintentos → reanudable) o fatal. buildStateSummary/get_run_status lo leen para explicar.
  const msg = err instanceof Error ? err.message : String(err);
  const kind = classifyRunError(msg);
  await store.setRunStatus("failed", { error: msg, kind });
  console.error(`\n✗ design run ${runId} falló (${kind}):`, msg);
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

  const startIndex = resumeStartIndex(wf.steps, doneP, approvedGates);
  return { ctx, phaseRuns, startIndex };
}
