# 03 · Roadmap ejecutable (el backlog que maneja el build)

Este es el **goal del proyecto**: una sesión toma la **primera tarea `[ ]` sin marcar**, respetando fases y
dependencias, la implementa con tests, la **verifica de verdad**, la marca `[x]`, commitea, y sigue. Termina cuando
TODO está `[x]` y `05-ejemplo-e2e.md` corre end-to-end. No saltear fases. No marcar `[x]` sin verificar.
Convención: `[ ] Fx-NN título — AC: <criterio verificable> · closes: <lección/gap>`.

---

## Fase 0 · Bootstrap
- [x] F0-01 Confirmar apuesta de plataforma — ✅ **Supabase managed** (06-decisiones D1, 2026-07-11). Próximo: F0-02.
- [x] F0-02 Provisionar Supabase (dev, **local-first con CLI**) — `supabase init` ✅ + `supabase start` ✅ (stack vivo: API :54321, DB :54322, Studio :54323), keys locales en `.env` (no commiteado), y `supabase db reset` aplica la 1ª migración limpio. Hosted (staging/prod) queda para D4/deploy. AC: stack levanta y `db reset` corre limpio. ✅ (Docker 29.6.1; 2026-07-12.)
- [x] F0-03 CI base — AC: pipeline que corre migraciones, tests Go, lint console, y el **test de fuga cross-tenant** (aunque vacío aún). ✅ `.github/workflows/ci.yml` (4 jobs: registry·control·database[+postgres:17]·console) — cada job delega a `scripts/ci.sh <stage>` (misma verificación local y CI, cero drift). Stages sin artefacto aún (migrations F1-01, leak F1-05/F2-04, console F6) hacen SKIP **anunciado** (no silencioso, L-AUTO-3). Verificado: `scripts/ci.sh` verde local (registry+control reales), `actionlint` y `shellcheck` limpios. La corrida en GitHub Actions queda pendiente del 1er push (D4).
- [x] F0-04 Skeleton `control/` (Go) — AC: binario que arranca, healthcheck, config por env; sin lógica de negocio todavía. ✅ módulo `github.com/aiudalabs/fluxo/control`; `/healthz`+`/readyz` (JSON), config por env (CONTROL_ADDR/CORS), shutdown grácil; `go vet`+tests verdes, binario driveado con curl. Sin metodología ni aislamiento a mano (golden rule).
- [x] F0-05 Cargar `registry/` de v1 — AC: agents/skills/workflows/templates copiados de aiuda-forge y validados (parsean). ✅ copia verbatim de `aiuda-forge/engine/registry` (agents 22 pares, skills 17, workflows 11, templates 50). Validador `registry/validate.py` (PyYAML): 33 YAML parsean con `id`, pares md/yaml OK, steps OK → verde. `stacks/` (perfiles hoy en templates/github-native) y `providers/` (F4-02) diferidos; `backends/` de v1 NO copiado (esquema v2 distinto). Ver `registry/README.md`.

## Fase 1 · Brain a Postgres+RLS (moat · aditivo)
- [x] F1-01 Schema `brain_events` (append-only) + RLS — AC: `tenant_id,project_id,kind,payload,actor,ts`; policy por tenant; **pgTAP: lectura cross-tenant RECHAZADA**. ✅ migración `supabase/migrations/20260712033907_brain_events.sql` (tabla + índice `(tenant_id,project_id,ts desc)` + RLS `enable`); policies `select/insert` scoped a `auth.jwt()->>'tenant'`; append-only por grants (authenticated: solo SELECT/INSERT; revoke UPDATE/DELETE/TRUNCATE; anon revoke all). Test pgTAP `supabase/tests/brain_events_rls_test.sql` (6 asserts) **PASS** vía `supabase test db`: read cross-tenant RECHAZADA, insert cross-tenant RECHAZADO, append-only OK. closes: L-ARCH-1 (parcial; F1-05 lo hace bloqueante en CI).
- [~] F1-02 Skill `brain-write` + tool MCP — AC: un agente appendea decisión/gate-answer/diseño-rechazado con un call; queda con provenance. **Método ✅**: `registry/skills/brain-write.md` (contrato de append: kinds decision/gate_answer/rejected_design/provenance; tenant/project inyectados por contexto = RLS; payload por-kind; one-call). **FALTA (tool MCP)**: bloqueado por **D2** (Agent SDK + host/lenguaje del tool + dependencia — regla "no deps sin preguntar"). La verificación del AC ("un agente appendea con un call") requiere el runtime de agentes → depende de D2.
- [ ] F1-03 Provenance requisito→issue→PR — AC: al publicar backlog y al mergear PR se escribe el link; la cadena es reconstruible por query.
- [ ] F1-04 Brain explorer mínimo (UI) — AC: timeline por proyecto leyendo Supabase con RLS+Realtime; sin backend propio nuevo.
- [ ] F1-05 Test de fuga cross-tenant del brain (CI, bloqueante) — closes: L-ARCH-1.

