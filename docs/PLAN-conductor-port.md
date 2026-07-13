# Plan: portar el CONDUCTOR de v1 → v2 (Fluxo)

**Estado:** spec para ejecutar (puede arrancar en sesión nueva con fidelidad total).
**Fecha:** 2026-07-13.
**Repos:** v1 = `~/projects/genai/aiuda-forge` (Go, `engine/internal/`). v2 = `~/projects/genai/fluxo` (worker TS en `design/src/`, console Next.js).

---

## 0. TL;DR

v2 hoy tiene un **dispatcher ingenuo** (`design/src/worker.ts` → `reconcileBuild`): promueve `backlog→ready` por deps y dispara `claude.yml` **por story**. Le falta el **cerebro** de v1: la **proyección** (GitHub = verdad → estado de las stories), el **despacho por sprint** (goal-mode), el **auto-merge gated por reviewer**, y los **guards**. Sin proyección, una story despachada queda en `running` para siempre y nada avanza.

**El modelo de v1 es correcto y es lo que queremos** — v1 no falló por la orquestación, falló por detalles de ejecución (builds de mobile, fragilidad del gate por-stack). Portamos el MODELO, no los bugs.

**Requisitos del usuario (confirmados):**
1. Despachar **sprints independientes** (paralelos si no hay deps cross-sprint) — Y también **por story**: los DOS modos, elegibles por `execution_unit` (setting por proyecto). NO es sprint-only.
2. **Esperar a que el humano mergee** (manual-merge default). El siguiente sprint dependiente espera hasta el merge.
3. **Auto-merge opcional**, pero solo si **un reviewer sobre el sprint** valida (check `claude-review` aprobado + checks CLEAN). Sprint = 1 PR ⇒ el reviewer es "sobre el sprint completo".

**Regla de oro:** aditivo, sin romper lo que v2 ya tiene funcionando (auth, gate de creación, Settings, labels, crash-resume del diseño).

---

## 1. Cómo funciona el conductor de v1 (el mapa)

v1 tiene DOS schedulers; el **activo** es el **conductor GitHub-native** (`engine/internal/conductor/*` + tick en `engine/internal/app/app.go`). El legacy (`engine/internal/orchestrator/native.go`) es la referencia de conceptos que el conductor "mirrorea" (ceremonias, reviewer in-run). Portamos el **conductor**.

### A. El tick loop
- `app.go:789-864` `conductorLoop`, **cada 25s** (`VIBEFORGE_GITHUB_SYNC_INTERVAL`, 0 = off). Orden por proyecto con repo: **proyectar → aprobar-workflows → auto-merge → (gate dispatch) → despachar**.
- Pasos: `Projector.SyncProject` (`app.go:806`) → `GetSettings` (`app.go:817`) → `SweepSafeApprovals` si `auto_if_safe` (`app.go:824`) → `autoMerge` si `merge_mode=auto` (`app.go:834`) → si `dispatch_mode != auto` corta (botón-only) → `Dispatcher.Candidates` + `Dispatch` (`app.go:848-861`).

