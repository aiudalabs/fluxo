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
| P4-2 | **Observabilidad** estilo Langfuse/Arize | 🟠 **Diseño CERRADO (2026-07-19), falta construir.** Decisiones: (1) renombrar Brain → **Observabilidad**; (2) alcance = **+ instrumentar costo de diseño** (loguear costo/tokens/latencia por fase de los agentes SDK, no solo el build); (3) eventos semánticos = **anotaciones en el span**. **Plan de build (2 partes):** **A)** instrumentar `runAgent`/agent.ts para capturar `usage` por fase + persistir (extender `design_phases` o `design_phase_costs`); worker escribe. **B)** vista Observabilidad: lista de trazas (diseño+build) + detalle (fases con duración+costo+artefactos+anotaciones) + dashboard; rename + reusar renderers por-kind. Detalle en memoria [[fluxo-improvements-backlog]] #2. |
| P4-3 | Drawers de nodo en `/flow` | ✅ (2026-07-19, deployado) Click en nodo de story (`story:<id>`) → abre el `TicketDetail` del board (reusado; deps clickeables, PR/sesión/run). Fases/sprints no abren drawer (sprint ya linkea al board). F6P-04. |
| P4-4 | Decisión Sidebar 11 secciones | 🔲 **Decisión** (no código): ¿replicar el sidebar de v1 o quedarse con el top-nav project-first de v2? F6P-05. |

---

## 🔵 Sprint P5 — AI Assistant + change-requests
**Objetivo:** el bot agéntico que v1 tenía y v2 perdió, + el disparador de incrementos
(el motor `iterate.yaml` + agente `iteration-planner` ya existen; falta el trigger UI).

| # | Ítem | Fuente |
|---|---|---|
| P5-1 | **AI Assistant** agéntico (tools = la misma API de la UI, con guardrails para acciones pagas/outward) | memoria improvements #3 |
| P5-2 | Botón **"pedir incremento / change-request"** (AI Assistant → Overview → Board) | memoria improvements |
| P5-3 | Selección de **workflow por proyecto** en Settings | CLAUDE.md pendiente |

---

## ⚪ Sprint P6 — Onboarding + GTM (para vender)
*(Del roadmap Fase 9.)*

| # | Ítem | Fuente |
|---|---|---|
| P6-1 | Wizard de onboarding con **semáforos de capacidad reales** | F9-01 · L-UX-3/4 |
| P6-2 | Capabilities project-scoped + **canal Copilot real** | F9-02 · L-UX-2 |
| P6-3 | Billing de agencia + metering (plan Team, overage, BYO-key) | F9-03 |

---

## ⚫ Sprint P7 — Aceptación E2E (finish line)
| # | Ítem | Fuente |
|---|---|---|
| P7-1 | MiSalon/Rosa corre de **punta a punta** (idea→app viva→brain trazable→change-request re-entra) | F10-01 |
| P7-2 | Webhooks activos en prod (hoy el worker poll-ea; falta el receiver) | F10-02 |

---

## 🧹 Deuda chica (folder aparte, no bloquea sprints)
- **Dispatch fuera del board no se trackea**: un re-run manual del Action en GitHub no actualiza el status de la story (el board solo refleja el dispatch vía `/api/.../dispatch`).
- **`publishBacklog` huérfanos al encoger**: si el backlog *pierde* stories en un re-handoff, quedan filas viejas (el `DELETE` está revocado para authenticated). Hoy solo inserta lo que falta.
- **Decisión de producto:** ¿el default global de `dispatch_mode` debería ser `manual` (hoy `auto`)? El `auto` ya sorprendió una vez con costo.

---

*Estado: abierto. Fuente de verdad del build. Al cerrar un ítem, marcá `[x]` y dejá una línea de fecha·qué·commit.*
