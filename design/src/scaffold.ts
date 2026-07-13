// F-CONDUCTOR-03 · SCAFFOLD del build — qué workflows commitea el handoff al repo del cliente.
// El conductor necesita en cada repo: el canal de despacho (claude.yml) Y los gates de review que
// en Fase 4 habilitan el auto-merge (claude-review.yml cross-modelo + suite-integrity.yml). El
// método vive en registry/ (golden rule 1); acá solo LEEMOS los templates y sustituimos las vars,
// para que main.ts quede fino y esto sea testeable sin GitHub.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Los workflows del scaffold, en orden. `subst: true` = pasa por la sustitución de {{vars}}.
const WORKFLOWS: Array<{ file: string; subst: boolean }> = [
  { file: "claude.yml", subst: false },          // canal de despacho (workflow_dispatch)
  { file: "claude-review.yml", subst: true },    // reviewer cross-modelo (gate del auto-merge, F4)
  { file: "suite-integrity.yml", subst: false }, // piso de tests (check CLEAN para el auto-merge, F4)
];

export interface ScaffoldVars {
  projectName: string;
}

// substitute: reemplaza {{project_name}} (única var por ahora). Explícito, sin motor de templates.
export function substitute(content: string, vars: ScaffoldVars): string {
  return content.replace(/\{\{project_name\}\}/g, vars.projectName);
}

// buildScaffold: lee los workflows de registry/templates/github-native/.github/workflows/ y devuelve
// {path, content} listos para putFile. Omite (defensivo) los que falten en el registry.
export function buildScaffold(registryDir: string, vars: ScaffoldVars): Array<{ path: string; content: string }> {
  const dir = resolve(registryDir, "templates", "github-native", ".github", "workflows");
  const out: Array<{ path: string; content: string }> = [];
  for (const w of WORKFLOWS) {
    const p = resolve(dir, w.file);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    out.push({ path: `.github/workflows/${w.file}`, content: w.subst ? substitute(raw, vars) : raw });
  }
  return out;
}
