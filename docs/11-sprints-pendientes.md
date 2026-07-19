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

## 🔴 Sprint P1 — Confianza en el build (anti-stub + verify real)
**Objetivo:** que un backlog "verde" signifique *entregado*, no *cableado*. Es el moat y ataca de raíz
lo que encontró la validación de Idearium. Se prueba en vivo con el build de MiSalon.

> **⚠️ Verificado 2026-07-19 contra el scaffold real + `nmlemus/misalon` (3 workflows:
> claude.yml · claude-review.yml · suite-integrity.yml). NINGÚN ítem de P1 está corregido.**
> **Nota:** el scaffold se congela en el handoff → arreglar P1 en el registry exige un **re-scaffold**
> (re-handoff, ya idempotente) para llegar al repo del cliente. MiSalon corre con los workflows viejos.

| # | Ítem | Fuente | Estado verificado |
|---|---|---|---|
| P1-1 | **Verify determinista** (lint/e2e/tests) como check REQUERIDO — PR con verify roja no mergea | F7-01 · L-AUTO-3 | ❌ NO existe verify en el scaffold (regresión vs v1: no es "sacar `continue-on-error`", es crearlo) |
| P1-2 | El CI **ejecuta** los tests que protege | docs/10 #6 | ❌ `suite-integrity.yml` cuenta marcadores, no corre `pytest`/`flutter test` |
| P1-3 | **Método anti-stub**: agentes no cablean `Logging*`/`InMemory*` como default de prod en I/O P0 → real, o falla ruidoso, o marca NO-HECHO | docs/10 #1-3 | ❌ Sin guard en agents/skills. Parcial adyacente: `claude-review.yml` + `acceptance-self-audit.md` (juzgan tests falsos, no stubs de prod) |
| P1-4 | Ninguna métrica mide el retorno de un stub (`delivery_rate=1.0` enviando cero) | docs/10 #2 | ❌ Sin guard |
| P1-5 | `app_path`/design_tokens poblados en scaffold (que `ui-verify` deje de skipear) | F7-02 · L-AUTO-3 | ❌ No hay `ui-verify` en el scaffold |
| P1-6 | Secretos **fail-closed**: no bootear en prod con defaults de dev | docs/10 #5 | ❌ Sin guard en el método |
| P1-7 | Cargar la meta-lección **L-BUILD-1** (stub certificado como éxito) en `04-lecciones` | docs/10 | ❌ No está (sí está su prima L-AUTO-3) |

---

## 🟠 Sprint P2 — Verificación de juicio (lo que el lint no ve)
**Objetivo:** verificar que lo construido *funciona de verdad y se ve bien*, no solo que compila.
*(No verificado en detalle contra el estado actual — del roadmap Fase 7.)*

| # | Ítem | Fuente |
|---|---|---|
| P2-1 | Juez-visión: screenshot vs mockup aprobado; visual roto bloquea | F7-03 · L-LM-3 |
| P2-2 | Verify **cross-lane e2e**: "el app desplegado habla con el backend desplegado" es gate | F7-04 · L-LM-5 |
| P2-3 | Verify **multi-superficie**: customer-app + admin + backend, cada uno el suyo | F7-05 · L-LM-4 |

---

## 🟡 Sprint P3 — Última milla (que el app entregado corra)
**Objetivo:** cerrar idea→**app viva**, no solo idea→PR. Incluye el caso "migrar Idearium a Firebase".
*(Del roadmap Fase 8 — no verificado en detalle.)*

| # | Ítem | Fuente |
|---|---|---|
| P3-1 | Provisioning de infra del **cliente** (su Supabase/Firebase, envs, secrets, dominio) | F8-01 · L-LM-2 |
| P3-2 | Deploy web preview + prod (Vercel/CF), "publicar" con un click | F8-02 · L-LM-2 |
| P3-3 | Build móvil firmado + distribución (App Distribution/TestFlight) | F8-03 · L-LM-1 |
| P3-4 | **Data migrations en change-requests** (schema del app sin romper prod) | F8-05 |
| P3-5 | Submission a tiendas (opt-in, más tarde) | F8-04 · L-LM-1 |

---

## 🟢 Sprint P4 — ArtifactView + Observabilidad
**Objetivo:** que todo lo que Fluxo produce sea legible y trazable en la UI. (DocView ya es el paso 1.)

| # | Ítem | Fuente |
|---|---|---|
| P4-1 | **ArtifactView** completo: highlight yaml/json/shell; adoptarlo en Studio/Registry/Brain (docs human-friendly) | memoria improvements #1 |
| P4-2 | **Observabilidad** estilo Langfuse/Arize: reencuadrar el Brain como trazas (run→fase→agente→tool→costo/latencia) | memoria improvements #2 |
| P4-3 | Drawers de nodo en `/flow` (TicketDetail/RunDrawer/PhasePanel al clickear) | F6P-04 |
| P4-4 | Decisión Sidebar 11 secciones (¿replicar v1 o quedarse con top-nav project-first?) | F6P-05 |

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
