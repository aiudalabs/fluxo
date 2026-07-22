// autonomy.ts — la capa de AUTONOMÍA (Fase 4). Envuelve el GateResolver humano para AUTO-APROBAR los
// gates seguros cuando el proyecto está en modo `auto_if_safe`, así el ciclo (diseño → build →
// review → retro → …) corre sin humano donde el riesgo es bajo. Es un DECORATOR: el resolver humano
// queda intacto para todo lo que no sea seguro.
//
// "Seguro" (política, golden rule #2 — automatizar donde el error es barato/reversible; humano donde
// hace falta juicio o el error es caro/irreversible):
//   1. modo == auto_if_safe (si no, todo lo aprueba un humano).
//   2. la fase NO dejó preguntas abiertas — señal de que el agente NO necesitó aclaración. OJO: es
//      omisión-frágil (un doc sin la sección "Open Questions" se lee como "sin preguntas"); es la
//      señal load-bearing de seguridad, inherente al diseño.
//   3. NO es un workflow de JUICIO HUMANO IRREEMPLAZABLE — HUMAN_ALWAYS abajo.
import type { GateResolver, GateRequest, GateDecision } from "./engine.ts";

// Workflows cuyo gate SIEMPRE lo aprueba un humano, aunque el modo sea auto:
//  - retro: edita el MÉTODO PROPIO de la fábrica (irreversible, self-modification).
//  - sprint-review: ACEPTA el incremento — el valor de la review es que un humano MIRE la preview;
//    auto-aceptar sin mirar la vacía de sentido.
// Los demás (design: PRD/arquitectura/backlog; sprint-planning/iterate: plan del backlog) se
// auto-aprueban si no hay preguntas abiertas — errores ahí son más baratos/reversibles (docs/plan
// antes de construir, o movimientos reversibles del backlog).
const HUMAN_ALWAYS = new Set(["retro", "sprint-review"]);

export interface AutonomyOpts {
  mode: "off" | "auto_if_safe";
  workflowId: string;
  onAuto?: (req: GateRequest) => void | Promise<void>; // audit de cada auto-aprobación
}

// gateAutoApprovable: la POLÍTICA, pura → testeable sin motor.
export function gateAutoApprovable(req: GateRequest, mode: string, workflowId: string): boolean {
  if (mode !== "auto_if_safe") return false;      // modo manual → siempre humano
  if (HUMAN_ALWAYS.has(workflowId)) return false; // retro (self-edit) + review (aceptar incremento)
  if (req.openQuestions.length > 0) return false; // la fase pidió aclaración → humano
  return true;
}

// autoResolver: envuelve el resolver base. Si el gate es auto-aprobable, aprueba al instante (con
// audit); si no, delega al humano.
export function autoResolver(base: GateResolver, opts: AutonomyOpts): GateResolver {
  return {
    async resolve(req: GateRequest): Promise<GateDecision> {
      if (gateAutoApprovable(req, opts.mode, opts.workflowId)) {
        await opts.onAuto?.(req);
        return { outcome: "approve" };
      }
      return base.resolve(req);
    },
  };
}