## Fase 2 · Aislamiento + estado en Postgres (mata la clase de bug)
- [ ] F2-01 Schema `stories/runs/events/sprints` + `tenant_id` + RLS — AC: pgTAP de aislamiento por tabla; índices por `project_id`. closes: L-ARCH-1/3/5.
- [ ] F2-02 Máquina de estados de story (transiciones en datos) — AC: transiciones legales declaradas; toda mutación pasa por un solo punto; test de transiciones ilegales.
- [ ] F2-03 Endpoints de tickets/runs sobre Postgres+RLS — AC: acceso por RLS (sin `WHERE id=?` a mano); lint que prohíbe status-literal y WHERE sin tenant fuera del helper. closes: L-SEC-1/2/6, L-CQ-2.
- [ ] F2-04 Test de fuga cross-tenant (stories/runs) en CI — AC: verde obligatorio para mergear.

## Fase 3 · Maestro reconciliador (mata el flap de raíz)
- [ ] F3-01 Edge Function receptora de webhooks firmados — AC: recibe PR/checks/workflow_run; verifica firma; idempotente.
- [ ] F3-02 Reconciliador determinista + histéresis — AC: democión SOLO por evento terminal explícito; dwell/cooldown; **no-LLM**; test: read-lag de 1 tick NO dispara 2º run. closes: L-ARCH-2.
- [ ] F3-03 Re-dispatch gateado por sesión viva — AC: no re-dispara si hay sesión activa (no por `status==backlog`). closes: L-ARCH-2.
- [ ] F3-04 Proyección de estado por Realtime — AC: la UI recibe cambios sin polling; sin loop serial. closes: L-ARCH-4.

## Fase 4 · Capa de Runtime (Runtime × Provider × ExecEnv, en data)
- [ ] F4-01 Interfaz `Runtime` + `Policy(runtime,provider,fallback)` — AC: contrato de `02-capa-runtime.md`; ids abiertos; tests con runtime fake.
- [ ] F4-02 `registry/providers/*.yaml` (claude, copilot) — AC: invocación/credential/probe/liveness/preamble en data; el dispatcher los carga; cero `switch` por-canal en Go. closes: L-CQ-1.
- [ ] F4-03 Runtime `github_actions` — AC: dispatch por workflow/agent-tasks; **liveness por workflow_run** (no 404); creds del cliente (BYO). closes: L-AUTO-4.
- [ ] F4-04 Runtime `local_daemon` (reusa worker+sandbox de v1) — AC: un daemon reclama unidades y corre el CLI local; misma interfaz.
- [ ] F4-05 Runtime `docker_isolated` (egress-deny) — AC: corre en contenedor efímero para E2E offline; misma interfaz.
- [ ] F4-06 Fallback por lista + probe declarado — AC: si el canal falla/no tiene capacidad, cae al siguiente de la lista con señal en UI. closes: L-CQ-1.

