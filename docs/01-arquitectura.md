# 01 · Arquitectura v2 — agent-native "orchestration-as-data"

## Principio
**Cero infra bespoke.** El sustrato determinista NO se escribe — se **alquila como config declarativa**. Lo único
propio es el MÉTODO (markdown) + un pegamento fino. Frontera dura:

| Determinista · alquilado · config (no se escribe) | Agente · markdown (lo propio) |
|---|---|
| identidad + tenant (OAuth → JWT con `tenant_id`) | el método: fases, roles, qué pregunta cada gate |
| aislamiento = **RLS policies** | el trabajo: discovery, PRD, arquitectura, UI, código |
| máquina de estados (transiciones en datos + Maestro) | el juicio: verificación, review, art-direction |
| ruteo de eventos (webhooks GitHub, push) | la memoria: qué se escribe al brain (skill `brain-write`) |
| deploy/preview (Vercel/CF) | ejecución: Runtime × Provider en data (ver `02`) |

Cruzar la frontera (poner aislamiento/estado en un LLM) reintroduce los bugs de v1 pero no-deterministas. No cruzar.

## Las capas
```
L3 · UI (Next.js delgado)   — vista sobre el brain: board · grafo+click · brain explorer · preview · gates
        ▲ Realtime (sin polling)                                   ▲ embed preview
L0 · SUSTRATO ALQUILADO (cero código bespoke)
     Supabase: Postgres+RLS (=brain) · Realtime · Auth(GitHub OAuth→JWT) · Vault · Edge Functions(pegamento)
     GitHub:   repos(cliente) · Issues(=backlog) · Actions(runtime) · branch protection(=gates)
     Vercel/CF: preview por branch (el "Lovable" real)
        ▲ webhooks push                                            ▲ dispatch / tokens
L1 · MÉTODO   registry/ (agents·skills·workflows·templates·stacks·providers)
L2 · AGENTES  diseño → Claude Agent SDK · ejecución → runtime (ver 02) · Maestro → reconciliador DETERMINISTA
```

### L0 — Sustrato (lo que v1 construyó a mano y v2 alquila)
- **Supabase = el brain multi-tenant.** RLS: cada fila con `tenant_id` + policy `using (tenant_id =
  auth.jwt()->>'tenant')`. El aislamiento es **imposible de saltar** (la DB rechaza la lectura/escritura cruzada) —
  mata la clase de bug cross-tenant de v1. **Realtime**: la UI se suscribe, cero polling (mata el conductor 25s y el
  flap). **Auth**: GitHub OAuth → JWT con tenant. **Vault**: secrets/keys (solo runtime cloud opcional). **Edge
  Functions**: el ÚNICO pegamento (webhook router, Maestro, token-mint), cientos de líneas.
- **GitHub** = ejecución + entrega (la buena apuesta de v1, se conserva).
- **Vercel/CF** = preview por branch out-of-the-box (URL viva + logs), embebido en la UI.

### L1 — Método (data/markdown, lo único propio)
`registry/`: se CARGA de v1 casi intacto. Skill clave nueva: **`brain-write`** (append auditable al brain).

### L2 — Agentes + Maestro
- Diseño: **Claude Agent SDK** (el loop en el SDK; el rol en markdown).
- Ejecución: la **capa de runtime** (`02-capa-runtime.md`).
- **Maestro = reconciliador DETERMINISTA** (Edge Function, NO LLM): reacciona a webhooks (PR/checks/workflow_run) y
  emite la próxima acción. **Histéresis desde el día 1**: una story solo se demota en un evento terminal explícito
  (`failed/cancelled`), nunca por "no vi PR en este tick". Re-dispatch gateado por ausencia de sesión viva.

### L3 — UI
Next.js que lee Supabase directo (RLS + Realtime). Casi sin backend propio. Board, grafo de deps con
click-para-despachar, **brain explorer** (timeline auditable), preview embebido, gates conversacionales. Español-first.

## Cómo cada pieza mata un bug de v1
| Pieza v2 | Mata de v1 (`04-lecciones`) |
|---|---|
| Postgres + RLS | corrupción cross-tenant (L-ARCH-1/3), techo SQLite (L-ARCH-5), registry/settings sin authz (L-SEC-1/2/6) |
| Realtime + webhooks | conductor serial 25s (L-ARCH-4) |
| Maestro con histéresis | el FLAP (L-ARCH-2), sesiones colgadas (L-AUTO-2/4) |
| Vault | llave de la App en plaintext (L-SEC-3) |
| método 100% en registry | metodología hardcodeada en Go (L-CQ-1) |
| Runtime × Provider en data | canales hardcodeados / regla de oro rota (L-CQ-1) |
| verify como check requerido | gate verde-vacío (L-AUTO-3) |

## Análisis adversarial (dónde muere v2)
Lock-in triple (Supabase+Vercel+GitHub — pero es alquilar vs mantener 49k LOC de bugs); "cero código" es
aspiracional (~2-5k LOC reales); **RLS mal escrita = brecha silenciosa** (test de fuga cross-tenant obligatorio en
CI); el Maestro sigue siendo el corazón delicado (la tentación de "que lo decida un agente" es la trampa); managed
keys = revendedor de compute (por eso es opcional). Mitigación transversal: **strangler** (validar cada capa contra
la realidad antes de apagar la vieja).