### B. Proyección (GitHub = verdad) — LA PIEZA QUE FALTA EN V2
`engine/internal/conductor/projection.go`, `SyncProject` (`projection.go:266-578`). Lee `ListIssueStates` + `ListOpenPRs`. Liga story↔issue por `external_ref = github:owner/repo#N`. Deriva estado (switch `projection.go:494-542`):
- **→ done**: issue `closed` (`:497`). PR mergeado sin auto-close → el bloque `closer` (`:426-460`) fuerza `CloseIssue`.
- **→ in_review**: PR abierto no-draft que cierra el issue (`:500-506`), guarda `pr_url`.
- **→ running**: PR draft que cierra el issue, O issue asignado a un agente (`isAgent()` `:189-199`), O label `agent:running` con run vivo (`deriveLabelAnchor` `:588-633`), O sesión Copilot viva (`:525-540`).
- **→ backlog** (default/recuperación): sin PR, sin agente, sin label/sesión viva (`:494`).
- Link PR→issue: closing keywords `Closes/Fixes/Resolves #N` (regex `:246`, `prFor` `:349-356`) O mención del ID de story (`:361-371`).
- Escribe con `SyncExternalStatus(id, target, prURL)` (`tickets.go:1153-1186`) que **bypassa `legalSources`** a propósito (GitHub puede reabrir done→backlog).
- **agent_lost / recuperación**: task Copilot muerta (404 sostenido > `notFoundDeathThreshold=8`) o label `agent:running` stale sin run vivo (`staleLabelThreshold=8` ticks) → `MarkAgentLost` + vuelve a backlog + `ClearStorySession` (`:373-419`, `:588-632`). En el conductor NO se escribe `failed` (eso es legacy); un agente perdido va a **backlog** re-despachable con badge `agent_lost`.

### C. Despacho: SPRINT vs STORY (los dos modos)
`engine/internal/conductor/dispatch.go`, `Candidates` (`:159-258`). `Policy` (`:25-32`) trae `ExecutionUnit`, `MaxConcurrency`, `ModelByLane`, `ExecutorByLane`.
- **STORY mode** (`:200-212`): cada story backlog mirrored con deps done (`storyReady` `:188-198`) → `Candidate{Kind:"story"}`. Prompt = un issue (`buildPrompt` `:449-459`), "Open a PR whose description includes `Closes #N`".
- **SPRINT mode / goal-mode** (`:214-257`): el sprint entero como UNA unidad → `Candidate{Kind:"sprint", Stories:[…]}` (`:251-254`). Un branch, un agente que implementa TODAS las stories **en orden de deps**, **un PR** con `Closes #a, Closes #b, …` (prompt goal-mode `:462-482`). Stories ordenadas por ID (`:243`); lane = `dominantLane` (`:554-567`).
- **Readiness del sprint / gate cross-sprint** (`:216-255`): dispatchable si `pending>0` **Y** `inFlight==0` (nada Running NI InReview `:230-231`) **Y** `!gated` (toda dep cross-sprint — `depSt.SprintID != sid` — está done `:233-238`). ⇒ **sprints sin deps cross-sprint corren en paralelo; uno que depende de otro espera al merge del prerequisito.**
- **Concurrencia** (`:170-180`): `inFlight` = stories `running` en el proyecto; si `MaxConcurrency>0 && inFlight>=MaxConcurrency` → nil.

### D. Merge + WAIT-FOR-MERGE
`MergeMode`: `manual` (default) | `auto` (`projects.go:32-33`).
- **manual**: no hay "wait" explícito — **emerge** de proyección + gate. PR abierto → stories `in_review` (`projection.go:504`). En sprint-mode `inFlight` cuenta Running **O InReview** (`dispatch.go:230`), así el sprint no se re-despacha; y el sprint dependiente queda `gated` hasta que **mergees** (issue cierra → story done → gate clarea). Sprints independientes siguen en paralelo. **No hay bloqueo global; el gate es por-dependencia.**
- **auto**: `app.go:742-772` `autoMerge`. Por story `in_review` con `pr_url`: lee `PRMergeInfo` (`workflows.go:133`); mergea (`gh pr merge --squash --delete-branch`, `github.go:228`) **solo si** `!Draft && State==OPEN && MergeStateStatus==CLEAN && ReviewDecision!=CHANGES_REQUESTED` (`app.go:762`). Retries acotados (`autoMergeFails>=3` deja al humano).
- **workflow_approval / auto_if_safe**: `approve.go`. Los runs CI de PRs de agentes quedan `action_required` (un agente podría editar CI). `SweepSafeApprovals` (`:68-92`) los aprueba **solo si** ningún archivo cambiado toca `.github/workflows/**` (`prSafe`/`unsafePath` `:26-64`). Si toca workflows → queda para el humano.

