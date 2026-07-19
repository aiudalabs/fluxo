# 04 · Lecciones de v1 (cargar como contratos/tests — NO re-aprender)

De la auditoría adversarial de aiuda-forge (2026-07-11). Cada lección es un bug que v2 debe hacer **imposible por
construcción** o **cubrir con un test**. Los códigos `L-*` los referencia `03-roadmap.md` en `closes:`.

## Aislamiento / datos
- **L-ARCH-1** · Escritura cross-tenant: v1 hacía `UPDATE stories SET … WHERE id=?` **sin `project_id`** contra PK
  compuesta → un tenant pisaba la story de otro. → v2: **RLS**; prohibido el WHERE sin scope; **test de fuga en CI**.
- **L-ARCH-3** · Dispatch cross-tenant: re-cargaba con `GetStory(id)` sin scope. → v2: todo lookup scoped por tenant (RLS).
- **L-ARCH-5** · SQLite `MaxOpenConns(1)` + scans sin índice `project_id`. → v2: Postgres + índices + RLS.
- **L-CQ-2** · State machine "centralizada" pero 16 literales `status='…'` crudos la saltaban. → v2: toda mutación por un
  solo helper tipado; lint que prohíbe literales de status fuera del helper.

## Flap / conductor / autonomía
- **L-ARCH-2** (el recurrente) · `running` derivado de UNA lectura eventual que **defaultea a backlog**, UPDATE crudo
  sin histéresis, y re-dispatch en el mismo tick → duplicaba runs pagos; el fix del label se volvió el bug de
  "eternamente stuck". → v2: **Maestro determinista, democión solo por evento terminal explícito, histéresis/cooldown,
  re-dispatch gateado por sesión viva**. Nunca derivar estado crítico de una sola lectura eventual.
- **L-ARCH-4** · Un goroutine conductor serial recorría TODOS los tenants con GitHub bloqueante cada 25s. → v2:
  webhooks push + Realtime, sin loop serial.
- **L-AUTO-2** · Requeue solo rescataba `failed`, no `running` (el estado real de trabado) → ediciones manuales de DB.
  → v2: requeue desde `running` con confirmación; transición legal.
- **L-AUTO-4** · Liveness de Copilot leída de la Agent-tasks API: 404 = "sin veredicto" → sesión colgada. → v2:
  **liveness declarada por `workflow_run`** (robusta), no por la API frágil.
- **L-AUTO-5** (2026-07-14, cazada en el E2E) · **Run vacío / fire-and-forget en headless**: el agente dentro
  de `claude-code-action` se va de costado —intentó **delegar a un subagente** (tool Agent/Task), que en un runner
  efímero no se ejecuta— y la action **terminó SIN trabajo** (ni commits ni PR). Misma familia que el bug que nos
  trajo de v1 (*"mandó a construir APKs en background y terminó el action"*). Dos fallas: (a) el Rescue checkpoint
  solo cubría *"trabajó pero no pusheó"*, no *"no trabajó"*; (b) el requeue dependía de la histéresis con
  `liveRunCount` **repo-level** → la story quedaba `running` hasta que TODO el repo quedara quieto (stuck lento).
  → v2: **enforcement, no disciplina** — `claude.yml` pasa `--disallowedTools Task` (el subagente no puede
  spawnearse); el rescate, ante un run vacío, marca el label **`agent:failed`** (evento terminal explícito) y la
  proyección lo degrada a `backlog` **YA**, desacoplado de `liveRunCount`. Guard por prompt (`HEADLESS_GUARD` en
  `dispatch.ts`) como cinturón. **Test:** `projection.test.ts` — `agent:failed` degrada `running→backlog` aunque
  `liveRuns>0`; y es no-op si la story ya está en `backlog`.
- **L-AUTO-3** · Gate de merge **verde-pero-vacío**: e2e-verify `continue-on-error`, ui-verify SKIP por `{{app_path}}`
  sin renderizar → el humano era el único QA. → v2: verify como **check REQUERIDO** + `app_path` poblado + juez-visión.

## Seguridad
- **L-SEC-1** · `PUT /registry/templates/file` sin authz → cualquier user envenenaba el `claude.yml` de TODOS los
  tenants. → v2: mutaciones de registry/settings tras rol admin de instancia; templates read-only del binario.
- **L-SEC-2/6** · `PUT /settings` y `GET /projects/{id}/settings` sin authz/ownership. → v2: RLS + rol.
- **L-SEC-3** · Llave maestra de la GitHub App (PEM + secrets) en archivo plaintext 0600 en el host. → v2: **Vault**,
  en memoria, rotación.

## Calidad / método
- **L-CQ-1** (la regla de oro) · Jerarquía épica/sprint/story, nombre del gate y los canales de ejecución
  **hardcodeados en Go** → cada stack/método/canal nuevo = release del kernel. → v2: **todo en `registry/`** (backlog
  schema, gate_file por step, `providers/*.yaml`); el ejecutor es genérico.
- **L-D2** · `$discovery.text`/`$prd.text` resolvían a "" (el texto vive en `output.text`). → v2: resolver correcto;
  test de encadenado de contexto entre fases.
