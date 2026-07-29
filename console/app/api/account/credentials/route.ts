// /api/account/credentials · las credenciales del TENANT (docs/16). NIVEL CUENTA, no proyecto: se
// cargan una vez y valen para TODOS tus proyectos.
//   GET → el registro + qué está seteado (nombres + updated_at). NUNCA el valor.
//   PUT → { name, value }: guarda el valor cifrado en Vault Y lo PROPAGA (siembra) en los Actions
//         secrets de TODOS tus repos, con tu token de GitHub. Así cada proyecto lo hereda solo.
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken } from "@/lib/server/githubAuth";
import { listTenantCredentials, setTenantCredential, tenantRepoSlugs, propagateToRepo, CREDENTIAL_REGISTRY } from "@/lib/server/tenantCredentials";

const KNOWN = new Set(CREDENTIAL_REGISTRY.map((c) => c.name));

function sessionOf(req: NextRequest) {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
}

export async function GET(req: NextRequest) {
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });
  return NextResponse.json({ credentials: await listTenantCredentials(session.tenant) });
}

export async function PUT(req: NextRequest) {
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { name?: string; value?: string };
  const name = (body.name ?? "").trim();
  const value = body.value;
  if (!KNOWN.has(name)) return NextResponse.json({ error: `credencial «${name}» no reconocida` }, { status: 400 });
  if (!value || value.length < 10) return NextResponse.json({ error: "valor vacío o inválido" }, { status: 400 });

  // 1) guardar cifrado en la bóveda del tenant.
  try {
    await setTenantCredential(session.tenant, name, value);
  } catch (e) {
    return NextResponse.json({ error: `no se pudo guardar: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }

  // 2) propagar a TODOS tus repos (best-effort). Necesita tu token de GitHub (permiso Secrets:write).
  const ghToken = await getUserToken(session.sub);
  const propagation: Array<{ repo: string; seeded: string[]; failed: Array<{ name: string; error: string }> }> = [];
  if (ghToken) {
    for (const slug of await tenantRepoSlugs(session.tenant)) {
      const r = await propagateToRepo(session.tenant, slug, ghToken);
      propagation.push({ repo: slug, ...r });
    }
  }
  return NextResponse.json({ saved: true, propagated: !!ghToken, propagation });
}