### E. El REVIEWER (para gate del auto-merge) — requisito #3
En el conductor, el reviewer es un **check de GitHub Actions por-PR**, scaffoldeado en el repo:
- `claude-review.yml` — reviewer **cross-modelo** en cada PR (`registry/templates/github-native/_common/.github/workflows/claude-review.yml.tmpl`). Un REQUEST_CHANGES pone `reviewDecision = CHANGES_REQUESTED`.
- `ui-verify.yml` — gate de aceptación visual (persona `art-director`).
- `suite-integrity` — el conteo de tests no puede bajar (`gate/gate.go`).
- **Auto-merge gated en el reviewer** = `MergeStateStatus==CLEAN` (todos los checks verdes, incl. claude-review/ui-verify/suite-integrity) **Y** `ReviewDecision != CHANGES_REQUESTED`. Como sprint = 1 PR ⇒ **es review por-sprint**. (El legacy además tenía un `agentic_verify` in-run + ceremonia `sprint-review` con hold — referencia si querés review humano por-sprint.)

### F. Canales + failover + mecánica de disparo
`dispatch.go` `fireChannel` (`:383-430`); superficie GitHub `engine/internal/github/dispatch.go`.
- **claude_action** (`:385-419`): `workflow_dispatch` a `claude.yml` (ref main, inputs `{prompt, issues}`) + preámbulo "ephemeral runner discipline" (`:389-398`) + `SetIssueRunning` (label `agent:running` inmediato, cierra el gap dispatch→run).
- **copilot** (`:420-429`): Copilot Agent tasks API `POST /agents/repos/{slug}/tasks {prompt, create_pull_request, model}`.
- **Pre-check de capacidad** (`capacityBlock` `:363-376`): claude_action requiere el secret `CLAUDE_CODE_OAUTH_TOKEN` (`RepoSecretExists`) o corta con razón visible.
- **Failover** (`Dispatch` `:308-333`): si el canal primario falla, cae al otro (no silencioso, setea `FallbackReason`).
- **Model/executor por lane** (`ModelByLane`/`ExecutorByLane` `:29-30`).
- **Reflejo inmediato** (`:337-345`): `SyncExternalStatus`→running + `SetStorySession` (link "ver sesión").
- **Grooming JIT** (`groom.go`): expande el body del issue con spec dev-ready antes de despachar (best-effort, no bloquea).

### G. State machine + guards
- **legalSources** (`tickets.go:97-116`): `running←backlog`, `in_review←running`, `done←in_review` (running→done PROHIBIDO), `failed←{backlog,running,in_review}`. `SyncExternalStatus` bypassa esto para stories GitHub-mirrored.
- **Guards de orden**: (1) `gateOnDocs`/`docsOnMain` (`dispatch.go:125-150`): si `docs/PRD.md` no está en `main`, HOLD todos los candidates (fail-open). (2) legacy `.vibeforge-gate`-on-dev. (3) `prGate`: run DONE debe dar PR usable.
- **Requeue** (failed→backlog): `RequeueSprint`/`RequeueStory` (`tickets.go:1472-1551`) — set `status=backlog, run_id='', pr_url=''`. En sprint-mode resucita el sprint entero.

### Ciclo de vida (un sprint, conductor)
backlog → `Candidates` (sprint sin deps cross-sprint) → `Dispatch` (`fireChannel` claude.yml, un branch/PR) → stories **running** → agente abre PR → proyección: **in_review** → **WAIT** (sprint dependiente `gated`) → merge (manual o auto-gated-por-reviewer) → issue cierra → **done** → siguiente sprint se desbloquea.

---

## 2. Qué tiene v2 hoy vs qué falta

