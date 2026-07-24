// P5-1 · Pieza 3 — Tools READ del AI Assistant. Un MCP server IN-PROCESS (createSdkMcpServer) con
// tools SOLO DE LECTURA para que el bot no dependa solo del resumen pre-fetcheado: puede leer el
// backlog fresco, el detalle de una story, los sprints, o un doc del brain. Todas scopeadas al
// `projectId` (el proxy del console ya validó que el proyecto es del tenant de la sesión) → sin fuga
// cross-project. NADA que mute: las acciones (increment/dispatch/gate) siguen por el patrón
// confirmable de la UI (el bot propone, el usuario confirma). Ver assistant.ts.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Artifact } from "./harvest.ts";

// El helper REST del worker (service-role), inyectado — no importamos internals del worker.
export type Rest = <T>(path: string, init?: RequestInit) => Promise<T>;

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const DOC_CAP = 24_000; // un doc/mockup grande no debe reventar el contexto del turno.

// resolveDoc (puro, testeable): dado el set de fases-done (cada una con sus artifacts) y un path,
// devuelve la ÚLTIMA versión del doc (orden asc → la última gana; misma lógica que supabase.loadDocs)
// truncada al cap, o un error con la lista de paths disponibles.
export function resolveDoc(rows: Array<{ artifacts: Artifact[] | null }>, path: string): { content: string } | { error: string; disponibles: string[] } {
  const byPath = new Map<string, Artifact>();
  for (const r of rows) for (const a of r.artifacts ?? []) byPath.set(a.path, a);
  const found = byPath.get(path);
  if (!found) return { error: `no hay un doc en ${path}`, disponibles: [...byPath.keys()] };
  const content = found.content.length > DOC_CAP ? found.content.slice(0, DOC_CAP) + "\n\n…(truncado)" : found.content;
  return { content };
}

// buildAssistantTools arma el MCP server "fluxo" con las tools READ para UN proyecto.
export function buildAssistantTools(opts: { projectId: string; rest: Rest }) {
  const { projectId, rest } = opts;
  return createSdkMcpServer({
    name: "fluxo",
    version: "1.0.0",
    tools: [
      tool("read_backlog", "Lista TODAS las stories del proyecto (key, título, estado, lane, PR). Usalo para ver el backlog completo o buscar una story.", {}, async () => {
        const rows = await rest<unknown[]>(`/stories?project_id=eq.${projectId}&select=key,title,status,lane,pr_url&order=key`);
        return textResult(JSON.stringify(rows));
      }),

      tool("read_story", "Detalle de UNA story por su key (ej S1-01): título, estado, lane, descripción, criterios de aceptación, PR.", { key: z.string().describe("la key de la story, ej S1-01") }, async ({ key }) => {
        const rows = await rest<unknown[]>(`/stories?project_id=eq.${projectId}&key=eq.${encodeURIComponent(key)}&select=key,title,status,lane,body,acceptance,pr_url,run_id&limit=1`);
        return textResult(JSON.stringify(rows[0] ?? { error: `no hay una story con key ${key}` }));
      }),

      tool("read_sprints", "Lista los sprints del proyecto (key, título, orden).", {}, async () => {
        const rows = await rest<unknown[]>(`/sprints?project_id=eq.${projectId}&select=key,title&order=position`);
        return textResult(JSON.stringify(rows));
      }),

      tool("get_run_status", "Estado del ÚLTIMO design-run: status, workflow, y si falló → el error + si fue transitorio o fatal + en qué fase se cortó + si es reanudable. Usalo para diagnosticar 'por qué se cortó el diseño'.", {}, async () => {
        const [runs, phases] = await Promise.all([
          rest<Array<{ id: string; status: string; workflow: string; error: string | null; error_kind: string | null }>>(`/design_runs?project_id=eq.${projectId}&select=id,status,workflow,error,error_kind&order=created_at.desc&limit=1`),
          rest<Array<{ phase_id: string; status: string }>>(`/design_phases?project_id=eq.${projectId}&select=phase_id,status&order=ord`),
        ]);
        const run = runs[0];
        if (!run) return textResult(JSON.stringify({ error: "no hay ningún design-run para este proyecto" }));
        const stuckPhase = phases.find((p) => p.status !== "done")?.phase_id ?? null; // la fase donde se cortó
        // Reanudable = failed + de diseño (las ceremonias se re-planean solas, no van por /design/resume).
        const resumable = run.status === "failed" && !["sprint-planning", "sprint-review", "retro"].includes(run.workflow);
        return textResult(JSON.stringify({ status: run.status, workflow: run.workflow, error: run.error, error_kind: run.error_kind, stuck_phase: stuckPhase, resumable }));
      }),

      tool("read_brain_doc", "Lee la ÚLTIMA versión de un documento de diseño del proyecto por su path (ej docs/BRIEF.md, docs/ARCHITECTURE.md). Si no existe, devuelve la lista de paths disponibles.", { path: z.string().describe("path del doc, ej docs/BRIEF.md") }, async ({ path }) => {
        const rows = await rest<Array<{ artifacts: Artifact[] | null }>>(`/design_phases?project_id=eq.${projectId}&status=eq.done&select=artifacts,updated_at&order=updated_at.asc`);
        const doc = resolveDoc(rows, path);
        return textResult("content" in doc ? doc.content : JSON.stringify(doc));
      }),
    ],
  });
}

// Los ids de tools MCP que el SDK expone como allowedTools: mcp__<server>__<tool>.
export const ASSISTANT_TOOL_IDS = [
  "mcp__fluxo__read_backlog",
  "mcp__fluxo__read_story",
  "mcp__fluxo__read_sprints",
  "mcp__fluxo__read_brain_doc",
  "mcp__fluxo__get_run_status",
];
