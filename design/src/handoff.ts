// F5-P4 · El HANDOFF: cuando el diseño termina, el backlog.yaml aprobado se publica como
// filas reales en stories/sprints (el board se llena). Cierra el arco idea→diseño→backlog.
//
// El engine llama handoff.run(step, ctx) en el step `ticket_publish`. Leemos docs/backlog.
// yaml del workdir compartido (donde el scrum-master lo escribió), lo parseamos al shape
// que publishBacklog espera, y lo publicamos vía el store (RLS por tenant). El outcome se
// audita en el brain.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { HandoffExecutor } from "./engine.ts";
import type { SupabaseDesignStore, SprintSeed, StorySeed } from "./supabase.ts";

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

// makeSupabaseHandoff realiza el ports HandoffExecutor sobre el store + el workdir.
export function makeSupabaseHandoff(store: SupabaseDesignStore, workdir: string): HandoffExecutor {
  return {
    async run(): Promise<void> {
      const path = join(workdir, "docs", "backlog.yaml");
      const raw = readFileSync(path, "utf8");
      const { sprints, stories } = parseBacklog(raw);
      const r = await store.publishBacklog(sprints, stories);
      await store.brainAppend("backlog_published", { sprints: r.sprints, stories: r.stories }, "engine:handoff");
      console.log(`  ↪ handoff: publicadas ${r.stories} stories en ${r.sprints} sprints`);
    },
  };
}
