// planRepoDocs: QUÉ docs del workdir van al repo del cliente en el handoff.
//
// La regla (post-bug mockups, 2026-07-20): el commit set se DERIVA, no se enumera.
// La whitelist REPO_DOCS anterior nació completa para los 8 docs planos de design.yaml
// y ciega al único output con forma de directorio (docs/mockups/) — drop silencioso que
// dejó al art-director sin mockups que juzgar. Golden rule #1: qué documentos produce el
// método es conocimiento del MÉTODO (declarado en el workflow del registry), no de la
// plataforma; acá solo caminamos lo que el run realmente produjo y verificamos contra lo
// declarado.
//
// - Inclusión: TODO archivo bajo workdir/docs/**, recursivo. Una fase nueva (o un
//   incremento vía iterate) que escriba docs nuevos los sube sin tocar este código.
// - Exclusión: política mínima de plataforma (dotfiles, tamaño). Falla hacia "subir de
//   más" (visible) — nunca hacia tirar en silencio; toda exclusión se reporta.
// - Verificación intención-vs-realidad: cada `output:` declarado por las fases design
//   del workflow debe estar en el plan; si falta, se reporta (fail loud, L-AUTO-3).
// - Guard del consumidor: una story frontend con screen_key necesita su
//   docs/mockups/<screen_key>.html (lo que el art-director de ui-verify compara).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import yaml from "js-yaml";
import type { StorySeed } from "./supabase.ts";

// Tope de plataforma: la Contents API de GitHub rechaza archivos grandes y un doc de
// diseño no debería acercarse. Excluir (reportado) en vez de reventar el handoff.
export const MAX_DOC_BYTES = 5 * 1024 * 1024;

export interface RepoDocsPlan {
  // Rutas repo-relativas (docs/...) a commitear, orden estable (sorted).
  files: string[];
  // Todo lo que se dejó afuera, SIEMPRE con motivo — la exclusión silenciosa fue el bug.
  excluded: Array<{ path: string; reason: string }>;
  // Outputs declarados por el workflow (bajo docs/) que NO están en el plan.
  missingDeclared: string[];
  // Stories frontend con screen_key cuyo mockup docs/mockups/<key>.html no está.
  missingMockups: Array<{ story: string; screenKey: string; path: string }>;
  // Pantallas de docs/UI_SCREENS.md sin story ni marca out_of_scope en el backlog (P8-B).
  // El scrum-master pudo comprimir N pantallas en menos stories → pantallas enteras nunca
  // tuvieron ticket → nunca se construyeron (panel del dueño de MiSalon esquelético, n=3).
  uncoveredScreens: string[];
}

// parseScreenIds: extrae el set de IDs de pantalla de un docs/UI_SCREENS.md. El ID es el token
// líder del header de cada pantalla ("P.1", "S.5", "A-1", "1.2", "1.0.1"), copiado verbatim — es
// la MISMA llave que el scrum-master vuelca en la matriz coverage del backlog. El formato del doc
// varía por proyecto (numeración ad-hoc, no hay role.screen dotted en los docs reales), así que
// esto es una HEURÍSTICA de reporte, no un parser estricto: se ancla en headers `### <id>` bajo
// secciones que NO son de tokens/componentes/flujos/navegación. Un falso positivo es ruido barato
// (el handoff reporta, no falla — como missingMockups); un falso negativo pierde una pantalla.
const NON_SCREEN_SECTION =
  /tokens|design system|componente|component|inventario|inventory|flujo|flow|navigation|navegaci|grafo|open questions|key screens|pantallas clave|screen count|cross-|summary|resumen|not in mvp|deliberately|apps? inventory|design commitment|app shell/i;
// El token de ID al inicio del header: opcional prefijo alfabético corto + dígitos con
// separadores de punto/guion. Captura "P.1", "S.14", "A-1", "1.2", "1.0.1".
const SCREEN_ID = /^#{3,4}\s+([A-Za-z]{0,4}[.\-]?\d+(?:[.\-]\d+)*)\b/;

