// F6a · Datos del DESPACHO para el console — el pegamento entre Supabase y el KERNEL PURO del
// conductor. La lógica de qué es despachable AHORA (story mode + sprint goal-mode + gate
// cross-sprint + concurrencia + routing por lane) NO se reimplementa acá: se importa
// `design/src/dispatch.ts` verbatim (una sola fuente de verdad — golden rule del método).
// Next 15 transpila ese módulo puro aunque viva fuera de console/ (verificado con next build).
//
// Este módulo hace SOLO I/O + mapeo: lee las stories/sprints/settings del proyecto (scoped al
// tenant), las convierte al shape del kernel, corre candidates(), y enriquece cada candidato con
// los datos que los endpoints necesitan (member DStory para el prompt, issues, la KEY como handle
// estable de cara al cliente). Lo usan GET /candidates y POST /dispatch — misma verdad en ambos.

import type { SupabaseClient } from "@supabase/supabase-js";
// Kernel PURO del despacho (design/src/dispatch.ts) importado VERBATIM — una sola fuente de verdad.
// Extensión .ts explícita: es zero-import y pura, así que se resuelve en las TRES toolchains
// (Next/SWC en el build, tsc con allowImportingTsExtensions, y node --experimental-strip-types en
// los tests) — el mismo idioma de imports que usa el paquete design/.
import { candidates, type Policy, type DStory, type DSprint } from "../../../design/src/dispatch.ts";

// Settings del proyecto que el despacho consume (espeja worker.ts `Settings`/`policyFrom`).
export interface Settings {
  channel?: string;
  execution_unit?: "sprint" | "story";
  max_concurrency?: number;
  merge_mode?: "manual" | "auto";
  lanes?: Record<string, { channel?: string; model?: string }>;
}

// issueNumOf: número de issue desde external_ref (github:owner/repo#N). null = no espejada.
const issueNumOf = (ref: string | null): number | null => {
  const m = ref?.match(/#(\d+)$/);
  return m ? Number(m[1]) : null;
};

// policyFrom: Settings → Policy del kernel. IMPORTANTE vs el worker: acá el default de
// maxConcurrency es 0 (ilimitado), no --max=3. El botón es despacho MANUAL, gateado por el
// humano que clickea; el tope de auto-pacing del worker no aplica a la acción manual. Si el
// proyecto FIJA max_concurrency, se respeta (candidates() no ofrece unidades si el cupo está lleno).
export function policyFrom(settings: Settings): Policy {
  const modelByLane = new Map<string, string>();
  const channelByLane = new Map<string, string>();
  for (const [lane, cfg] of Object.entries(settings.lanes ?? {})) {
    if (cfg?.model) modelByLane.set(lane, cfg.model);
    if (cfg?.channel) channelByLane.set(lane, cfg.channel);
  }
  return {
    executionUnit: settings.execution_unit === "sprint" ? "sprint" : "story",
    channel: settings.channel || "claude_action",
    maxConcurrency: settings.max_concurrency != null ? settings.max_concurrency : 0,
    modelByLane, channelByLane,
  };
}

// Row shapes tal como salen de Supabase.
interface StoryRow {
  id: string; key: string; title: string; lane: string | null; status: string;
  sprint_id: string | null; blocked_by: string[] | null; external_ref: string | null;
  body: string | null; acceptance: string | null;
}
interface SprintRow { id: string; key: string; title: string | null }

function toDStory(r: StoryRow): DStory {
  return {
    id: r.id, key: r.key, title: r.title, lane: r.lane ?? "", status: r.status,
    sprintId: r.sprint_id, deps: r.blocked_by ?? [], issue: issueNumOf(r.external_ref),
    body: r.body, acceptance: r.acceptance,
  };
}

// UICandidate: un candidato del kernel enriquecido para los endpoints. `id` es la KEY (story key
// o sprint key) — el handle ESTABLE y legible que el cliente manda al POST /dispatch; el server
// re-deriva y matchea por (kind, id) para no confiar en el cliente. `members` (DStory) alimenta
// el prompt goal-mode; `issues` es el csv del workflow_dispatch.
export interface UICandidate {
  kind: "story" | "sprint";
  id: string;            // KEY estable (handle de cara al cliente)
  title: string;
  storyKeys: string[];   // KEYs miembro (el board mapea el botón a cada card)
  members: DStory[];     // para construir el prompt (body/acceptance/issue)
  issues: number[];
  lane: string;
  model: string;
  channel: string;
}

// computeCandidates: la ÚNICA fuente de "qué se puede despachar ahora" en el console. Corre el
// kernel y traduce uuids → KEYs. Filtra a claude_action: es el único canal cableado en v2 (copilot
// = permiso pendiente), así que un botón para copilot solo fallaría — no lo mostramos (el POST
// igual re-valida el canal). Espeja el skip del worker.
export function computeCandidates(storyRows: StoryRow[], sprintRows: SprintRow[], settings: Settings): UICandidate[] {
  const pol = policyFrom(settings);
  const dstories = storyRows.map(toDStory);
  const byId = new Map(dstories.map((s) => [s.id, s]));
  const keyByStoryId = new Map(dstories.map((s) => [s.id, s.key]));
  const sprintsById = new Map<string, DSprint>(sprintRows.map((s) => [s.id, { id: s.id, key: s.key, title: s.title ?? "" }]));

  return candidates(dstories, sprintsById, pol)
    .map((c): UICandidate => {
      const members = c.stories.map((id) => byId.get(id)!).filter(Boolean);
      const key = c.kind === "sprint" ? (sprintsById.get(c.id)?.key ?? c.id) : (keyByStoryId.get(c.id) ?? c.id);
      return {
        kind: c.kind, id: key, title: c.title,
        storyKeys: members.map((m) => m.key), members, issues: c.issues,
        lane: c.lane, model: c.model, channel: c.channel,
      };
    })
    .filter((c) => c.channel === "claude_action");
}

// ── Carga scoped al tenant ────────────────────────────────────────────────────
export interface DispatchContext {
  repo: string | null;
  settings: Settings;
  storyRows: StoryRow[];
  sprintRows: SprintRow[];
}

// loadDispatchContext: lee el proyecto SOLO si es del tenant de la sesión (ownership server-side),
// y sus stories+sprints. Devuelve null si el proyecto no existe o no es del tenant. `db` = admin()
// (service_role): ya validamos el tenant contra projects.tenant_id, así que la lectura es segura.
export async function loadDispatchContext(db: SupabaseClient, tenant: string, projectId: string): Promise<DispatchContext | null> {
  const { data: project } = await db.from("projects").select("repo,settings,tenant_id").eq("id", projectId).maybeSingle();
  if (!project || project.tenant_id !== tenant) return null;

  const [{ data: stories }, { data: sprints }] = await Promise.all([
    db.from("stories").select("id,key,title,lane,status,sprint_id,blocked_by,external_ref,body,acceptance").eq("project_id", projectId),
    db.from("sprints").select("id,key,title").eq("project_id", projectId),
  ]);

  return {
    repo: (project.repo as string | null) ?? null,
    settings: (project.settings as Settings) ?? {},
    storyRows: (stories as StoryRow[]) ?? [],
    sprintRows: (sprints as SprintRow[]) ?? [],
  };
}
