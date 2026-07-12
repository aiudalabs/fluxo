import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// DEV-SHIM (F1-04): a pre-minted tenant JWT so the browser can read brain_events
// under RLS before real auth exists. The real path is GitHub OAuth → a session
// JWT carrying a `tenant` claim (a later auth task); when that lands, this var and
// the accessToken hook go away and the client uses the user's real session.
const devToken = process.env.NEXT_PUBLIC_DEV_TENANT_JWT;

let client: SupabaseClient | null = null;

// browserClient returns a singleton. When a dev token is present it is used as the
// access token for PostgREST reads (RLS applies). The REALTIME socket token is armed
// once by the project layout (lib/project.tsx → ProjectProvider), not here — the
// project context is the single place that establishes the tenant session, so the
// feature views (studio/board/brain) never re-arm it. Real GitHub-OAuth auth will feed
// the user's session in the same one place.
export function browserClient(): SupabaseClient {
  if (client) return client;
  client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(devToken ? { accessToken: async () => devToken } : {}),
  });
  return client;
}

// devTenantToken is the pre-minted tenant JWT (dev-shim) the project layout arms on the
// realtime socket. Exported so the ProjectProvider is the one caller of setAuth.
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
