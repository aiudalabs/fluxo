# 22 · Análisis del pivote — adversarial · premortem · mercado

> **Cómo se produjo este doc (2026-08-08):** tres agentes independientes, cada uno con acceso al repo,
> al log de decisiones (`~/.devtrace/decisions/fluxo.md`) y a la evidencia de los 17 incidentes de
> `docs/21 §5`. Parte 1 ataca a Fluxo v2 tal como existe; Parte 2 hace el premortem del sucesor ANTES
> de construirlo; Parte 3 (research de mercado con fuentes web verificadas) se agrega al completarse.
> Las conclusiones alimentan `docs/23-blueprint-sucesor-bmad.md`.

---

# Parte 1 · Análisis adversarial de Fluxo v2

*Base: `CLAUDE.md`, `docs/00,01,04,19,20`, los 990 renglones de `~/.devtrace/decisions/fluxo.md`, y una medición directa del repo (LOC, tablas, reconcilers, servicios). Fecha del ataque: 2026-08-09.*

---

## 0. La medición que ordena todo el resto

La tesis fundacional (`docs/01`) dice: *"~49k LOC de Go → ~2-5k de pegamento + config"*. Lo que hay hoy en disco:

| Área | Líneas | Qué es realmente |
|---|---|---|
| `console/` (sin `.next`) | 20.223 | UI Next.js, incluidas 6.368 de `globals.css` |
| `registry/` | 11.574 | **el método** (data — el activo real) |
| `design/src/` | 9.716 | kernel + worker + 314 tests |
| `control/` (Go) | 3.162 | **muerto**: nada lo importa salvo `ci.sh` |
| `supabase/` | 1.664 | 27 migraciones + RLS + una Edge Function stub |
| `scripts/` | 1.220 | bash operacional host-level |
| **Total ejecutable propio** | **~36.000** | contra un presupuesto declarado de 2–5k |

**El pegamento fino se comió al sustrato alquilado por un factor de 7 a 18.** Y eso sin contar que `control/` —el "kernel Go que es el moat porque debe estar fuertemente testeado" (`docs/01` §L2)— es código muerto que nadie llama. Ese solo hecho invalida el diagnóstico de la propia arquitectura: si el kernel del Maestro nunca se cableó y el sistema funcionó igual, el kernel no era el moat.

---

## 1. Ataques a la arquitectura

### 1.1 El sustrato NO está alquilado. Se construyó otro, artesanal, encima del alquilado

Supabase sí es alquilado. GitHub sí es alquilado. Y arriba de ellos se construyó, pieza por pieza, cada componente que la golden rule #4 prohíbe explícitamente:

| Lo que se construyó | Lo que reemplaza (y v1 ya tenía roto) |
|---|---|
| `worker.ts` con **14 reconcilers** en un tick poll-serial single-instance | el conductor serial de 25s de v1 (**L-ARCH-4, declarado muerto, vivo**) |
| **3 colas propias**: `build_jobs`, `preview_requests`, `increment_requests` | un sistema de colas |
| lease por `heartbeat_at` + "huérfano si >90s", **sin claim atómico** | el scheduler distribuido que se decidió no usar |
| `reconcileWatchdog` (techo duro + inactividad de commits) | supervisión de procesos |
| `costFromLog.ts` + `pricing.ts` (tabla de LiteLLM vendorizada) + `reconcileOrphanCosts` | billing/metering |
| `agent-runner.sh` + `agent-runner-poller.sh` + `engine-tail.sh` (systemd) | el runner de contenedores |
| `preview-runner.sh` (445 líneas) + cloudflared + Caddy dinámico + shim de reescritura de `fetch`/`XHR`/`WebSocket` | un servicio de entornos efímeros |
| `buildScaffold` + `substitute` + guard `leftoverVars` | un motor de templates |
| Vault + `CREDENTIAL_REGISTRY` + `propagateToRepo` vía `gh secret set` + whitelist + probes | un secret manager con distribución |
| `engine.ts` + `workflow.ts` + `effects.ts` + `plan.ts` + `planApply.ts` + crash-resume + salvage | un motor de workflows durable (Temporal, explícitamente rechazado el 2026-07-13) |

Ninguna de esas decisiones fue mala **aisladamente** — cada una tiene su entrada en el log con su rationale defendible. El problema es acumulativo y nadie lo declaró: **la golden rule #4 se violó 10 veces sin que se registre una sola violación.** El log tiene entradas explícitas del tipo *"descartado C (engine propio) por reabrir 'construir el sustrato' (golden rule 4, el pecado de v1)"* — y seis semanas después el engine propio (`fluxo_engine`, docs/17) está construido, desplegado y es el camino recomendado.

### 1.2 Contá los saltos: "quiero X" → "X corre"

Camino completo, sin exagerar (todos verificados en código):

1. Console (Docker/VPS) inserta en `projects` (Supabase managed, RLS, JWT de tenant minteado a mano)
2. `worker.ts` poll → `reconcileDesign` → adquiere lease por heartbeat
3. spawnea **subproceso** `main.ts` → `engine.runDesign` → Claude Agent SDK
4. 8 fases de agentes; captura por **mtime-diff del workdir** (workdir-harvest)
5. artifacts → `brain_events` + `design_phases` + `design_gates`
6. gate humano en Studio (otra app, otro contenedor)
7. `handoff.ts`: GitHub App JWT RS256 → installation token → crear repo → `putFile` docs → `buildScaffold` sobre 70 templates → crear N issues
8. `publishBacklog` → `stories`/`sprints` en Postgres, dos pasadas key→uuid
9. dispatch, **por dos caminos incompatibles**:
   - `github_actions`: RPC `project_external_status` (bypass de la máquina de estados vía GUC transaccional) → `workflow_dispatch` → `claude.yml` → `claude-code-action` → `claude`
   - `fluxo_engine`: fila en `build_jobs` → poller systemd → `agent-runner.sh` → `docker run` → `claude -p`
10. proyección: el worker lee GitHub (issues + PRs + labels + `liveRunCount`) → `derive()` con histéresis → RPC de bypass → `stories.status`
11. `reconcileApprovals` → `reconcileAutoMerge` (GraphQL para `mergeStateStatus`) → merge
12. reviewer: `build_jobs kind=review` → mismo poller → findings JSON → `publishFindings` → stories con `severity` → gate "0 P0"
13. para *verlo*: `preview_requests` → `preview-runner.sh` → docker compose → emulador Firebase + seed + shim JS + edge Caddy → quick-tunnel → Caddy de prod

**Trece saltos, cinco procesos distintos, cuatro servicios systemd, dos runtimes de ejecución, tres colas.** El equivalente local es: `claude -p "implementá la story" && flutter run`. Dos saltos.

### 1.3 ¿Dónde vive el estado? Cinco fuentes, dos reconciliadores para el mismo hecho

El estado de una story vive simultáneamente en:

1. `stories.status` en Postgres
2. el estado del issue de GitHub (open/closed)
3. los labels `agent:running` / `agent:failed` que **el propio workflow del cliente** escribe
4. `build_jobs.status` (solo en el camino engine)
5. `liveRunCount` de Actions (repo-level, explícitamente "grueso")

La proyección reconcilia 2+3+5 → 1. Pero el camino `fluxo_engine` **no pasa por la proyección** — por eso existe `engine-tail.sh`, que hace su *propia* reconciliación merge→done consultando el PR con otro token. Dos implementaciones del mismo verbo, exactamente el patrón que la auditoría interna del 2026-07-21 identificó como raíz de los bugs (*"el mismo verbo implementado dos veces"*) — y que se volvió a introducir cuatro días después.

El RPC `project_external_status` merece mención aparte: es un `SECURITY DEFINER` que setea un GUC transaccional para que el trigger de la máquina de estados **se salte a sí mismo**. Está bien construido y bien testeado. Que haya hecho falta significa que la máquina de estados no modela la realidad — la realidad es que el estado autoritativo está afuera.

