// F-CONDUCTOR-03 · Re-scaffold de un repo YA creado. El handoff scaffoldea el canal de despacho +
// el harness de verify (e2e-verify/provisioning-lint/ui-verify + .fluxo/verify/**) al CREAR el repo;
// un repo scaffoldeado ANTES (o con un scaffold viejo) necesita re-aplicarlo. putFile es idempotente
// (reusa el sha si el archivo ya existe), así que correrlo de nuevo es seguro.
//
// A diferencia del handoff (que lee el workdir), acá resolvemos las vars desde la DB: el stack sale del
// artefacto provisioning.yaml de la fase architecture, y las lanes de las stories del proyecto.
//
// Uso:  set -a; source .env; set +a
//       node --experimental-strip-types design/src/rescaffold.ts <project_id> [--dry-run]

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { GithubApp, GithubRepo } from "./github.ts";
import { buildScaffold, type ScaffoldVars } from "./scaffold.ts";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(here, "..", "..", "registry");

const projectId = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!projectId || projectId.startsWith("--")) { console.error("uso: rescaffold.ts <project_id> [--dry-run]"); process.exit(1); }

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (source .env)"); process.exit(1); }

const ghAppId = process.env.GITHUB_APP_ID;
const ghKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const ghKey = process.env.GITHUB_APP_PRIVATE_KEY;
if (!ghAppId || !(ghKeyPath || ghKey)) { console.error("need GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY(_PATH)"); process.exit(1); }
const app = new GithubApp({ appId: ghAppId, privateKeyPath: ghKeyPath, privateKey: ghKey });

const base = url.replace(/\/$/, "") + "/rest/v1";
const svc = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json" };
const get = async <T>(path: string): Promise<T> => (await (await fetch(`${base}${path}`, { headers: svc })).json()) as T;

const projects = await get<Array<{ name: string; org: string | null; repo: string | null }>>(`/projects?id=eq.${projectId}&select=name,org,repo`);
const p = projects[0];
if (!p) { console.error(`proyecto ${projectId} no encontrado`); process.exit(1); }
if (!p.org || !p.repo) { console.error(`proyecto sin org/repo (org=${p.org} repo=${p.repo})`); process.exit(1); }

// stack: del artefacto provisioning.yaml de la fase architecture (§machine-readable del architect).
let stack: string | undefined;
const phases = await get<Array<{ artifacts: Array<{ path: string; content: string }> | null }>>(
  `/design_phases?project_id=eq.${projectId}&phase_id=eq.architecture&select=artifacts`,
);
const prov = (phases[0]?.artifacts ?? []).find((a) => a.path.endsWith("provisioning.yaml"));
if (prov) {
  try { const y = yaml.load(prov.content) as { stack?: string }; if (y?.stack) stack = String(y.stack).trim(); } catch { /* ignora */ }
}

// lanes: de las stories del proyecto (para AGENTS.md/CLAUDE.md cuando el generador de pre-render exista).
const stories = await get<Array<{ lane: string | null }>>(`/stories?project_id=eq.${projectId}&select=lane`);
const laneSet = [...new Set(stories.map((s) => s.lane).filter((l): l is string => !!l && l.trim() !== ""))];

const vars: ScaffoldVars = {
  project_name: p.name, stack, language: "es",
  lanes: laneSet.length ? laneSet.map((l) => `- ${l}`).join("\n") : undefined,
  art_director: "on",
};

const { files, skipped } = buildScaffold(registryDir, vars);
console.log(`re-scaffold ${p.name} → ${p.repo} · stack ${stack ?? "—"} · ${files.length} archivo(s)${dryRun ? " · DRY-RUN" : ""}`);
if (skipped.length) for (const s of skipped) console.log(`  ⚠ omitido ${s.path} → {{${s.missing.join("}} {{")}}}`);
if (dryRun) { for (const f of files) console.log(`  [dry] ${f.path} (${f.content.length} bytes)`); process.exit(0); }

const repo = GithubRepo.fromUrl(await app.installationToken(p.org), p.repo);
for (const f of files) {
  await repo.putFile(f.path, f.content, `scaffold: ${f.path}`);
  console.log(`  ✓ ${f.path}`);
}
console.log("listo.");
