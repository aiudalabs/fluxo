// F-CONDUCTOR-03 · SCAFFOLD del build — qué archivos commitea el handoff al repo del cliente.
//
// El repo del cliente necesita: el canal de despacho (claude.yml) + los gates de review/verify que
// hacen creíble "verde = ENTREGADO" (claude-review cross-modelo, suite-integrity, y —lo importante—
// el HARNESS DE VERIFY real: e2e-verify + provisioning-lint + ui-verify + .fluxo/verify/** que
// ejecutan el sistema integrado en vez de leer archivos). El método vive en registry/ (golden rule 1);
// acá solo LEEMOS los templates y sustituimos las {{vars}} — el kernel transporta strings, no interpreta.
//
// Un repo generado = `_common/**` (stack-agnóstico) + `<stack>/**` (el stack lockeado del proyecto).
// buildScaffold camina AMBOS árboles, renderiza cada `.tmpl` (strip de la extensión) y emite {path,
// content} listos para putFile. Los archivos que aún referencian una var que NO pudimos resolver se
// SALTAN y se reportan (nunca shippear un archivo con `{{placeholder}}` a medio-renderizar — es el
// mismo anti-patrón de "stub certificado como éxito" que este sprint ataca, aplicado a lo nuestro).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

// Las vars del contrato de templates (registry/templates/github-native/README.md §Template variables).
// Solo se sustituye una var cuyo valor esté DEFINIDO; una var sin resolver deja el `{{...}}` en el
// archivo → el guard lo detecta y saltea el archivo (honesto, no silencioso).
export interface ScaffoldVars {
  project_name: string;
  stack?: string;
  language?: string;
  lanes?: string;
  design_tokens?: string;
  path_map_backend?: string;
  path_map_frontend?: string;
  validation_commands?: string;
  app_path?: string;
  art_director?: string;
}

const VAR_KEYS: Array<keyof ScaffoldVars> = [
  "project_name", "stack", "language", "lanes", "design_tokens",
  "path_map_backend", "path_map_frontend", "validation_commands", "app_path", "art_director",
];

// substitute: reemplaza {{key}} por su valor SOLO para las vars con valor definido. Deja intactas
// las vars sin resolver (para que el guard las cace) y NUNCA toca `${{ ... }}` (expresiones de GitHub
// Actions — llevan `$` y espacios; nuestras vars son `{{snake_case}}` sin `$`).
export function substitute(content: string, vars: ScaffoldVars): string {
  let out = content;
  for (const k of VAR_KEYS) {
    const v = vars[k];
    if (v === undefined) continue;
    out = out.replace(new RegExp(`(?<!\\$)\\{\\{${k}\\}\\}`, "g"), v);
  }
  return out;
}

// leftoverVars: nuestras vars {{snake_case}} sin resolver (sin `$` delante → no son de GitHub Actions).
export function leftoverVars(content: string): string[] {
  const found = new Set<string>();
  for (const m of content.matchAll(/(?<!\$)\{\{([a-z_]+)\}\}/g)) found.add(m[1]);
  return [...found];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export interface ScaffoldResult {
  files: Array<{ path: string; content: string }>;
  skipped: Array<{ path: string; missing: string[] }>;
}

// buildScaffold: emite `_common/**` + `<stack>/**` renderizados. `<stack>` gana ante una colisión de
// path (más específico). Un archivo con vars sin resolver va a `skipped` (con las vars faltantes), no
// a `files` — el handoff loguea los skips.
export function buildScaffold(registryDir: string, vars: ScaffoldVars): ScaffoldResult {
  const base = resolve(registryDir, "templates", "github-native");
  const byPath = new Map<string, string>(); // repo-path → content (stack pisa a _common)
  const skipped = new Map<string, string[]>();

  const roots = ["_common", vars.stack].filter((r): r is string => !!r);
  for (const root of roots) {
    const dir = resolve(base, root);
    if (!existsSync(dir)) continue;
    for (const abs of walk(dir)) {
      const rel = relative(dir, abs);
      const isTmpl = rel.endsWith(".tmpl");
      const repoPath = isTmpl ? rel.slice(0, -".tmpl".length) : rel;
      const raw = readFileSync(abs, "utf8");
      const content = isTmpl ? substitute(raw, vars) : raw;
      const missing = leftoverVars(content);
      if (missing.length) { skipped.set(repoPath, missing); byPath.delete(repoPath); continue; }
      skipped.delete(repoPath);
      byPath.set(repoPath, content);
    }
  }

  const files = [...byPath.entries()].map(([path, content]) => ({ path, content })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const skips = [...skipped.entries()].map(([path, missing]) => ({ path, missing })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped: skips };
}
