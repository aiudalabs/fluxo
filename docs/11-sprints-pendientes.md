# 11 · Sprints de pendientes (backlog groomed que maneja el build de Fluxo)

> El backlog de trabajo de Fluxo v2, agrupado en **sprints** por valor y dependencia. Sale de fundir:
> `03-roadmap.md` (fases sin cerrar) + `10-calidad-build-backlog.md` (hallazgos de Idearium) + la
> memoria de improvements + lo que salió operando en prod. Se marca a medida que se cierra.
>
> **Orden recomendado:** P1 → (P2 ∥ P3) → P4/P5 (UX/producto) → P6 (GTM) → P7 (finish line).
> **Regla:** verificá el estado REAL antes de tomar un ítem — el roadmap puede estar desactualizado.

## ✅ Cerrado reciente (no re-listar)
F5-03 handoff (repo+issues+deps) · F6P-03 mockups navegables (DocView) · despliegue prod con TLS ·
conductor idempotente + re-mint del JWT · incongruencia de Settings (`execution_unit` + surface de
`dispatch_mode`) · workflow_approval `auto_if_safe` · vistas Agentes + Spend.

---

## 🟢 Sprint P1 — Confianza en el build (anti-stub + verify real) — **IMPLEMENTADO 2026-07-19**
**Objetivo:** que un backlog "verde" signifique *entregado*, no *cableado*. Es el moat y ataca de raíz
lo que encontró la validación de Idearium.

> **✅ Implementado y verificado en el repo real `nmlemus/misalon`** (commits df83c39 scaffold+verify,
> 3199dfb método anti-stub, + L-BUILD-1). El scaffold ahora emite **21 archivos** incl. el harness de
> verify completo (`.fluxo/verify/**` + e2e-verify/provisioning-lint/ui-verify), bloqueantes.
> **Aplicado a MiSalon** vía `rescaffold.ts` (idempotente, sin re-crear issues).

| # | Ítem | Estado |
|---|---|---|
| P1-1 | Verify determinista bloqueante | ✅ e2e-verify + provisioning-lint sin `continue-on-error` (guard interno → skip-limpio en repos sin `.fluxo/verify`). **Nota:** no se fuerzan required-checks en branch-protection (path-filters → deadlock); el auto-merge exige CLEAN. Bajo **merge_mode:manual** (MiSalon) el rojo es advisory → confirmar que el harness skipea-limpio en repos inmaduros ANTES de activar auto-merge. |
| P1-2 | CI ejecuta lo que protege | ✅ **CERRADO.** e2e-verify corre el sistema integrado + nuevo **`test-verify.yml`** (per-stack) **ejecuta la unit-suite del repo** bloqueante. El audit por ejecución de MiSalon lo probó necesario (37 tests que el CI nunca corría) y encontró **L-BUILD-2** (tests no herméticos: `ECONNREFUSED 127.0.0.1:5432` — unit tests que abren Postgres real; verde solo con infra levantada). Ver `docs/10`. |
| P1-3 | Método anti-stub | ✅ Reviewer (`claude-review.yml`): 4ª categoría de BLOCKER. Skill `acceptance-self-audit` item 5. Las **6 personas** de build (3 stacks ×2) con el mismo item 5. |
| P1-4 | Métricas ≠ retorno de stub | ✅ Incluido en el gate del reviewer + self-audit ("nunca leer una métrica de éxito del retorno de un stub"). |
| P1-5 | `ui-verify` deja de skipear | ✅ `ui-verify.yml` emitido y corre (react-supabase self-guard en `package.json`). *Diferido:* `app_path` (stack Flutter) + pre-render de `design_tokens` (un-skipea `frontend.instructions`). |
| P1-6 | Secretos fail-closed | ✅ En el gate del reviewer + self-audit ("nunca bootear prod con un secreto de dev; fail closed"). |
| P1-7 | **L-BUILD-1** en `04-lecciones` | ✅ Agregada (liga L-AUTO-3). |

