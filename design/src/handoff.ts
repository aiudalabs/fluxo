// F5-P4 · El HANDOFF: cuando el diseño termina, el backlog.yaml aprobado se publica como
// filas reales en stories/sprints (el board se llena). Cierra el arco idea→diseño→backlog.
//
// El engine llama handoff.run(step, ctx) en el step `ticket_publish`. Leemos docs/backlog.
// yaml del workdir compartido (donde el scrum-master lo escribió), lo parseamos al shape
// que publishBacklog espera, y lo publicamos vía el store (RLS por tenant). El outcome se
// audita en el brain.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { HandoffExecutor } from "./engine.ts";
import type { SupabaseDesignStore, SprintSeed, StorySeed } from "./supabase.ts";
import { GithubApp, GithubRepo } from "./github.ts";
import { labelSpecsFor } from "./labels.ts";

interface RawBacklog {
  epic?: { id?: string; title?: string; description?: string };
  sprints?: Array<{ id: string; name?: string; goal?: string }>;
  stories?: Array<{
    id: string; title: string; body?: string; acceptance?: string;
    owner?: string; sprint_id?: string; deps?: string[]; depends_on?: string[];
    screen_key?: string; kind?: string;
  }>;
}

// parseBacklog: docs/backlog.yaml (schema del scrum-master, registry/agents/scrum-master.md)
// → {sprints, stories} para publishBacklog. epic.id se propaga como epic_id a cada story.
export function parseBacklog(raw: string): { sprints: SprintSeed[]; stories: StorySeed[] } {
  const doc = (yaml.load(raw) ?? {}) as RawBacklog;
  const epicId = doc.epic?.id;
  const sprints: SprintSeed[] = (doc.sprints ?? []).map((s, i) => ({
    key: s.id, title: s.name ?? s.id, goal: s.goal ?? "", position: i,
  }));
  const stories: StorySeed[] = (doc.stories ?? []).map((s) => ({
    key: s.id,
    title: s.title,
    body: (s.body ?? "").trim() || undefined,
    acceptance: (s.acceptance ?? "").trim() || undefined,
    lane: s.owner ?? "",
    sprint: s.sprint_id && s.sprint_id.trim() ? s.sprint_id.trim() : undefined,
    // `deps` es canónico; `depends_on` es alias defensivo (deps gana si están ambos).
    deps: (Array.isArray(s.deps) && s.deps.length ? s.deps : s.depends_on ?? []).filter(Boolean),
    epic_id: epicId,
    kind: s.kind && s.kind.trim() ? s.kind.trim() : undefined,
    screen_key: s.screen_key && s.screen_key !== "none" ? s.screen_key : undefined,
  }));
  return { sprints, stories };
}

// slugify: nombre de proyecto → nombre de repo válido (minúsculas, guiones).
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "fluxo-project";
}

// El cuerpo del issue: user story + criterios + deps + sprint/lane.
function issueBody(st: StorySeed): string {
  const parts: string[] = [st.body ?? st.title];
  if (st.acceptance) parts.push(`\n## Acceptance criteria\n${st.acceptance}`);
  if (st.deps?.length) parts.push(`\n**Depends on:** ${st.deps.join(", ")}`);
  const meta = [st.sprint && `Sprint ${st.sprint}`, st.lane && `Lane ${st.lane}`, st.screen_key && `Screen ${st.screen_key}`].filter(Boolean);
  if (meta.length) parts.push(`\n_${meta.join(" · ")}_`);
  return parts.join("\n");
}

export interface GithubTarget {
  app: GithubApp;
  org: string;
  repoName: string; // se slugifica
  description?: string;
  userToken?: string; // token OAuth del dueño — crea el repo en su cuenta personal O su org
  // Archivos de scaffold a commitear al repo (ej. .github/workflows/claude.yml — el canal
  // de build del conductor). {path, content}. Vienen del registry (main.ts los lee).
  scaffold?: Array<{ path: string; content: string }>;
}

