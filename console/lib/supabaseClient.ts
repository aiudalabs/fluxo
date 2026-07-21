import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { needsRefresh } from "./jwtRefresh";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// La sesión real (F5-P8 A): tras el login con GitHub, el callback deja el JWT de sesión en
// el fragment y AuthCapture lo guarda en localStorage("fluxo_session"). Ese JWT (role=
// authenticated + claim tenant del usuario) es el access token de Supabase → RLS por-usuario.
const SESSION_KEY = "fluxo_session";
export function sessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_KEY);
}
export function setSessionToken(jwt: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(SESSION_KEY, jwt);
}
export function clearSession() {
  if (typeof window !== "undefined") window.localStorage.removeItem(SESSION_KEY);
}

// DEV-SHIM: un tenant JWT pre-minteado como FALLBACK mientras no haya sesión real (dev sin
// login). Con sesión, gana la sesión. Cuando el auth esté 100%, se puede quitar.
const devToken = process.env.NEXT_PUBLIC_DEV_TENANT_JWT;

// El token efectivo: sesión del usuario si existe, si no el dev-shim.
export function activeToken(): string | undefined {
  return sessionToken() ?? devToken ?? undefined;
}

// ── Refresh silencioso del JWT de sesión (deuda-chica 🔴 2026-07-20) ──────────────────────────────
// El JWT de sesión (8h) vencía sin refresh → "JWT expired" a mitad de una sesión larga (el E2E lo
// mordió). freshToken() lo cambia por uno fresco cuando está por vencer, ANTES de que muera; mientras
// el usuario esté activo dentro de la ventana el token nunca expira. El re-mint del worker cubría el
// conductor, no el console — esto cierra ese hueco.
const REFRESH_BEFORE_S = 60 * 60; // refrescá si quedan menos de 60 min
let refreshing: Promise<string | null> | null = null; // debounce: un solo refresh en vuelo

async function refreshSession(current: string): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/refresh", { method: "POST", headers: { Authorization: `Bearer ${current}` } });
    if (!res.ok) return null; // 401 → ya venció; el usuario tendrá que re-loguear
    const { token } = (await res.json()) as { token?: string };
    if (token) { setSessionToken(token); return token; }
    return null;
  } catch {
    return null;
  }
}

// freshToken: el token vigente; si es la sesión y está por vencer, la refresca en silencio (debounced).
// El dev-shim no se refresca (no tiene endpoint). Si el refresh falla, devuelve el actual (fallará
// explícito si ya venció) — nunca peor que hoy.
export async function freshToken(): Promise<string | undefined> {
  const tok = sessionToken();
  if (!tok) return devToken ?? undefined;
  if (needsRefresh(tok, Math.floor(Date.now() / 1000), REFRESH_BEFORE_S)) {
    if (!refreshing) refreshing = refreshSession(tok).finally(() => { refreshing = null; });
    return (await refreshing) ?? tok;
  }
  return tok;
}

let client: SupabaseClient | null = null;

// browserClient (singleton). accessToken se evalúa por-request → toma la sesión más reciente
// (login/logout sin recargar) y la REFRESCA en silencio si está por vencer. El realtime lo arma el
// project layout con activeToken().
export function browserClient(): SupabaseClient {
  if (client) return client;
  client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => (await freshToken()) ?? "",
  });
  return client;
}

// devTenantToken se mantiene por compat (ProjectShell lo usaba); preferí activeToken().
export const devTenantToken = devToken;

export type BrainEvent = {
  id: number;
  tenant_id: string;
  project_id: string;
  kind: string;
  payload: Record<string, unknown>;
  actor: string;
  ts: string;
};
