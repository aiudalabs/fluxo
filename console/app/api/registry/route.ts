// /api/registry · LECTOR del método (registry/). Read-only: expone el catálogo de agents/skills/
// workflows/providers + el árbol de templates github-native que Fluxo instala en cada repo. La
// vista Registry (F-registry) lo consume para que el usuario SEPA qué se está usando. Es método
// (data), no datos de tenant → sin scope de sesión (no hay nada privado acá). Lee el filesystem del
// repo (registry/ está en la raíz, un nivel arriba del cwd del console).
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// En dev el registry vive un nivel arriba del cwd del console (../registry). En el contenedor se
// fija por REGISTRY_DIR (el Dockerfile copia registry/ y lo apunta), porque el layout monorepo no
// se preserva igual en la imagen.
const ROOT = process.env.REGISTRY_DIR ?? path.resolve(process.cwd(), "..", "registry");
const KINDS = ["agents", "skills", "workflows", "providers"] as const;

// Honestidad UI (H1): qué workflows tienen HOY un disparador vivo en v2 vs los que están como
// método-en-data pero aún sin cablear. La fuente de verdad son los reconcilers del worker
// (design/src/worker.ts): reconcileDesign → design/demo-design, reconcileIncrements → iterate.
// MANTENER en sync con el worker: al cablear una ceremonia (reconcileCeremonies), sumarla acá.
const WIRED_WORKFLOWS = new Set(["design", "demo-design", "iterate"]);

async function readOr(p: string): Promise<string | null> {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}
async function listDir(p: string): Promise<string[]> {
  try { return await fs.readdir(p); } catch { return []; }
}
function line(text: string | null, re: RegExp): string | null {
  const m = text?.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

// walk: árbol relativo de un dir (para el catálogo de templates). Acotado en profundidad.
async function walk(base: string, dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const out: string[] = [];
  for (const name of await listDir(dir)) {
    const full = path.join(dir, name);
    let isDir = false;
    try { isDir = (await fs.stat(full)).isDirectory(); } catch { continue; }
    if (isDir) out.push(...(await walk(base, full, depth + 1)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind");
  const id = req.nextUrl.searchParams.get("id");

  // Detalle de un item: el yaml (metadata) y/o el md (persona/doc), crudos.
  if (kind && id && (KINDS as readonly string[]).includes(kind) && /^[a-z0-9._-]+$/i.test(id)) {
    const dir = path.join(ROOT, kind);
    const [yaml, yml, md] = await Promise.all([
      readOr(path.join(dir, `${id}.yaml`)),
      readOr(path.join(dir, `${id}.yml`)),
      readOr(path.join(dir, `${id}.md`)),
    ]);
    const yamlC = yaml ?? yml;
    if (yamlC == null && md == null) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ kind, id, yaml: yamlC, md });
  }

  // Contenido de un TEMPLATE por su path relativo bajo templates/github-native (para que la UI pueda
  // ABRIR y ver qué CI/scaffold siembra Fluxo, no solo listar el path). Path-safe: sin ".." y resuelto
  // DENTRO del árbol de templates (no se puede leer fuera).
  if (kind === "templates") {
    const rel = req.nextUrl.searchParams.get("path") ?? "";
    const baseDir = path.join(ROOT, "templates", "github-native");
    const abs = path.resolve(baseDir, rel);
    if (!rel || rel.includes("..") || !(abs === baseDir || abs.startsWith(baseDir + path.sep))) {
      return NextResponse.json({ error: "bad path" }, { status: 400 });
    }
    const content = await readOr(abs);
    if (content == null) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ kind: "templates", path: rel, content });
  }

  // Catálogo: por cada kind, la lista de items con un resumen (role/primera línea) + modelo.
  const catalog: Record<string, Array<{ id: string; summary: string | null; model: string | null; wired?: boolean }>> = {};
  for (const k of KINDS) {
    const files = await listDir(path.join(ROOT, k));
    const ids = [...new Set(files.filter((f) => /\.(ya?ml|md)$/.test(f)).map((f) => f.replace(/\.(ya?ml|md)$/, "")))].sort();
    const items: Array<{ id: string; summary: string | null; model: string | null; wired?: boolean }> = [];
    for (const iid of ids) {
      const y = (await readOr(path.join(ROOT, k, `${iid}.yaml`))) ?? (await readOr(path.join(ROOT, k, `${iid}.yml`)));
      const md = await readOr(path.join(ROOT, k, `${iid}.md`));
      const summary = line(y, /^role:\s*(.+)$/m) ?? line(md, /^#\s*(.+)$/m) ?? line(y, /^description:\s*(.+)$/m) ?? line(y, /^#\s*(.+)$/m);
      // Solo los workflows llevan estado de cableado (H1); el resto no aplica.
      const wired = k === "workflows" ? WIRED_WORKFLOWS.has(iid) : undefined;
      items.push({ id: iid, summary, model: line(y, /^model:\s*(.+)$/m), ...(wired !== undefined ? { wired } : {}) });
    }
    catalog[k] = items;
  }
  const templates = await walk(path.join(ROOT, "templates", "github-native"), path.join(ROOT, "templates", "github-native")).catch(() => []);
  return NextResponse.json({ catalog, templates });
}
