// POST /api/projects/[id]/dispatch · DESPACHO MANUAL de UNA unidad desde el board (F6a). Espeja
// el `reconcileBuild` del worker (design/src/worker.ts) — MISMA lógica money-safe, hecha por el
// humano que clickea ▶ en vez del tick:
//   1. Sesión + ownership (tenant) + repo.
//   2. RE-DERIVA el candidato server-side con el kernel (nunca confía en el cliente: recomputa
//      candidates() y matchea por (kind, id) — si ya no es despachable → 409).
//   3. MONEY-SAFE: marca la(s) story(s) `running` vía el RPC project_external_status (service_role,
//      bypass del state machine) ANTES de disparar → sale del set despachable, nunca doble-run pago.
//   4. workflow_dispatch a claude.yml con el token OAuth del USUARIO (la App tiene actions:write),
//      prompt del kernel (storyPrompt/sprintPrompt) + issues csv.
//   5. Si el disparo falla → revierte a `backlog`. Si tuvo éxito → PUNTO DE NO RETORNO: session_url
//      es best-effort y NO revierte (revertir re-despacharía = segundo run pago).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { verifySessionJwt, getUserToken, admin } from "@/lib/server/githubAuth";
import { loadDispatchContext, computeCandidates, loadCapabilityGate } from "@/lib/server/dispatchData";
import { githubSecretProbe, CLAUDE_SECRET, registryDir } from "@/lib/server/capabilitiesData";
import { storyPrompt, sprintPrompt } from "../../../../../../design/src/dispatch.ts";

// Guía de fidelidad visual (DATA del registry) — misma que el worker. El despacho manual también debe
// mandarle al agente la barra de calidad de UI. Ausente → "" (no-op). Strip del comentario HTML.
function uiFidelity(): string {
  try { return readFileSync(join(registryDir(), "prompts", "ui-fidelity.md"), "utf8").replace(/^<!--[\s\S]*?-->\s*/, ""); }
  catch { return ""; }
}

const API = "https://api.github.com";