### 1.4 Lo que la arquitectura prometió matar y no mató

`docs/01` §"Cómo cada pieza mata un bug de v1" es una tabla de promesas. Estado real:

- **"Realtime + webhooks mata el conductor serial 25s (L-ARCH-4)"** → la Edge Function `github-webhook` son 97 líneas **nunca cableadas al conductor**. El worker es poll-serial single-instance. L-ARCH-4 sigue vivo.
- **"Maestro con histéresis mata el FLAP"** → la histéresis existe, y el watchdog nuevo canceló un run sano a los 20 minutos al primer intento (2026-07-28). El flap volvió con otro nombre.
- **"verify como check requerido mata el gate verde-vacío (L-AUTO-3)"** → ver §2. No lo mató; lo reprodujo nueve veces.
- **"Postgres+RLS mata la corrupción cross-tenant"** → esto sí. Es la única línea de la tabla que se sostiene. Con un tenant, todavía no rindió nada.

---

## 2. Ataques al método

### 2.1 Fluxo tiene, en sus propios gates, exactamente el bug que le acusa a los agentes

El patrón raíz que el proyecto bautizó `L-BUILD-1` es: *"stub certificado como éxito — la métrica mide el retorno del stub, no el efecto real"*. Ahora la lista de gates **de Fluxo** que hicieron eso:

1. `ui-verify` inerte meses por un `app_path` hardcodeado — nunca corrió, siempre verde
2. el smoke de `ui-verify` certificó **SMOKE OK con texto=0 chars y canvas vacío** — cualquier app que crashea pasa
3. `e2e-verify` con `continue-on-error` — rojo que no bloquea
4. `provisioning-lint` cuyo regex anti-placeholder **no cazaba** `MAPS_API_KEY_PLACEHOLDER`
5. el step `validate` del engine: **no-op** (documentado como tal en el ADR de P8)
6. el join de cobertura por `screen_key`: **0 matches en los 6 docs reales** → no-op silencioso
7. el secret `FIREBASE_SERVICE_ACCOUNT_JSON` vs `FIREBASE_SERVICE_ACCOUNT`: App Distribution skipeaba en silencio con la key sembrada
8. el handoff tragándose un 401 → 10 stories sin issue, "board publicado"
9. la whitelist `REPO_DOCS` dropeando `docs/mockups/` en silencio → el art-director se saltea → la UI sale pobre
10. el scaffold degradando a `_common` en silencio ante un stack alucinado → se pierde el gate visual entero

Diez instancias del mismo patrón, cada una curada **caso por caso**, ninguna con la meta-defensa: **no existe un solo test que verifique que un gate FALLA cuando debe fallar.** Todo el harness está testeado en el camino feliz. Para un sistema cuya tesis es "los gates son el producto", eso es la contradicción central.

Y el diagnóstico se generaliza mal en el propio doc 19: se atribuye "done ≠ corre" al *mandato del agente* ("pasá los tests"). Pero los incidentes 1, 2, 3 y 10 muestran que el mandato del agente era correcto y **el instrumento de medición estaba roto**. El agente no mintió: pasó el gate que se le puso. El gate mintió.

### 2.2 El determinismo también se rompe — y se rompe más caro

La golden rule #2 dice "determinismo donde el gaming/error es barato". Inventario de fallas **en el código determinista**:

- race de doble adopción → **34 issues duplicadas en el repo del cliente**
- handoff no idempotente → re-handoff re-duplica las 34
- token OAuth leído al inicio del run, usado horas después → 401, repos a medio crear
- JWT de tenant venciendo a 1h en runs de horas → run pago perdido
- watchdog falso-positivo → run sano cancelado
- `agent:running` y `agent:failed` simultáneos → story trabada con el run vivo
- `pkill -f "firebase emulators:start"` matando al propio agente porque el prompt iba en argv → 14 min de trabajo bueno, sin PR
- drift de migraciones local↔prod, **dos veces**, la segunda matando un run pago
- rsync al target equivocado deployando la versión vieja en silencio
- `docker prune` borrando la imagen → runs con rc=2

**Cuando el LLM se equivoca, reintentás y cuesta dólares. Cuando el determinismo se equivoca, hacés cirugía en la DB de producción a mano** — y el log tiene al menos cinco entradas de eso (flip `failed→running` con heartbeat viejo, requeue por RPC, inyectar un artifact salvado, cerrar 34 issues como duplicate, destrabar `U-ms73u48q`). El determinismo no eliminó el error; lo movió a la clase de error que no tiene reintento automático y que solo el dueño sabe reparar.

### 2.3 El reviewer autónomo: valor real, envoltorio desproporcionado

Hay evidencia dura en las dos direcciones y hay que ser preciso.

**Lo que funcionó y es innegable:** el reviewer cazó un P0 real en YoMap SP1 (el admin no buildeaba por un `@apply` circular) que 150 tests en verde escondían. Eso es medible y reproducible.

**Pero:** el propio `docs/19` §5 dice, textual, *"F1 + F2 primero (un dev en máquina real que buildea y corre — **solo eso ya hubiera cazado el APK en SP1**)"*. F1 es un Dockerfile. F2 es un párrafo de markdown en `registry/agents/*-dev.md`. Los dos arreglos que resuelven el problema son **data, cuestan un día, y cero código**.

Lo que se construyó en cambio: agente reviewer + workflow + `reviewGate.ts` + columna `severity` + `publishFindings` + producer/applier en el worker + `build_jobs kind='review'` + `review_mode:auto` + gate "done ⟺ 0 P0" + guard del auto-merge + UI en tres superficies (Flow, badge P0 en el board, badge en Agents). Semanas.

Y el P0 lo cazó **el build limpio**, no la maquinaria de re-feed. El build limpio es F1+F2. Todo lo demás es infraestructura de autonomía **para un sistema cuyo único operador está sentado enfrente mirándolo**. `review_mode:auto` está apagado por default. Se pagó el precio de la autonomía sin cosechar la autonomía.

### 2.4 La verificación llega tarde por diseño, y eso multiplica el costo

El reviewer corre **post-sprint**. Un sprint = 1 PR = N stories = ~$10–20 y decenas de minutos. Descubrir "no buildea" en ese punto significa re-pagar el ciclo.

En la máquina del dueño, el mismo Claude, con el mismo modelo, descubre "no buildea" en 30 segundos y gratis, porque `flutter run` está a un comando. El incidente 17 lo dice sin ambigüedad: **hicieron falta ~15 iteraciones de infra** (emulador, shim de reescritura de red, seed, tipos, uid fijo, edge Caddy con ruteo por path) para conseguir lo que localmente es un comando. Y el incidente 9 muestra el otro filo: el motor no sabe saltear un paso por contenido, así que "mockups" costó $8.92 y 9 minutos **para concluir que no había nada que mockear**.

El sistema convirtió el loop más barato del desarrollo (compilar y correr) en el más caro.

---

## 3. Ataques a la operación

**Bus factor 1, sin matices.** 297 commits, un autor, cinco semanas. El conocimiento operativo vive en un decision log de 990 líneas, 24 docs, un `CLAUDE.md` de 211 líneas con gotchas de deploy, y la cabeza del dueño. No hay una segunda persona que pueda hacer un deploy correcto — porque el deploy correcto requiere saber que el target es `/opt/fluxo/` y no `/opt/fluxo/deploy/`, que `preview-runner.sh` va en `scripts/` mientras los otros van en la raíz, que rsync pierde el bit `+x`, y que hay que **grepear el chunk servido porque el log "Built" miente**.

