// F5-P7b · El conductor del BUILD: poller que toma stories listas y las despacha al canal
// claude.yml (workflow_dispatch) para que un agente las implemente y abra un PR.
//
// Por tick, por proyecto CON repo:
//   1. readiness: una story `backlog` con TODAS sus deps `done` → `ready`.
//   2. dispatch: cada `ready` (hasta max concurrencia) → workflow_dispatch(claude.yml,
//      {prompt, issues}) y la story pasa a `running`.
// Corre como proceso backend (service_role: lee/escribe cross-tenant, es infra confiable,
// igual que watch.ts). La proyección PR→estado es la próxima tajada (conduct sube a running;
// el claude.yml pone/quita el label agent:running; el board lo lee).
//
// Uso: set -a; source .env; set +a
//      node --experimental-strip-types design/src/conduct.ts [--max=3] [--interval=20] [--dry-run]

import { GithubApp, GithubRepo } from "./github.ts";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ghAppId = process.env.GITHUB_APP_ID;
const ghKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const ghKey = process.env.GITHUB_APP_PRIVATE_KEY;
if (!url || !serviceKey) { console.error("need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (source .env)"); process.exit(1); }
if (!ghAppId || !(ghKeyPath || ghKey)) { console.error("need GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY(_PATH)"); process.exit(1); }

const dryRun = process.argv.includes("--dry-run");
const numArg = (flag: string, def: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${flag}=`));
  return a ? Number(a.split("=")[1]) : def;
};
const MAX = numArg("max", 3);          // stories corriendo en paralelo por proyecto
const intervalMs = numArg("interval", 20) * 1000;

const base = url.replace(/\/$/, "") + "/rest/v1";
const svc = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json", "Content-Type": "application/json" };
const app = new GithubApp({ appId: ghAppId, privateKeyPath: ghKeyPath, privateKey: ghKey });
const tokenByOrg = new Map<string, string>(); // cache del installation token por org (por tick)

interface Story {
  key: string; status: string; blocked_by: string[]; external_ref: string | null;
  title: string; body: string | null; acceptance: string | null; sprint_id: string | null;
}
interface Project { id: string; name: string; org: string | null; repo: string | null; }

// El prompt que recibe claude-code-action: implementá el issue, con el contexto del repo.
function buildPrompt(p: Project, s: Story, issueNum: number): string {
  return [
    `Implementá el issue #${issueNum} de este repo: "${s.title}".`,
    s.body ? `\n${s.body}` : "",
    s.acceptance ? `\n## Criterios de aceptación\n${s.acceptance}` : "",
    `\nLeé los docs de diseño en docs/ (BRIEF.md, PRD.md, backlog.yaml) para el contexto del producto.`,
    `Implementá SOLO lo que pide este issue, con tests. Abrí un PR con el cambio y en la descripción poné "Closes #${issueNum}".`,
  ].join("\n");
}
const issueNumOf = (ref: string | null): number | null => {
  const m = ref?.match(/#(\d+)$/);
  return m ? Number(m[1]) : null;
};

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers: svc });
  if (!res.ok) throw new Error(`supabase ${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function tick() {
  tokenByOrg.clear();
  const projects = await rest<Project[]>(`/projects?select=id,name,org,repo&repo=not.is.null`);
  for (const p of projects) {
    if (!p.repo || !p.org) continue;
    const stories = await rest<Story[]>(`/stories?project_id=eq.${p.id}&select=key,status,blocked_by,external_ref,title,body,acceptance,sprint_id`);
    const doneIds = new Set(stories.filter((s) => s.status === "done").map((s) => s.key));
    const idByUuid = new Map<string, string>(); // blocked_by son uuids; mapeamos a keys via una 2ª query si hiciera falta
    // blocked_by es uuid[]; para saber si una dep está done necesitamos su status por uuid.
    const statusByUuid = new Map<string, string>();
    const uuidRows = await rest<Array<{ id: string; key: string; status: string }>>(`/stories?project_id=eq.${p.id}&select=id,key,status`);
    for (const r of uuidRows) { statusByUuid.set(r.id, r.status); idByUuid.set(r.id, r.key); }

    // 1) readiness: backlog con deps done → ready
    const promoted: string[] = [];
    for (const s of stories) {
      if (s.status !== "backlog") continue;
      const depsDone = (s.blocked_by ?? []).every((u) => statusByUuid.get(u) === "done");
      if (!depsDone) continue;
      if (dryRun) { console.log(`[dry] ${p.name}/${s.key}: backlog→ready`); }
      else { await rest(`/stories?project_id=eq.${p.id}&key=eq.${s.key}`, { method: "PATCH", body: JSON.stringify({ status: "ready" }) }); }
      promoted.push(s.key);
    }

    // 2) dispatch: ready (existentes + recién promovidas) hasta MAX corriendo.
    const running = stories.filter((s) => s.status === "running").length;
    let slots = Math.max(0, MAX - running);
    const readyKeys = new Set([...stories.filter((s) => s.status === "ready").map((s) => s.key), ...promoted]);
    if (slots === 0 || readyKeys.size === 0) continue;

    let repo: GithubRepo | null = null;
    if (!dryRun) {
      let token = tokenByOrg.get(p.org);
      if (!token) { token = await app.installationToken(p.org); tokenByOrg.set(p.org, token); }
      repo = GithubRepo.fromUrl(token, p.repo);
    }
    for (const s of stories) {
      if (slots === 0) break;
      if (!readyKeys.has(s.key)) continue;
      const issueNum = issueNumOf(s.external_ref);
      if (!issueNum) { console.error(`  ${p.name}/${s.key}: sin external_ref/issue — no despacho`); continue; }
      if (dryRun) { console.log(`[dry] ${p.name}/${s.key}: dispatch issue #${issueNum} → running`); slots--; continue; }
      try {
        await repo!.dispatchWorkflow("claude.yml", { prompt: buildPrompt(p, s, issueNum), issues: String(issueNum) });
        await rest(`/stories?project_id=eq.${p.id}&key=eq.${s.key}`, { method: "PATCH", body: JSON.stringify({ status: "running" }) });
        console.log(`▶ ${p.name}/${s.key}: despachado issue #${issueNum} → running`);
        slots--;
      } catch (e) {
        console.error(`  ${p.name}/${s.key}: dispatch falló: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

console.log(`🎛  conductor: poll cada ${intervalMs / 1000}s · max ${MAX}/proyecto${dryRun ? " (DRY-RUN)" : ""}`);
await tick();
setInterval(tick, intervalMs);
