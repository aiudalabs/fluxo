# 21 · Radiografía de Fluxo v2 — el documento base para el sucesor

> **Para qué existe este doc (2026-08-08):** decisión del usuario tras el E2E de YoMap y la saga del
> preview: Fluxo v2 funciona pero **cuesta días de operación humana** — cosas triviales con Claude Code
> directo (probar la app, deployar un demo) acá son infraestructura propia con incidentes. Este doc
> radiografía TODO el sistema (estado, arquitectura, flujos, datos, incidentes, costos) para servir de
> base a un **sucesor más simple**: BMAD como método + delegación total de la ejecución a
> agentes/harness existentes (Claude Code, Copilot CLI), pegamento mínimo. Acompañan:
> `docs/22-analisis-adversarial-premortem-y-mercado.md` (análisis con agentes) y
> `docs/23-blueprint-sucesor-bmad.md` (la dirección del sucesor).

---

## 1. Qué es Fluxo v2 (la tesis y dónde quedó)

**Fluxo = fábrica de software gobernada.** Un brief en español entra; sale un producto construido por
agentes en el GitHub del cliente, con un backlog trazable, gates de calidad y un registro auditable (el
*brain*). Vendido por AIuda Labs a agencias/dev-shops LATAM.

La tesis v2 (post-auditoría de v1): *"cargar el método, alquilar el sustrato"* — el método vive en
`registry/` (YAML+markdown), el sustrato determinista se alquila (Supabase para Postgres+RLS+Vault,
GitHub para repos/issues/actions) y el código propio es "pegamento fino".

**Dónde quedó la tesis en la práctica** (el hallazgo central de esta radiografía): el sustrato de
*datos* sí se alquiló, pero el sustrato de *ejecución* se terminó construyendo artesanal: un worker
propio, un engine de builds propio en un VPS con 3 servicios systemd, un runner de previews propio con
emulador+shim+seed, deploy por rsync sin CI. El "pegamento fino" hoy mide:

| Pieza | Tamaño real |
|---|---|
| Kernel TypeScript (`design/src`, sin tests) | ~9.700 LOC |
| Tests del kernel | ~3.800 LOC (317 tests) |
| Console Next.js (`console/`) | ~13.400 LOC |
| Scripts host-level del VPS (`scripts/*.sh`) | ~1.100 LOC de bash |
| Registry (el método como data) | 162 archivos |
| Migraciones Postgres | 27 |
| Docs de diseño | ~3.100 líneas |

**~24.000 LOC de código propio + 1.100 de bash operativo** para orquestar agentes que, individualmente,
ya saben hacer el trabajo. Ese es el costo de la vía actual.

---

## 2. Estado actual (qué funciona, con evidencia)

| Capacidad | Estado | Evidencia |
|---|---|---|
| Diseño gateado (brief→PRD→arquitectura→backlog→mockups) | ✅ validado | YoMap: 34 stories diseñadas con gates humanos en Studio |
| Handoff (repo GitHub + issues + scaffold de CI por stack) | ✅ validado (con cicatrices) | YoMap repo + 34 issues; incidentes #4,#5,#6 (abajo) |
| Despacho a build (engine propio en VPS, docker) | ✅ validado | YoMap SP1–SP10: 34/34 stories mergeadas, $190.47 |
| Gates deterministas de CI (test-verify, provisioning-lint, suite-integrity) | ✅ validados | Bloquearon merges reales; provisioning-lint cazó rol faltante |
| Gate visual (ui-verify + art-director) | ⚠️ **certifica cascarones** | Incidente #10: "SMOKE OK" con canvas vacío y texto=0 |
| Reviewer autónomo (build+run → findings → gate "done⟺0 P0") | ✅ validado | Cazó el P0 real del admin que 150 tests verdes escondían |
| Preview "App en vivo" (Flutter + Firebase emulado, cero credenciales) | ✅ validado (2026-08-08) | YoMap corriendo: login SMS + mapa + categorías + data demo |
| Incrementos (change request → delta backlog → build) | ⚠️ funciona, caro | $1.31 el plan + **$8.92 la fase mockups que no hizo nada** |
| Multi-tenant real (RLS + Vault + varios clientes) | 🔲 nunca ejercitado | Un solo tenant real: el dueño |
| Billing / metering / onboarding | 🔲 no construido | Roadmap F9 sin empezar |