**El deploy es tres formas conocidas de mentir.** Existe `.github/workflows/ci.yml`, pero producción no lo usa: es rsync + `docker compose build` a mano por SSH. Los tres modos de falla silenciosa están *documentados en la constitución del proyecto*, que es la confesión de que se convive con ellos en lugar de eliminarlos. Un CI de deploy de 20 líneas los mata a los tres.

**El debugging es arqueología.** ssh + journalctl + docker logs + psql + grep del bundle. Hay una vista "Observabilidad" en la consola, pero mide costo/tokens/latencia **de los agentes**, no salud del sistema. No hay alertas, no hay health checks agregados, no hay traza de una story a través de los 13 saltos. Cuando algo se traba, el diagnóstico es leer el log de decisiones para recordar cuál de las cinco fuentes de verdad se desincronizó esta vez.

**Migraciones aplicadas a prod salteando local.** Documentado dos veces como incidente, la segunda matando un run pago. La `schema_migrations` de prod estuvo **vacía** y hubo que repararla. No hay un solo camino de migración; hay tres (CLI, psql, Management API) y se usaron los tres.

**El día que hay 3 clientes reales**, en orden de qué se rompe primero:

1. **El VPS de producción corre los builds y los previews de todos los tenants**, con docker, sin sanitizar el compose del cliente (STOPGAP explícito en `docs/15`; el escalado E1–E5 está sin hacer). Un cliente con un compose hostil, un build que llene el disco, o simplemente tres previews concurrentes, tumba a los otros dos. Ya pasó **sin clientes**: un `prune` borró una imagen y tumbó un run.
2. **El worker es single-instance sin claim atómico.** Correr dos ya produjo 34 issues duplicadas en el repo de un cliente. Escalar horizontalmente requiere el `FOR UPDATE SKIP LOCKED` anotado como pendiente desde el 2026-07-13.
3. **`fluxo_engine` corre con el token de suscripción Pro/Max del dueño.** No es un problema técnico, es de ToS y de aritmética: no escala a N clientes, y rompe la tesis "cero COGS" (ver §4).
4. **La operación humana no se divide por cliente, se multiplica.** Hoy, con cero clientes, el dueño pierde días. Con tres, cada incidente sistémico se manifiesta tres veces con tres contextos distintos, y él es el único que puede diagnosticar.

Fluxo se vende a agencias de 3–20 devs. **No sobrevive a su propio ICP.**

---

## 4. Ataques a la economía

**Lo que costó, medido:** YoMap idea→producto = **$190.47 en 15 jobs**, más ~$10 por incremento chico. Salonara, MiSalon e Idearium encima. Y el desperdicio es visible en el log, no inferido:

- $43 en un run de 72 minutos que terminó "success" **sin PR** (el token de la App expiró a la hora; el trabajo se perdió)
- $11.63 en un run cancelado por timeout
- $8.92 en un paso de mockups que concluyó que no había nada que mockear
- un `increment_request` **vacío** que disparó un planner pago sobre la nada, sin validación en ninguna capa
- el trabajo de SP-ui-md3-3, declarado **irrecuperable**

Del orden del **20–30% del gasto observable es desperdicio estructural**, no variabilidad del modelo.

**Lo que no está en el precio:** los días de operación humana. Ese es el costo dominante y es el único que no se instrumentó. Hay una tabla `run_costs` con estimador post-hoc y precios vendorizados de LiteLLM para contar dólares de LLM; no hay ninguna medición de las horas del dueño, que son el recurso escaso.

**La comparación honesta.** El mismo trabajo con Claude Code local: **el mismo binario, el mismo modelo, la misma persona** — `claude -p` es literalmente lo que corre adentro del contenedor (`docs/19` §2 lo admite: *"Fluxo no construyó un dev peor"*). La diferencia es una suscripción plana, `flutter run` gratis en vez de 15 iteraciones de infra de preview, feedback en segundos en vez de post-sprint, y cero días de operación.

La evidencia más incómoda es del propio log (2026-07-31 / 2026-08-01): el `/goal` **local** orquestó una flota de subagentes que "transformó la UI", Fluxo no lo hacía, y la solución fue **copiar el comportamiento del harness local a un imperativo en el prompt**. O sea: la capacidad que se quería estaba en la herramienta local, y Fluxo tuvo que perseguirla. Fluxo no agrega capacidad al dev; le saca contexto y le agrega latencia.

**El modelo de negocio ya no cierra con la arquitectura actual.** `docs/00` dice: ejecución con credenciales del cliente → **cero COGS**. Pero la dirección vigente (`fluxo_engine`, docs/17, adoptada porque *"GitHub Actions cobra por minuto y topó el presupuesto del cliente"*) corre los builds en el VPS del dueño con su suscripción. COGS ≠ 0, y el compute no es revendible. **El pivote rompió la tesis económica del pitch y nadie lo declaró como decisión.**

Y el precio: $199–500/mo por orquestar una herramienta que el cliente puede comprar por $20–200/mo flat, sin operador. La orquestación tendría que valer más que la fricción que agrega. Con cero clientes pagando después de cuatro productos construidos, la hipótesis está sin validar y la evidencia disponible apunta en contra.

**Dónde está el valor agregado real y medible:** exactamente dos cosas. (a) El reviewer de contexto fresco con build+run limpio cazó un P0 que 150 tests escondían — real, reproducible, y **reproducible con un comando local**. (b) El registro auditable (brain) es el moat declarado y es plausible que una agencia lo pague — pero nadie lo compró todavía, y el único usuario del brain es el dueño. Todo lo demás (board, dispatch, proyección, auto-merge, previews, spend, assistant) reimplementa cosas que GitHub, Linear o la terminal ya hacen.

---

## 5. Lo que SOBREVIVE el ataque

Con honestidad, esto tiene valor demostrado y hay que llevárselo:

1. **La tesis de `docs/19`: "done = buildea + corre", y el dev es Claude Code en una máquina con el toolchain del target.** Es el hallazgo más valioso del proyecto. Cuesta un Dockerfile y un párrafo de markdown. Es portable a cualquier harness.

2. **El reviewer de contexto fresco, como *práctica*.** La checklist de `docs/19` §3.2 (build limpio desde el repo, arranca, matchea el spec/mockups, anti-stub, cobertura) es oro destilado del E2E de YoMap. Conservarla como un **prompt + checklist que se invoca**, no como subsistema con tabla, columna, producer, applier y badges.

3. **`registry/` completo — 11.574 líneas de método como data.** 24 personas, 18 skills, 12 workflows, 3 stacks, 22 templates de workflow de CI. Es el activo real del proyecto y es agnóstico del sustrato. Cargarlo tal cual.

4. **Las lecciones verificadas contra la realidad**, que no se re-aprenden gratis: `docs/04` (L-BUILD-1, L-AUTO-5), `docs/10`, el hallazgo del `http://` hardcodeado en los tres SDK de FlutterFire web (verificado contra el source de los plugins, no inferido), el prompt de commits incrementales como señal de vida, y el hallazgo **"permitir ≠ invocar"** validado con un A/B real (guard permisivo → 0 subagentes; imperativo condicional → 3 subagentes en paralelo). Ese último es transferible a cualquier trabajo con agentes.

5. **Los gates baratos que sí miran algo:** `provisioning-lint` con el regex apretado, `suite-integrity` (el conteo de marcadores de test no baja head<base), la regla anti-placeholder. Deterministas, sin infra, y atrapan la clase de mentira que importa. Van en el CI del repo del cliente, no en una plataforma.

6. **La receta de preview con emulador** (`registry/templates/.../aiuda-flutter-firebase/.fluxo/preview/`) y la convención preview-aware. Son 15 iteraciones de dolor destiladas. Valen como **receta de proyecto** que el dev copia, no como feature de plataforma con runner, tunnel y edge dinámico.

7. **Los templates de workflow por stack** (`build-apk` con firma de keystore, `deploy.yml`, `device-verify`). Config reusable, cero sustrato.

