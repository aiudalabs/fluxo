// POST /api/projects · crear un proyecto CON las dos garantías del gate (server-side, no
// confía en el cliente): (1) sesión GitHub válida, (2) la Fluxo App instalada en la org
// destino. Solo si ambas se dan inserta el proyecto — así el repo que el worker crea después
// nunca falla por "App no instalada" (la lección de Idearium). owner_id/tenant_id salen de
// la sesión verificada, no del body. Si la App no está instalada devuelve el installUrl para
// mandarte a instalarla ahí mismo.
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, ownerHasInstallation, admin, INSTALL_URL } from "@/lib/server/githubAuth";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { name?: string; description?: string; org?: string };
  const name = (body.name ?? "").trim();
  const description = (body.description ?? "").trim();
  const org = (body.org ?? "").trim();
  if (!name || !org) return NextResponse.json({ error: "faltan name/org" }, { status: 400 });

  // (1) GitHub conectado. (2) App instalada en `org` — re-consultado en GitHub (autoritativo).
  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ error: "github no conectado", installUrl: INSTALL_URL }, { status: 403 });
  if (!(await ownerHasInstallation(token, org))) {
    return NextResponse.json(
      { error: `La app de Fluxo no está instalada en "${org}". Instalala ahí para crear el proyecto.`, installUrl: INSTALL_URL, needsInstall: true },
      { status: 409 },
    );
  }

  // owner_id/tenant_id de la sesión verificada (no del body) — como los defaults del JWT en un
  // insert directo, pero acá es un insert service_role, así que hay que setearlos explícitos.
  const { data, error } = await admin()
    .from("projects")
    .insert({ name, description: description || null, org, owner_id: session.sub, tenant_id: session.tenant })
    .select("id")
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 502 });
  return NextResponse.json({ id: data.id });
}
