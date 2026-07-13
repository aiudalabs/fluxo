// F-CONDUCTOR-01 · PROYECCIÓN — la pieza que convierte el dispatcher ingenuo de v2 en un
// CONDUCTOR. GitHub es la verdad: leemos issues + PRs de un repo y derivamos el estado de cada
// story espejada (open PR → review, issue closed → done, agente perdido → backlog). Escribimos
// vía el RPC `project_external_status` (bypass del state machine, ver la migración).
//
// Espeja `engine/internal/conductor/projection.go` de v1 (SyncProject :266-578, switch :494-542),
// adaptado al vocab de v2 (`review`/`backlog`, no `in_review`). Es lógica pura + un writer
// inyectado, para testear sin GitHub ni Supabase.
//
// LA HISTÉRESIS (golden rule 2 — nunca derivar estado crítico de una sola lectura eventual): una
// story `running` NO vuelve a backlog por una lectura sin señal. Solo tras N ticks consecutivos SIN
// PR, SIN asignado, SIN label agent:running Y con CERO workflow runs vivos en el repo. La señal
// "hay runs vivos" (liveRunCount) es la que evita el flap durante el trabajo real del agente
// (que puede tardar minutos en abrir el PR).

// ── Hechos de GitHub (lo que GhSource entrega) ──────────────────────────────────
export interface GhIssue {
  number: number;
  state: "open" | "closed";
  assignees: string[]; // logins
  labels: string[];    // nombres
}
export interface GhPr {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  url: string;
  closes: number[];    // issues que cierra (closing keywords)
  mentions: number[];  // otros #N mencionados (fallback de ligado)
}

// GhSource: la superficie de lectura que la proyección necesita. GithubRepo la implementa; los
// tests inyectan un fake.
export interface GhSource {
  listIssues(): Promise<GhIssue[]>;
  listPulls(): Promise<GhPr[]>;
  liveRunCount(): Promise<number>;
}

// La story tal como la proyección la necesita (espejada en GitHub por su issue #N).
export interface MirroredStory {
  id: string;
  key: string;
  status: string;    // vocab v2
  issue: number;     // número de issue de external_ref
  prUrl: string | null;
}

// El writer inyectado: escribe el estado derivado (RPC project_external_status en producción).
export type ExternalWriter = (
  storyId: string,
  status: string,
  prUrl?: string | null,
  agentLost?: string | null,
) => Promise<void>;

// parseIssueRefs: saca de un cuerpo de PR los issues que CIERRA (closing keywords) y los demás
// #N mencionados. El ligado prioriza `closes`; `mentions` es fallback. (v1 projection.go:246,361.)
export function parseIssueRefs(body: string): { closes: number[]; mentions: number[] } {
  const closes = new Set<number>();
  const mentions = new Set<number>();
  const closeRe = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b\s*:?\s*#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = closeRe.exec(body))) closes.add(Number(m[1]));
  const memRe = /#(\d+)/g;
  while ((m = memRe.exec(body))) { const n = Number(m[1]); if (!closes.has(n)) mentions.add(n); }
  return { closes: [...closes], mentions: [...mentions] };
}

// isAgentAssignee: ¿el asignado es un agente (Copilot / bot)? Señal de "running" de v1 (isAgent).
export function isAgentAssignee(login: string): boolean {
  const l = login.toLowerCase();
  return l.endsWith("[bot]") || l.includes("copilot");
}

// La clasificación derivada de los HECHOS de GitHub para una story (sin histéresis todavía).
export type Derivation =
  | { kind: "done" }
  | { kind: "review"; prUrl: string }
  | { kind: "running" } // señal fuerte: PR draft, asignado agente, o label agent:running
  | { kind: "idle" };   // sin señal positiva

// derive: espeja el switch projection.go:494-542.
//   issue closed                    → done
//   issue open + PR abierto no-draft → review (+pr_url)
//   issue open + PR abierto draft    → running
//   issue open + asignado agente     → running
//   issue open + label agent:running → running
//   else                             → idle
export function derive(issue: GhIssue | undefined, prs: GhPr[]): Derivation {
  if (!issue) return { kind: "idle" };
  if (issue.state === "closed") return { kind: "done" };
  const open = prs.filter((p) => p.state === "open");
  const nonDraft = open.find((p) => !p.draft);
  if (nonDraft) return { kind: "review", prUrl: nonDraft.url };
  if (open.some((p) => p.draft)) return { kind: "running" };
  if (issue.assignees.some(isAgentAssignee)) return { kind: "running" };
  if (issue.labels.includes("agent:running")) return { kind: "running" };
  return { kind: "idle" };
}