8. **Postgres + RLS como store**, si y solo si algún día hay multi-tenant real. Con un tenant es un SQLite con pasos extra — pero es la única promesa de `docs/01` que se cumplió sin deuda.

---

## 6. Veredicto: qué NO reconstruir

Lista concreta. Cada ítem tiene su evidencia arriba.

1. **El worker poll-serial con 14 reconcilers.** Es el conductor de v1 reencarnado en TypeScript, con los mismos bugs (flap, doble adopción, estado derivado de lecturas eventuales). L-ARCH-4 nunca murió.
2. **Las tres colas propias** (`build_jobs`, `preview_requests`, `increment_requests`), sus tres pollers systemd, el lease por heartbeat, y el claim atómico que sigue sin existir.
3. **El watchdog.** Canceló un run sano al primer intento; los umbrales siguen sin calibrar. Un timeout duro en el comando hace el 90% del trabajo con tres líneas.
4. **El estimador de costos post-hoc** (`costFromLog` + `pricing` vendorizada + `reconcileOrphanCosts` + tabla `run_costs`). Contabilidad de un compute que en el sucesor no orquestás.
5. **El sistema de previews efímeros**: 445 líneas de runner + cloudflared + Caddy dinámico + shim de reescritura de `fetch`/`XHR`/`WebSocket`/`sendBeacon` + seed + orquestación del emulador. Reemplazo: correr la app en la máquina del dev. Guardá la *receta*, tirá el *runner*.
6. **La proyección GitHub→DB con histéresis**, el RPC de bypass de la máquina de estados, y el protocolo de labels `agent:running`/`agent:failed`. Todo existe para mantener sincronizada una copia de un estado que GitHub ya tiene. Si el board **es** GitHub Issues, no hay nada que proyectar y desaparecen tres clases enteras de bug.
7. **El auto-merge gated + `workflow_approval: auto_if_safe`.** Money-critical, dependiente de una branch protection que nunca se configuró (caveat abierto desde el 2026-07-13), y el humano mergea igual.
8. **La consola de 20k líneas** (6.4k de CSS, **tres rediseños completos**: Mission Control → MD3 → tokens container/on-container). Cero clientes la usaron. Es el artefacto con peor ratio esfuerzo/uso del repo.
9. **El AI Assistant** (chat + SSE + tools MCP in-process + persistencia + acciones confirmables + panel flotante). Es un Claude Code peor, adentro de una app que envuelve a Claude Code.
10. **Las tres ceremonias Scrum cableadas** (planning/review/retro + DSL de acciones + `planApply` + `proposals` + `registry_apply`). En particular **`registry_apply` — la fábrica editando su propio método en el working tree sin commit a git** — es la pieza más riesgosa del repo, está declarada como tal en su propio ADR, y no la pidió nadie.
11. **`control/` en Go (3.162 líneas).** Muerto. El "kernel que es el moat" nunca se cableó y el sistema anduvo igual.
12. **El motor de diseño durable propio**: 8 fases + gates + crash-resume + heartbeat + `buildResumeState` + salvage-resume manual. Las *fases* son buenas (son BMAD, viven en `registry/`); el *motor de ejecución durable* no.
13. **La bóveda de credenciales del tenant + propagación a repos + whitelist + probes.** Con un tenant, es una variable de entorno.
14. **Los dos ExecEnv en paralelo** (`github_actions` y `fluxo_engine`) con dos caminos de reconciliación distintos. Elegí uno. Mantener los dos duplicó el verbo "reconciliar merge→done" y ya costó una story trabada.
15. **El doble sistema de i18n** (flat + catálogo), deuda declarada el 2026-07-14 y nunca pagada.
16. **La regla "nunca un parche manual, todo se cierra como capacidad del sistema".** Es la regla correcta para un producto con clientes y **una máquina de complejidad para un producto con cero clientes**. Es la causa mecánica de la mitad de esta lista: cada incidente produjo un fix de método (bien) *y* una pieza de infra permanente (mal). Reactivarla cuando exista alguien a quien servir.

### El sucesor mínimo que conserva todo el valor de §5

`registry/` (el método) + un Dockerfile con el toolchain real del target + un script que corre `claude -p` con la persona correcta y el mandato build-and-run + los gates baratos como CI **en el repo del cliente** + GitHub Issues como board + el reviewer como comando invocable con su checklist. Eso son cientos de líneas, no decenas de miles, y cubre las dos únicas cosas con valor medible demostrado: **que el artefacto corra de verdad, y que un segundo par de ojos frescos lo confirme.**

Todo lo demás es la caja. Y `docs/19` ya lo dijo mejor, sobre el dev: *"No hay que enseñarle a trabajar bien: hay que **dejar de enjaularlo**."* La conclusión se aplica una capa más arriba de donde se aplicó.
---

# Parte 2 · Premortem del sistema sucesor — "el sistema simple"

> **Fecha de la sesión:** agosto 2026. **Escenario:** es **febrero 2027**. El sistema simple fracasó y fue abandonado. Noel volvió a construir productos a mano con Claude Code, o volvió a Fluxo v2. Abajo están las autopsias, escritas *antes* de que pasen.
>
> Método: cada narrativa tiene **mecánica plausible** (anclada en incidentes reales de Fluxo v2 registrados en `~/.devtrace/decisions/fluxo.md` y `docs/04-lecciones.md`), **señales tempranas** a 2 semanas y a 2 meses, y **la mitigación que hay que meter en el diseño HOY** — no una intención, una decisión de construcción.
>
> **El sucesor, en una línea:** BMAD como método de diseño (fases gateadas ya resueltas) + delegación total de la ejecución a harness existentes (Claude Code CLI/SDK/Actions, Copilot CLI) + el mínimo pegamento propio. Dueño: una persona.

---

## 1. Las 12 narrativas de fracaso

### F1 · "Reconstruimos Fluxo sin darnos cuenta"
**Cómo murió.** Arrancó con ~300 líneas: un script que corre BMAD, otro que lanza Claude Code sobre un issue. En la semana 3 apareció el primer `if`: "si el run falla, reintentar". Semana 5: "necesito saber qué stories están corriendo" → un archivo JSON de estado. Semana 7: el JSON se corrompe con dos runs simultáneos → una tabla. Semana 9: "¿quién mira la tabla?" → un loop `while true; sleep 30`. Semana 12: el loop se cae al cerrar la laptop → systemd. Semana 16: hay que ver el estado sin SSH → una UI. En diciembre el "sistema simple" tenía worker, DB, UI y 3 servicios — **y ninguno de los tests, gates ni lecciones que Fluxo v2 había pagado con sangre**. Era Fluxo v2 con 6 meses menos de hardening. Noel lo abandonó porque, honestamente, el viejo era mejor.

**Señales tempranas.** *(2 semanas)* aparece el primer archivo que guarda estado entre invocaciones; alguien escribe la palabra "poller", "tick" o "reconcile". *(2 meses)* hay un proceso que corre cuando Noel no está mirando; el pegamento pasa de 500 a 2.000 líneas; ya hay una función llamada `deriveStatus()`.

**Mitigación hoy.** **Prohibición estructural, no cultural:** el sucesor no tiene proceso de larga vida ni base de datos propia. La verdad de "en qué estado está esto" es **el estado de GitHub** (issue abierto/cerrado, PR, run, label) leído *on demand* cuando un humano pregunta. Corolario duro: **si hace falta un proceso corriendo para que el sistema funcione, el diseño está mal y se para la obra** (invariante I1). Y un contador visible de LOC de pegamento en el README, con techo declarado (métrica M4): el crecimiento tiene que doler antes de ser irreversible.

---