**v2 tiene:**
- Worker con tick (`design/src/worker.ts`): `reconcileDesign` (crash-resume OK) + `reconcileBuild` (promueve backlog→ready por deps + dispara `claude.yml` **por story**, con installation token).
- Cliente GitHub dep-light (`design/src/github.ts`): `GithubApp.installationToken`, `GithubRepo` con `dispatchWorkflow`, `createIssue`, `putFile`, `ensureLabel`, `fromUrl`.
- Store Supabase (`design/src/supabase.ts`) + handoff (`design/src/handoff.ts`: crea repo + docs + issues + labels de colores + scaffold `claude.yml`).
- Settings (`projects.settings` jsonb): `channel`, `merge_mode`, `execution_unit`, `max_concurrency`, `workflow_approval`, `lanes:{lane:{channel,model}}` — **se guardan pero el worker NO los aplica todavía**.
- State machine (migration `20260712054615_story_state_machine.sql`): `backlog→ready→running→review→done`, `review→done` only, `blocked`/`failed` + `failed→ready`. **OJO vocab v2: usa `review` (no `in_review`) y `blocked`; el board adapta a `in_review` en `statusToken`.**
- RPC `dispatch_story` (`20260712064441_dispatch_story.sql`): flip ready→running + crea run (DB-only, NO dispara GitHub).
- Board (`console/app/projects/[projectId]/board/Board.tsx`): `KanbanBoard` SOPORTA `onDispatch`/`candidates` pero **Board.tsx no los cablea** (no hay botón hoy).

