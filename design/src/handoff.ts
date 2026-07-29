// F5-P4 · El HANDOFF: cuando el diseño termina, el backlog.yaml aprobado se publica como
// filas reales en stories/sprints (el board se llena). Cierra el arco idea→diseño→backlog.
//
// El engine llama handoff.run(step, ctx) en el step `ticket_publish`. Leemos docs/backlog.
// yaml del workdir compartido (donde el scrum-master lo escribió), lo parseamos al shape
// que publishBacklog espera, y lo publicamos vía el store (RLS por tenant). El outcome se
// audita en el brain.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { HandoffExecutor } from "./engine.ts";
import type { SupabaseDesignStore, SprintSeed, StorySeed } from "./supabase.ts";
import { GithubApp, GithubRepo } from "./github.ts";
import { labelSpecsFor } from "./labels.ts";
import { buildScaffold, type ScaffoldVars } from "./scaffold.ts";
import { planRepoDocs } from "./repodocs.ts";
import { resolveFrontierMarkers } from "./capabilities.ts";

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

// serializeBacklog: {sprints, stories} → docs/backlog.yaml (el schema del scrum-master que
// parseBacklog lee de vuelta). Se usa para REGENERAR el backlog del repo desde la DB tras un
// iterate — donde el workdir trae solo el delta. Round-trip con parseBacklog (test). NO preserva
// las anotaciones design-time del scrum-master (coverage/out_of_scope/epic.name) porque no viven
// en la DB → por eso el handoff solo regenera cuando el workdir era un DELTA (ver makeHandoff).
export function serializeBacklog(sprints: SprintSeed[], stories: StorySeed[]): string {
  const epicId = stories.find((s) => s.epic_id)?.epic_id;
  const doc: RawBacklog = {
    ...(epicId ? { epic: { id: epicId } } : {}),
    sprints: sprints.map((s) => ({ id: s.key, name: s.title, goal: s.goal || undefined })),
    stories: stories.map((s) => ({
      id: s.key,
      title: s.title,
      ...(s.lane ? { owner: s.lane } : {}),
      ...(s.sprint ? { sprint_id: s.sprint } : {}),
      ...(s.deps?.length ? { deps: s.deps } : {}),
      ...(s.body ? { body: s.body } : {}),
      ...(s.acceptance ? { acceptance: s.acceptance } : {}),
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.screen_key ? { screen_key: s.screen_key } : {}),
    })),
  };
  return "# backlog.yaml — regenerado desde la DB (verdad mergeada) tras el handoff de un incremento.\n" +
    "# Es la fuente de las stories/deps; las anotaciones de cobertura viven en el brain versionado.\n" +
    yaml.dump(doc, { lineWidth: 100, noRefs: true });
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
  // P8-C: si la story construye una pantalla, apuntá al dev a SU spec y SU mockup — no al
  // genérico "leé docs/". El art-director compara la UI construida contra docs/mockups/<key>.html.
  if (st.screen_key) {
    parts.push(
      `\n## Pantalla\nEsta story construye la pantalla \`${st.screen_key}\`. ` +
      `Spec: la sección de \`${st.screen_key}\` en \`docs/UI_SCREENS.md\`. ` +
      `Mockup aprobado: \`docs/mockups/${st.screen_key}.html\` — construí la UI para que lo matchee.`,
    );
  }
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
  // El scaffold se CONSTRUYE en el handoff (no antes): necesita el stack + docs que solo existen
  // en el workdir al final del run. Pasamos el registryDir (de dónde salen los templates) y el
  // nombre humano del proyecto ({{project_name}}); el resto de las vars se resuelven del workdir.
  registryDir: string;
  projectName: string;
  // `output:` de las fases design del workflow que corrió (workflow.declaredOutputs) — la
  // declaración EN DATA de qué docs debe dejar el run; el handoff verifica el plan contra esto.
  declaredOutputs?: string[];
}