### F2 · "BMAD no es nuestro" — el framework se movió y nos partió al medio
**Cómo murió.** En septiembre BMAD publicó una versión nueva con otra estructura de módulos (el layout `registry/packs/` que `docs/18` daba por bueno dejó de mapear). Noel había hecho 40 ediciones chicas a los agentes core para el contexto LATAM/español: personas ajustadas, un `scrum-master` que emite la matriz de cobertura, un `architect` que escribe `provisioning.yaml`. Ninguna estaba aislada — estaban editadas *in place* sobre el checkout de BMAD. Upgradear significaba re-aplicar 40 diffs a mano; no upgradear significaba quedarse fuera del ecosistema que era la razón de adoptarlo. Se quedó en la versión vieja, y en enero el "framework externo maduro" era de facto **un fork privado sin mantenedor** — exactamente el `registry/` de Fluxo, pero sin los tests de `validate.py`.

**Señales tempranas.** *(2 semanas)* la primera edición a un archivo de BMAD que no está en un directorio nuestro. *(2 meses)* nadie sabe decir en qué versión de BMAD estamos ni qué cambiamos; un `git diff` contra upstream no es posible porque no se guardó el upstream.

**Mitigación hoy.** BMAD entra **vendorizado y pineado** (versión exacta commiteada) y **nunca se edita in place**: toda divergencia vive en un `overlay/` propio que se aplica encima, de modo que `diff upstream overlay` sea siempre una pregunta contestable en un comando. Segundo: **una prueba de fuego de reemplazo** — escribir hoy, en una página, qué pasa si BMAD desaparece mañana. Si la respuesta no es "seguimos con nuestros ~8 markdowns de personas", entonces no estamos usando BMAD como método, estamos **dependiendo** de él como plataforma, y eso es sustrato ajeno en el camino crítico. Tercero: elegir explícitamente **qué de BMAD usamos** — el orden de fases y las personas, no su runtime.

---

### F3 · "El harness delegado no rinde cuentas" — volvimos a "done ≠ corre"
**Cómo murió.** La premisa era "Claude Code ya sabe: dejalo trabajar". Y trabaja: escribe código bueno, tests que pasan, PRs limpios. En noviembre el cliente abrió el APK de su app y no arrancó — Firebase no conectaba, el mapa en blanco. Igual que YoMap en agosto. La causa: sin un juez de contexto fresco que **buildee y corra** el artefacto, el criterio de "hecho" vuelve a ser el del propio implementador, que confunde *wired* con *connected* (L-BUILD-1: `delivery_rate=1.0` enviando cero pushes; email de reset que solo loguea el token). El sucesor había tirado el reviewer autónomo junto con el resto de Fluxo — la única pieza que **ya había demostrado** cazar un P0 que 150 tests en verde escondían.

**Señales tempranas.** *(2 semanas)* el primer "listo" que nadie corrió: el criterio de aceptación se cierra con un PR verde, no con una app abierta. *(2 meses)* el primer cliente reporta algo que el sistema declaró hecho; nadie puede decir qué comando probaría eso.

**Mitigación hoy.** El **reviewer de contexto fresco es la única pieza de Fluxo v2 que se carga entera al sucesor**, y se implementa de la forma más barata posible: **un segundo `claude -p` con un prompt que dice "buildeá el artefacto real y corrélo; escribí findings.json"**, disparado por un comando del repo, sin servicio propio. Y el gate se codifica como regla, no como intención: **"sprint done ⟺ 0 P0"**, con los P0 re-alimentados al backlog. Segundo: el mandato del dev es literal — *"tu criterio de terminado no es que pasen los tests, es que el artefacto buildea y corre"* — que ya está escrito y validado en `scripts/agent-runner.sh`. Copiar ese texto, no re-derivarlo.

---

### F4 · "El bug es de otro y no lo podemos arreglar" — vendor drift del harness
**Cómo murió.** Un run de 72 minutos terminó `success`, costó $43 y **no dejó ningún PR**: el token que el wrapper mintea expira a la hora y el agente perdió las credenciales de git a mitad (bug abierto `anthropics/claude-code-action#716`). Eso pasó en Fluxo v2 en julio y se resolvió con un workaround (un PAT fine-grained del cliente). En el sucesor, que **delega todo al harness por diseño**, cada uno de esos bugs es una pared: no hay instrumentación propia (GitHub devuelve 404 del log hasta que el job termina — L-AUTO-4), no hay forma de reproducir, y la única palanca es esperar al upstream. En diciembre se acumularon tres a la vez (un cambio de flags, un cambio en el formato `stream-json`, un rate limit nuevo) y el sistema quedó dos semanas sin poder entregar. Un cliente se fue.

**Señales tempranas.** *(2 semanas)* la primera vez que la respuesta a un fallo es "es del action / del CLI, esperemos". *(2 meses)* existe un archivo de workarounds; alguien pinea una versión del harness "porque la nueva rompe".

**Mitigación hoy.** **Pinear el harness igual que BMAD** (versión del CLI/action commiteada) y — clave — **preferir el camino más crudo posible**: `claude -p` directo sobre una máquina de dev, no un wrapper. Fluxo ya aprendió esto: los subagentes fallaban en `claude-code-action` pero funcionan con `claude -p` crudo, porque la limitación era del wrapper, no de la efimeralidad (decisión del 2026-07-31). **Menos capas ajenas = menos bugs que no podemos arreglar.** Segundo: escribir hoy el "plan de degradación" — si el harness está caído, ¿el trabajo se hace a mano en la laptop y se sigue entregando? Si la respuesta es no, el sistema es más frágil que un humano con una terminal, que era exactamente lo que veníamos a mejorar.

---

### F5 · "El dueño sigue siendo el runtime"
**Cómo murió.** Nunca se automatizó el juicio, y estaba bien — pero tampoco se automatizó el **arranque**. Cada proyecto necesitaba a Noel para: elegir el stack, aprobar los gates de diseño, sembrar las credenciales, mirar el review, decidir si re-despachar. Con un cliente eran 3 horas por semana. Con cuatro clientes eran 30, y Noel dejó de vender para operar. En enero rechazó dos proyectos por falta de tiempo — con un sistema cuyo propósito era **multiplicar** su tiempo. El "sistema simple" era simple porque la complejidad la absorbía la persona.

**Señales tempranas.** *(2 semanas)* hay al menos un paso que solo Noel sabe hacer y no está escrito en ningún lado. *(2 meses)* el tiempo en operar crece linealmente con la cantidad de proyectos; un proyecto no avanza los días que Noel no lo toca.

**Mitigación hoy.** Medirlo desde el día 1 (métrica **M2**: horas/semana operando el sistema vs. construyendo producto, con techo del 10%). Y una regla de producto: **todo paso humano recurrente se convierte en un comando del repo o se elimina**; nunca en "algo que hago yo" (es la memoria `fluxo-no-manual-patches-self-serve` — el usuario ya la nombró como principio y Fluxo la violó decenas de veces). Concretamente: la lista de pasos humanos por proyecto se escribe **antes** de construir; si tiene más de 5 ítems, el diseño no está listo. Los gates de diseño de BMAD son juicio legítimo (se quedan); todo lo demás — sembrar credenciales, re-despachar, mirar logs — es fricción y tiene que morir.

---

### F6 · "La demo al cliente falla en vivo"
**Cómo murió.** Reunión de venta con una agencia en Bogotá. Noel abre la app construida y muestra… un cascarón: pantalla en blanco, Firebase sin conectar. La misma escena de Fluxo v2 en agosto ("App en vivo muestra el cascarón, no la app" — `docs/20`). La agencia no compró: **lo único que un comprador evalúa es la app corriendo**, no el board ni el registro auditable. El sucesor había asumido que "un dev con Claude Code local hace `flutter run` sin fricción" — cierto en la laptop de Noel, falso en cualquier lugar donde el evaluador no tenga el toolchain, las credenciales y 15 minutos.

