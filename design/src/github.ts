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
  async putFile(path: string, content: string, message: string): Promise<void> {
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
}
