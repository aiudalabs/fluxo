// GET /auth/github/status · ¿está el auth configurado? + el install_url de la App (para el
// paso "instalá la Fluxo App en tu org"). Si el cliente manda su sesión, devuelve su login.
import { NextRequest, NextResponse } from "next/server";
import { authConfigured, INSTALL_URL, verifySessionJwt, admin } from "@/lib/server/githubAuth";

export async function GET(req: NextRequest) {
  const configured = authConfigured();
  let login: string | null = null;
  const auth = req.headers.get("authorization");
  if (configured && auth?.startsWith("Bearer ")) {
    const s = verifySessionJwt(auth.slice(7));
    if (s) {
      const { data } = await admin().from("app_users").select("gh_login").eq("id", s.sub).maybeSingle();
      login = (data?.gh_login as string) ?? null;
    }
  }
  return NextResponse.json({ configured, installUrl: INSTALL_URL, login });
}