**Señales tempranas.** *(2 semanas)* no existe una URL que un tercero pueda abrir para ver lo construido; la demo es un video o una pantalla compartida. *(2 meses)* la primera demo en vivo se cancela o se hace "grabada por las dudas".

**Mitigación hoy.** **La URL navegable es un entregable de primera clase, no un extra** — y el camino ya está resuelto y validado: **emulador + proyecto `demo-*` + seed** (docs/20 P1+P2, validado contra el emulador real el 2026-08-07), que corre **sin ninguna credencial real**. Cargarlo tal cual, incluyendo los dos hallazgos caros: (a) el shim `http→https` va en la **infra**, no en cada app (los SDK de FlutterFire web hardcodean `http://` → mixed content bloqueado); (b) **gate fail-loud**: si la app no es preview-aware, el preview **falla con instrucción concreta** en vez de publicar un cascarón. Segundo, y es lo que hace la diferencia entre esto y las ~15 iteraciones que costó en Fluxo: **la receta de preview vive en el repo del cliente** (`docker-compose` + un script), no en un runner nuestro. El cliente la corre; nosotros también. Si solo corre en nuestro VPS, es infra propia (F1) y frágil (F12).

---

### F7 · "El costo por producto explota sin techo"
**Cómo murió.** YoMap costó $190 y fue la prueba de que el modelo cerraba. El tercer proyecto costó $900 y nadie se enteró hasta la factura: dos sprints que se re-corrieron por un bug de método, un run cancelado a los 45 minutos que igual gastó $11.63, y un `dispatch_mode` que en algún momento quedó en auto y disparó agentes sobre stories vacías. Como el sucesor delega el gasto al harness, **no hay ningún punto donde el sistema sepa cuánto lleva gastado** — la instrumentación de costo de Fluxo (`run_costs`, estimación desde el log de runs cancelados, tabla de precios de LiteLLM vendorizada) se había tirado por "infra propia". El margen del proyecto se lo comió el propio proceso; el modelo de negocio dejó de cerrar y no había cómo diagnosticarlo.

**Señales tempranas.** *(2 semanas)* nadie puede decir cuánto costó el último proyecto sin abrir la consola de facturación. *(2 meses)* la varianza entre dos proyectos parecidos supera 2×, y no hay hipótesis de por qué.

**Mitigación hoy.** Tres cosas baratas, ninguna es un servicio: **(1) presupuesto declarado por proyecto antes de arrancar** (un número en el repo), **(2) el costo real se lee del `result` del propio `claude -p`** — el harness ya lo emite (`total_cost_usd`), es un `tail | jq` a un CSV en el repo, no una tabla con RLS — y **(3) el kill-switch no es código nuestro**: límites de gasto en la cuenta del proveedor, más el default **manual** en cualquier cosa que dispare un agente. Fluxo cambió el default `auto→manual` recién después de que el auto disparara runs pagos sin querer; el sucesor arranca en manual. Regla: **ninguna acción que gasta se dispara sin un humano o sin un techo declarado** (invariante I4).

---

### F8 · "Verificación teatro v2"
**Cómo murió.** El sucesor sí puso gates — pero los puso donde era fácil. En octubre un gate visual empezó a pasar siempre: la variable del path de la app nunca se resolvía y el step **skipeaba limpio**, exactamente como el `{{app_path}}` que en Fluxo hizo que `ui-verify` jamás se scaffoldeara en proyectos Flutter. Nadie lo notó durante seis semanas porque un skip se ve igual que un verde. Cuando se descubrió, había cuatro proyectos entregados con la UI sin revisar y la confianza del cliente en "el sistema verifica" se evaporó — que es peor que no tener gate, porque el humano había dejado de mirar.

**Señales tempranas.** *(2 semanas)* existe un gate que nunca falló; nadie probó romperlo a propósito. *(2 meses)* un gate se saltea por config faltante y el resultado es verde/skip en vez de rojo.

**Mitigación hoy.** Tres reglas, todas aprendidas a golpes en v2: **(a) un gate que no puede correr FALLA, nunca skipea** (el opuesto exacto del `continue-on-error` y del skip silencioso de L-AUTO-3); **(b) cada gate se estrena con un test que lo hace fallar** — si no viste el rojo, el gate no existe; **(c) el gate mide efecto real, no el retorno del stub** (L-BUILD-1). Y un ritual barato: **una vez por proyecto, un rojo intencional** — meter un bug obvio y confirmar que algo lo caza. Si nada lo caza, los gates son decoración.

---

### F9 · "Nunca se termina el sucesor" — Fluxo v2 zombi
**Cómo murió.** Fluxo v2 seguía en prod porque YoMap, Salonara y MiSalon vivían ahí. El sucesor se construía "en paralelo, cuando hay tiempo". Cada semana un cliente rompía algo en v2 y se iban dos días. En cuatro meses el sucesor tenía el 40% hecho y v2 el 100% de la atención. En febrero Noel cerró el repo del sucesor: no era que fuera mala idea, es que **nunca tuvo una ventana de existencia**. Es el mismo strangler que v2 hizo contra v1 — pero v2 tardó un año y tenía la ventaja de que v1 era abandonable de golpe.

**Señales tempranas.** *(2 semanas)* el sucesor no tiene un primer cliente/proyecto asignado — es un side project. *(2 meses)* el ratio de commits v2:sucesor sigue arriba de 1; se sigue arreglando v2 "porque es rápido".

**Mitigación hoy.** Decidir **antes de escribir una línea**: (1) **un proyecto real y nuevo nace en el sucesor la primera semana** — no un port, un cliente o un producto propio, porque un sistema sin usuario no se termina nunca; (2) **v2 entra en congelamiento explícito**: solo fixes que desbloqueen a un cliente pagando, y cada uno se anota como deuda con su costo en horas; (3) **fecha de corte declarada** — si a los 3 meses el sucesor no entregó un producto de punta a punta, **el sucesor se cancela y volvemos a v2 sin culpa**. Una decisión tomada hoy en frío vale diez veces una tomada en enero con dos sistemas a medias.

---

### F10 · "La última milla de credenciales mata otra vez"
**Cómo murió.** Todo funcionaba salvo la parte que le importa al cliente: la app compilaba y no arrancaba. Esta familia de bugs es la más recurrente y la más subestimada de Fluxo v2, y **no la resuelve delegar**: el token de la GitHub App expira a las ~8h y el handoff falla con 401 horas después de arrancar (el repo de YoMap no se creó por eso); el JWT de tenant expira a la hora en runs que duran horas; un secret con **dos nombres** (`FIREBASE_SERVICE_ACCOUNT` vs `..._JSON`) hizo que App Distribution skipeara en silencio aunque el usuario **sí** había cargado la key; y el config de runtime (`google-services.json`, Maps key) nunca se pedía. En el sucesor, con menos código propio, el problema no desapareció — se volvió **invisible**, porque no había ningún lugar donde se declarara qué credenciales hacen falta para que esto **corra**.

**Señales tempranas.** *(2 semanas)* la lista de credenciales por proyecto vive en la cabeza de Noel o en un chat. *(2 meses)* el primer "compila pero no arranca"; el primer secret que existe con dos nombres distintos.

**Mitigación hoy.** **Un manifiesto de credenciales por proyecto, versionado en el repo del cliente**, que distinga las dos categorías que Fluxo tardó un año en separar: **build-time** (CI, deploy) vs **runtime** (lo que la app necesita para arrancar). Reglas: un nombre canónico por credencial en todo el sistema (el bug del `_JSON` fue puro renaming); **el preview no usa ninguna credencial real** (emulador, F6) así que la demo nunca está bloqueada por esto; y **un lint determinista** que falle si queda un placeholder (`project_number: 000…`, `MAPS_API_KEY_PLACEHOLDER`). El `provisioning-lint` de Fluxo es una de las tres piezas que **funcionaron**: se porta.

