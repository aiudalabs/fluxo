// GET /auth/github/callback · cierra el OAuth: valida el state (anti-CSRF), cambia el code
// por el token, upsertea el usuario + tokens, mintea la sesión y vuelve al console con el
// JWT en el FRAGMENT (#gh_session=…) para que no toque los logs del server. (F5-P8 A)
//
// Separa install de login: un callback con setup_action pero SIN state es una INSTALACIÓN de
// la App, no un login — redirige a / sin mintear sesión (evita login-CSRF), como v1.
import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, fetchGithubUser, upsertUser, mintSessionJwt } from "@/lib/server/githubAuth";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const setupAction = url.searchParams.get("setup_action");
  // Detrás de un reverse-proxy (Caddy en prod) `url.origin` es la URL INTERNA (localhost:3000) →
  // los redirects post-login irían a localhost. Usamos PUBLIC_URL cuando está seteado; en dev
  // (sin PUBLIC_URL) cae a url.origin.
  const origin = process.env.PUBLIC_URL ?? url.origin;

  // Instalación de la App (no login): sin state pero con setup_action → no minteamos sesión.
  if (!state && setupAction) {
    return NextResponse.redirect(`${origin}/?gh_setup=${encodeURIComponent(setupAction)}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${origin}/?auth_error=missing_code_or_state`);
  }
  // Validar el state contra la cookie (one-time).
  const cookieState = req.cookies.get("gh_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(`${origin}/?auth_error=bad_state`);
  }

  try {
    const tok = await exchangeCode(code);
    const gh = await fetchGithubUser(tok.access_token);
    const { userId, tenantId } = await upsertUser(gh, tok);
    const session = mintSessionJwt(tenantId, userId);
    // → onboarding (conectar/instalar); si el usuario ya está seteado, esa pantalla lo salta.
    // Fragment: no llega al server (ni a sus logs). El cliente lo levanta y lo guarda.
    const res = NextResponse.redirect(`${origin}/onboarding#gh_session=${session}&login=${encodeURIComponent(gh.login)}`);
    res.cookies.delete("gh_oauth_state");
    return res;
  } catch (e) {
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(e instanceof Error ? e.message : "oauth_failed")}`);
  }
}
