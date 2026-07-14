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

## ▶ PRÓXIMA SESIÓN — correr el E2E BROWSER-DRIVEN del conductor (pedido explícito del usuario)

El **conductor F1–F4 + la UI F6 (despacho manual + monitor Agentes) ya están en `main`**
(proyección + despacho story/sprint + reviewer scaffold + auto-merge gated + botón ▶ en el board +
vista Agentes + `dispatch_mode:manual`). **El loop nunca se corrió end-to-end de verdad** — solo
unit tests (design 94/94, console 8/8) + smoke de GET /candidates contra Idearium local. La tarea
pedida para una sesión con contexto limpio: **ejecutar el E2E real, ahora BROWSER-DRIVEN, y verlo
funcionar** (clickear ▶ Despachar en el board en vez de correr el worker a mano).

1. **LEÉ `docs/E2E-conductor.md`** — runbook paso a paso, ya actualizado a browser-driven
   (dispatch_mode=manual: el humano despacha desde el board, el worker corre SOLO para proyectar +
   auto-mergear). NO es un test Playwright (v2 no tiene harness de browser); se observa en el console + `gh`/API/DB.
2. Contexto del port: `docs/PLAN-conductor-port.md` (spec + mapa de v1). Decisiones: `~/.devtrace/decisions/fluxo.md`.
3. **Requiere acciones del usuario** (pediles antes de arrancar): (a) login con GitHub en el console
   (para que POST /dispatch actúe como el usuario), (b) sembrar el `CLAUDE_CODE_OAUTH_TOKEN` ROTADO en
   Settings → Canal de build de Idearium, (c) OK para escribir a su repo (`nmlemus/idearium`) en el re-scaffold,
   (d) setear `dispatch_mode:manual` en Settings del proyecto (por ahora vía DB — ver runbook §3).
4. ⚠️ **Cuesta plata** (dispara un agente Claude real en las Actions del repo con el token del usuario) → empezá
   con UNA story (story-mode, sin deps: S1-01 o S1-02) antes de sprint-mode / auto-merge.
5. Pendiente además: **Fase 5** (workflow_approval `auto_if_safe` automático + guard docs-on-main; F6b hace
   el approve MANUAL desde Agentes, que alcanza para operar). Toggle de `dispatch_mode` en la UI de Settings
   (hoy solo por DB). Canal Copilot sin cablear. El E2E va PRIMERO — valida lo que ya está en main.

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

## Decisiones ya tomadas — defaults firmes (NO volver a preguntar)

- **D1 ✅ Supabase** (managed; local-first con el CLI para dev).
- **D2 ✅ Claude Agent SDK** para los agentes de diseño (dirección; la versión se pinea en F5-01).
- **Deps pre-aprobadas:** Next.js + @supabase/supabase-js (console), Claude Agent SDK (F5); `control/` stdlib-first
  (una dep nueva solo si un doc la nombra).
- **brain / tenant:** escrituras con **JWT de tenant** (RLS aplica de verdad); `service_role` solo para paths de sistema/admin.
- **Auth real** (GitHub-OAuth → JWT con claim `tenant`) es una tarea posterior; hasta entonces usá un **dev-shim** del claim y seguí — no es un bloqueo.
- **D4 (repo remoto/org):** solo bloquea `git push`. Construí y commiteá local sin parar por D4.
- **D3 (alcance última milla):** se define al llegar a Fase 7; no bloquea nada antes.

Si alguna se reabre, lo dice el humano — la sesión no las vuelve a preguntar. Detalle en `docs/06-decisiones.md`.

## Estado

Rebuild en marcha (2026-07). Fase 0 completa + Fase 1 en curso (brain a Postgres+RLS: F1-01/02 hechos). La
construcción sigue el protocolo autónomo de `GOAL.md` sobre `docs/03-roadmap.md`. El único bloqueo real pendiente es
**D4** (repo remoto) y solo para `git push` — el trabajo local NO para por eso.
