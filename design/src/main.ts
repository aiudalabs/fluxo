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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadWorkflow, designPhases } from "./workflow.ts";
import { runDesign } from "./engine.ts";
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
const workflowId = wfArg ? wfArg.split("=")[1] : "design"; // demo-design = lean (3 fases)
const ideaOverride = args.find((a) => !a.startsWith("--"));

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
const pres = await fetch(`${base}/projects?id=eq.${projectId}&select=tenant_id,name,description,org`, {
  headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
});
if (!pres.ok) {
  console.error(`no pude leer el proyecto: ${pres.status} ${await pres.text()}`);
  process.exit(1);
}
const [project] = (await pres.json()) as Array<{ tenant_id: string; name: string; description: string | null; org: string | null }>;
if (!project) {
  console.error(`proyecto ${projectId} no existe`);
  process.exit(1);
}
const idea = ideaOverride ?? project.description ?? project.name;

// 2) Cargar el workflow + sembrar las fases (todas las de tipo design, en orden).
const wf = loadWorkflow(registryDir, workflowId);
const phaseSeeds = designPhases(wf).map((p, i) => ({ phase_id: p.id, label: p.label, ord: i }));

// 3) Store (mintea su propio tenant JWT → RLS real, sin service_role) + runner (Agent SDK).
const store = new SupabaseDesignStore({ url, anonKey, jwtSecret, tenant: project.tenant_id, project: projectId });
const runId = await store.createRun(workflowId, phaseSeeds);
const workdir = mkdtempSync(join(tmpdir(), "fluxo-design-"));
const runner = makeSdkRunner(registryDir, workdir);

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
  github = {
    app: new GithubApp({ appId: ghAppId, privateKeyPath: ghKeyPath, privateKey: ghKey }),
    org: project.org,
    repoName: project.name,
    description: idea.slice(0, 200),
  };
  console.log(`  handoff GitHub: org ${project.org} · repo ${project.name}`);
}
const handoff = makeHandoff(store, workdir, github);
try {
  const res = await runDesign(
    wf,
    { instructions: idea, project_id: projectId, repo: "" },
    { runner, resolver: store.resolver, sink: store.sink, handoff },
  );
  await store.setRunStatus(res.status);
  console.log(`\n✓ design run ${runId} terminó: ${res.status}`);
  for (const [phase, n] of Object.entries(res.phaseRuns)) console.log(`  ${phase}: ${n} corrida(s)`);
} catch (err) {
  await store.setRunStatus("failed");
  console.error(`\n✗ design run ${runId} falló:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
