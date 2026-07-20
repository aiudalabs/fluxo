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

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

  return { files, excluded, missingDeclared, missingMockups };
}
