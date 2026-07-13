// F5-P8 (A) · Helpers server-only del auth con GitHub. SOLO se importan desde Route
// Handlers (server) — nunca desde el browser: manejan el client secret + service_role.
//
// Flujo: /auth/github/start → OAuth de la Fluxo App → /callback cambia el code por el
// token user-to-server, upsertea el usuario + sus tokens en Supabase (service_role), y
// mintea un JWT de sesión (mismo shape que el dev-shim: role=authenticated + claim tenant)
// para que el browser hable con Supabase bajo RLS como ese usuario.

import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET ?? "";
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";
const SUPA_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
export const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ?? "http://localhost:3000/auth/github/callback";
export const APP_SLUG = process.env.GITHUB_APP_SLUG ?? "fluxo-by-aiudalabs-com";
export const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

export function authConfigured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET && JWT_SECRET && SUPA_URL && SERVICE_KEY);
}
export function githubClientId(): string { return CLIENT_ID; }

// admin: cliente Supabase con service_role (BYPASSRLS) — solo server. Lee/escribe las
// tablas de auth (app_users/github_tokens) que están cerradas a los roles de cliente.
export function admin(): SupabaseClient {
  return createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// mintSessionJwt: JWT HS256 de sesión (mismo shape que el dev-shim, firmado con el
// SUPABASE_JWT_SECRET) → el browser lo usa como access token de Supabase (RLS por tenant).
export function mintSessionJwt(tenantId: string, userId: string, ttlSeconds = 60 * 60 * 8): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    role: "authenticated", aud: "authenticated", sub: userId, tenant: tenantId, iat: now, exp: now + ttlSeconds,
  }));
  const sig = b64url(createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// verifySessionJwt: valida la firma HS256 + exp de un JWT de sesión → {sub, tenant} o null.
export function verifySessionJwt(token: string): { sub: string; tenant: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expect = b64url(createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest());
  if (sig !== expect) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub || !payload.tenant) return null;
    return { sub: payload.sub, tenant: payload.tenant };
  } catch {
    return null;
  }
}

// refreshUserToken: canjea el refresh_token por un access_token nuevo (los user-to-server de
// una GitHub App expiran ~8h). GitHub rota también el refresh_token → hay que persistir ambos.
async function refreshUserToken(refreshToken: string): Promise<OAuthToken> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = (await res.json()) as OAuthToken & { error?: string; error_description?: string };
  if (!res.ok || data.error || !data.access_token) throw new Error(`refresh: ${data.error_description ?? data.error ?? res.status}`);
  return data;
}

// getUserToken: el token OAuth del usuario (para actuar como él). Refresca si expiró (los
// user-to-server duran ~8h) — así las rutas nunca pegan a GitHub con un token vencido (el 401
// que rompía el probe / installations). `forceRefresh` refresca aunque no esté vencido: sirve
// cuando el usuario ACABA de conceder un permiso nuevo a la App — su token guardado todavía no
// lo trae hasta que se re-emite. El llamador lo usa como retry ante un 401/403 de permiso.
export async function getUserToken(userId: string, forceRefresh = false): Promise<string | null> {
  const db = admin();
  const { data } = await db.from("github_tokens").select("access_token,refresh_token,expires_at").eq("user_id", userId).maybeSingle();
  if (!data?.access_token) return null;
  const exp = data.expires_at ? new Date(data.expires_at as string).getTime() : 0;
  const fresh = !exp || exp - 60_000 > Date.now();
  if (fresh && !forceRefresh) return data.access_token as string;
  // Refrescar (vencido o forzado). Sin refresh_token no hay nada que hacer.
  if (!data.refresh_token) return data.access_token as string;
  try {
    const tok = await refreshUserToken(data.refresh_token as string);
    const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
    await db.from("github_tokens").update({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? data.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    return tok.access_token;
  } catch {
    return data.access_token as string; // el refresh falló → devolver el viejo (fallará explícito)
  }
}

export interface OAuthToken { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; }

// exchangeCode: code → token user-to-server (POST github.com/login/oauth/access_token).
export async function exchangeCode(code: string): Promise<OAuthToken> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: REDIRECT_URI }),
  });
  const data = (await res.json()) as OAuthToken & { error?: string; error_description?: string };
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(`oauth exchange: ${data.error_description ?? data.error ?? res.status}`);
  }
  return data;
}

export interface GithubUser { id: number; login: string; email: string | null; }

export async function fetchGithubUser(token: string): Promise<GithubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" },
  });
  if (!res.ok) throw new Error(`GET /user → ${res.status}`);
  return (await res.json()) as GithubUser;
}

// Installation: una cuenta/org DONDE la Fluxo App está instalada = exactamente donde el
// usuario puede crear repos (personal u org). Es la fuente AUTORITATIVA — no `user/orgs`,
// que lista orgs SIN la App (ahí la creación de repo falla con 403). El personal (type User)
// va primero. Lección cara (Idearium): crear un repo requiere la App instalada en la cuenta.
export interface Installation {
  login: string;
  type: "User" | "Organization";
  avatarUrl: string;
}

export async function fetchInstallations(token: string): Promise<Installation[]> {
  const res = await fetch("https://api.github.com/user/installations", {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { installations?: Array<{ account?: { login?: string; type?: string; avatar_url?: string } }> };
  const list = (data.installations ?? [])
    .filter((i): i is { account: { login: string; type?: string; avatar_url?: string } } => !!i.account?.login)
    .map((i) => ({ login: i.account.login, type: (i.account.type === "User" ? "User" : "Organization") as Installation["type"], avatarUrl: i.account.avatar_url ?? "" }));
  // Personal (type User) primero — la cuenta por defecto para la mayoría de los usuarios.
  return list.sort((a, b) => (a.type === b.type ? 0 : a.type === "User" ? -1 : 1));
}

// ownerHasInstallation: gate autoritativo del server — ¿la App está instalada en `owner`?
// Re-consulta GitHub (no confía en el body del cliente) antes de dejar crear un proyecto ahí.
export async function ownerHasInstallation(token: string, owner: string): Promise<boolean> {
  const insts = await fetchInstallations(token);
  return insts.some((i) => i.login.toLowerCase() === owner.toLowerCase());
}

// upsertUser: liga la identidad GitHub a un app_user (por gh_id) y guarda sus tokens.
// Devuelve {userId, tenantId} para mintear la sesión.
export async function upsertUser(gh: GithubUser, tok: OAuthToken): Promise<{ userId: string; tenantId: string }> {
  const db = admin();
  const { data: existing } = await db.from("app_users").select("id,tenant_id").eq("gh_id", gh.id).maybeSingle();
  let userId: string, tenantId: string;
  if (existing) {
    userId = existing.id as string; tenantId = existing.tenant_id as string;
    await db.from("app_users").update({ gh_login: gh.login, email: gh.email }).eq("id", userId);
  } else {
    const { data, error } = await db.from("app_users").insert({ gh_id: gh.id, gh_login: gh.login, email: gh.email }).select("id,tenant_id").single();
    if (error || !data) throw new Error(`upsert app_user: ${error?.message}`);
    userId = data.id as string; tenantId = data.tenant_id as string;
  }
  const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  await db.from("github_tokens").upsert({
    user_id: userId, gh_login: gh.login, access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? null, expires_at: expiresAt, updated_at: new Date().toISOString(),
  });
  return { userId, tenantId };
}