> **Follow-up de P1 (deferido, NO bloquea):** el **generador de pre-render** de `design_tokens`/`path_map_*`/
> `validation_commands` — mientras no exista, `AGENTS.md`/`CLAUDE.md`/`frontend.instructions.md` se **saltan**
> (el scaffold los reporta con las vars que faltan). El reviewer + self-audit + `.agent.md` ya cubren el
> camino de build real. Va a **P4** (junto al ArtifactView).

---

## 🟢 Sprint P2 — Verificación de juicio (lo que el lint no ve) — **~IMPLEMENTADO 2026-07-19**
**Objetivo:** verificar que lo construido *funciona de verdad y se ve bien*, no solo que compila.

> **Verificado 2026-07-19:** P2 estaba **~80% construido por P1** (el harness ya traía el art-director y
> el e2e-verify). El trabajo real fue reconectar el juez-visión (P2-1).

| # | Ítem | Estado |
|---|---|---|
| P2-1 | Juez-visión: screenshot vs mockup aprobado; visual roto bloquea | ✅ (commit d0e7ced) El art-director de `ui-verify` (render screenshot+mockup → opus-4-8 → PASS/FAIL → rojo, con guard anti prompt-injection) ya estaba shippeado en P1 pero **skipeaba siempre** (buscaba `docs/mockups/<screen_key>.html`, el designer emitía un `index.html`). Fix del **contrato**: `ux` da la key `role.screen` por pantalla, `designer`/`mockup-html` emiten `docs/mockups/<screen_key>.html` per-pantalla, el `scrum-master` ya asigna `screen_key`. Ahora el juez dispara. **Aplica a runs futuros** (MiSalon ya tenía index.html → re-correr mockups para activar, opcional). |
| P2-2 | Verify cross-lane e2e | ✅ **Built + bloqueante en P1.** `e2e-verify` bootea el backend real, siembra, corre el flow en browser real + invariantes, exit 1 en fallo. Eso **es** L-LM-5 (integración = gate, no lint estático). El "desplegado↔desplegado" literal es **F8/P3**. |
| P2-3 | Verify multi-superficie (per-app) | 🟡 **PARCIAL.** Para **react-supabase** (web única, ej. MiSalon): las superficies son pantallas → cubiertas por el art-director per-`screen_key` (P2-1) + rutas por los e2e flows (el harness soporta N flows en `e2e.flows/`). **Residual:** el `ui-verify` de **Flutter** usa un solo `{{app_path}}` (primario) → un producto multi-app (customer+provider+admin) solo verifica el primario (L-LM-4). Fix diseñado: matrix sobre app_paths + flows por superficie. **Diferido** hasta que corra un proyecto multi-app real (no shippear una matrix untested a un stack sin proyecto vivo — disciplina anti-stub sobre lo nuestro). |

---

## 🟢 Sprint P3 — Última milla (que el app entregado corra) — **~IMPLEMENTADO 2026-07-19 (D3=cut)**
**Objetivo:** cerrar idea→**app viva**, no solo idea→PR. **D3 decidida: CUT** (web + link de prueba;
tiendas + provisioning-auto → v1.1). Ver `06-decisiones`. Deploy REAL = **BYO-credencial** (el humano
pone sus tokens Vercel/Railway).

| # | Ítem | Estado |
|---|---|---|
| P3-1 | Provisioning de infra del cliente | 🟡 **Cut minimal:** el cliente trae sus cuentas (Supabase/Vercel/Railway); el `deploy.yml` cablea env/secrets y publica contra ellas. **Provisioning AUTO (crear su Supabase vía API) → v1.1** (parte "full" de D3). |
| P3-2 | Deploy web preview + prod, "publicar con un click" | ✅ **`deploy.yml`** (react-supabase + python-fastapi-react): `workflow_dispatch` preview/prod, frontend→Vercel, backend/worker→Railway. Cada tramo skipea-limpio sin su secret (aditivo). Cierra F8-02/L-LM-2 (web). |
| P3-3 | Build móvil firmado + link de prueba | ✅ **`build-apk.yml`** (flutter): firma release real si hay keystore en secrets (cae a debug si no) + distribución a Firebase App Distribution si está configurado (cae al artifact si no). Cierra F8-03/L-LM-1 (cut). **Diferido:** flutter web deploy (firebase hosting), iOS/TestFlight. |
| P3-4 | Data migrations en el deploy | ✅ El `deploy.yml` corre migraciones ANTES del código (drizzle-kit / alembic), guardado por el secret de DB. Cierra F8-05. |
| P3-5 | Submission a tiendas | ⛔ **Diferido a v1.1** por D3 (cut). App Store Connect / Play Console, signing Apple, macOS runner. |

