// F-CONDUCTOR-04 · AUTO-MERGE gated (detrás de `merge_mode: auto`). Por cada PR de una story en
// `review`, mergea SOLO si el reviewer aprobó y todos los checks están verdes. Espeja el `autoMerge`
// de v1 (`engine/internal/app/app.go:742-772`), adaptado al cliente dep-light de v2.
//
// MONEY-CRITICAL: nunca mergear un PR que no esté CLEAN + no-rechazado por el reviewer. El predicado
// `shouldMerge` es puro (testeable sin GitHub). El merge real se ve en E2E (necesita un PR vivo).
//
// DEDUP: un sprint = 1 PR que cierra N issues ⇒ N stories en review comparten el mismo PR. Mergear
// UNA sola vez por PR (no N). RETRIES ACOTADOS: tras `maxFails` fallos de merge de un mismo PR, se
// deja para el humano (no loop infinito) — faithful a v1 (`autoMergeFails>=3`).

export interface PrMergeInfo {
  number: number;
  state: string;                 // OPEN | CLOSED | MERGED
  isDraft: boolean;
  mergeStateStatus: string;      // CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | UNKNOWN | …
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  headRefName: string;           // branch a borrar tras el merge
}

// shouldMerge: el predicado money-critical (espeja `app.go:762`). Mergear SOLO si el PR está abierto,
// no es draft, todos los checks verdes (CLEAN incluye claude-review + suite-integrity de F3) y el
// reviewer no pidió cambios. `reviewDecision === null` (sin review requerido por branch-protection)
// NO bloquea por sí solo — faithful a v1 (`ReviewDecision != CHANGES_REQUESTED`); el gate real del
// reviewer es el check `claude-review` dentro de CLEAN.
export function shouldMerge(info: PrMergeInfo): boolean {
  return !info.isDraft
    && info.state === "OPEN"
    && info.mergeStateStatus === "CLEAN"
    && info.reviewDecision !== "CHANGES_REQUESTED";
}

// prNumFromUrl: saca el número de PR de una `pr_url` (https://github.com/owner/repo/pull/123).
export function prNumFromUrl(url: string | null): number | null {
  const m = url?.match(/\/pull\/(\d+)(?:$|[/?#])/);
  return m ? Number(m[1]) : null;
}

// La superficie de merge que el auto-merge necesita. `GithubRepo` la implementa; los tests inyectan
// un fake.
export interface MergeSource {
  prMergeInfo(n: number): Promise<PrMergeInfo>;
  mergePr(n: number, headRef: string): Promise<void>;
}

export interface AutoMergeResult {
  merged: number[];                              // PRs mergeados este tick
  skipped: Array<{ pr: number; reason: string }>; // PRs evaluados pero no mergeados (con motivo)
}

// AutoMerger: mantiene el contador de fallos de merge ENTRE ticks (el worker es un proceso largo, el
// estado a nivel de instancia persiste — como el `Projector`). Las claves de `fails` se scopean por
// proyecto (`scope#pr`) porque los números de PR NO son únicos entre repos.
export class AutoMerger {
  private fails = new Map<string, number>(); // `${scope}#${pr}` → fallos de merge consecutivos
  private maxFails: number;
  private log: (m: string) => void;

  constructor(opts: { maxFails?: number; log?: (m: string) => void } = {}) {
    this.maxFails = opts.maxFails ?? 3; // v1 autoMergeFails>=3
    this.log = opts.log ?? (() => {});
  }

  // reconcile: dedup de PRs, evalúa `shouldMerge` y mergea (una vez por PR). `scope` (id de proyecto)
  // aísla los contadores de fallos entre repos. Solo limpia contadores de ESTE scope.
  async reconcile(source: MergeSource, prNumbers: number[], scope = ""): Promise<AutoMergeResult> {
    const key = (pr: number) => `${scope}#${pr}`;
    const result: AutoMergeResult = { merged: [], skipped: [] };
    const seen = new Set<number>();

    for (const pr of prNumbers) {
      if (seen.has(pr)) continue; // dedup: un sprint = 1 PR que cierra N issues
      seen.add(pr);

      if ((this.fails.get(key(pr)) ?? 0) >= this.maxFails) {
        result.skipped.push({ pr, reason: "max_fails" }); // agotó retries → para el humano
        continue;
      }

      const info = await source.prMergeInfo(pr);
      if (!shouldMerge(info)) {
        result.skipped.push({ pr, reason: `not_ready(${info.state}/${info.mergeStateStatus}/${info.reviewDecision})` });
        continue;
      }

      try {
        await source.mergePr(pr, info.headRefName);
        this.fails.delete(key(pr));
        result.merged.push(pr);
        this.log(`  ⤳ PR #${pr} auto-merged (squash + delete branch)`);
      } catch (e) {
        const n = (this.fails.get(key(pr)) ?? 0) + 1;
        this.fails.set(key(pr), n);
        result.skipped.push({ pr, reason: `merge_failed(${n}/${this.maxFails})` });
        this.log(`  ⚠ PR #${pr} merge falló (${n}/${this.maxFails}): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Limpia contadores de PRs de ESTE scope que ya no están en review (mergeados o cerrados).
    const prefix = `${scope}#`;
    for (const k of [...this.fails.keys()]) {
      if (!k.startsWith(prefix)) continue;
      const pr = Number(k.slice(prefix.length));
      if (!seen.has(pr)) this.fails.delete(k);
    }
    return result;
  }
}
