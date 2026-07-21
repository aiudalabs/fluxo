// F5-P6 · Cliente mínimo de la GitHub App (sin deps): mintea el App JWT (RS256, node:crypto),
// resuelve la installation de una org y saca un installation token, y expone los verbs que el
// handoff necesita — crear repo, subir archivo, crear issue. Igual filosofía dep-light que
// design/src/supabase.ts (fetch + crypto, nada más).

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface GithubAppConfig {
  appId: string;
  privateKeyPath?: string; // GITHUB_APP_PRIVATE_KEY_PATH
  privateKey?: string;     // o el PEM inline (GITHUB_APP_PRIVATE_KEY)
}

const API = "https://api.github.com";
const H = (token: string, jwt = false) => ({
  Authorization: `${jwt ? "Bearer" : "token"} ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "fluxo",
});

export class GithubApp {
  private appId: string;
  private key: string;

  constructor(cfg: GithubAppConfig) {
    this.appId = cfg.appId;
    this.key = cfg.privateKey ?? (cfg.privateKeyPath ? readFileSync(cfg.privateKeyPath, "utf8") : "");
    if (!this.key) throw new Error("GithubApp: falta la private key (privateKey o privateKeyPath)");
  }

  // App JWT RS256 (iss=appId, ttl 9min).
  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${payload}`);
    signer.end();
    return `${head}.${payload}.${b64url(signer.sign(this.key))}`;
  }

  // installationToken: resuelve la installation de la org y devuelve un token (1h).
  async installationToken(org: string): Promise<string> {
    const jwt = this.appJwt();
    const list = await fetch(`${API}/app/installations`, { headers: H(jwt, true) });
    if (!list.ok) throw new Error(`GET /app/installations → ${list.status} ${await list.text()}`);
    const insts = (await list.json()) as Array<{ id: number; account?: { login?: string } }>;
    const inst = insts.find((i) => i.account?.login?.toLowerCase() === org.toLowerCase()) ?? insts[0];
    if (!inst) throw new Error(`la app no está instalada (0 installations)`);
    const tok = await fetch(`${API}/app/installations/${inst.id}/access_tokens`, { method: "POST", headers: H(jwt, true) });
    if (!tok.ok) throw new Error(`POST access_tokens → ${tok.status} ${await tok.text()}`);
    return ((await tok.json()) as { token: string }).token;
  }
}