**Proyectos construidos por Fluxo:** Idearium (python-fastapi-react, validado por ejecución),
Salonara (react-supabase, 51/51 stories, overhaul visual), MiSalon (react-supabase, preview
validado), YoMap (aiuda-flutter-firebase, 34/34 + preview emulado). La factoría **produce** — el
problema no es el output, es el costo de operarla.

---

## 3. Arquitectura

### 3.1 Componentes

```mermaid
flowchart TB
    subgraph LOCAL["Dev / Operación (laptop de Noel)"]
        CC[Claude Code<br/>construye Fluxo mismo]
    end

    subgraph SUPABASE["Supabase (fluxo-prod) — sustrato ALQUILADO"]
        PG[(Postgres + RLS<br/>21 tablas)]
        VAULT[Vault<br/>tenant_credentials]
        RT[Realtime<br/>UI reactiva]
    end

    subgraph VPS["VPS Hostinger (2.25.78.202) — sustrato CONSTRUIDO"]
        CADDY[Caddy<br/>TLS + on-demand certs sslip.io]
        CONSOLE[console (Next.js, docker)<br/>board · studio · flow · agents · settings]
        WORKER[worker (docker)<br/>projection · dispatch · increments · costs]
        AR[fluxo-agent-runner (systemd)<br/>poll build_jobs → docker run claude -p]
        ET[fluxo-engine-tail (systemd)<br/>reconcilia PRs merge→done]
        PR[fluxo-preview-runner (systemd)<br/>previews efímeros con emulador]
        IMG[[imagen fluxo-agent-dev:local<br/>Flutter+Android+Java+node+claude]]
    end

    subgraph GITHUB["GitHub (repos del cliente) — sustrato ALQUILADO"]
        REPO[repo + issues + PRs]
        ACT[Actions: test-verify · ui-verify ·<br/>provisioning-lint · claude-review · build-apk]
    end

    CC -- rsync + docker build (deploy manual) --> VPS
    CONSOLE <--> PG
    WORKER <--> PG
    AR <--> PG
    PR <--> PG
    CADDY --> CONSOLE
    WORKER -- workflow_dispatch / API --> GITHUB
    AR -- git push + PR (token tenant) --> REPO
    AR -- docker run --> IMG
    REPO --> ACT
    ET -- reconcilia --> REPO
    PR -- clona repo + levanta emulador --> REPO
```

### 3.2 El flujo E2E completo (idea → producto → preview)

```mermaid
sequenceDiagram
    actor U as Usuario (console)
    participant W as worker (VPS)
    participant M as main.ts (design run)
    participant B as brain (Postgres)
    participant GH as GitHub cliente
    participant E as engine (agent-runner)
    participant RV as reviewer autónomo
    participant PV as preview-runner

    U->>B: crear proyecto (stack, settings)
    W->>M: spawn design run (workflow design.yaml)
    loop fases con gate humano
        M->>B: fase done (PRD, arquitectura, backlog, mockups)
        U->>B: aprueba gate en Studio
    end
    M->>GH: handoff — repo + 34 issues + scaffold CI del stack
    U->>W: ▶ Despachar sprint (board)
    W->>B: stories → running (money-safe ANTES de disparar)
    W->>E: encola build_job (prompt por STDIN desde 2026-08-08)
    E->>E: docker run claude -p (imagen dev real: buildea y CORRE)
    E->>GH: push incremental + PR "Closes #N"
    GH->>GH: gates: test-verify · provisioning-lint · ui-verify · claude-review
    GH->>B: merge → projection → story done
    RV->>E: post-sprint: build_job kind=review (contexto fresco, build+run)
    RV->>B: findings con severity; P0 ⇒ re-feed al sprint (done ⟺ 0 P0)
    U->>PV: pedir "App en vivo" (rama o main)
    PV->>GH: clona → emulador Firebase demo-* + build web + shim + seed
    PV->>U: https://preview-<pid>.sslip.io (login demo, data demo)
```

### 3.3 Dónde vive el estado (las fuentes de verdad)

| Estado | Vive en | Se sincroniza con |
|---|---|---|
| Diseño (PRD, backlog, mockups, gates) | `design_runs/phases/gates` + artifacts en Postgres | workdir efímero del run |
| Backlog ejecutable | `stories/sprints/epics` (Postgres) | Issues de GitHub (`external_ref`) — **doble fuente** |
| Estado de build | `build_jobs` (Postgres) | PRs de GitHub — reconciliado por engine-tail |
| Credenciales | Vault (tenant) + Actions secrets (repo) + `.git-token`/`.env.prod` en el VPS — **tres lugares** |
| El método | `registry/` en git — rsync-eado al VPS (puede divergir) |
| Costos | `run_costs` + markers en logs de streams |

