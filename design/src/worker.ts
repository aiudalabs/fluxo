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
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GithubApp, GithubRepo } from "./github.ts";
import { Projector, type MirroredStory } from "./projection.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mainScript = resolve(here, "main.ts");

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
function spawnDesign(projectId: string, name: string, resumeRunId?: string) {
  const tag = resumeRunId ? "↻ resume" : "▶ diseño";
  if (dryRun) { console.log(`[dry] ${tag}: "${name}" (${projectId})${resumeRunId ? ` run ${resumeRunId}` : ` [${workflow}]`}`); return; }
  console.log(`${tag}: "${name}" (${projectId})${resumeRunId ? ` run ${resumeRunId}` : ""}`);
  const argv = ["--experimental-strip-types", mainScript, projectId, `--workflow=${workflow}`];
  if (resumeRunId) argv.push(`--resume=${resumeRunId}`);
  const child = spawn("node", argv, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => { console.log(`  ${resumeRunId ? "resume" : "diseño"} de ${projectId} terminó (code ${code})`); designing.delete(projectId); });
}

// ── 1) Reconcile DISEÑO ─────────────────────────────────────────────────────────
async function reconcileDesign() {
  const [projects, runs, stories] = await Promise.all([
    rest<Array<{ id: string; name: string }>>(`/projects?select=id,name`),
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
    spawnDesign(p.id, p.name);
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
function buildPrompt(title: string, body: string | null, acceptance: string | null, n: number): string {
  return [
    `Implementá el issue #${n} de este repo: "${title}".`,
    body ? `\n${body}` : "",
    acceptance ? `\n## Criterios de aceptación\n${acceptance}` : "",
    `\nLeé los docs de diseño en docs/ para el contexto. Implementá SOLO este issue, con tests. Abrí un PR y poné "Closes #${n}".`,
  ].join("\n");
}
const tokenByOrg = new Map<string, string>();
const repoTokenFor = async (org: string): Promise<string> => {
  let tok = tokenByOrg.get(org);
  if (!tok) { tok = await app!.installationToken(org); tokenByOrg.set(org, tok); }
  return tok;
};

// ── 2a) Reconcile PROYECCIÓN (GitHub = verdad; corre ANTES del despacho) ──────────
// El writer inyectado en el Projector: el RPC project_external_status (bypass del state machine).
const projector = new Projector({
  write: async (storyId, status, prUrl, agentLost) => {
    await rest(`/rpc/project_external_status`, {
      method: "POST",
      body: JSON.stringify({ p_story_id: storyId, p_status: status, p_pr_url: prUrl ?? null, p_agent_lost: agentLost ?? null }),
    });
  },
  log: (m) => console.log(m),
});

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

async function reconcileBuild() {
  if (!app) return; // sin credenciales de la App no hay build
  const projects = await rest<Array<{ id: string; name: string; org: string | null; repo: string | null }>>(`/projects?select=id,name,org,repo&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    const stories = await rest<Array<{ key: string; status: string; blocked_by: string[]; external_ref: string | null; title: string; body: string | null; acceptance: string | null }>>(`/stories?project_id=eq.${p.id}&select=key,status,blocked_by,external_ref,title,body,acceptance`);
    const uuids = await rest<Array<{ id: string; status: string }>>(`/stories?project_id=eq.${p.id}&select=id,status`);
    const statusByUuid = new Map(uuids.map((r) => [r.id, r.status]));
    const promoted: string[] = [];
    for (const s of stories) {
      if (s.status !== "backlog") continue;
      if (!(s.blocked_by ?? []).every((u) => statusByUuid.get(u) === "done")) continue;
      if (!dryRun) await rest(`/stories?project_id=eq.${p.id}&key=eq.${s.key}`, { method: "PATCH", body: JSON.stringify({ status: "ready" }) });
      promoted.push(s.key);
    }
    const running = stories.filter((s) => s.status === "running").length;
    let slots = Math.max(0, MAX - running);
    const readyKeys = new Set([...stories.filter((s) => s.status === "ready").map((s) => s.key), ...promoted]);
    if (slots === 0 || readyKeys.size === 0) continue;
    let repo: GithubRepo | null = null;
    if (!dryRun) repo = GithubRepo.fromUrl(await repoTokenFor(p.org), p.repo);
    for (const s of stories) {
      if (slots === 0) break;
      if (!readyKeys.has(s.key)) continue;
      const n = issueNumOf(s.external_ref);
      if (!n) continue;
      if (dryRun) { console.log(`[dry] build: ${p.name}/${s.key} → issue #${n}`); slots--; continue; }
      try {
        await repo!.dispatchWorkflow("claude.yml", { prompt: buildPrompt(s.title, s.body, s.acceptance, n), issues: String(n) });
        await rest(`/stories?project_id=eq.${p.id}&key=eq.${s.key}`, { method: "PATCH", body: JSON.stringify({ status: "running" }) });
        console.log(`▶ build: ${p.name}/${s.key} despachado issue #${n}`);
        slots--;
      } catch (e) { console.error(`  build ${p.name}/${s.key} falló: ${e instanceof Error ? e.message : e}`); }
    }
  }
}

async function tick() {
  try { await reconcileDesign(); } catch (e) { console.error("reconcileDesign:", e instanceof Error ? e.message : e); }
  if (!noBuild) {
    // Orden del conductor de v1: PROYECTAR (GitHub = verdad) antes de DESPACHAR.
    try { await reconcileProjection(); } catch (e) { console.error("reconcileProjection:", e instanceof Error ? e.message : e); }
    try { await reconcileBuild(); } catch (e) { console.error("reconcileBuild:", e instanceof Error ? e.message : e); }
  }
}

console.log(`⚙  worker Fluxo · tick ${intervalMs / 1000}s · workflow=${workflow} · build=${!noBuild && !!app ? "on" : "off"}${dryRun ? " · DRY-RUN" : ""}`);
tokenByOrg.clear();
await tick();
setInterval(() => { tokenByOrg.clear(); void tick(); }, intervalMs);