function slugOf(repoUrl: string | null): string | null {
  const m = (repoUrl ?? "").replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// setStatus: escritura de proyección vía el RPC (service_role) — mismo path que el worker. Bypassa
// el state machine (backlog→running directo; running→backlog al revertir) SOLO para service_role.
async function setStatus(storyId: string, status: string): Promise<void> {
  const { error } = await admin().rpc("project_external_status", {
    p_story_id: storyId, p_status: status, p_pr_url: null, p_agent_lost: null,
  });
  if (error) throw new Error(`project_external_status(${status}): ${error.message}`);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  const session = auth?.startsWith("Bearer ") ? verifySessionJwt(auth.slice(7)) : null;
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { kind?: string; id?: string };
  if (!body.kind || !body.id) return NextResponse.json({ error: "kind + id requeridos" }, { status: 400 });

  const context = await loadDispatchContext(admin(), session.tenant, id);
  if (!context) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const slug = slugOf(context.repo);
  if (!slug) return NextResponse.json({ error: "el proyecto todavía no tiene repo" }, { status: 400 });

  // Token del usuario ARRIBA: lo necesita el readiness gate por capability (probe de secrets) además
  // del disparo. Re-derivar la verdad del despacho acá (money-safe) incluye el gate: una story que
  // referencia el secret de una capability aún no 🟢 NO es candidata (nunca se dispara un run que se
  // estrellaría). Probe fail-open ante la duda (misma verdad que GET /candidates).
  const token = await getUserToken(session.sub);
  const { gate } = await loadCapabilityGate(admin(), id, context.storyRows, githubSecretProbe(slug, token));

  // Re-derivar: la verdad del despacho se recomputa acá, no viene del cliente.
  const cands = computeCandidates(context.storyRows, context.sprintRows, context.settings, gate);
  const cand = cands.find((c) => c.kind === body.kind && c.id === body.id);
  // 409: la unidad dejó de estar lista (ya se despachó, cambió una dep, capability no 🟢, etc.).
  if (!cand) return NextResponse.json({ error: "la unidad ya no está lista para despachar" }, { status: 409 });
  if (cand.channel !== "claude_action") {
    return NextResponse.json({ error: `canal "${cand.channel}" no implementado aún (solo claude_action)` }, { status: 501 });
  }
  if (cand.members.length === 0) return NextResponse.json({ error: "candidato sin stories" }, { status: 409 });

  // ── ExecEnv fluxo_engine (docs/17) ─────────────────────────────────────────────────────────────
  // Si el proyecto corre en el engine propio, NO disparamos GitHub Actions: encolamos un build_job que
  // el poller host-level (fluxo-agent-runner) levanta y corre en docker con el token Pro/Max (cero
  // Actions, cero API metered). No necesita el github token del usuario ni el secret del repo.
  const { data: proj } = await admin().from("projects").select("settings").eq("id", id).single();
  const execEnv = (proj?.settings as { exec_env?: string } | null)?.exec_env ?? "github_actions";
  if (execEnv === "fluxo_engine") {
    const uiFid = uiFidelity();
    const enginePrompt = cand.kind === "sprint" ? sprintPrompt(cand.title, cand.members, uiFid) : storyPrompt(cand.members[0], uiFid);
    const label = cand.kind === "sprint" ? `sprint-${cand.id}` : cand.members[0].key.toLowerCase();
    for (const m of cand.members) await setStatus(m.id, "running"); // money-safe (sale del set despachable)
    const { error } = await admin().from("build_jobs").insert({
      tenant_id: session.tenant, project_id: id, label, prompt: enginePrompt,
      issues: cand.issues.join(","), story_keys: cand.members.map((m) => m.key),
    });
    if (error) {
      for (const m of cand.members) { try { await setStatus(m.id, "backlog"); } catch { /* best-effort */ } }
      return NextResponse.json({ error: `no se pudo encolar el build en el engine: ${error.message}` }, { status: 502 });
    }
    return NextResponse.json({ dispatched: true, execEnv: "fluxo_engine", kind: cand.kind, id: cand.id, issues: cand.issues });
  }

  if (!token) return NextResponse.json({ error: "github no conectado" }, { status: 403 });

  // Gate del CANAL de build: no disparar si el secret CLAUDE_CODE_OAUTH_TOKEN no está en el repo — si
  // no, la Action arranca y falla de una (y la story queda "running"). El probe existía en Settings
  // pero el despacho no lo consultaba. null (no se pudo chequear) = fail-open, como el gate de capabilities.
  if ((await githubSecretProbe(slug, token)(CLAUDE_SECRET)) === false) {
    return NextResponse.json({ error: "falta el secret CLAUDE_CODE_OAUTH_TOKEN en el repo — seteálo en Settings → Canal de build antes de despachar" }, { status: 409 });
  }

  const uiFid = uiFidelity();
  const prompt = cand.kind === "sprint" ? sprintPrompt(cand.title, cand.members, uiFid) : storyPrompt(cand.members[0], uiFid);
  const issuesCsv = cand.issues.join(",");

  // Marcá running ANTES de disparar (money-safe). Si el disparo falla, revertí a backlog.
  try {
    for (const m of cand.members) await setStatus(m.id, "running");
    const res = await fetch(`${API}/repos/${slug}/actions/workflows/claude.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fluxo", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { prompt, issues: issuesCsv } }),
    });
    if (!res.ok) throw new Error(`workflow_dispatch → ${res.status} ${await res.text()}`);
  } catch (e) {
    for (const m of cand.members) { try { await setStatus(m.id, "backlog"); } catch { /* best-effort */ } }
    return NextResponse.json({ error: `no se pudo despachar: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }, { status: 502 });
  }

  // PUNTO DE NO RETORNO: el run YA se disparó. session_url es best-effort — un fallo se loguea pero
  // NO revierte (revertir re-despacharía y pagaría un segundo run).
  const sessionUrl = `https://github.com/${slug}/actions/workflows/claude.yml`;
  for (const m of cand.members) {
    try { await admin().from("stories").update({ session_url: sessionUrl }).eq("id", m.id); }
    catch { /* best-effort */ }
  }

  return NextResponse.json({ dispatched: true, kind: cand.kind, id: cand.id, issues: cand.issues });
}