// resolveScaffoldVars arma las {{vars}} del scaffold desde el workdir (al momento del handoff los
// docs ya están cosechados). Solo pone las que puede resolver bien; las que faltan (design_tokens,
// path_map_*) dejan sus archivos sin emitir — buildScaffold los reporta y el handoff los loguea.
function resolveScaffoldVars(workdir: string, projectName: string, stories: StorySeed[]): ScaffoldVars {
  // stack: de docs/provisioning.yaml (§machine-readable del architect). Sin él → solo _common.
  let stack: string | undefined;
  try {
    const prov = yaml.load(readFileSync(join(workdir, "docs", "provisioning.yaml"), "utf8")) as { stack?: string };
    if (prov?.stack) stack = String(prov.stack).trim();
  } catch { /* sin provisioning.yaml: degradá a _common */ }

  // lanes: bullet list de las lanes distintas del backlog (para AGENTS.md/CLAUDE.md).
  const laneSet = [...new Set(stories.map((s) => s.lane).filter((l): l is string => !!l && l.trim() !== ""))];
  const lanes = laneSet.length ? laneSet.map((l) => `- ${l}`).join("\n") : undefined;

  return {
    project_name: projectName,
    stack,
    language: "es",          // ICP LATAM/español (default; el wizard lo fijará por proyecto — F9)
    lanes,
    art_director: "on",      // el juez-visión se auto-saltea sin screen_key/mockup (P2-1 lo endurece)
  };
}