## Fase 5 · Método en registry + Agent SDK (cumplir la regla de oro)
- [ ] F5-01 Runtime de diseño en Agent SDK — AC: los agentes de fase corren por SDK (rol .md + skills + tools MCP); resolver `$step.output.text` correcto. closes: L-D2.
- [ ] F5-02 Jerarquía de backlog + gate a data — AC: épica/sprint/story y nombre del gate salen del registry (schema); un método kanban (sin sprints) no requiere tocar Go. closes: L-CQ-1.
- [ ] F5-03 Handoff → Issues + deps en el repo del cliente — AC: publica Issues con grafo `blocked_by`; provenance al brain.
- [ ] F5-04 Gates conversacionales — AC: en cada gate se puede aprobar / corregir / **responder las preguntas abiertas** (no solo approve/reject).

## Fase 6 · UI (console sobre Supabase realtime)
- [ ] F6-01 Board + grafo de deps + click-para-despachar — AC: vive por Realtime; despacha por API; estado en la URL.
- [ ] F6-02 Studio (pipeline de diseño gateado) — AC: recorre las fases, muestra docs/mockups, aprueba gates; al publicar backlog **linkea a ejecución** (no se queda mudo). closes: L-UX-1.
- [ ] F6-03 Brain explorer completo — AC: timeline auditable + trail requisito→issue→PR presentable.
- [ ] F6-04 i18n es/en + rebrand — AC: strings externalizados; sin "Forja". closes: L-UX-6.

## Fase 7 · Verificación REAL (no solo "arranca")
- [ ] F7-01 Verify (e2e/lint) como check REQUERIDO — AC: sale de `continue-on-error`; un PR con verify roja NO mergea. closes: L-AUTO-3.
- [ ] F7-02 `app_path`/design_tokens poblados en scaffold — AC: `ui-verify` deja de SKIPear; un repo scaffoldeado tiene `app_path` no vacío. closes: L-AUTO-3.
- [ ] F7-03 Juez-visión (art-director vs mockup) — AC: un screenshot se juzga contra el mockup aprobado; visual roto bloquea. closes: L-LM-3.
- [ ] F7-04 Verificación cross-lane e2e — AC: "el app desplegado habla con el backend desplegado" es un gate (no solo lint estático). closes: L-LM-5.
- [ ] F7-05 Multi-superficie: verify por app (no solo el primario) — AC: customer-app + admin + backend cada uno con su verify. closes: L-LM-4.

## Fase 8 · Entrega / última milla (lo que la auditoría marcó faltante)
- [ ] F8-01 Provisioning de infra del CLIENTE — AC: crear su backend (Firebase/Supabase del cliente), entornos dev/preview/prod, secrets de la app, dominio. closes: L-LM-2.
- [ ] F8-02 Deploy web (preview + prod) por Vercel/CF — AC: preview por branch embebido; "publicar" con un click a prod en el dominio del cliente. closes: L-LM-2.
- [ ] F8-03 Build móvil firmado + distribución — AC: firma de release (keystore/signing en secrets del cliente); distribución a link de prueba (Firebase App Distribution / TestFlight). closes: L-LM-1.
- [ ] F8-04 Submission a tiendas (opt-in) — AC: pipeline a App Store Connect / Play Console con metadata; iOS (macOS runner + signing Apple). closes: L-LM-1.
- [ ] F8-05 Data migrations en change-requests — AC: un cambio de schema del app del cliente se aplica versionado, sin romper prod.

## Fase 9 · Onboarding + GTM
- [ ] F9-01 Wizard de onboarding — AC: Continue with GitHub → instalar App → **semáforos de capacidad REALES** → preset de autonomía → primer proyecto; no se lanza design run sin canal listo. closes: L-UX-3/4.
- [ ] F9-02 Capabilities project-scoped — AC: probe del secret del repo + Copilot real; campo `copilot`; sin falso-verde. closes: L-UX-2.
- [ ] F9-03 Billing de agencia + metering — AC: plan Team; overage de compute transparente; BYO-key o managed (runtime cloud) opcional.