export function parseScreenIds(md: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let inScreenSection = false;
  for (const line of md.split(/\r?\n/)) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) { inScreenSection = !NON_SCREEN_SECTION.test(h2[1]); continue; }
    if (!inScreenSection) continue;
    const m = SCREEN_ID.exec(line);
    if (!m) continue;
    // Los agrupadores de superficie ("### 4.1 Superficie: App X") no son pantallas.
    if (/superficie|surface/i.test(line)) continue;
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

// parseCoverageClaim: los IDs de pantalla que el backlog DECLARA cubrir (matriz coverage) o
// diferir explícitamente (out_of_scope). Ambos bloques usan el ID verbatim de UI_SCREENS.md —
// el MISMO namespace que parseScreenIds — para que el diff sea real (no el no-op que daría unir
// por screen_key/role.screen, ausente de los docs reales). Backlog malformado → sets vacíos.
interface RawCoverage {
  coverage?: Array<{ screen?: unknown }>;
  out_of_scope?: Array<{ screen?: unknown }>;
}
export function parseCoverageClaim(backlogYaml: string): { covered: Set<string>; outOfScope: Set<string> } {
  const covered = new Set<string>();
  const outOfScope = new Set<string>();
  let doc: RawCoverage;
  try {
    doc = (yaml.load(backlogYaml) ?? {}) as RawCoverage;
  } catch {
    return { covered, outOfScope };
  }
  for (const row of doc.coverage ?? []) if (row?.screen != null) covered.add(String(row.screen).trim());
  for (const row of doc.out_of_scope ?? []) if (row?.screen != null) outOfScope.add(String(row.screen).trim());
  return { covered, outOfScope };
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
}

export function planRepoDocs(
  workdir: string,
  declaredOutputs: string[],
  stories: Pick<StorySeed, "key" | "screen_key" | "lane">[],
): RepoDocsPlan {
  const docsDir = join(workdir, "docs");
  const files: string[] = [];
  const excluded: RepoDocsPlan["excluded"] = [];

  const absPaths: string[] = [];
  try {
    walk(docsDir, absPaths);
  } catch {
    // Sin docs/ en el workdir: plan vacío; los declarados (si hay) saldrán como missing.
  }
  for (const abs of absPaths) {
    const rel = join("docs", relative(docsDir, abs)).split(sep).join("/");
    const base = rel.split("/").pop() ?? rel;
    if (base.startsWith(".")) {
      excluded.push({ path: rel, reason: "dotfile" });
      continue;
    }
    const size = statSync(abs).size;
    if (size > MAX_DOC_BYTES) {
      excluded.push({ path: rel, reason: `supera ${MAX_DOC_BYTES} bytes (${size})` });
      continue;
    }
    files.push(rel);
  }
  files.sort();

  const planned = new Set(files);
  const missingDeclared = declaredOutputs
    .filter((o) => o.startsWith("docs/")) // solo lo que el handoff commitea
    .filter((o) => !planned.has(o))
    .sort();

  const missingMockups: RepoDocsPlan["missingMockups"] = [];
  for (const st of stories) {
    if (!st.screen_key) continue;
    const path = `docs/mockups/${st.screen_key}.html`;
    if (!planned.has(path)) missingMockups.push({ story: st.key, screenKey: st.screen_key, path });
  }

  // Cobertura de UI (P8-B): las pantallas de UI_SCREENS.md que el backlog NO cubre ni difiere.
  // Sin UI_SCREENS.md (proyecto sin UI) → nada que chequear (degrada con gracia, como provisioning).
  const uncoveredScreens: string[] = [];
  const screens = readDoc(docsDir, "UI_SCREENS.md");
  if (screens !== null) {
    const backlog = readDoc(docsDir, "backlog.yaml");
    const { covered, outOfScope } = backlog !== null
      ? parseCoverageClaim(backlog)
      : { covered: new Set<string>(), outOfScope: new Set<string>() };
    for (const id of parseScreenIds(screens)) {
      if (!covered.has(id) && !outOfScope.has(id)) uncoveredScreens.push(id);
    }
  }

  return { files, excluded, missingDeclared, missingMockups, uncoveredScreens };
}

// readDoc: lee un doc del workdir/docs; null si no existe (degradación con gracia).
function readDoc(docsDir: string, name: string): string | null {
  try {
    return readFileSync(join(docsDir, name), "utf8");
  } catch {
    return null;
  }
}