**Falta (el gap):**
| Pieza | v1 | v2 |
|---|---|---|
| **Proyección** GitHub→story (open→review, merge→done, agent_lost) | ✅ `projection.go` | ❌ **no existe** |
| Despacho **sprint goal-mode** (1 branch/PR, Closes #…) | ✅ `dispatch.go:214` | ❌ (solo per-story) |
| Gate **cross-sprint** (independientes en paralelo) | ✅ `dispatch.go:216-255` | ❌ (solo deps por-story) |
| **Auto-merge** gated CLEAN + review | ✅ `app.go:742` | ❌ |
| **Reviewer** `claude-review.yml` scaffold | ✅ template | ❌ (solo `claude.yml`) |
| `workflow_approval: auto_if_safe` | ✅ `approve.go` | ❌ |
| Guard `docs-on-main` | ✅ `dispatch.go:125` | ❌ |
| Aplicar knobs de Settings (execution_unit, max_concurrency, channel/model por lane) | ✅ | ❌ (se guardan, no se usan) |
| Botón de despacho manual en el board | ✅ | ⚠️ componente listo, no cableado |

---

## 3. Plan de port (fases; cada una buildable + testeable)

> Todo en el worker TS (`design/src/`) + scaffold en `registry/templates/`. Poll (tick del worker) primero; webhooks después. Los knobs salen de `projects.settings`.

### Fase 1 — PROYECCIÓN (la piedra angular; sin esto nada avanza) — ✅ HECHA (2026-07-13, branch `feat/conductor-f1-projection`)

**Entregado:** `design/src/projection.ts` (`derive` puro + `Projector` con histéresis), lectura GitHub en
`design/src/github.ts` (`listIssues`/`listPulls`/`liveRunCount`), migración
`20260713150000_project_external_status.sql` (RPC `project_external_status` SECURITY DEFINER + GUC
transaction-local `fluxo.external_sync` que bypassa el trigger SOLO para service_role), y el paso
`reconcileProjection` cableado ANTES de `reconcileBuild` en el tick del worker. 19 tests unitarios +
verificación funcional en Postgres local (trigger intacto para el tenant, bypass no fuga entre txns).
**Decisión resuelta:** bypass = RPC dedicado (no relajar el trigger). **Histéresis:** agent_lost solo tras
N=8 ticks sin PR/asignado/label Y con `liveRunCount==0` (evita el flap durante el trabajo real del agente).


- **Nuevo** `design/src/projection.ts`: `syncProject(repo, stories)` que lee issues+PRs de GitHub (installation token, `GithubRepo`), liga por `external_ref` (`github:owner/repo#N`) + `Closes #N` / mención de ID, y deriva `running / review / done / backlog` (espejar `projection.go:494-542`).
- Escribir con un `syncExternalStatus` que **bypassa el trigger** del state machine (equivalente a `SyncExternalStatus`): probablemente un RPC `SECURITY DEFINER` o un update service_role que el trigger permita para transiciones GitHub. **DECISIÓN**: cómo bypassar el trigger limpio (RPC dedicado `project_external_status(story, status, pr_url)`).
- Recuperación: label `agent:running` stale (contador N ticks) → backlog + nota `agent_lost` (v2 ya tiene `agentLost.ts` en console + campo `agent_lost`).
- Meter `syncProject` como PRIMER paso del tick del worker, antes de `reconcileBuild`.
- **Test:** un PR abierto con `Closes #1` → story #1 pasa a `review`; mergeado → `done`; deps se desbloquean. (Fixture o repo real.)

### Fase 2 — DESPACHO ambos modos (story + sprint) desde Settings — ✅ HECHA (2026-07-13, branch `feat/conductor-f2-dispatch`)

**Entregado:** `design/src/dispatch.ts` — kernel PURO del despacho: `candidates()` (story mode + sprint
goal-mode con gate cross-sprint), `channelFor`/`modelFor` (routing por lane), `storyPrompt`/`sprintPrompt`.
`reconcileBuild` refactorizado en `worker.ts` para leer `projects.settings` → `Policy` (`execution_unit`,
`max_concurrency`, `channel`, `lanes`); marca running vía el RPC bypass ANTES de disparar (anti-doble-dispatch)
y revierte a backlog si el disparo falla; `session_url` → página de runs. 15 tests unitarios + verificación
LIVE en dry-run contra Idearium (local DB, 20 stories/8 sprints): story mode → las 2 stories sin deps (issues
1,2); sprint mode → SOLO SP1 (issues 1,2,3 como una unidad goal-mode), SP2–SP8 gated por deps cross-sprint.
**Nota:** el label `agent:running` lo maneja el propio `claude.yml` (set al arrancar / clear en `always()`),
así que el despacho NO lo toca; la proyección (F1) lee ese label + `liveRunCount`. **Copilot** aún no cableado
en el cliente v2 → si una lane pide `copilot`, se avisa y se omite (no se finge). **Pendiente para dispatch
real:** sembrar `CLAUDE_CODE_OAUTH_TOKEN` en el repo (Settings → Canal); sin el secret el run arranca y muere
(el pre-check de capacidad `capacityBlock` de v1 es de Fase 5).


- Refactor `reconcileBuild` → leer `settings.execution_unit`.
  - **story mode** (lo actual, pero leyendo el modo): un issue → `claude.yml`.
  - **sprint mode**: bundle del sprint entero → un `workflow_dispatch` con prompt goal-mode (`Closes #a, #b, …`), un branch, un PR. Espejar `dispatch.go` Candidates sprint + prompt goal-mode.
- **Gate cross-sprint**: un sprint es dispatchable si `pending>0 && inFlight==0 (running|review) && !gated` (toda dep cross-sprint done). Sprints independientes en paralelo.
- **Concurrencia**: `settings.max_concurrency` (no `--max` CLI).
- **Canal/model por lane**: `settings.lanes` + `settings.channel`.
- **Test:** sprint sin deps se despacha; el dependiente espera; en story-mode una story a la vez.

### Fase 3 — SCAFFOLD del reviewer (para gate del auto-merge)
- Portar templates a `registry/templates/github-native/`: `claude-review.yml` (reviewer cross-modelo), `ui-verify.yml` (opcional, lanes UI), `suite-integrity`.
- El handoff (`handoff.ts` scaffold) los commitea junto a `claude.yml`.
- **Test:** un PR nuevo dispara `claude-review`; un REQUEST_CHANGES se refleja en `reviewDecision`.

### Fase 4 — AUTO-MERGE gated (detrás de `merge_mode: auto`)
- **Nuevo** paso en el tick: por story `review` con `pr_url`, leer merge info (`gh pr view` / API: `mergeStateStatus`, `reviewDecision`, `state`, `draft`) y mergear (`gh pr merge --squash --delete-branch` o API) **solo si** `!draft && state==OPEN && mergeStateStatus==CLEAN && reviewDecision != CHANGES_REQUESTED`. Retries acotados.
- Requiere permiso `pull_requests: write` (la App ya lo tiene).
- **Test:** PR con checks verdes + review aprobado → auto-merge; con CHANGES_REQUESTED o check rojo → NO mergea.

### Fase 5 — GUARDS + workflow approval
- `workflow_approval: auto_if_safe`: aprobar runs `action_required` salvo que el diff toque `.github/workflows/**` (espejar `approve.go`). Requiere `actions: write` (la App lo tiene).
- Guard `docs-on-main`: no despachar si `docs/PRD.md` no está en `main` (fail-open).
- **Test:** un PR que toca workflows NO se auto-aprueba; sin PRD en main no despacha.

### Fase 6 (UI) — botón de despacho manual + monitor
- Cablear `candidates`/`onDispatch` en `Board.tsx` → endpoint `POST /api/projects/[id]/dispatch` que corre la lógica de `Dispatch` para un candidate.
- Vista Agentes/monitor: sesiones running + cola de PRs + aprobar workflows (espejar la vista Agentes de v1).

---

## 4. Reglas para no romper v2

1. **Aditivo.** No tocar auth, gate de creación, Settings, labels, crash-resume del diseño salvo para LEER settings.
2. **El método vive en `registry/` (YAML/markdown), NUNCA hardcodear metodología en el worker.** (golden rule del proyecto.)
3. **`statusToken.ts` es la única fuente de colores/estados de la UI.**
4. **Vocab de estados v2**: `review`/`blocked` en DB; la UI adapta a `in_review`. No introducir `in_review` en DB.
5. **Proyección debe bypassar el trigger del state machine** para stories GitHub-mirrored (GitHub puede reabrir), pero SIN romper el trigger para el resto.
6. **Todo con tests** (`design`: `npm test` verde; console: lint verde) y commits convencionales. Una fase = un branch = un PR.
7. **No fabricar** IDs/tokens/URLs. El secret del canal nunca se guarda en Fluxo.
8. **Poll primero, webhooks después** — no meter webhooks hasta que la proyección por poll funcione.

---

## 5. Decisiones abiertas (resolver al ejecutar)
- **Bypass del trigger para la proyección**: RPC dedicado `project_external_status(...)` SECURITY DEFINER vs relajar el trigger. (Recomendado: RPC dedicado, explícito.)
- **Poll vs webhook**: arrancar poll (tick 25s como v1); webhooks (receptor F1) después.
- **Review humano por-sprint** (además del reviewer automático): ¿portar la ceremonia `sprint-review` con hold, o alcanza con el check `claude-review` + merge manual? (v1 tiene ambos; el conductor usa solo el check.)
- **Grooming JIT** (`story-detailer` antes de despachar): ¿v1-parity ahora o después?

---

## 6. Punto de entrada para una sesión nueva
1. Leé este doc + el mapa de v1 (sección 1) — los `file:line` apuntan a `~/projects/genai/aiuda-forge/engine/internal/`.
2. Estado y decisiones previas: `~/.devtrace/decisions/fluxo.md` + la memoria del proyecto.
3. Arrancá por **Fase 1 (Proyección)** — es la que convierte el dispatcher en conductor.
4. Corré la demo E2E contra un repo real (Idearium: `github.com/nmlemus/idearium`, 20 issues, project_id `0b4a923c-f295-431a-9f51-af461462dd80`) — pero primero sembrá el `CLAUDE_CODE_OAUTH_TOKEN` (rotado) en Settings → Canal de build.