## Fase 10 · Aceptación end-to-end
- [ ] F10-01 El ejemplo Rosa (`05-ejemplo-e2e.md`) corre de punta a punta — AC: idea→diseño→backlog→mobile+web+backend→verify real→PR→web publicada+app distribuida→brain trazable→change-request re-entra. TODAS las fases anteriores en `[x]`.
- [ ] F10-02 Despliegue público fluxo.aiudalabs.com — AC: webhooks activos, TLS, la App apunta a prod.

---

**Nota de progreso:** cuando marques tareas, dejá una línea de estado abajo (fecha · fase · qué quedó) para que la
próxima sesión se re-oriente rápido.

### Bitácora
- 2026-07-11 · Bootstrap: repo, docs 00-06, CLAUDE.md, skeleton. Sin código.
- 2026-07-11 · F0-01 ✅ plataforma = Supabase managed (D1 resuelta). Desbloqueado F0-02.
- 2026-07-11 · F0-02 en curso: `supabase init` hecho (local-first con CLI 2.26.9). Falta `supabase start` (Docker apagado) + keys a .env. Luego F0-03 (CI) / F0-05 (cargar registry de v1) / F1-01 (1ª migración: brain_events).
- 2026-07-11 · F0-04 ✅ skeleton `control/` (Go 1.24, stdlib only): módulo `github.com/aiudalabs/fluxo/control`, `cmd/control` + `internal/config` + `internal/httpapi`. `/healthz`+`/readyz` JSON, config por env, CORS de origen único, shutdown grácil. Verificado: `go vet`, `go test ./...` verde, binario corrido y driveado con curl (200/404/SIGTERM). Módulo asume org `aiudalabs` (pendiente D4 — rename mecánico si cambia). Próximo desbloqueado: F0-05 (cargar registry de v1 desde ~/projects/genai/aiuda-forge). F0-02 espera Docker.
- 2026-07-11 · F0-05 ✅ registry cargado de v1 (verbatim): `agents/ skills/ workflows/ templates/`. Validador `registry/validate.py` (PyYAML) verde: 33 YAML con `id`, 22 pares md/yaml, 11 workflows con steps. `backends/` v1 NO copiado (→ providers, F4-02); `stacks/` diferido (viven en templates/github-native). Flujo de branches: sin remoto aún (D4), cada tarea = branch → merge ff-only a `main` local (main = trunk acumulador). Próximo desbloqueado: F0-03 (CI: ya hay Go + validador registry para cablear). F0-02 sigue esperando Docker.
- 2026-07-11 · F0-03 ✅ CI base: `scripts/ci.sh` (stages registry·control·migrations·leak·console, skip anunciado hasta que exista el artefacto) + `.github/workflows/ci.yml` (4 jobs delegan a esos stages; job database con servicio postgres:17). Verificado local: `scripts/ci.sh` verde, `actionlint`+`shellcheck` limpios. Pendiente: corrida real en Actions tras 1er push (D4). **Fase 0 casi cerrada** — sólo falta F0-02 (necesita Docker: pedir a Noel `supabase start`). Siguiente fase desbloqueada sin Docker: F1-01 (schema `brain_events`+RLS) puede AUTORARSE, pero su verificación (pgTAP, `db reset`) necesita Docker/DB → depende de F0-02.
- 2026-07-12 · F0-02 ✅ + F1-01 ✅ (Docker 29.6.1 resuelto; Supabase local vivo, `.env` seteado). **Fase 0 COMPLETA.** brain_events: migración + RLS (policies scoped a `auth.jwt()->>'tenant'`, append-only por grants) verificada con `supabase db reset` (aplica limpio) + `supabase test db` (pgTAP 6/6 PASS, incl. lectura/insert cross-tenant RECHAZADOS → L-ARCH-1). `scripts/ci.sh` endurecido: leak stage salta si falta `pg_prove` (corre vía container en `supabase test db`; su cableado en CI = F1-05). Próximo: **F1-02** (skill `brain-write` + tool MCP) — depende D2 (Agent SDK) para el tool MCP; el append en sí se puede hacer sobre la tabla ya lista. Nota: migración NO idempotente (create table) — CI usa DB fresca; dev usa `db reset`.