La sincronización entre estas fuentes es donde vivieron los incidentes #4, #5, #6 y #14.

### 3.4 El método como data (lo portable)

- **12 workflows** (`design`, `iterate`, `factory`, `retro`, `sprint-review`, …) — fases + gates en YAML.
- **~15 agentes/personas** (analyst, architect, data-modeler, designer, dev por stack, reviewer,
  art-director, iteration-planner…) — markdown con contratos operativos afilados por incidentes reales.
- **3 stacks** como manifiestos (paths, validation_commands, design_tokens, imagen, contrato de verify).
- **Templates de scaffold** por stack: workflows de CI, harness e2e con emulador, provisioning-lint
  (tabla de reglas por stack), receta de preview.
- **Prompts operativos**: ENGINE_GUARD (orquestá subagentes cuando el goal descompone), ui-fidelity,
  INCREMENTAL_COMMIT.

**Esto es lo valioso y portable.** No depende del sustrato: son contratos en texto que cualquier
harness (Claude Code, Copilot) puede ejecutar. El kernel de 9.7k LOC existe casi todo para
*transportar* estos textos entre Postgres, el VPS y GitHub.

---

## 4. Casos de uso (los que el sucesor tiene que seguir cubriendo)

1. **Idea → backlog gateado** — el cliente trae un brief en español; salen PRD + arquitectura +
   backlog por sprints + mockups navegables, con aprobación humana por fase. *(Esto ES BMAD — el
   sucesor lo hereda del framework en vez de reimplementarlo.)*
2. **Backlog → código mergeado** — cada story/sprint se delega a un agente que implementa, se
   auto-verifica (build+run, no solo tests), abre PR; gates de CI bloquean lo roto.
3. **Review independiente** — un contexto fresco corre el artefacto de verdad y publica findings;
   un P0 reabre el sprint. *(La única defensa demostrada contra "done ≠ corre".)*