export interface ProjectionResult {
  changes: Array<{ key: string; from: string; to: string; note?: string }>;
}

// Projector: mantiene el contador de staleness ENTRE ticks (el worker es un proceso largo, así
// que el estado a nivel de módulo persiste — espeja el anchor in-memory de v1). Se resetea por
// story ante cualquier señal fuerte.
export class Projector {
  private stale = new Map<string, number>(); // storyId → ticks consecutivos sin señal ni run vivo
  private threshold: number;
  private log: (m: string) => void;

  constructor(opts: { write: ExternalWriter; threshold?: number; log?: (m: string) => void }) {
    this.write = opts.write;
    this.threshold = opts.threshold ?? 8; // v1 staleLabelThreshold
    this.log = opts.log ?? (() => {});
  }
  private write: ExternalWriter;

  // syncProject: lee GitHub, deriva y aplica. Devuelve los cambios (para logging/eventos).
  async syncProject(source: GhSource, stories: MirroredStory[]): Promise<ProjectionResult> {
    const [issues, prs, liveRuns] = await Promise.all([source.listIssues(), source.listPulls(), source.liveRunCount()]);
    const issueByNum = new Map(issues.map((i) => [i.number, i]));
    const prsByIssue = new Map<number, GhPr[]>();
    for (const pr of prs) {
      const targets = pr.closes.length ? pr.closes : pr.mentions;
      for (const n of targets) { const arr = prsByIssue.get(n) ?? []; arr.push(pr); prsByIssue.set(n, arr); }
    }

    const result: ProjectionResult = { changes: [] };
    const seen = new Set<string>();
    for (const s of stories) {
      seen.add(s.id);
      const d = derive(issueByNum.get(s.issue), prsByIssue.get(s.issue) ?? []);
      await this.applyOne(s, d, liveRuns, result);
    }
    // Limpia contadores de stories que ya no están (evita fuga de memoria).
    for (const id of [...this.stale.keys()]) if (!seen.has(id)) this.stale.delete(id);
    return result;
  }

  private async applyOne(s: MirroredStory, d: Derivation, liveRuns: number, result: ProjectionResult): Promise<void> {
    const record = (to: string, note?: string) => { result.changes.push({ key: s.key, from: s.status, to, note }); };

    if (d.kind === "done") {
      this.stale.delete(s.id);
      if (s.status !== "done") { await this.write(s.id, "done", s.prUrl, null); record("done"); this.log(`  ✓ ${s.key}: ${s.status} → done (issue cerrado)`); }
      return;
    }
    if (d.kind === "review") {
      this.stale.delete(s.id);
      if (s.status !== "review" || s.prUrl !== d.prUrl) { await this.write(s.id, "review", d.prUrl, null); record("review"); this.log(`  → ${s.key}: ${s.status} → review (PR ${d.prUrl})`); }
      return;
    }
    if (d.kind === "running") {
      this.stale.delete(s.id);
      if (s.status !== "running") { await this.write(s.id, "running", null, null); record("running"); this.log(`  ▶ ${s.key}: ${s.status} → running (agente activo)`); }
      return;
    }

    // idle: sin señal positiva. Histéresis — solo un running/review puede degradarse, y solo
    // cuando NO hay runs vivos en el repo (si los hay, el agente está trabajando: mantener).
    if (liveRuns > 0) { this.stale.delete(s.id); return; }
    if (s.status !== "running" && s.status !== "review") { this.stale.delete(s.id); return; }
    const n = (this.stale.get(s.id) ?? 0) + 1;
    if (n >= this.threshold) {
      this.stale.delete(s.id);
      await this.write(s.id, "backlog", null, "agent_lost");
      record("backlog", "agent_lost");
      this.log(`  ⚠ ${s.key}: ${s.status} → backlog (agent_lost tras ${n} ticks sin señal)`);
    } else {
      this.stale.set(s.id, n);
    }
  }
}