// Docs que commiteamos al repo si existen en el workdir (orden de lectura).
const REPO_DOCS = ["BRIEF.md", "CONSTITUTION.md", "PRD.md", "DATA_MODEL.md", "ARCHITECTURE.md", "UI_SCREENS.md", "DESIGN_SYSTEM.md", "backlog.yaml"];

// publishToGithub: crea el repo (Administration:write), commitea los docs (Contents:write),
// y crea un issue por story (Issues:write), reconciliando project.repo + story.external_ref.
async function publishToGithub(store: SupabaseDesignStore, workdir: string, gh: GithubTarget, stories: StorySeed[]): Promise<void> {
  // El token OAuth del dueño crea el repo en su cuenta personal O su org; si no hay, cae al
  // installation token (solo orgs con la App instalada). Los issues/docs usan el mismo token.
  const token = gh.userToken ?? await gh.app.installationToken(gh.org);
  const repo = await GithubRepo.create(token, gh.org, slugify(gh.repoName), { private: true, description: gh.description });
  for (const f of REPO_DOCS) {
    const p = join(workdir, "docs", f);
    if (existsSync(p)) await repo.putFile(`docs/${f}`, readFileSync(p, "utf8"), `design: ${f}`);
  }
  // Scaffold: el canal de build (.github/workflows/claude.yml, etc.) — Workflows:write.
  for (const f of gh.scaffold ?? []) {
    await repo.putFile(f.path, f.content, `scaffold: ${f.path}`);
  }
  await store.setProjectRepo(repo.htmlUrl);
  // Pass 0 — labels de colores (sprint / lane / épica), deduplicados. Se ven de un vistazo en
  // GitHub: cada sprint y cada lane su color. Idempotente (recolorea labels viejos gris).
  const specs = new Map<string, { color: string; description: string }>();
  for (const st of stories) for (const s of labelSpecsFor(st)) if (!specs.has(s.name)) specs.set(s.name, { color: s.color, description: s.description });
  for (const [name, { color, description }] of specs) {
    try { await repo.ensureLabel(name, color, description); } catch (e) { console.error(`  ⚠ label ${name}: ${e instanceof Error ? e.message : e}`); }
  }
  // Pass 1 — issues, etiquetados con los mismos nombres de label.
  let issues = 0;
  for (const st of stories) {
    const labels = labelSpecsFor(st).map((s) => s.name);
    const { number } = await repo.createIssue(`[${st.key}] ${st.title}`, issueBody(st), labels);
    await store.setStoryRef(st.key, `github:${repo.owner}/${repo.repo}#${number}`, repo.htmlUrl);
    issues++;
  }
  await store.brainAppend("repo_created", { repo: repo.htmlUrl, issues, labels: specs.size }, "engine:handoff");
  console.log(`  ↪ GitHub: repo ${repo.htmlUrl} + ${issues} issues + ${specs.size} labels`);
}

// makeHandoff: el HandoffExecutor completo. Publica al board SIEMPRE (Supabase); si se pasa
// `github`, además crea el repo + docs + issues. El tramo GitHub DEGRADA con gracia: si falla
// (ej. falta el permiso Administration en la installation) loguea y sigue — el board ya quedó.
export function makeHandoff(store: SupabaseDesignStore, workdir: string, github?: GithubTarget): HandoffExecutor {
  return {
    async run(): Promise<void> {
      const raw = readFileSync(join(workdir, "docs", "backlog.yaml"), "utf8");
      const { sprints, stories } = parseBacklog(raw);
      const r = await store.publishBacklog(sprints, stories);
      await store.brainAppend("backlog_published", { sprints: r.sprints, stories: r.stories }, "engine:handoff");
      console.log(`  ↪ handoff: publicadas ${r.stories} stories en ${r.sprints} sprints`);
      if (github) {
        try {
          await publishToGithub(store, workdir, github, stories);
        } catch (e) {
          console.error(`  ⚠ handoff GitHub omitido (el board ya se publicó): ${e instanceof Error ? e.message : e}`);
        }
      }
    },
  };
}

// Alias retrocompatible (solo Supabase).
export function makeSupabaseHandoff(store: SupabaseDesignStore, workdir: string): HandoffExecutor {
  return makeHandoff(store, workdir);
}
