// F5-P3 · El trigger automático del diseño: un poller que mira `projects` sin design_run
// y arranca `main.ts <project_id>` para cada uno. Así "crear un proyecto" dispara el
// diseño solo — sin correr el worker a mano.
//
// Corre como proceso Node backend (usa service_role para ver proyectos de todos los
// tenants). Cada diseño se lanza como SUBPROCESO aislado (main.ts) para que un gate
// congelado de un proyecto no bloquee a los demás.
//
// Uso:  set -a; source .env; set +a
//       node --experimental-strip-types design/src/watch.ts [--dry-run] [--interval=15]

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mainScript = resolve(here, "main.ts");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (source .env)");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");
const intervalArg = process.argv.find((a) => a.startsWith("--interval="));
const intervalMs = (intervalArg ? Number(intervalArg.split("=")[1]) : 15) * 1000;
// El workflow que corre cada diseño auto-arrancado; se forwardea a main.ts. Para un demo
// ágil: --workflow=demo-design (3 fases/3 gates) en vez de la design completa (8).
const wfArg = process.argv.find((a) => a.startsWith("--workflow="));

const base = url.replace(/\/$/, "") + "/rest/v1";
const svc = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json" };

// in-flight: project_ids cuyo diseño ya lanzamos en esta corrida (no re-spawnear mientras
// corre; una vez que crea su design_run, la query tampoco lo vuelve a elegir).
const inFlight = new Set<string>();

async function tick() {
  // proyectos sin ningún design_run.
  const [pr, dr] = await Promise.all([
    fetch(`${base}/projects?select=id,name,description`, { headers: svc }),
    fetch(`${base}/design_runs?select=project_id`, { headers: svc }),
  ]);
  if (!pr.ok || !dr.ok) {
    console.error(`poll error: projects ${pr.status} / design_runs ${dr.status}`);
    return;
  }
  const projects = (await pr.json()) as Array<{ id: string; name: string; description: string | null }>;
  const withRun = new Set(((await dr.json()) as Array<{ project_id: string }>).map((r) => r.project_id));

  for (const p of projects) {
    if (withRun.has(p.id) || inFlight.has(p.id)) continue;
    inFlight.add(p.id);
    if (dryRun) {
      console.log(`[dry-run] arrancaría diseño de "${p.name}" (${p.id})`);
      continue;
    }
    console.log(`▶ auto-arranque de diseño: "${p.name}" (${p.id})${wfArg ? ` [${wfArg}]` : ""}`);
    const child = spawn("node", ["--experimental-strip-types", mainScript, p.id, ...(wfArg ? [wfArg] : [])], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      console.log(`  diseño de ${p.id} terminó (code ${code})`);
      // no lo quitamos de inFlight: ya tiene design_run, la query no lo re-elige.
    });
  }
}

console.log(`👁  watch: poll cada ${intervalMs / 1000}s${dryRun ? " (DRY-RUN)" : ""} · service_role`);
await tick();
setInterval(tick, intervalMs);
