// GET /api/preview/tls-allow?domain=<host> · guard del on-demand TLS del Caddy de prod (release v2 /
// docs/14). Antes de emitir un cert Let's Encrypt para un preview, Caddy pregunta acá: SOLO autorizamos
// hosts de previews ACTIVOS (status=live con ese preview_url). Sin este guard, cualquiera con un SNI
// random `*.sslip.io` dispararía emisión ilimitada de certs (rate-limit / DoS). Server-side + service_role
// (no confía en el cliente). Responde 200 = emitir, 403 = no.
import { NextRequest, NextResponse } from "next/server";
import { admin } from "@/lib/server/githubAuth";

const HOST_RE = /^preview-[a-z0-9]+\.[0-9.]+\.sslip\.io$/;

export async function GET(req: NextRequest) {
  const domain = (req.nextUrl.searchParams.get("domain") ?? "").toLowerCase();
  if (!HOST_RE.test(domain)) return new NextResponse("no", { status: 403 });
  try {
    const { data } = await admin()
      .from("preview_requests")
      .select("id")
      .eq("status", "live")
      .like("preview_url", `%${domain}%`)
      .limit(1);
    return data && data.length > 0 ? new NextResponse("ok", { status: 200 }) : new NextResponse("no", { status: 403 });
  } catch {
    return new NextResponse("no", { status: 403 });
  }
}
