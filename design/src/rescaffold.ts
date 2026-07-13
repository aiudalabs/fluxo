// F-CONDUCTOR-03 · Re-scaffold de un repo YA creado. El handoff scaffoldea los workflows
// (claude.yml + claude-review.yml + suite-integrity.yml) al CREAR el repo; un repo scaffoldeado
// ANTES de que existiera claude-review.yml (ej. nmlemus/idearium) necesita re-aplicarlo. putFile
// es idempotente (reusa el sha si el archivo ya existe), así que correrlo de nuevo es seguro.
//
// Uso:  set -a; source .env; set +a
//       node --experimental-strip-types design/src/rescaffold.ts <project_id> [--dry-run]

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GithubApp, GithubRepo } from "./github.ts";
import { buildScaffold } from "./scaffold.ts";

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
const projects = await (await fetch(`${base}/projects?id=eq.${projectId}&select=name,org,repo`, { headers: svc })).json() as Array<{ name: string; org: string | null; repo: string | null }>;
const p = projects[0];
if (!p) { console.error(`proyecto ${projectId} no encontrado`); process.exit(1); }
if (!p.org || !p.repo) { console.error(`proyecto sin org/repo (org=${p.org} repo=${p.repo})`); process.exit(1); }

const files = buildScaffold(registryDir, { projectName: p.name });
console.log(`re-scaffold ${p.name} → ${p.repo} (${files.length} workflows)${dryRun ? " · DRY-RUN" : ""}`);
if (dryRun) { for (const f of files) console.log(`  [dry] ${f.path} (${f.content.length} bytes)`); process.exit(0); }

const repo = GithubRepo.fromUrl(await app.installationToken(p.org), p.repo);
for (const f of files) {
  await repo.putFile(f.path, f.content, `scaffold: ${f.path}`);
  console.log(`  ✓ ${f.path}`);
}
console.log("listo.");
