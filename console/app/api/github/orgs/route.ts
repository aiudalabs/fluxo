// GET /api/github/orgs · las orgs donde el usuario puede crear repos (de user/installations
// + user/orgs). Requiere la sesión (Authorization: Bearer <session jwt>) → resuelve su token
// OAuth guardado y consulta GitHub como él. (F5-P8 A)
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, fetchOwners } from "@/lib/server/githubAuth";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });
  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });
  try {
    const orgs = await fetchOwners(token);
    return NextResponse.json({ orgs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "orgs failed" }, { status: 502 });
  }
}