- **L-BUILD-1** (2026-07-18, validando Idearium por EJECUCIÓN) · **Stub certificado como éxito**: un requisito P0
  de I/O cableado a un `Logging*`/`InMemory*` como default de prod + métricas que miden el RETORNO del stub = falso
  verde (ej: `delivery_rate=1.0` enviando cero pushes; email de reset que solo loguea el token). El método escribe
  lógica/arquitectura buenas pero confunde *wired* (cableado) con *connected* (conectado); la suite verde prueba el
  scheduling, no la entrega. → v2: (a) prohibir el default de stub **silencioso** en I/O P0 (implementación real, o
  falla RUIDOSO, o se marca NO-HECHO en el backlog); (b) métricas de **efecto real**, no del retorno del stub;
  (c) status que distingue "cableado" de "hecho"; (d) **verify por ejecución** en las fronteras. Detalle y los 7
  casos: `docs/10-calidad-build-backlog.md`; el trabajo: Sprint P1 en `docs/11-sprints-pendientes.md`. Extiende L-AUTO-3.

## Producto / onboarding
- **L-UX-1** · Tras publicar el backlog la fábrica quedaba muda (default dispatch `approve`, Studio sin link a
  ejecución). → v2: Studio linkea a ejecución + estado de "listo para build".
- **L-UX-2** · La señal de capacidad `claude` era un falso-verde (miraba el env del server, no el repo del cliente).
  → v2: capabilities project-scoped (probe del secret del repo + Copilot real).
- **L-UX-3/4** · No hay wizard de onboarding; se podía correr un design run completo sin canal de ejecución listo.
  → v2: wizard con semáforos reales; no lanzar sin canal.
- **L-UX-6** · i18n a medias, docs con la marca vieja "Forja". → v2: i18n completo, rebrand.

## Última milla (del ejemplo Rosa — la auditoría del ejemplo)
- **L-LM-1** · Publicación móvil: v1 solo produce APK **debug** interno; falta firma release, iOS, tiendas. → v2:
  F8-03/04.
- **L-LM-2** · No existe provisioning del backend/entornos/dominio del **cliente** (preview corre contra emulador). → v2: F8-01/02.
- **L-LM-3** · Verificación visual: solo prueba que "arranca", no que "se ve como el dibujo". → v2: juez-visión (F7-03).
- **L-LM-4** · Multi-superficie parcial: verify solo del app primario. → v2: verify por app (F7-05).
- **L-LM-5** · Integración cross-lane no es gate (el contrato de frontera es lint estático). → v2: e2e cross-lane (F7-04).

## Lecciones de UI de v1 (portar el diseño, NO rediseñar) — ver `07-ui-port-v1.md`
El build autónomo rehízo la UI **plana** (inline styles, GitHub-dark, sin `/flow`, sin marca, UUIDs) porque el spec pedía
*funcionalidad*, no el diseño real. Vara = producción → **portar la consola de v1 100%**, cambiar solo la fuente de datos.
- **L-UI-1** · La consola de v1 (`aiuda-forge/console/src`) ES el diseño (semanas de trabajo). Portar `globals.css` (4567 líneas), fuentes, `statusToken`, componentes **verbatim**; cambiar SOLO el data-hook a Supabase. NO rediseñar/simplificar.
- **L-UI-2** · NUNCA `transform` en la animación de `.wrap`/`.tickets-shell`/`.studio-shell` — un transform computado los hace containing-block de los `.drawer position:fixed` (banda fantasma + drawer intercepta clicks). Solo opacity. (globals.css:2633)
- **L-UI-3** · `statusToken.ts` = ÚNICA fuente de color/pill de estado (6 estados). No divergir en 5 mapas (el bug de v1 temprano).
- **L-UI-4** · Board JIRA: columnas vacías colapsan a riel de 42px → las 6 entran sin scroll-H desde ~1280px; scroll independiente por columna.
- **L-UI-5** · Mostrar NOMBRES de proyecto, no UUIDs. La entrada `/` abre estilo **chatbot** ("¿Qué quieres construir?" + idea + chips de ejemplo que guían), no un panel vacío.
- **L-UI-6** · Docs con VERSIONES (v1: commits en branch `design`; chips v1…vN + changelog global). **RESUELTO en v2 (commit 83dc9c9)**: las versiones salen del **brain append-only** (`brain_events` kind=artifact, cada evento = una versión con su `content` en el payload) — no hizo falta tabla `design_docs` nueva; el brain YA es el registro append-only. Los chips vN leen de ahí; ver una versión vieja rinde su content real.
- **L-UI-7** · Port sin fricción de imports: al copiar el dir `lib/i18n/**` de v1, el `lib/i18n.ts` flat de v2 colisiona (`@/lib/i18n` resuelve al file, no al dir). Renombrar el de v2 a `i18n-flat.ts`. Y excluir `**/*.test.ts` del tsconfig (v1 los corre con node:test, usan import con extensión `.ts`).
- **L-UI-8** · El Studio de v1 tiene DOS mecanismos conversacionales: el **gate 3-vías por fase** (Aprobar/Responder-preguntas/Pedir-cambios → resuelve `design_gates`) y el **refine per-doc** (re-corre la fase del doc). El gate ya cubre lo conversacional en v2; el refine per-doc queda para cuando exista el motor de diseño (F5) que re-corra la fase.

> Regla: si estás por escribir código que reintroduce cualquiera de estos, PARÁ. La arquitectura v2 los hace
> innecesarios o imposibles — si sentís que "necesitás" el patrón viejo, estás cruzando la frontera de `01-arquitectura`.
