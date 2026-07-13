// GET /api/github/installations · las cuentas/orgs DONDE la Fluxo App está instalada = donde
// el usuario puede crear proyectos (repos). Fuente autoritativa (user/installations), no
// user/orgs. Requiere sesión (Authorization: Bearer <session jwt>) → resuelve el token OAuth
// guardado y consulta GitHub como él. Devuelve además el installUrl para instalar en más
// cuentas. (Cierra el hueco que dejó a Idearium sin repo: la App no estaba instalada ahí.)
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, fetchInstallations, INSTALL_URL } from "@/lib/server/githubAuth";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });
  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado", installUrl: INSTALL_URL }, { status: 403 });
  try {
    const installations = await fetchInstallations(token);
    return NextResponse.json({ installations, installUrl: INSTALL_URL });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "installations failed" }, { status: 502 });
  }
}