---

### F11 · "El blast radius es el repo del cliente"
**Cómo murió.** El sucesor delega, y delegar significa que **un agente escribe en el GitHub de otra persona**. En septiembre un re-handoff duplicó 34 issues (había pasado literal en YoMap: dos procesos adoptaron el mismo run en una ventana de 20 segundos). En noviembre un agente, limpiando el emulador que había levantado para verificar, corrió `pkill -f "firebase emulators:start"` — y como el prompt viajaba en el argv, **matcheó su propio proceso y se suicidó** con 14 minutos de trabajo bueno sin pushear (pasó de verdad, 2026-08-08, story `S-fb-emulator-init-1` de YoMap, rc=143). En enero un agente pisó un workflow del cliente y rompió su CI de producción. Perdimos la cuenta. **La confianza es el activo del ICP** — una agencia no vuelve a darte acceso a su GitHub después de eso.

**Señales tempranas.** *(2 semanas)* alguna operación escribe al repo del cliente sin ser idempotente (crear issue sin chequear si ya existe). *(2 meses)* el primer "¿por qué hay dos de esto?"; alguien limpia a mano en el repo de un cliente.

**Mitigación hoy.** **Toda escritura outward es idempotente por construcción** (crear issue = skip si ya hay `external_ref`; crear repo = distinguir "ya existe" de un 422 real — los dos son bugs concretos ya diagnosticados en YoMap y nunca arreglados). **El agente trabaja siempre en una rama propia y nunca toca `.github/workflows/`** ni la default branch (el guard `unsafePath` de v2, que existe y funciona). Y el detalle que parece cosmético y no lo es: **el prompt entra por stdin, jamás por argv** — está documentado con la autopsia completa en `scripts/agent-runner.sh:137`. Copiar ese comentario textual al sucesor.

---

### F12 · "No es producto: es la laptop de Noel"
**Cómo murió.** El sucesor era genuinamente simple y genuinamente bueno — **para Noel**. Corría con su `~/.claude`, sus tokens, su `gcloud` logueado, su Docker, sus alias. Cuando la primera agencia quiso usarlo, la respuesta honesta fue "te lo configuro yo" y después "mejor lo corro yo y te entrego el resultado". Eso no es una fábrica de software gobernada: es **Noel haciendo consultoría con buenas herramientas**, que ya era lo que hacía antes. No había nada que vender a agencias LATAM, que era el ICP entero. Y como todo el conocimiento del proceso vivía en transcripts efímeros en vez de un registro auditable, tampoco había **moat**: cualquiera con Claude Code y BMAD hace lo mismo. El sucesor no fracasó técnicamente. Fracasó como **producto**.

**Señales tempranas.** *(2 semanas)* nadie escribió el `README` de "cómo lo corre alguien que no sos vos"; el sistema depende de al menos una config global de la máquina. *(2 meses)* nadie más que Noel lo corrió nunca de punta a punta; la respuesta a "¿qué vendemos?" tarda más de una frase.

**Mitigación hoy.** **Un tercero lo corre en el mes 1** — un amigo, un contractor, una máquina limpia; el criterio es que llegue a una app corriendo siguiendo solo el README. Todo lo que se rompa en ese intento es el producto real. Segundo: **decidir explícitamente qué es el moat antes de tirar cosas.** De Fluxo v2, lo que produjo valor diferenciado no fue el orquestador — fue **(a)** el reviewer de contexto fresco que caza lo que los tests esconden, **(b)** los gates deterministas (`provisioning-lint`), y **(c)** el registro auditable de por qué se decidió cada cosa. Los tres son **archivos y comandos en el repo del cliente**, cero infra. Un registro auditable no necesita Postgres+RLS: **necesita commits**. Si el sucesor se queda sin (a), (b) y (c) por simplicidad, es un wrapper de Claude Code y no hay negocio.

---

## 2. Herencias peligrosas — qué sobrevive al rediseño

De los ~24 incidentes reales registrados de Fluxo v2, cuáles **desaparecen por construcción** al no tener orquestador ni infra propia, y cuáles **el diseño simple sigue heredando** (con qué mutación).

| # | Incidente real (v2) | ¿El sucesor lo hereda? | Por qué / en qué se convierte |
|---|---|---|---|
| 1 | Token GitHub App expira ~8h → handoff 401, repo no creado (YoMap) | **SÍ, intacto** | Es del proveedor. Mitigación: releer el token justo antes de cada escritura, nunca al inicio del run |
| 2 | Token del wrapper expira a 1h → 72 min y $43 sin PR (`claude-code-action#716`) | **SÍ, mutado** | Menos capas (`claude -p` crudo) reduce la superficie, pero cualquier corrida larga con credencial de vida corta lo reproduce |
| 3 | JWT de tenant expira a 1h en runs de horas (bug MiSalon) | **NO — eliminado** | No hay DB propia ni JWT propio que expirar |
| 4 | Agente se suicida con `pkill` (prompt en argv) → rc=143 | **SÍ, intacto** | Delegar más = más agentes corriendo comandos. Fix conocido: prompt por stdin |
| 5 | Run vacío / fire-and-forget (subagente en runner efímero, L-AUTO-5) | **SÍ, mutado** | El bug era del wrapper; con `claude -p` los subagentes funcionan, pero "el agente terminó sin trabajo" sigue siendo posible |
| 6 | Watchdog falso positivo canceló un run sano a los 20 min | **NO — eliminado** | No hay watchdog porque no hay proceso que vigile. El techo lo pone el propio comando |
| 7 | Doble adopción de run (heartbeat stale) → 34 issues duplicadas | **NO — eliminado** *(si y solo si se cumple I1)* | Sin poller ni lease no hay race. Si aparece un poller, vuelve idéntico |
| 8 | Flap: doble dispatch pago sin histéresis (L-ARCH-2) | **NO — eliminado** | No se deriva estado crítico de lecturas eventuales porque no se deriva estado |
| 9 | `dispatch_mode:auto` disparó agentes pagos sin querer | **SÍ, mutado** | Cualquier automatismo que gaste. Default manual desde el día 1 |
| 10 | Run cancelado/timeout con costo invisible ($11.63 en salonara) | **SÍ, intacto** | El gasto ocurre igual. Sin `run_costs`, es *más* invisible → hace falta el CSV de costos (F7) |
| 11 | Stub certificado como éxito (`delivery_rate=1.0` con 0 pushes, L-BUILD-1) | **SÍ — el más peligroso** | Es un patrón del **agente**, no del sustrato. Delegar no lo toca. Solo lo caza el reviewer build+run |
| 12 | Gate verde-pero-vacío (`continue-on-error`; `{{app_path}}` sin resolver) | **SÍ, intacto** | Cualquier gate nuevo puede skipear. Regla: no-puede-correr ⇒ falla |
| 13 | Scaffold degradó a `_common` por stack inventado, en silencio (Salonara) | **SÍ, mutado** | BMAD puede inventar igual. Se cura con lista cerrada + fail-loud, no con delegación |
| 14 | Secret con dos nombres → skip silencioso de App Distribution | **SÍ, intacto** | Puro naming. Manifiesto de credenciales con nombre canónico único |
| 15 | Drift de migraciones local↔prod (42P01, run pago perdido, salvage-resume manual) | **NO — eliminado** | No hay migraciones ni dos entornos propios |
| 16 | Deploy por rsync al target equivocado; `+x` perdido → `203/EXEC` | **NO — eliminado** | No hay deploy propio. *Salvo* que aparezca un VPS (I1) |
| 17 | Whitelist `REPO_DOCS` droppeó los mockups en silencio | **SÍ, mutado** | "Enumerar en código lo que el método declara" es un anti-patrón portable. Derivar del workdir, nunca enumerar |
| 18 | Handoff tragó un 401 → 10 stories sin issue, en silencio | **SÍ, intacto** | Todo `catch {}` que trague. Regla: fail-loud siempre en escrituras outward |
| 19 | Imagen Docker pruneada → `rc=2` de arranque (u-gaps1) | **SÍ, mutado** | Si el reviewer corre en Docker (y debe, para build+run), self-heal o falla claro |
| 20 | Preview: ~15 iteraciones de infra propia (mixed content, seed, tipos) | **PARCIAL** | La receta ya está resuelta y validada; heredarla **como archivos del repo**, no como runner |
| 21 | Console↔design acoplados por cross-import → un deploy arrastra al otro | **NO — eliminado** | No hay console ni dos paquetes |
| 22 | Branch protection nunca seteada → el gate del reviewer no bloqueaba de verdad | **SÍ, intacto** | El gate más caro de v2 fue advisory sin que nadie lo notara. Setearla en el scaffold |
| 23 | Dos sesiones commiteando en el mismo working tree | **SÍ, intacto** | Es disciplina de operación humana; un worktree por tarea |
| 24 | "Permitir ≠ invocar": guard permisivo → 0 subagentes, trabajo lineal | **SÍ, intacto** | Delegar al modelo su propia orquestación exige **imperativo condicional**, no permiso |