> **Estado de aterrizaje en MiSalon:** el harness de verify (incl. `test-verify`) ya está en `nmlemus/misalon`
> (rescaffolds previos). `deploy.yml` quedó pendiente de subir por un **HTTP 503 de GitHub** (blip externo,
> no del código) — reintentar el `rescaffold.ts` cuando GitHub se recupere. El deploy real necesita los
> tokens del usuario (Vercel/Railway) de todos modos.

---

## 🟢 Sprint P4 — ArtifactView + Observabilidad
**Objetivo:** que todo lo que Fluxo produce sea legible y trazable en la UI.

| # | Ítem | Estado |
|---|---|---|
| P4-1 | **ArtifactView** completo | ✅ (2026-07-19, deployado) `DocView` resaltea yaml/json/shell (tokenizer sin dep, spans seguros, tokens theme-aware) y lo adoptan **Studio + Registry + Brain**. Un solo renderer por tipo. Resuelve "yaml/.vibeforge-gate como texto crudo". |
| P4-2 | **Observabilidad** estilo Langfuse/Arize | ✅ (2026-07-19, deployado + migración aplicada a fluxo-prod). **A)** `agent.ts` captura costo/tokens/latencia del SDK por fase → `design_phases` (migración `20260719120000`); worker instrumentado (verificado sin crash). **B)** vista **Observabilidad** (rename de Brain): dashboard (costo total/diseño/build + tokens + fases·runs) + tab **Trazas** (fases con barra de duración+costo + gates como anotación + builds de `run_costs`) + tab **Eventos** (log preservado). El costo de DISEÑO aparece "—" en MiSalon (fases pre-instrumentación) → se llena en el próximo design run. |
| P4-3 | Drawers de nodo en `/flow` | ✅ (2026-07-19, deployado) Click en nodo de story (`story:<id>`) → abre el `TicketDetail` del board (reusado; deps clickeables, PR/sesión/run). Fases/sprints no abren drawer (sprint ya linkea al board). F6P-04. |
| P4-4 | Decisión Sidebar 11 secciones | ✅ **Decidido (2026-07-19): mantener el top-nav project-first de v2** (ratifica D6). NO se replica el sidebar global de v1 — el IA project-first es el correcto para una herramienta project-scoped y ya estaba validado. Cero código. Cierra F6P-05. |

---

## 🟢 Sprint P5 — AI Assistant + change-requests — **COMPLETO 2026-07-20**
**Objetivo:** el bot agéntico que v1 tenía y v2 perdió, + el disparador de incrementos.
**Los 3 ítems hechos + deployados.**

