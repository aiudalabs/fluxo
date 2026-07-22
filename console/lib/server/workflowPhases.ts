// Deriva las FASES de un workflow de diseño desde su YAML del registry, usando la MISMA función
// del motor (design/src/workflow.ts) — una sola fuente de verdad (golden rule #1). Antes el
// dropdown de Settings tenía la lista de fases hardcodeada como string y podía driftear del YAML;
// ahora sale del mismo lugar del que /flow deriva las suyas. Es método (data), no dato de tenant.
import { loadWorkflow, designPhases } from "../../../design/src/workflow.ts";
import { registryDir } from "./capabilitiesData";

// Los workflows de diseño que un proyecto puede ELEGIR como su pipeline (los entry points del plano
// diseño). NO son todos los del registry: `iterate` se dispara por incrementos y las ceremonias por
// estado de sprint — no se eligen acá. El nombre corto es copy de UI; las FASES salen del YAML.
export const DESIGN_WORKFLOWS = [
  { id: "design", name: "Completo" },
  { id: "demo-design", name: "Lean (demos)" },
] as const;

export function designWorkflowOptions(): Array<{ id: string; name: string; phases: string[] }> {
  const dir = registryDir();
  return DESIGN_WORKFLOWS.map(({ id, name }) => ({
    id,
    name,
    phases: designPhases(loadWorkflow(dir, id)).map((p) => p.label),
  }));
}
