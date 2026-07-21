// POST /api/auth/refresh — refresh SILENCIOSO del JWT de sesión (deuda-chica 🔴 2026-07-20).
// El browser lo llama ANTES de que su JWT venza (needsRefresh): mientras el token actual siga
// VÁLIDO, lo cambiamos por uno fresco (mismo shape, exp corrido) sin re-hacer OAuth. Si ya venció
// o es inválido → 401 y el cliente redirige a login. No toca GitHub: solo re-firma el claim de sesión.
import { NextResponse } from "next/server";
import { verifySessionJwt, mintSessionJwt, authConfigured } from "@/lib/server/githubAuth";

export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) return NextResponse.json({ error: "auth no configurado" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "sin token" }, { status: 401 });
  // verifySessionJwt valida firma + exp: un token ya vencido NO se refresca (hay que re-loguear).
  const claims = verifySessionJwt(token);
  if (!claims) return NextResponse.json({ error: "sesión inválida o vencida" }, { status: 401 });
  const fresh = mintSessionJwt(claims.tenant, claims.sub);
  return NextResponse.json({ token: fresh });
}
