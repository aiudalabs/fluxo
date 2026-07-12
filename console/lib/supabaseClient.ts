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
// access token for BOTH PostgREST and Realtime, so RLS applies to reads and to the
// realtime stream exactly as it will for a real logged-in user.
export function browserClient(): SupabaseClient {
  if (client) return client;
  client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(devToken ? { accessToken: async () => devToken } : {}),
  });
  // The realtime socket needs the token explicitly, or it connects as anon and
  // RLS delivers no rows. (Real auth will feed the user's session here instead.)
  if (devToken) void client.realtime.setAuth(devToken);
  return client;
}

export type BrainEvent = {
  id: number;
  tenant_id: string;
  project_id: string;
  kind: string;
  payload: Record<string, unknown>;
  actor: string;
  ts: string;
};
