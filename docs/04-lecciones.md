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

> Regla: si estás por escribir código que reintroduce cualquiera de estos, PARÁ. La arquitectura v2 los hace
> innecesarios o imposibles — si sentís que "necesitás" el patrón viejo, estás cruzando la frontera de `01-arquitectura`.
