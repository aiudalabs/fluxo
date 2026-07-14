// approve.ts — Workflow approval (Fase 5, port de conductor/approve.go de v1). Los runs de CI de
// los PRs de agentes quedan `action_required` por diseño (un agente podría editar el CI para
// exfiltrar secrets, así que GitHub los retiene). Bajo workflow_approval=auto_if_safe el conductor
// los aprueba SOLO cuando el diff del PR NO toca `.github/workflows/**` — el caveat de seguridad
// exacto que documentó el PoC. Cualquier cosa que toque workflows queda para el humano.
//
// Kernel PURO: el sweep recibe una WorkflowApprover (GithubRepo la implementa estructuralmente),
// así se testea sin GitHub. El MISMO chequeo (prDiffSafe) lo reusa la aprobación manual del console.

export interface PendingRun {
  id: number;
  prNumbers: number[]; // PRs detrás del run (de run.pull_requests). Vacío = sin PR asociado.
}

export interface WorkflowApprover {
  listActionRequiredRuns(): Promise<PendingRun[]>;
  listPRFiles(pr: number): Promise<string[]>;
  approveRun(runId: number): Promise<void>;
}

export interface ApproveResult {
  approved: number[]; // run ids aprobados (re-disparados)
  blocked: number[];  // run ids dejados al humano (diff inseguro o sin PR)
}

// unsafePath: un archivo cambiado que podría alterar lo que ejecuta el CI.
export function unsafePath(path: string): boolean {
  return path === ".github/workflows" || path.startsWith(".github/workflows/");
}

// prDiffSafe: todo archivo de todo PR detrás del run es seguro. Un run SIN PR se considera NO seguro
// (se deja al humano) — fuera de scope: dispatches manuales, etc. Faithful a v1 (prNumbers vacío →
// false). `cache` evita re-pedir los files de un PR compartido por varios runs.
export async function prDiffSafe(gh: WorkflowApprover, prNumbers: number[], cache: Map<number, string[]>): Promise<boolean> {
  if (prNumbers.length === 0) return false;
  for (const n of prNumbers) {
    let files = cache.get(n);
    if (!files) { files = await gh.listPRFiles(n); cache.set(n, files); }
    if (files.some(unsafePath)) return false;
  }
  return true;
}

export class Approver {
  private log: (m: string) => void;
  constructor(opts: { log?: (m: string) => void } = {}) {
    this.log = opts.log ?? (() => {});
  }

  // sweep: aprueba todo run pendiente cuyo diff sea seguro. Lo usa el tick bajo auto_if_safe. Un
  // fallo al leer los files de un PR (o al aprobar) se loguea y no frena al resto (best-effort).
  async sweep(gh: WorkflowApprover): Promise<ApproveResult> {
    const res: ApproveResult = { approved: [], blocked: [] };
    const runs = await gh.listActionRequiredRuns();
    const cache = new Map<number, string[]>();
    for (const r of runs) {
      let safe: boolean;
      try {
        safe = await prDiffSafe(gh, r.prNumbers, cache);
      } catch (e) {
        this.log(`approve sweep run ${r.id}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!safe) { res.blocked.push(r.id); continue; }
      try {
        await gh.approveRun(r.id);
        res.approved.push(r.id);
      } catch (e) {
        this.log(`approve run ${r.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return res;
  }
}

// safeToApproveOne: el mismo guard para la aprobación MANUAL de un run (botón de la vista Agentes).
// Devuelve found=false si el run ya no está pendiente; safe=false si su diff toca workflows. El
// guard aplica igual aunque haya un click humano — faithful a v1 ApproveOne.
export async function safeToApproveOne(gh: WorkflowApprover, runId: number): Promise<{ found: boolean; safe: boolean }> {
  const runs = await gh.listActionRequiredRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { found: false, safe: false };
  const safe = await prDiffSafe(gh, run.prNumbers, new Map());
  return { found: true, safe };
}
