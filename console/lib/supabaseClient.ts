import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

let client: SupabaseClient | null = null;

// browserClient (singleton). accessToken se evalúa por-request → toma la sesión más reciente
// (login/logout sin recargar). El realtime lo arma el project layout con activeToken().
export function browserClient(): SupabaseClient {
  if (client) return client;
  client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => activeToken() ?? "",
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