// publishToGithub: crea el repo (Administration:write), commitea los docs (Contents:write),
// y crea un issue por story (Issues:write), reconciliando project.repo + story.external_ref.
//
// Los docs a commitear se DERIVAN del workdir (planRepoDocs: walk recursivo de docs/**),
// nunca de una lista en código — la whitelist REPO_DOCS que vivía acá dropeó docs/mockups/
// en silencio (bug 2026-07-20). Lo declarado por el workflow y lo que exige el art-director
// (mockup por screen_key) se VERIFICA contra el plan y se reporta fuerte si falta.
async function publishToGithub(store: SupabaseDesignStore, workdir: string, gh: GithubTarget, stories: StorySeed[]): Promise<void> {
  // El token OAuth del dueño crea el repo en su cuenta personal O su org; si no hay, cae al
  // installation token (solo orgs con la App instalada). Los issues/docs usan el mismo token.
  const token = gh.userToken ?? await gh.app.installationToken(gh.org);
  const repo = await GithubRepo.create(token, gh.org, slugify(gh.repoName), { private: true, description: gh.description });
  // P6-2b · markers de provisioning humano de las capabilities de frontera de este run (accounts
  // de provisioning.yaml ∪ capabilities del stack) — para cazar ACs de build no-despachables.
  const markersByCapability = resolveFrontierMarkers(gh.registryDir, workdir);
  const plan = planRepoDocs(workdir, gh.declaredOutputs ?? [], stories, markersByCapability);
  for (const rel of plan.files) {
    await repo.putFile(rel, readFileSync(join(workdir, rel)), `design: ${rel.replace(/^docs\//, "")}`);
  }
  console.log(`  ↪ docs: ${plan.files.length} archivo(s) commiteado(s) a ${repo.owner}/${repo.repo}`);
  for (const ex of plan.excluded) console.log(`  ⚠ docs: EXCLUIDO ${ex.path} (${ex.reason})`);
  if (plan.missingDeclared.length) {
    console.error(`  ✗ docs: el workflow declara ${plan.missingDeclared.length} output(s) que el run NO produjo: ${plan.missingDeclared.join(", ")}`);
    await store.brainAppend("handoff_docs_missing", { declared_missing: plan.missingDeclared }, "engine:handoff");
  }
  if (plan.missingMockups.length) {
    console.error(`  ✗ docs: ${plan.missingMockups.length} story(s) frontend con screen_key SIN mockup (el art-director de ui-verify no podrá juzgarlas):`);
    for (const m of plan.missingMockups) console.error(`     · ${m.story} (${m.screenKey}) → falta ${m.path}`);
    await store.brainAppend("handoff_mockups_missing", { stories: plan.missingMockups }, "engine:handoff");
  }
  // P8-B · cobertura de UI: pantallas de UI_SCREENS.md sin story ni marca out_of_scope en el
  // backlog. Es la falla AGUAS ARRIBA del art-director — una story ausente es invisible para él
  // (no hay nada que construir ni juzgar). Reporta fuerte (como missingMockups); NO falla el
  // handoff: el board ya se publicó y el parse de pantallas es heurístico (un falso positivo no
  // debe trabar el build). El scrum-master emite la matriz coverage para cerrar el hueco (P8-A).
  if (plan.uncoveredScreens.length) {
    console.error(`  ✗ docs: ${plan.uncoveredScreens.length} pantalla(s) de UI_SCREENS.md SIN story ni marca out_of_scope en el backlog (nunca se construirán):`);
    console.error(`     · ${plan.uncoveredScreens.join(", ")}`);
    await store.brainAppend("handoff_screens_uncovered", { screens: plan.uncoveredScreens }, "engine:handoff");
  }
  // P6-2b · gate capability-aware: ACs de build que re-enuncian provisioning HUMANO one-time (crear
  // proyecto + billing) — NO despachables (ningún agente crea un proyecto GCP+billing). Es el bug que
  // el E2E cazó en S-fbmig-1. Reporta fuerte (como uncoveredScreens); NO falla el handoff: el board ya
  // se publicó y el match marker↔AC es heurístico. La cura de raíz es aguas arriba (scrum-master
  // referencia la capability en vez de re-enunciar el provisioning).
  if (plan.provisioningLeaks.length) {
    console.error(`  ✗ backlog: ${plan.provisioningLeaks.length} AC(s) re-enuncian PROVISIONING HUMANO (no-despachable — ningún agente crea proyecto+billing):`);
    for (const l of plan.provisioningLeaks) console.error(`     · ${l.story} [${l.capability}] «${l.marker}» → ${l.ac}`);
    await store.brainAppend("handoff_backlog_provisioning_leak", { leaks: plan.provisioningLeaks }, "engine:handoff");
  }
  // Scaffold: el canal de build + el HARNESS DE VERIFY (e2e-verify/provisioning-lint/ui-verify +
  // .fluxo/verify/**). Se construye acá (workdir con docs → stack + lanes). Los archivos que aún
  // necesitan una var sin resolver NO se emiten y se loguean (no shippear `{{placeholder}}`).
  const vars = resolveScaffoldVars(workdir, gh.projectName, stories);
  const { files, skipped, unknownStack, availableStacks } = buildScaffold(gh.registryDir, vars);
  // FAIL-LOUD (2026-07-29): el proyecto declaró un stack SIN template → solo se emitió `_common`, o sea
  // SIN la persona de frontend, las instructions ni el gate `ui-verify` (calidad de UI sin verificar).
  // Antes esto pasaba callado. Lo surface-amos en el brain para que se vea y se corrija (elegir un stack
  // real de `available`, o crear ese template). NO abortamos: los archivos de `_common` + docs igual sirven.
  if (unknownStack) {
    console.log(`  ⛔ scaffold: stack «${unknownStack}» NO existe como template → solo _common (SIN ui-verify ni persona de frontend). Stacks reales: ${availableStacks.join(", ")}`);
    await store.brainAppend("scaffold_unknown_stack", { declared: unknownStack, available: availableStacks, degraded_to: "_common" }, "engine:handoff");
  }
  for (const f of files) {
    await repo.putFile(f.path, f.content, `scaffold: ${f.path}`);
  }
  console.log(`  ↪ scaffold: ${files.length} archivo(s) (stack ${vars.stack ?? "—"})`);
  if (skipped.length) {
    console.log(`  ⚠ scaffold: ${skipped.length} archivo(s) omitido(s) por vars sin resolver (falta el generador de pre-render):`);
    for (const s of skipped) console.log(`     · ${s.path} → {{${s.missing.join("}} {{")}}}`);
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
export function makeHandoff(store: SupabaseDesignStore, workdir: string, github?: GithubTarget, opts?: { full?: boolean }): HandoffExecutor {
  return {
    async run(): Promise<void> {
      const raw = readFileSync(join(workdir, "docs", "backlog.yaml"), "utf8");
      const { sprints, stories } = parseBacklog(raw);
      // full = re-handoff completo (design) → puede ENCOGER; iterate = delta aditivo (nunca encoge).
      const r = await store.publishBacklog(sprints, stories, { full: opts?.full ?? false });
      await store.brainAppend("backlog_published", { sprints: r.sprints, stories: r.stories }, "engine:handoff");
      console.log(`  ↪ handoff: publicadas ${r.stories} stories en ${r.sprints} sprints`);
      // Deuda-chica (2026-07-20): huérfanos al encoger. En un re-handoff FULL, stories 'backlog' que
      // ya no están en el backlog aprobado quedan en la DB. NO se borran (perdería trabajo despachado)
      // — se REPORTAN al brain para que sean visibles (patrón P8-B). Archivarlas de verdad exige un
      // status 'archived' (migración + filtro del board) → diferido para no reintroducir drift.
      if (r.orphans.length) {
        console.error(`  ⚠ backlog: ${r.orphans.length} story(s) huérfana(s) (en la DB, 'backlog', ya no en el backlog aprobado): ${r.orphans.join(", ")}`);
        await store.brainAppend("backlog_orphans", { orphans: r.orphans }, "engine:handoff");
      }
      // Deuda-chica 🟠 (2026-07-20): en un iterate el docs/backlog.yaml del workdir es SOLO el DELTA.
      // publishBacklog mergea a la DB (aditivo, ok), pero planRepoDocs commitea lo que hay en el
      // workdir → pisaría el backlog completo del repo con el delta (y loadProjectDocs lo sombraría
      // para el próximo iterate). Fix: si la DB quedó con MÁS stories que las del workdir, el workdir
      // era un delta → regenerá el backlog del workdir desde la DB (verdad mergeada) ANTES de
      // commitear. Un diseño fresco (mismos counts) NO se toca → preserva coverage/out_of_scope (P8-A).
      try {
        const merged = await store.loadBacklog();
        if (merged.stories.length > stories.length) {
          writeFileSync(join(workdir, "docs", "backlog.yaml"), serializeBacklog(merged.sprints, merged.stories), "utf8");
          console.log(`  ↪ backlog.yaml regenerado desde la DB: ${merged.stories.length} stories mergeadas (el workdir traía ${stories.length}, un delta)`);
        }
      } catch (e) {
        console.error(`  ⚠ no pude regenerar backlog.yaml desde la DB (se commitea el del workdir): ${e instanceof Error ? e.message : e}`);
      }
      if (github) {
        try {
          await publishToGithub(store, workdir, github, stories);
        } catch (e) {
          // FAIL-LOUD (2026-07-29): el tramo GitHub NO degrada en silencio. Antes CUALQUIER error
          // (incluido un 401 de auth, o un installation token que no puede POST /user/repos en una
          // cuenta personal) se tragaba como "el board ya se publicó" → el repo del cliente quedaba
          // SIN issues/mockups y el run igual marcaba `done`. Consecuencia real (Salonara, 2026-07-29):
          // 10 stories del incremento sin issue → external_ref null → NO despachables, sin que nadie
          // se enterara. Ahora: brain event queryable + re-throw → el run queda FAILED, visible en el
          // board, y el operador reintenta. Un handoff que no aterriza los issues NO es un éxito.
          const msg = e instanceof Error ? e.message : String(e);
          await store.brainAppend("handoff_github_failed", { error: msg }, "engine:handoff");
          console.error(`  ✗ handoff GitHub FALLÓ — el board se publicó, pero el repo NO recibió docs/issues (stories NO despachables): ${msg}`);
          throw new Error(`handoff GitHub falló: ${msg}`);
        }
      }
    },
  };
}

// Alias retrocompatible (solo Supabase).
export function makeSupabaseHandoff(store: SupabaseDesignStore, workdir: string): HandoffExecutor {
  return makeHandoff(store, workdir);
}