| # | Ítem | Fuente |
|---|---|---|
| P5-1 | **AI Assistant** agéntico | ✅ **COMPLETO (2026-07-20, deployado).** Chat con las 3 acciones confirmables (increment/dispatch/gate), UI de v1 + markdown, sección + panel flotante. Streaming SSE = polish diferido. *(detalle abajo)* Fundación VIVA y de-riesgada. Diseño cerrado: LLM = token de suscripción vía claude-agent-sdk; acciones (incremento/dispatch/gate) con confirmación; UI sección+flotante. **Infra de-riesgada:** el agent-loop corre en el **worker** (ambiente probado), el console **proxea** (`WORKER_ASSISTANT_URL`) — no en el alpine/root del console. v1 DEPLOYADO + probado (respondió con datos reales de MiSalon). Sección "AI Assistant" en la nav, **UI portada de v1** (`.brain*`) con respuestas en **markdown**. **Acción "pedir incremento" con confirmación LISTA:** el bot emite un bloque ```fluxo-action``` (JSON validado) → la UI lo renderiza como tarjeta `.brain-action` → "Confirmar y pedir" → encola en `increment_requests` (patrón propose→confirm→execute, el bot nunca dispara solo). Probado E2E (propuso "Mis Citas"/"depósitos" referenciando las stories reales). **Próximos incrementos:** acciones dispatch/aprobar-gate (hoy sugeridas en prosa) + panel flotante + streaming SSE. |
| P5-2 | Botón **"pedir incremento / change-request"** | ✅ (2026-07-19, deployado) Vertical slice: tabla `increment_requests` (cola, RLS) + `worker.reconcileIncrements` → `spawnIterate` (main.ts --workflow=iterate) + `main.ts` siembra el workdir con los docs existentes (`loadProjectDocs`) → el `iteration-planner` emite un DELTA → handoff APPENDea. UI: componente `IncrementRequest` (textarea + lista Realtime) en el Overview cuando el producto existe. El motor `iterate.yaml` ya existía; esto es el disparador. **Primer uso real dispara un planner pago** (aún no corrido). |
| P5-3 | Selección de **workflow por proyecto** en Settings | ✅ (2026-07-20, deployado) El worker usaba un flag global `--workflow=design`; ahora cada proyecto elige en Settings **Completo (`design`, 8 fases)** vs **Lean (`demo-design`, 3 fases)**. `reconcileDesign` lee `settings.workflow` → `spawnDesign` (solo fresh; resume usa el del run). |
| P5-4 | **Memoria del AI Assistant** (persistencia de conversación) | ⚪ **PENDIENTE.** Hoy el chat es *stateless entre sesiones*: `AssistantChat` guarda los mensajes en `useState([])` (se pierden al refrescar/navegar), no hay tabla de historial, y `runAssistant` (worker) recibe la historia por request y no persiste nada. Dentro de un hilo el bot tiene contexto; al volver arranca de cero — no recuerda charlas ni decisiones. **v1:** tabla `assistant_threads`/`assistant_messages` (RLS tenant+project), load-on-mount, el worker appendea la respuesta. **v2 (opcional):** memoria semántica del proyecto que el bot pueda leer/escribir (estilo OMEGA). Chico; candidato a colgar de P8 o hacerlo como P5-follow-up suelto. |

---

## ⚪ Sprint P6 — Onboarding + GTM (para vender)
*(Del roadmap Fase 9.)*

