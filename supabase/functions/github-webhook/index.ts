// F3-01 · GitHub webhook receiver (Edge Function). It verifies the HMAC signature,
// then records the delivery idempotently into public.webhook_deliveries for the
// Maestro (F3-02) to reconcile. It does NOT interpret the event — that judgement
// is the deterministic reconciler's job, kept separate so this stays a thin,
// verifiable gate.
//
// Security: the body is authenticated by X-Hub-Signature-256 (HMAC-SHA256 with the
// shared secret). An unsigned or wrongly-signed request is rejected 401 — this is
// the only trust boundary, so it is constant-time and fails closed.
//
// Idempotency: GitHub retries deliveries. The UNIQUE delivery_id + an
// ignore-duplicates upsert make a retry a no-op (200, duplicate=true).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare over equal-length hex strings.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = header.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return timingSafeEqual(toHex(mac), expected);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
  if (!secret) return json({ error: "receiver misconfigured" }, 500);

  const raw = await req.text();
  const valid = await verifySignature(secret, raw, req.headers.get("x-hub-signature-256"));
  if (!valid) return json({ error: "invalid signature" }, 401);

  const deliveryId = req.headers.get("x-github-delivery");
  const eventType = req.headers.get("x-github-event");
  if (!deliveryId || !eventType) return json({ error: "missing delivery headers" }, 400);

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const repository = payload.repository as { full_name?: string } | undefined;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Idempotent: a retried delivery hits the UNIQUE delivery_id and is ignored.
  const { data, error } = await supabase
    .from("webhook_deliveries")
    .upsert(
      {
        delivery_id: deliveryId,
        event_type: eventType,
        action: (payload.action as string) ?? null,
        repo: repository?.full_name ?? null,
        payload,
      },
      { onConflict: "delivery_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) return json({ error: error.message }, 502);

  const duplicate = !data || data.length === 0;
  return json({ received: true, duplicate }, 200);
});
