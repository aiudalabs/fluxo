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

  // create: crea el repo en la org (necesita permiso Administration:write). Si ya existe
  // (422), lo adopta. Devuelve el GithubRepo.
  static async create(token: string, org: string, name: string, opts: { private?: boolean; description?: string } = {}): Promise<GithubRepo> {
    const res = await fetch(`${API}/orgs/${org}/repos`, {
      method: "POST",
      headers: H(token),
      body: JSON.stringify({ name, private: opts.private ?? true, description: opts.description ?? "", auto_init: true }),
    });
    if (res.status === 422) return new GithubRepo(token, org, name); // ya existe → adoptar
    if (!res.ok) throw new Error(`POST /orgs/${org}/repos → ${res.status} ${await res.text()}`);
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
