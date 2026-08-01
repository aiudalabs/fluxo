// GET /api/projects/[id]/branches · lista las ramas del repo del proyecto (para el dropdown del preview
// y donde haga falta elegir una rama — ej. previsualizar la rama de un build del engine antes de mergear).
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";

const API = "https://api.github.com";
function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const { data: project } = await admin().from("projects").select("repo").eq("id", id).eq("tenant_id", session.tenant).single();
  const slug = slugOf(project?.repo ?? null);
  if (!slug) return NextResponse.json({ branches: [], defaultBranch: "main" });

  const token = await getUserToken(session.sub);
  if (!token) return NextResponse.json({ branches: [], defaultBranch: "main" });
  const H = { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo" };

  // default branch + hasta 100 ramas (más que suficiente; las de build del engine empiezan con engine/).
  const [repoRes, brRes] = await Promise.all([
    fetch(`${API}/repos/${slug}`, { headers: H }),
    fetch(`${API}/repos/${slug}/branches?per_page=100`, { headers: H }),
  ]);
  const defaultBranch = repoRes.ok ? ((await repoRes.json()) as { default_branch?: string }).default_branch ?? "main" : "main";
  if (!brRes.ok) return NextResponse.json({ branches: [], defaultBranch });
  const branches = ((await brRes.json()) as Array<{ name: string }>).map((b) => b.name);
  // Ordená: default primero, después las engine/ (builds recientes), después el resto alfabético.
  branches.sort((a, b) => {
    if (a === defaultBranch) return -1; if (b === defaultBranch) return 1;
    const ae = a.startsWith("engine/"), be = b.startsWith("engine/");
    if (ae !== be) return ae ? -1 : 1;
    return a < b ? -1 : 1;
  });
  return NextResponse.json({ branches, defaultBranch });
}