export class GithubRepo {
  private token: string;
  readonly owner: string;
  readonly repo: string;
  constructor(token: string, owner: string, repo: string) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }
  get htmlUrl() { return `https://github.com/${this.owner}/${this.repo}`; }

  // fromUrl: adopta un repo existente desde su URL https://github.com/owner/repo.
  static fromUrl(token: string, url: string): GithubRepo {
    const m = url.replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) throw new Error(`repo url inválida: ${url}`);
    return new GithubRepo(token, m[1], m[2]);
  }

  // dispatchWorkflow: dispara un workflow_dispatch (Actions:write). El conductor manda el
  // prompt de la story + los issues (para el label agent:running).
  async dispatchWorkflow(workflowFile: string, inputs: Record<string, string>, ref = "main"): Promise<void> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/actions/workflows/${workflowFile}/dispatches`, {
      method: "POST",
      headers: H(this.token),
      body: JSON.stringify({ ref, inputs }),
    });
    if (!res.ok) throw new Error(`POST workflow dispatch → ${res.status} ${await res.text()}`);
  }

  // create: crea el repo bajo `owner`, detectando si es ORG (POST /orgs/{owner}/repos) o
  // CUENTA PERSONAL (POST /user/repos → va a la cuenta del token). Con el token OAuth del
  // usuario funciona en ambas; con el installation token solo en orgs con la App instalada.
  // Si ya existe (422), lo adopta.
  static async create(token: string, owner: string, name: string, opts: { private?: boolean; description?: string } = {}): Promise<GithubRepo> {
    const who = await fetch(`${API}/users/${owner}`, { headers: H(token) });
    const isOrg = who.ok && ((await who.json()) as { type?: string }).type === "Organization";
    const url = isOrg ? `${API}/orgs/${owner}/repos` : `${API}/user/repos`;
    const res = await fetch(url, {
      method: "POST",
      headers: H(token),
      body: JSON.stringify({ name, private: opts.private ?? true, description: opts.description ?? "", auto_init: true }),
    });
    if (res.status === 422) return new GithubRepo(token, owner, name); // ya existe → adoptar
    if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { name: string; owner: { login: string } };
    return new GithubRepo(token, r.owner.login, r.name);
  }

  // putFile: crea/actualiza un archivo (Contents:write). Idempotente: si existe, reusa su sha.
  async putFile(path: string, content: string | Buffer, message: string): Promise<void> {
    let sha: string | undefined;
    const cur = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${path}`, { headers: H(this.token) });
    if (cur.ok) sha = ((await cur.json()) as { sha?: string }).sha;
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${path}`, {
      method: "PUT",
      headers: H(this.token),
      body: JSON.stringify({ message, content: Buffer.from(content).toString("base64"), ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw new Error(`PUT contents/${path} → ${res.status} ${await res.text()}`);
  }

  // ensureLabel: crea el label con su color (Issues:write, idempotente). Si ya existe (422),
  // hace PATCH para fijar color/description → re-exportar recolorea labels viejos gris-default.
  async ensureLabel(name: string, color: string, description = ""): Promise<void> {
    const post = await fetch(`${API}/repos/${this.owner}/${this.repo}/labels`, {
      method: "POST",
      headers: H(this.token),
      body: JSON.stringify({ name, color, description }),
    });
    if (post.ok) return;
    if (post.status === 422) {
      const patch = await fetch(`${API}/repos/${this.owner}/${this.repo}/labels/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: H(this.token),
        body: JSON.stringify({ color, description }),
      });
      if (!patch.ok) throw new Error(`PATCH label ${name} → ${patch.status} ${await patch.text()}`);
      return;
    }
    throw new Error(`POST label ${name} → ${post.status} ${await post.text()}`);
  }

  // createIssue: (Issues:write). Devuelve número + url.
  async createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; html_url: string }> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/issues`, {
      method: "POST",
      headers: H(this.token),
      body: JSON.stringify({ title, body, labels: labels.filter(Boolean) }),
    });
    if (!res.ok) throw new Error(`POST issues → ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { number: number; html_url: string };
    return { number: r.number, html_url: r.html_url };
  }

  // ── Lectura para la PROYECCIÓN (GhSource) ───────────────────────────────────
  // Pagina hasta agotar (cap defensivo de 10 páginas × 100 = 1000). El endpoint de issues
  // devuelve también los PRs (tienen `pull_request`); los filtramos.
  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/${path}&per_page=100&page=${page}`, { headers: H(this.token) });
      if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
      const batch = (await res.json()) as T[];
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  // listIssues: estado de cada issue (open/closed) + asignados + labels. Excluye PRs.
  async listIssues(): Promise<import("./projection.ts").GhIssue[]> {
    type Raw = { number: number; state: "open" | "closed"; pull_request?: unknown; assignees?: Array<{ login: string }>; labels?: Array<{ name: string } | string> };
    const raw = await this.paginate<Raw>("issues?state=all");
    return raw
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        state: i.state,
        assignees: (i.assignees ?? []).map((a) => a.login),
        labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
      }));
  }

  // listPulls: PRs con draft/merged + los issues que cierran (parseados del body).
  async listPulls(): Promise<import("./projection.ts").GhPr[]> {
    type Raw = { number: number; state: "open" | "closed"; draft?: boolean; merged_at?: string | null; body?: string | null; html_url: string };
    const raw = await this.paginate<Raw>("pulls?state=all");
    const { parseIssueRefs } = await import("./projection.ts");
    return raw.map((p) => {
      const refs = parseIssueRefs(p.body ?? "");
      return {
        number: p.number,
        state: p.state,
        draft: Boolean(p.draft),
        merged: Boolean(p.merged_at),
        url: p.html_url,
        closes: refs.closes,
        mentions: refs.mentions,
      };
    });
  }

  // liveRunCount: cantidad de workflow runs vivos (queued|in_progress) en el repo. Es la señal
  // "hay un agente trabajando" que evita marcar agent_lost prematuramente durante el trabajo real.
  async liveRunCount(): Promise<number> {
    let total = 0;
    for (const status of ["queued", "in_progress"]) {
      const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/actions/runs?status=${status}&per_page=1`, { headers: H(this.token) });
      if (!res.ok) throw new Error(`GET actions/runs?status=${status} → ${res.status} ${await res.text()}`);
      total += ((await res.json()) as { total_count?: number }).total_count ?? 0;
    }
    return total;
  }

  // ── AUTO-MERGE (F4 · MergeSource) ────────────────────────────────────────────
  // prMergeInfo: estado de merge del PR vía GraphQL. `mergeStateStatus` y `reviewDecision` NO existen
  // en REST v3 — son campos de GraphQL. `state` (OPEN/CLOSED/MERGED), `isDraft`, `mergeStateStatus`
  // (CLEAN sii todos los checks requeridos verdes), `reviewDecision` (lo pone claude-review con su
  // review APPROVE/REQUEST_CHANGES), `headRefName` (branch a borrar tras el merge).
  async prMergeInfo(n: number): Promise<import("./automerge.ts").PrMergeInfo> {
    const query = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){number state isDraft mergeStateStatus reviewDecision headRefName}}}`;
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: H(this.token),
      body: JSON.stringify({ query, variables: { owner: this.owner, repo: this.repo, n } }),
    });
    if (!res.ok) throw new Error(`POST /graphql prMergeInfo #${n} → ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } }; errors?: unknown };
    const pr = json.data?.repository?.pullRequest;
    if (!pr) throw new Error(`prMergeInfo #${n}: PR no encontrado (${JSON.stringify(json.errors ?? json)})`);
    return {
      number: Number(pr.number),
      state: String(pr.state),
      isDraft: Boolean(pr.isDraft),
      mergeStateStatus: String(pr.mergeStateStatus),
      reviewDecision: pr.reviewDecision == null ? null : String(pr.reviewDecision),
      headRefName: String(pr.headRefName),
    };
  }

  // mergePr: squash-merge (REST PUT) + borra la head branch — faithful a v1 (`gh pr merge --squash
  // --delete-branch`). El borrado de la branch es best-effort: si falla DESPUÉS del merge se avisa
  // pero NO se lanza (el PR ya está mergeado; relanzar solo re-contaría un fallo falso).
  async mergePr(n: number, headRef: string): Promise<void> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/pulls/${n}/merge`, {
      method: "PUT",
      headers: H(this.token),
      body: JSON.stringify({ merge_method: "squash" }),
    });
    if (!res.ok) throw new Error(`PUT pulls/${n}/merge → ${res.status} ${await res.text()}`);
    if (!headRef) return;
    const del = await fetch(`${API}/repos/${this.owner}/${this.repo}/git/refs/heads/${headRef}`, { method: "DELETE", headers: H(this.token) });
    if (!del.ok && del.status !== 404 && del.status !== 422) {
      console.warn(`  ⚠ PR #${n} mergeado, pero DELETE branch ${headRef} → ${del.status} ${await del.text()}`);
    }
  }

  // ── WORKFLOW APPROVAL (F5 · WorkflowApprover) ────────────────────────────────
  // listActionRequiredRuns: runs de CI retenidos en `action_required` (GitHub los frena porque un
  // agente podría editar el CI) con los PRs detrás de cada uno. `run.pull_requests` viene poblado
  // para PRs del MISMO repo — el caso del agente (empuja su branch al repo, no a un fork).
  async listActionRequiredRuns(): Promise<import("./approve.ts").PendingRun[]> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/actions/runs?status=action_required&per_page=50`, { headers: H(this.token) });
    if (!res.ok) throw new Error(`GET actions/runs?status=action_required → ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { workflow_runs?: Array<{ id: number; pull_requests?: Array<{ number: number }> | null }> };
    return (data.workflow_runs ?? []).map((r) => ({ id: r.id, prNumbers: (r.pull_requests ?? []).map((p) => p.number) }));
  }

  // listPRFiles: los paths que cambia un PR (paginado). El guard de approve.ts marca inseguro si
  // alguno cae bajo .github/workflows/**.
  async listPRFiles(pr: number): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/pulls/${pr}/files?per_page=100&page=${page}`, { headers: H(this.token) });
      if (!res.ok) throw new Error(`GET pulls/${pr}/files → ${res.status} ${await res.text()}`);
      const batch = (await res.json()) as Array<{ filename: string }>;
      out.push(...batch.map((f) => f.filename));
      if (batch.length < 100) break;
    }
    return out;
  }

  // approveRun: aprueba un run `action_required` (POST .../approve) — lo mismo que el botón manual
  // del console, pero disparado por el sweep auto_if_safe del conductor.
  async approveRun(runId: number): Promise<void> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/actions/runs/${runId}/approve`, { method: "POST", headers: H(this.token) });
    if (!res.ok) throw new Error(`POST actions/runs/${runId}/approve → ${res.status} ${await res.text()}`);
  }

  // listRepoIssueComments: todos los comentarios de issues del repo (paginado, recientes primero).
  // Lo usa reconcileCosts (F-spend) para encontrar los marcadores <!-- fluxo:cost {...} -->. Acotado
  // a 10 páginas (1000 comentarios) — de sobra para un repo de proyecto.
  async listRepoIssueComments(): Promise<Array<{ body: string }>> {
    const out: Array<{ body: string }> = [];
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/issues/comments?per_page=100&page=${page}&sort=created&direction=desc`, { headers: H(this.token) });
      if (!res.ok) throw new Error(`GET issues/comments → ${res.status} ${await res.text()}`);
      const batch = (await res.json()) as Array<{ body?: string }>;
      for (const c of batch) if (c.body) out.push({ body: c.body });
      if (batch.length < 100) break;
    }
    return out;
  }

  // fileOnRef: ¿existe `path` en `ref`? Lo usa el guard docs-on-main (Fase 5): no despachar si el
  // PRD no está en `main`. 404 → false; otro error se propaga (el caller hace fail-open capturando).
  async fileOnRef(path: string, ref: string): Promise<boolean> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${ref}`, { headers: H(this.token) });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`GET contents/${path}?ref=${ref} → ${res.status} ${await res.text()}`);
    return true;
  }

  // secretPresent: ¿el Actions secret `name` existe en el repo? (Secrets:read). Modela el probe del
  // readiness gate por capability (P6-2b Paso 3). TRI-ESTADO: true=presente (🟢), false=404 confirmado
  // ausente (gatea), null=indeterminado (403 sin permiso / error de red → el caller fail-open, no
  // gatea ante la duda). NO expone el valor del secret — GitHub solo devuelve metadata.
  async secretPresent(name: string): Promise<boolean | null> {
    try {
      const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/actions/secrets/${name}`, { headers: H(this.token) });
      if (res.status === 404) return false;
      if (res.ok) return true;
      return null;
    } catch {
      return null;
    }
  }
}