**Lectura del cuadro.** El diseño simple elimina de raíz **7 incidentes** — y todos son de la misma familia: *estado propio, procesos propios, entornos propios*. No elimina ninguno de los que más caro salieron: **stub certificado como éxito, gates que skipean, credenciales que expiran, escrituras no idempotentes al repo ajeno**. Conclusión incómoda y central: **la simplicidad compra la mitad del problema — la mitad barata**. La otra mitad hay que seguir pagándola con reviewer, gates fail-loud y manifiesto de credenciales, y eso es exactamente lo que hay riesgo de tirar en nombre de "delegamos todo".

---

## 3. Los 5 invariantes del sucesor

Reglas de diseño con una propiedad: **son verificables**. Si se viola una, no es un debate de gustos — es la señal de que vamos camino a alguna de las 12 narrativas, y la respuesta es parar y rediseñar, no seguir con un `if` más.

**I1 · Cero procesos propios de larga vida.**
Ni worker, ni poller, ni `systemd`, ni cron nuestro, ni loop de reconciliación. Todo corre porque un humano o un evento de GitHub lo disparó, y termina. *Verificación:* `ps` en cualquier máquina no muestra nada nuestro corriendo. *Si se viola:* estamos en **F1**, y todo el bloque "eliminados" de la tabla de herencias (races, flaps, watchdogs, drift, deploy) vuelve de golpe.

**I2 · Cero estado de verdad propio.**
No hay base de datos, ni archivo de estado, ni tabla que diga en qué situación está una story. La verdad es el repo + GitHub, leído cuando se pregunta. *Verificación:* borrar toda máquina nuestra no pierde información de ningún proyecto. *Si se viola:* estamos reconstruyendo el conductor.

**I3 · Ningún "hecho" sin artefacto ejecutado.**
Nada se marca terminado sin que algo haya **buildeado y corrido**, con evidencia adjunta (exit code, screenshot, URL abierta). Tests en verde no son evidencia de que corre. *Verificación:* tomar cualquier ítem cerrado del último mes y encontrar su evidencia en menos de un minuto. *Si se viola:* **F3 + F8**, que es el fracaso que trajo al sucesor a existir.

**I4 · Ningún gasto sin techo declarado y sin corte externo.**
Presupuesto por proyecto escrito antes de arrancar; límite duro en la cuenta del proveedor; default **manual** en todo lo que dispara un agente. El kill-switch nunca es código nuestro. *Verificación:* el costo acumulado del proyecto en curso se responde en un comando. *Si se viola:* **F7**, y el modelo de negocio deja de cerrar sin que nadie lo vea.

**I5 · Todo lo nuestro se corre desde el repo, con un comando, por alguien que no es Noel.**
Nada depende de la máquina de Noel, de una UI nuestra, ni de un servidor nuestro. Las dependencias externas (BMAD, harness) van pineadas y vendorizadas, y las divergencias en un `overlay/` diffeable. *Verificación:* un tercero en una máquina limpia llega a una app corriendo con el README. *Si se viola:* **F2 + F5 + F12** — no hay producto, hay una persona con herramientas.

> **Cómo se usan.** Una violación no es un bug: es un **evento de revisión**. Se anota, se nombra la narrativa hacia la que empuja, y se decide *rediseñar o cancelar*. Tres violaciones sin resolver = el sucesor está muriendo la muerte de Fluxo, y hay que decirlo en voz alta.

---

## 4. Métricas de vida o muerte

Seis métricas, con umbral concreto, cadencia y qué se hace al cruzarlas. Todas son baratas de medir; si medirlas requiere construir algo, están mal diseñadas.

| # | Métrica | Umbral (verde / rojo) | Cadencia | Qué se hace en rojo |
|---|---|---|---|---|
| **M1** | **Idea → demo navegable que un tercero abre en su browser** | < 8 h de trabajo efectivo / **> 2 días** | Por proyecto, revisada semanal | Es la métrica de venta (**F6**). En rojo se para todo lo demás: sin demo confiable no hay negocio |
| **M2** | **Horas/semana operando el sistema** vs. construyendo producto | ≤ 10% (≈ 4 de 40) / **> 25%** | Semanal, anotada a mano | **F5**. Se identifica el paso humano más caro y se elimina o se convierte en comando, esa semana |
| **M3** | **Incidentes de infra propia** (debug de algo que escribimos nosotros y no es el producto del cliente) | **0 por semana** / ≥ 2 | Semanal | **F1**. Dos semanas seguidas en rojo = revisar I1/I2: hay sustrato propio que no debería existir |
| **M4** | **LOC de pegamento propio** (sin contar BMAD vendorizado ni templates) | ≤ 2.000, derivada ≤ +200/mes / **> 3.000 o +500 en un mes** | Mensual, un `wc -l` en el README | **F1**. En rojo: sesión de borrado antes de cualquier feature nueva |
| **M5** | **Costo por producto entregado**, y varianza entre proyectos comparables | ≤ $250 y varianza < 40% / **> $400 o varianza > 2×** | Por proyecto + resumen mensual | **F7**. Referencia real: YoMap = $190,47 / 34 stories / 15 jobs. En rojo: diagnosticar antes de tomar el próximo cliente |
| **M6** | **P0 encontrados después de "hecho"** (por el cliente, por el dueño, o por el reviewer post-merge) | 0 llegados al cliente / **≥ 1 llegado al cliente** | Por sprint | **F3 + F8**. Un P0 que llega al cliente = el gate no existe. Se reproduce el fallo como test antes de seguir |

**Ritual de revisión.** Semanal, 20 minutos, contra M1/M2/M3: tres números y una pregunta — *¿violamos algún invariante esta semana?*. Mensual, 1 hora, contra M4/M5 + el estado de las 12 narrativas: *¿alguna dejó de ser hipotética?*. **Al mes 3**, la única decisión que importa: **¿el sucesor entregó un producto de punta a punta con un tercero pudiendo correrlo?** Si no — se cancela y se vuelve a v2 con las lecciones escritas. Cancelar a tiempo es el único resultado que este premortem puede comprar; todo lo demás es suerte.

---

> **La frase que hay que tener pegada al monitor.** Fluxo v2 no fracasó por construir un orquestador: fracasó porque construyó un orquestador **y además** tuvo que resolver stubs certificados como éxito, gates que skipean, credenciales que expiran y apps que compilan sin arrancar. El sucesor borra la primera mitad de esa lista. **Si además borra la segunda —el reviewer, los gates deterministas, el registro auditable— no queda un sistema simple: queda Claude Code, y eso ya lo tenía cualquiera.**