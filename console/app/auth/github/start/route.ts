// GET /auth/github/start · arranca el OAuth (user authorization) de la Fluxo App. Setea un
// state anti-CSRF en cookie httpOnly y redirige a GitHub. (F5-P8 A)
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { authConfigured, githubClientId, REDIRECT_URI } from "@/lib/server/githubAuth";

export async function GET() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "auth GitHub no configurado (faltan envs GITHUB_APP_CLIENT_ID/SECRET, SUPABASE_*)" }, { status: 500 });
  }
  const state = randomUUID();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", githubClientId());
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set("gh_oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