| # | Ítem | Fuente |
|---|---|---|
| P6-1 | Wizard de onboarding con **semáforos de capacidad reales** | F9-01 · L-UX-3/4 |
| P6-2 | Capabilities project-scoped + **canal Copilot real** | F9-02 · L-UX-2 |
| P6-2b | **Capabilities/Integrations BYO generalizadas** (Firebase, Vercel, Railway, Gemini…) — mismo patrón que el token de Claude: credencial tipada + probe 🟢 → Actions secret del repo del cliente. Ver "problema 3" del 2026-07-20: un AC "crear el proyecto Firebase" NO es despachable → el humano crea la cuenta/proyecto+billing UNA vez (como Vercel), otorga una **service-account key** scoped, y el agente hace TODO lo demás (rules/indexes/functions/auth) con firebase-tools. Requiere lado-método: el diseño (architect/scrum-master vía `docs/provisioning.yaml`) debe ser **capability-aware** — separar "provisioning humano one-time" de las stories, y no escribir ACs que el agente no puede cumplir. Data-driven (registry/capabilities, golden rule #1/#5). | 2026-07-20 · extiende P3 BYO-deploy |
| P6-3 | Billing de agencia + metering (plan Team, overage, BYO-key) | F9-03 |

---

## ⚫ Sprint P7 — Aceptación E2E (finish line)
| # | Ítem | Fuente |
|---|---|---|
| P7-1 | MiSalon/Rosa corre de **punta a punta** (idea→app viva→brain trazable→change-request re-entra) | F10-01 |
| P7-2 | Webhooks activos en prod (hoy el worker poll-ea; falta el receiver) | F10-02 |

---

## 🟢 Sprint P8 — Fidelidad diseño→build (que la UI entregada refleje el spec+mockups) — **IMPLEMENTADO 2026-07-20**
**Objetivo:** cerrar el hueco de método que dejó el panel del dueño de **MiSalon esquelético** (validación n=3).
**Diagnóstico raíz:** el `scrum-master` **comprimió 27 pantallas de `UI_SCREENS.md` en ~8 `screen_keys`** → pantallas
enteras nunca tuvieron story → nunca existieron para ningún agente. La falla es de la **cadena del método** (3 eslabones
rotos), no del implementador. Está **aguas arriba del harness de verify (P1/P2)**: el art-director solo juzga lo que tiene
story+mockup; si la story nunca existió, no hay nada que construir ni verificar. Prerequisito (**los mockups llegando al
repo**) **ya resuelto** por `repodocs.ts` (commit 95414c2). Complementa la línea de calidad de build (docs/10, L-BUILD).

| # | Ítem | Estado |
|---|---|---|
| P8-A | **Cobertura de UI en el backlog** | ✅ (2026-07-20, `b730465`) El `scrum-master` LEE `docs/UI_SCREENS.md` y emite una story por pantalla, con matriz `coverage:` (pantalla→story) + bloque `out_of_scope:` explícito en `backlog.yaml`. `design.yaml` pasa `screens_path` a la fase `backlog`. Degrada con gracia sin `UI_SCREENS.md` (igual que `provisioning.yaml`). **Llave de join = ID de pantalla verbatim del header** (`P.1`, `S.5`, `1.2`…), NO `screen_key`/`role.screen` — verificado n=6 que ningún `UI_SCREENS.md` real emite el dotted key; unir por él sería un no-op silencioso. |
| P8-B | **Chequeo determinista de cobertura** | ✅ (2026-07-20, `5e1c149` + `789c70e`) En el seam REAL (`repodocs.ts`/`handoff.ts`, NO el `validate` no-op del engine): `parseScreenIds` parsea `UI_SCREENS.md`, `parseCoverageClaim` lee `coverage`/`out_of_scope`, `planRepoDocs` reporta `uncoveredScreens`. El handoff lo emite como `handoff_screens_uncovered` (guard al brain, mismo estilo que `missingMockups` — **reporta fuerte, no falla** el handoff: parse heurístico no debe trabar el build). Tests primero (golden rule #6), **piso 123→132/132**. **Demostrado contra MiSalon real:** parsea las 27 pantallas y reporta el panel del dueño que faltó (S.6-9, S.11-14). |
| P8-C | **Puntero a spec+mockup en el prompt del dev** | ✅ (2026-07-20, `789c70e`) `storyPrompt`/`sprintPrompt` (`dispatch.ts`) e `issueBody` (`handoff.ts`) apuntan a la sección de la pantalla en `docs/UI_SCREENS.md` y a `docs/mockups/<screen_key>.html`, no solo "leé docs/". `dispatch.ts` sigue kernel-puro: `screenKey` llega por `DStory` (sin fs/imports); threaded en el select del worker y del console. |

> **Casa (constraint del pedido):** branch fresco, tests-first, **NO** incluir en los commits los cambios ajenos de otra sesión
> en `console/components/AssistantChat.tsx` ni `design/src/assistant.ts` (P5-1). Branch → ff-merge a main local, **sin push**
> hasta OK. Ver el spec completo en el mensaje de origen / `~/.devtrace/decisions/fluxo.md`.

---

## 🧹 Deuda chica (folder aparte, no bloquea sprints)
- **Dispatch fuera del board no se trackea**: un re-run manual del Action en GitHub no actualiza el status de la story (el board solo refleja el dispatch vía `/api/.../dispatch`).
- **`publishBacklog` huérfanos al encoger**: si el backlog *pierde* stories en un re-handoff, quedan filas viejas (el `DELETE` está revocado para authenticated). Hoy solo inserta lo que falta.
- **Decisión de producto:** ¿el default global de `dispatch_mode` debería ser `manual` (hoy `auto`)? El `auto` ya sorprendió una vez con costo.
- **Drift de migraciones local↔prod (aplicadas a prod, NO a local)** 🔴 *bit 2 veces el 2026-07-20 operando el E2E.* `increment_requests` (P5-2) y `design_phase_costs` (P4-2) se aplicaron a prod vía Management API pero nunca a local → el worker tiró `42P01 relation does not exist` y `PGRST204 cache_read_tokens column not found`; **el segundo abortó un iteration-planner grande YA corrido y pago** (el delta se salvó del workdir; el PATCH de la fase falló al escribir costos). Fix (a otro sprint): aplicar cada migración a local+prod en el mismo paso, y/o un check al arrancar el worker que verifique que el schema esperado existe (fail-fast con mensaje claro, no 400 a mitad de run). Ambas ya aplicadas a local a mano.
- **`iterate` pisa `docs/backlog.yaml` con el delta (no acumula) → el doc del repo pierde lo original** 🟠 *raíz, 2026-07-20.* La DB es additiva (publishBacklog appendea, ok), pero el `iteration-planner` emite un DELTA (new ids only), el workdir lo sobrescribe y `planRepoDocs` commitea ese delta pisando el backlog completo del repo. Además `loadProjectDocs()` ("latest per path") sombrea el original → **un PRÓXIMO iterate no vería las stories originales** (perdería contexto). Fix (con tests, golden rule #6): que el iterate acumule el backlog — o mergear delta+existente antes del handoff, o (más robusto) regenerar `docs/backlog.yaml` desde la DB (verdad ya mergeada) tras publicar. La UI ya se arregló aparte (Studio muestra docs project-wide); esto es el lado data. *(El E2E lo cazó; el original sigue recuperable en la DB, run 50c95565.)*
- **`iterate` no corre la fase de mockups → stories frontend nuevas nacen sin mockup** 🟡 *observado 2026-07-20 en el E2E.* Un change-request que agrega pantallas nuevas (ej. `auth.login`, `pensador.home/calendar/graph` en la migración Firebase) publica stories con `screen_key` pero el handoff avisa "story frontend con screen_key SIN mockup → el art-director de ui-verify no podrá juzgarlas". El workflow `iterate.yaml` solo tiene `plan→gate→handoff`, sin fase de mockups. Fix (a otro sprint): que iterate genere mockups para las pantallas nuevas del delta (o marque explícito que no aplica), para no romper la verificación de juicio (P2) en incrementos con UI nueva.
- **Studio en un incremental no mostraba los docs viejos ni las 2 versiones del backlog** ✅ *resuelto 2026-07-20.* Studio derivaba el panel de documentos de `phases` (SOLO el último run) → un `iterate` (que solo produce su fase delta) escondía PRD/BRIEF/backlog. Fix: `files` deriva del **brain versionado** (`brain_events` kind=artifact, project-wide) — la fuente de verdad (cada doc de diseño se sube a git + se registra como versión), con fallback a las fases del run actual. Ahora se ven todos los docs y sus chips vN. *(El delta del change-plan no había quedado versionado por el bug del drift — ver abajo — se backfilleó como v2 a mano.)*
- **Hardening del sink: `brainAppend` corre DESPUÉS del write de costos → una falla ahí pierde la versión** 🟡 *2026-07-20.* En `supabase.ts onPhaseDone`, el orden es `patchPhase(status+artifacts+costos)` y LUEGO `brainAppend(versión)`. El drift de `cache_read_tokens` hizo fallar el primero → la versión del delta nunca se registró. Fix (con tests): registrar la versión del doc ANTES/independiente del write de métricas (el doc durable no debe perderse por un fallo de un dato secundario).
- **JWT expira → "Could not read the repo docs.: JWT expired" (re-auth frecuente)** 🔴 *reportado 2026-07-20, operando el E2E.* El JWT de sesión/tenant caduca con TTL corto y el path de lectura (repo docs / `loadProjectDocs`) NO hace refresh silencioso → el usuario tiene que re-loguearse seguido. El re-mint que ya existe cubre el path del **conductor/worker**, no el del **console**. Fix (a otro sprint): refresh silencioso del token en el cliente antes de expirar (o re-mint on-401 + retry en el fetch de docs), y/o subir el TTL del JWT de tenant. Molesta la UX pero no bloquea el build.

---

*Estado: abierto. Fuente de verdad del build. Al cerrar un ítem, marcá `[x]` y dejá una línea de fecha·qué·commit.*
