// POST /api/account/credentials/sync · propaga TODAS las credenciales del tenant a los Actions secrets
// de tus repos. { projectId } → solo ese repo; sin body → todos. Idempotente. Lo usa el botón "sincronizar
// a mis proyectos" de la UI y el alta de proyecto (para que un proyecto nuevo herede las credenciales).
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";
import { tenantRepoSlugs, propagateToRepo } from "@/lib/server/tenantCredentials";

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { projectId?: string };
  const ghToken = await getUserToken(session.sub);
  if (!ghToken) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  // Un proyecto puntual (ownership por tenant) o todos los repos del tenant.
  let slugs: string[];
  if (body.projectId) {
    const { data: proj } = await admin().from("projects").select("tenant_id,repo").eq("id", body.projectId).maybeSingle();
    if (!proj || (proj as { tenant_id: string }).tenant_id !== session.tenant) return NextResponse.json({ error: "sin acceso" }, { status: 403 });
    const s = slugOf((proj as { repo: string | null }).repo);
    if (!s) return NextResponse.json({ error: "el proyecto todavía no tiene repo" }, { status: 400 });
    slugs = [s];
  } else {
    slugs = await tenantRepoSlugs(session.tenant);
  }

  const results = [];
  for (const slug of slugs) results.push({ repo: slug, ...(await propagateToRepo(session.tenant, slug, ghToken)) });
  return NextResponse.json({ synced: results.length, results });
}
