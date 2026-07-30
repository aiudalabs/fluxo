// POST /api/projects/[id]/build-jobs/cancel · Detener un build del ExecEnv fluxo_engine.
// Marca el build_job status='cancelling'; el tailer host-level (fluxo-engine-tail) lo ve, mata el
// proceso del agente en el VPS, lo pasa a failed y revierte las stories a backlog. (El console no
// puede matar procesos del host directo — señaliza por la DB, como todo el resto del engine.)
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, admin } from "@/lib/server/githubAuth";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { id?: string };
  if (!b.id) return NextResponse.json({ error: "id del build requerido" }, { status: 400 });

  // Solo builds del proyecto+tenant, y solo si está corriendo.
  const { error } = await admin().from("build_jobs")
    .update({ status: "cancelling", updated_at: new Date().toISOString() })
    .eq("id", b.id).eq("project_id", id).eq("tenant_id", session.tenant).eq("status", "running");
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ ok: true });
}
