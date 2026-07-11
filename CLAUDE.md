# Fluxo v2 — Constitución del proyecto

**Fluxo** es una **fábrica de software gobernada**: convierte el brief de un cliente (en español) en un backlog
gateado y trazable, ejecuta el trabajo con agentes en el GitHub del cliente, y guarda todo el conocimiento en un
registro auditable (el *brain*). Vendido por **AIuda Labs** (fluxo.aiudalabs.com). ICP: **agencias/dev-shops boutique
LATAM**. Este repo es el **rebuild v2** — un sustrato nuevo que reemplaza al kernel v1 de `aiuda-forge` (auditado
2026-07-11). NO es un port de código: es *carry del método, reemplazo del sustrato*.

> **Lee `docs/` antes de tocar nada.** El orden: `00-vision` → `01-arquitectura` → `02-capa-runtime` →
> `03-roadmap` (el backlog ejecutable) → `04-lecciones` (bugs a NO repetir) → `05-ejemplo-e2e` (spec de aceptación) →
> `06-decisiones`.

---

## La tesis (por qué v2 existe)

v1 construyó su propio sustrato (store SQLite, conductor serial, aislamiento a mano, minting de tokens, canales
hardcodeados) — y **ahí vivían TODOS los bugs críticos** de la auditoría, que *"se arreglan y vuelven"* porque son
arquitectónicos. v2 **alquila el sustrato determinista como config declarativa** y deja como código propio solo el
método (data/markdown) + un pegamento fino. ~49k LOC de Go → ~2-5k de pegamento + config.

| CARGAR (el valor, portable) | REEMPLAZAR (el sustrato roto → plataforma) |
|---|---|
| el método: `registry/` (agents·skills·workflows·templates·stacks) | store SQLite → **Postgres + RLS** |
| la consola (UI) | conductor serial 25s → **Maestro por webhooks + histéresis** |
| los harnesses de verify (e2e·lint·ui) | scoping a mano → **RLS declarativa** |
| el conocimiento operativo (`docs/04-lecciones`) como contratos/tests | tokens en archivo → **Vault** · canales en Go → **Runtime×Provider en data** |

## Golden Rules (no negociables)

1. **Cero metodología en código.** El método vive en `registry/` (YAML + markdown). NUNCA `if step.id == …` ni una
   persona/PRD/jerarquía-de-backlog en Go. El ejecutor es genérico y data-driven.
2. **Determinismo donde el gaming/error es barato; agente donde hace falta juicio.** Identidad, aislamiento (RLS),
   máquina de estados, ruteo de eventos = código/config determinista. Diseño, código, verificación de juicio = agentes.
   **Nunca** derivar estado crítico de una sola lectura eventual sin histéresis (fue el "flap" de v1).
3. **Aislamiento multi-tenant = RLS, en un solo lugar.** Toda tabla lleva `tenant_id`/`project_id` + policy. Prohibido
   el `WHERE id=?` sin scope. Un test de fuga cross-tenant en CI es obligatorio (bloqueante).
4. **El sustrato se ALQUILA, no se construye.** Postgres/RLS/Realtime/Auth/Vault (Supabase por defecto, ver
   `06-decisiones`) · GitHub (repos/Issues/Actions) · Vercel/CF (preview). Lo propio es método + pegamento.
5. **Ejecución agnóstica: Runtime × Provider × ExecEnv, en data.** `registry/providers/*.yaml`. Sumar un engine
   (local/docker/E2E/cloud) o un CLI (claude/copilot/codex/…) = data, cero Go. Credenciales por-runtime; el default
   (github_actions) usa las del CLIENTE (BYO, cero COGS).
6. **Tests antes que implementación en lo determinista.** El kernel es el moat: chiquito y fuertemente testeado.
   NUNCA debilitar un test para que pase.
7. **Strangler, no big-bang.** Cada capa se valida contra la realidad antes de apagar la vieja. Empezar por el brain
   (aditivo). Cargar las lecciones de `04-lecciones` como contratos/tests — no re-aprender viejos bugs.
8. **Commits chicos, convencionales, verdes. Una tarea = un branch = un PR.** Español en docs/UX; código en inglés.

## Layout del repo

```
docs/          la fuente de verdad del diseño (leer en orden 00→06)
registry/      EL MÉTODO como data: agents/ skills/ workflows/ templates/ stacks/ providers/
control/       pegamento Go mínimo (API, tenant-resolve, dispatch a runtime) — lo más delgado posible
supabase/      migrations/ (schema + RLS) · functions/ (webhook receiver, Maestro, token-mint)
console/       UI Next.js (vista sobre el brain: board, grafo, studio, brain explorer, preview)
```

## Protocolo de build autónomo (para sesiones nuevas)

Cuando una sesión arranca a construir:

1. **Leé** `CLAUDE.md` + `docs/` (todo). Entendé la fase actual.
2. **Abrí `docs/03-roadmap.md`** y tomá la **primera tarea sin marcar `[ ]`** respetando dependencias (no saltees fases).
3. **Implementá** esa tarea: tests primero en lo determinista; RLS/policy si toca datos; método en `registry/` si es
   metodología. Contra el AC de la tarea.
4. **Verificá de verdad** (corré los tests/linters; para lo que tenga UI, drivealo). No declares "listo" sin correr.
5. **Marcá la tarea `[x]`** en el roadmap, commit convencional, y seguí con la próxima.
6. **Si una decisión no está tomada** (ver `06-decisiones`, marcadas ⚠️), NO adivines algo con costo/lock-in
   irreversible: dejá la tarea, anotá la pregunta en `06-decisiones` y seguí con otra tarea desbloqueada.
7. **Repetí hasta que `03-roadmap.md` esté 100% en `[x]`** y el `05-ejemplo-e2e.md` corra de punta a punta.

**Regla de oro del loop:** preferí una verdad incómoda ("esto no lo puedo cerrar sin decidir X") a un avance falso.
Nunca marques `[x]` algo que no verificaste.

## Estado

Bootstrap inicial (2026-07-11). Sin código todavía — el skeleton y los docs están; la construcción empieza en
sesiones nuevas siguiendo `docs/03-roadmap.md`. Decisión abierta que gatea la Fase 1: la apuesta de plataforma
(Supabase por defecto — confirmar en `06-decisiones`).