4. **App corriendo para evaluar** — el cliente/dueño navega la app con data demo sin credenciales
   reales. *(El dolor #1 de Fluxo: esto costó ~15 iteraciones de infra propia.)*
5. **Incrementos** — "agregale X" → delta backlog → build, sin re-diseñar todo.
6. **Trazabilidad** — qué se decidió, qué costó, qué gate aprobó quién. *(Vendible a agencias; hoy
   es el brain en Postgres.)*

---

## 5. El registro de incidentes (la evidencia de por qué migrar)

Cada uno costó horas o días del dueño. La columna final es la pregunta que el sucesor debe responder.

| # | Incidente | Causa raíz | ¿El sucesor lo hereda? |
|---|---|---|---|
| 1 | "done ≠ corre": APK compilaba, app no arrancaba; 150 tests verdes | El mandato era "pasá tests", no "corré el artefacto" | **Sí, salvo que el mandato del agente sea build+RUN** — portar el reviewer como práctica |
| 2 | Stack alucinado → scaffold degradó en silencio | Inferencia de LLM donde iba una lista cerrada | Sí — toda config derivada por LLM necesita fail-loud |
| 3 | ui-verify inerte meses (app_path fijo) | Path hardcodeado + guard que se saltea en silencio | Sí — gates que se autodesactivan en verde |
| 4 | Token OAuth expiró a mitad de handoff (401) | Token leído al inicio, usado horas después | Menos (menos pasos largos), pero cualquier token de 8h + proceso largo lo repite |
| 5 | Race doble-adopción → 34 issues duplicadas | Lease no atómico en worker propio | **No, si no hay worker propio** |
| 6 | Re-handoff re-duplicaba issues | Efecto no idempotente | Sí — todo efecto sobre GitHub debe ser idempotente |
| 7 | Agente se suicidó con `pkill -f` (prompt en argv) | Prompt como argv del proceso | **No, si el harness es Claude Code estándar** (no armamos el `docker run` nosotros) |
| 8 | Run pago sobre pedido vacío | Sin validación en ninguna capa; console inserta directo en DB | Sí — validar entradas ANTES de gastar |
| 9 | Fase mockups: $8.92 para nada | Motor de workflow propio sin skip condicional | **No, si no hay motor de workflow propio** |
| 10 | Gate visual certificó canvas vacío | Heurística "hay canvas ⇒ pintó" | Sí — un gate mal medido es peor que ninguno |
| 11 | FlutterFire hardcodea http:// en web → shim+edge propio | Preview HTTPS propio contra emulador | **No, si el preview se delega** (emulador local / hosting del stack) |
| 12 | App moría por storageBucket faltante | Contrato de options demo incompleto | Parcial — contratos de config demo deben validarse ejecutando |
| 13 | Seed genérico ≠ esquema real → spinner infinito | Fixtures del stack ≠ dominio del proyecto | Sí — la data demo es DEL PROYECTO, siempre |
| 14 | rsync target equivocado deploya viejo en silencio; +x perdido → 203/EXEC | Deploy artesanal sin CI | **No, si no hay VPS propio que deployar** |
| 15 | docker prune mató imágenes → rc=2 | Infra propia sin gestión de imágenes | **No, sin infra propia** |
| 16 | increment: gate aprobado en 10s sin leerse (el diseño lo permite) | Gates humanos como click-through | Sí — un gate que no muestra el diff no gobierna |
| 17 | Preview del cliente bloqueado por su propia VPN | Operación remota opaca | Parcial — siempre habrá red del cliente |

**Patrón de fondo:** de 17 incidentes, **7 desaparecen por construcción** si no hay worker, motor de
workflow, runner ni VPS propios. Otros 8 son lecciones de método (idempotencia, fail-loud, gates
honestos, validar antes de gastar) que se cargan como **contratos/tests del método**, no como código de
orquestación. Solo 2 son irreducibles (red del cliente, tokens de terceros).

---

## 6. Economía real

| Concepto | Costo medido |
|---|---|
| YoMap idea → producto (diseño + 34 stories + fixes) | ~$190 en builds + días de operación |
| Incremento chico (1 story) | $1.31 plan + $8.92 mockups innecesarios + ~$3-5 build |
| Review autónomo de un sprint | ~$3-8 por corrida |
| Operación del dueño | **días por semana** en debugging de infra propia (el costo dominante, no facturado) |
| Infra fija | VPS Hostinger + Supabase (fijos bajos) |

El costo en tokens es razonable. **El costo que mata es el tiempo del dueño operando el sustrato
construido.** El preview de YoMap (emulador+shim+seed) consumió ~15 iteraciones para lograr lo que
`flutter run` da gratis en local.

---

## 7. Qué cargar al sucesor / qué NO

### Cargar (probado con evidencia)
1. **El método completo de `registry/`** — personas, workflows, stacks, contratos de verify. Es texto;
   BMAD es el esqueleto natural para colgarlo.
2. **El reviewer autónomo como PRÁCTICA** — contexto fresco + build&run real + "done ⟺ 0 P0". No el
   ejecutor (build_jobs/poller): el mandato y el formato de findings.
3. **provisioning-lint** — el gate determinista por tabla de reglas; barato y cazó bugs reales.
4. **Stack como concepto de primera clase** — lista cerrada, manifiestos, fail-loud si no existe.
5. **Las lecciones (docs/04 + §5)** como contratos del método: idempotencia, fail-loud, money-safe
   antes de disparar, prompts nunca por argv, data demo del proyecto.
6. **El principio del gate visual honesto** — pero medido de verdad (pixel/texto real, no "hay canvas").

### NO reconstruir
1. **Worker/scheduler propio** (races, leases, heartbeats — incidentes #5, #8).
2. **Motor de workflows propio** (goto/skip/feedback — incidente #9; BMAD + el harness ya lo traen).
3. **Runner de agentes propio** (docker run + stream-json + push incremental — incidente #7; Claude
   Code headless/Actions y Copilot coding agent son eso, mantenido por otros).
4. **Infra de preview propia** (emulador+shim+seed+Caddy on-demand — incidentes #11-13; delegar al
   stack: `flutter run` del harness, hosting del framework, o builders con preview nativo).
5. **Console de 13k LOC** — empezar con el board nativo de GitHub (issues/projects) + el chat del
   harness; UI propia solo cuando un cliente la pida.
6. **Deploy por rsync a VPS propio** (incidente #14-15).
7. **Multi-tenant/RLS/Vault antes del segundo cliente real.**

---

*Continúa en `docs/22-analisis-adversarial-premortem-y-mercado.md` (análisis de agentes) y
`docs/23-blueprint-sucesor-bmad.md` (el diseño del sucesor).*
