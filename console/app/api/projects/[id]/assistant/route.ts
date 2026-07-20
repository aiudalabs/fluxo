// P5-1 · AI Assistant — proxy del console al agent-loop del WORKER (que corre el claude-agent-sdk con
// el token de suscripción en su ambiente probado). El console NO corre el SDK (alpine/root incierto);
// acá solo verifica la sesión + que el proyecto sea del tenant, y forwardea a WORKER_ASSISTANT_URL.

import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, admin } from "@/lib/server/githubAuth";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { messages?: Array<{ role: "user" | "assistant"; content: string }> };
  if (!Array.isArray(body.messages) || body.messages.length === 0) return NextResponse.json({ error: "messages requeridos" }, { status: 400 });

  // El proyecto debe ser del tenant de la sesión (no cross-tenant).
  const { data: proj } = await admin().from("projects").select("tenant_id").eq("id", id).single();
  if (!proj || (proj as { tenant_id: string }).tenant_id !== session.tenant) return NextResponse.json({ error: "sin acceso" }, { status: 403 });

  const workerUrl = process.env.WORKER_ASSISTANT_URL;
  if (!workerUrl) return NextResponse.json({ error: "AI Assistant no configurado (WORKER_ASSISTANT_URL)" }, { status: 503 });

  try {
    const r = await fetch(`${workerUrl.replace(/\/$/, "")}/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id, messages: body.messages }),
    });
    const j = await r.json().catch(() => ({ error: "respuesta inválida del worker" }));
    return NextResponse.json(j, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "el worker no responde" }, { status: 502 });
  }
}
