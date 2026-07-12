# 07 · Port del UI de v1 (100% fiel) — la consola es el diseño de aiuda-forge

**Fuente de verdad del UI: `/Users/nmlemus/projects/genai/aiuda-forge/console/src`** (la v1, "Fluxo by AIuda Labs").
Se le dedicaron semanas de diseño. **NO se rediseña — se PORTA verbatim**; lo ÚNICO que cambia es la fuente de datos
(REST + WebSocket de v1 → **Supabase queries + Realtime**). Este doc es el mapa.

> Regla dura: si estás por "mejorar" o "simplificar" un componente de UI de v1, PARÁ. El objetivo es que la v2 se vea y
> se comporte **idéntica** a la v1, no distinta. El único diff legítimo por archivo es: (a) el data-hook apunta a
> Supabase, (b) las rutas son project-first (`app/projects/[projectId]/...`, ya hecho en D6).

## 0. Qué salió mal (para no repetirlo)
El build autónomo reconstruyó la UI **desde cero, plana** (inline styles, GitHub-dark, sin `/flow`, sin marca) porque
los docs pedían continuidad *funcional*, no portar el diseño real. Contra la vara de **producción** eso no sirve.
Este port lo corrige: copiar el design system y los componentes reales de v1.

---

## 1. Copiar VERBATIM (assets de diseño — cero reescritura)

| Traer de v1 | A v2 | Nota |
|---|---|---|
| `console/src/app/globals.css` (**4567 líneas, un archivo, light-only**) | `console/app/globals.css` | Reemplaza al de 29 líneas. Es TODO el design system. |
| `console/src/app/layout.tsx` (los `<link>` de fuentes) | `console/app/layout.tsx` | **Satoshi** (Fontshare `satoshi@400,500,700,900`), **Instrument Serif** (Google, `ital@0;1`), **JetBrains Mono** (Google, 400,500). `<html lang="es">`, body Satoshi 15px/1.6. |
| `console/src/lib/i18n/**` (index.tsx, catalog.ts, ns/*.ts — 13 namespaces es/en/pt) | `console/lib/i18n/**` | i18n propio, sin deps. Copiar tal cual (default `es`; localStorage key `vibeforge.lang` está OK). |
| `console/src/lib/statusToken.ts` | `console/lib/statusToken.ts` | **ÚNICA fuente** de color/pill por estado. Copiar verbatim (ver §4). |
| `console/src/components/Logo.tsx` | `console/components/Logo.tsx` | Wordmark `{ Fluxo }` + `<aiuda/> labs`. |
| `console/src/components/LanguageSwitcher.tsx` | `console/components/LanguageSwitcher.tsx` | 🇪🇸/🇬🇧/🇧🇷. |

### El `:root` (paleta Aiuda — el corazón del design system)
```css
:root{ --bg:#faf8f4; --bg2:#f3f0ea; --bg3:#ebe7de; --ink:#0d0d0f; --ink2:#2a2a2f; --ink3:#52525a; --ink4:#8a8a92;
  --accent:#e8440a; --accent-h:#d13a06; --accent-soft:rgba(232,68,10,.07); --accent-line:rgba(232,68,10,.24);
  --emerald:#0a7b5a; --navy:#142850; --amber:#7a5d00; --danger:#9a2020; /* +soft de cada uno */
  --stroke:rgba(13,13,15,.07); --stroke-strong:rgba(13,13,15,.14);
  --shadow-soft:0 16px 42px rgba(13,13,15,.07); --shadow-accent:0 12px 28px rgba(232,68,10,.2);
  --display:"Satoshi"; --serif:"Instrument Serif"; --mono:"JetBrains Mono";
  --ease:cubic-bezier(.16,1,.3,1); --r:12px; --r-lg:16px; --r-xl:28px; }
```
**Gotcha:** globals.css referencia vars sin definir que SIEMPRE usan literal como fallback — al portar, definilas o
remapealas: `--card→#fff`, `--line→--stroke`, `--muted→--ink4`, `--panel→#fff`, `--bg1→#fff`, `--ink1→--ink`.

**LECCIÓN CRÍTICA de v1 (globals.css:2633):** `.wrap`/`.tickets-shell`/`.studio-shell` animan **SOLO opacity, NUNCA
transform** — un transform computado convierte el contenedor en containing-block de los `.drawer position:fixed`
(banda fantasma + drawer intercepta clicks). NO reintroducir transform en esas animaciones.

---

## 2. El shell + la entrada `/` (chatbot)
- **Shell:** portar `AppShell.tsx`, `Sidebar.tsx` (nav de **11 secciones**, orden en `lib/sections.ts`: studio ✎, overview ◇,
  brain ✦, tickets ☰, flow ⌥, agents ▶, registry ◆, spend ◷, docs ❏, team ◉, settings ⚙), `Topbar.tsx` (eyebrow+título
  por sección, cost chip, bell+notif, avatar), `ProjectSwitcher` (menú hacia arriba con ✓ en el activo). Adaptar la nav a
  project-first (`/projects/[id]/studio`, etc.) conservando el visual 1:1.
- **La entrada `/` (lo que pediste — "abre como chatbot con ideas claras"):** portar `studio/StudioEntry.tsx` (CSS `.entry*`
  en globals L2337-2478) **verbatim**. Es: `<Logo size="lg">` centrado → **"¿Qué quieres construir?"** (Instrument Serif) →
  subtítulo que explica la fábrica → **textarea de idea** (autofocus, ring `0 0 0 4px accent-soft`) → **3 chips de ejemplo**
  clickeables (marketplace / task app / CRM) → nombre de proyecto → org/repo → CTA **"✦ Empezar el diseño →"**. `launch()`:
  crear proyecto → crear design run → ir a `/studio`. En v2: `createProject` + `createDesignRun` pasan a ser inserts a
  Supabase (`projects`/`design_runs`) + arrancar el design engine.

---

## 3. Mapa archivo-por-archivo (componentes → v2)
Portar cada archivo a `console/` conservando el JSX/CSS; cambiar SOLO el data-hook. Lista completa:

- **Board/Runs:** `board/BoardView.tsx`, `RunCard.tsx`, `RunDrawer.tsx`, `StatusPill.tsx`, `StatCards.tsx`, `LiveLog.tsx`,
  `TimelineBar.tsx`, `DiffBox.tsx`.
- **Tickets (JIRA):** `tickets/TicketsView.tsx` (shell: header + toolbar de filtros + canvas full-bleed, 4 tabs
  tabla/sprints/kanban/grafo), `KanbanBoard.tsx` (el board), `TicketDetail.tsx` (drawer), `LaneChip.tsx`,
  `SprintsView.tsx`, `DepGraph.tsx`.
- **Studio:** `studio/StudioDocs.tsx` (**el workspace** — topbar + rail[fases+docs] + main[viewer/PhasePanel/changelog] +
  activity drawer), `PhasePanel.tsx` (gate 3-vías: **Aprobar/Rechazar/Responder** + artifact + mockup iframe),
  `phaseHelpers.ts` (state machine `phaseState`), `StudioModals.tsx` (IterationModal), `BacklogArtifact.tsx`.
- **Flow:** `flow/FlowView.tsx` (2 tabs: **cycle** + **detail**), `flow/cycle/FlowCycle.tsx` (SVG viewBox 940×560),
  `cycle/cycleModel.ts`, `flowGraph.ts`, `layout.ts`, `nodes.tsx`. **Deps nuevas (sancionadas): `@xyflow/react`^12 + `@dagrejs/dagre`^3.**
  `flowGraph.ts`/`cycleModel.ts`/`layout.ts` son **derivación pura data-agnostic → portan sin cambios**.

---

## 4. `statusToken.ts` (copiar verbatim — única fuente de estados)
6 estados en `STATUS_ORDER = [backlog, ready, running, in_review, done, failed]`. Cada uno: `pill` (clase), `color`
(fuerte), `soft` (fill), `border`, `icon`. backlog=ink4/bg3/⏳, ready=accent/⟳, running=navy/⟳, in_review=amber/⌾,
done=emerald/✓, failed=danger/✗. + `AGENT_LOST_TOKEN` (overlay ⚠, no es estado de ciclo). Todo el board/kanban/flow lee
de acá — mantenerlo intacto = el visual porta 1:1.

---

## 5. Re-point de datos (REST/WS de v1 → Supabase) — el ÚNICO trabajo real
El UI lee shapes; solo cambia de dónde salen. Mapa hook v1 → fuente v2:

| Vista | Hook v1 (endpoint) | Shape v1 | Fuente v2 (Supabase) |
|---|---|---|---|
| Kanban/Tickets | `useTickets` (`GET /tickets`) | `OrchestratorTicket[]` | `select * from stories where project_id=` (+ RLS) |
| Board | `useRuns`/`useRun`/`useStats` (`/runs`,`/stats`) | `Run[]`/`RunDetail` | `runs` table |
| Studio | `useDesignRuns`/`useDesignRun` (`/runs` filtrado) | `DesignRun`+`DesignPhase[]` | `design_runs`+`design_phases`+`design_gates` |
| Studio docs | `useProjectDocs`/`useProjectDoc`/`useDocHistory` (`/projects/{id}/docs*`) | `DocEntry[]`/`DocVersion[]` | **GAP** (ver §6 — versiones de docs) |
| Flow | `useSprints`/`useProjectSettings` | `Sprint[]`/`ProjectSettings` | `sprints` (+ campos faltantes, §6) |
| Dispatch ▶ | `useDispatchCandidates` (`/dispatch/candidates`) | `DispatchCandidate[]` | la función `dispatch_story` (F6-01) + selección Runtime×Provider |
| Gates | `useApprove/Reject/Answer/Rerun` (`POST /runs/{id}/steps/...`) | — | `update design_gates set status='resolved',outcome=...` (ya lo hace el Studio v2 actual) |

**Realtime (WS bus → Supabase):** v1 tiene un único `/ws` que empuja `KernelEvent` y invalida caches de React Query.
En v2, reemplazar por **subscripciones `postgres_changes`** por tabla (`stories`, `runs`, `design_phases`, `design_gates`,
`sprints`, `events`) que disparan las MISMAS invalidaciones que hace `useRealtime` hoy (`hooks.ts:163`). La derivación
(`flowGraph`/`cycleModel`/`layout`) no cambia.

---

## 6. GAPS de schema (para que el port sea 100%, no 80%)
La UI de v1 muestra campos que el schema v2 todavía NO tiene. **Agregarlos** (migraciones + RLS) o el port queda cojo:

**`stories`** — v2 tiene: `id, tenant_id, project_id, sprint_id, key, title, lane, status, blocked_by, created_at`.
FALTAN (los usa la card/detalle de v1): `body`, `acceptance`, `run_id`, `epic_id`, `pr_url`, `session_url`,
`external_ref`, `repo`, `kind`, `screen_key`, `agent_lost`. (map: v1 `deps`→v2 `blocked_by`, v1 `owner`→v2 `lane`.)

**`sprints`** — v2 tiene: `id, tenant_id, project_id, key, title, position`. FALTAN (los usa el `/flow` Ciclo): `goal`,
`planned_at`, `planning_run_id`, `reviewed_at`, `review_run_id`, `retro_at`, `retro_run_id`.

**`epics`** — NO existe. La crea el New-Story modal + el eyebrow del detalle. Agregar tabla `epics` (id, project_id, title).

**Versiones de documentos** (lo que pediste explícito) — v1 versiona docs como **commits en la branch `design` del repo**
(`getDocHistory` = git log; `getProjectDoc?ref=<sha>` = blob a ese commit; chips de versión v1…vN + changelog). v2 hoy no
guarda versiones. **Dos caminos (decidir):**
- **(A) Igual que v1:** el design engine COMMITEA los docs a la branch `design` del repo del cliente; la UI lee el
  historial git vía la GitHub App. Fiel 100%, pero ata la feature al subsistema GitHub App (F4-03/F5-03).
- **(B) En Postgres:** tabla `design_docs`(project_id, path, version, sha/hash, content, message, created_at) append-only;
  `getDocHistory`→`select ... order by version desc`; el harvest escribe una versión nueva por corrida. No depende de la
  App, y RLS lo aísla. **Recomendado para desbloquear ya**; migrar a (A) si se quiere el git real.

**Estados:** v1 usa `QUEUED|RUNNING|DONE|AWAITING|FAILED` (design) y `backlog|ready|running|in_review|done|failed`
(stories); v2 design usa `pending|running|awaiting_gate|done|failed`. Hacer un adaptador de estado en la capa de datos
(no tocar el componente) para que `phaseState`/`statusToken` reciban lo que esperan.

---

## 7. El BOARD como ejemplo 100% (lo que pediste concreto)
`http://localhost:3000/projects/<id>/board` debe quedar **idéntico** al kanban de v1:
1. Portar `tickets/KanbanBoard.tsx` + `LaneChip.tsx` + `statusToken.ts` **verbatim**, y las clases `.kb-*`/`.pill*`/
   `.lane-chip*`/`.tickets-*` de globals.css.
2. **6 columnas** en `STATUS_ORDER` (backlog→ready→running→in_review→done→failed), header = `.pill` del color + count +
   caret; **collapse-to-rail** de 42px (`isCollapsed = userCollapsed[s] ?? len===0`; vacías colapsan, así entran 6 sin
   scroll-H desde ~1280px); scroll independiente por columna (`.kb-cards overflow-y:auto`).
3. **Card** (`StoryCard`): `.kb-top` (id · sprint) / `.kb-ttl` / `.kb-lost` (si agent_lost) / `.kb-body` (clamp 3 líneas) /
   `.kb-meta` (▶ dispatch · LaneChip owner · `✓N` ACs · PR↗ · session↗ · run) / `.kb-gate` (⧗ waiting) / `.kb-deps`.
   `.gated` opacity .66. Card `onClick`→drawer `TicketDetail`.
4. **Datos:** `select * from stories where project_id` (+ RLS + Realtime en `stories`), mapeando `blocked_by→deps`,
   `lane→owner`. Para las cards completas hacen falta los campos del §6 (body, acceptance, pr_url, etc.) → agregarlos.
5. **Gating** (`waitingBySprint`): por story con sprint, deps cross-sprint no-done → "⧗ waiting on SPn"; card gated si
   `gate && (ready|backlog)`.

Criterio de aceptación del ejemplo: abrir el board en v2 y que sea **pixel-fiel** al de v1 (mismas columnas, cards, chips,
colores de `statusToken`, collapse) — con data real de Supabase por Realtime.

---

## 8. Orden sugerido del port
1. **Fundación:** globals.css + fonts + i18n + statusToken + Logo + shell (Sidebar/Topbar/AppShell) + la entrada `/`.
   (Esto solo ya transforma el look de todo.)
2. **Board 100%** (§7) — el ejemplo, con los gaps de `stories`.
3. **Studio** (StudioDocs + PhasePanel + versiones de docs, §6 camino B).
4. **Flow** (React Flow + Ciclo SVG).
5. Tickets tabla/sprints/grafo, agents, overview, etc.

Cada paso: portar verbatim, re-apuntar datos, verificar contra la v1 (misma pantalla lado a lado). "Done" = se ve
idéntico a v1, con datos de Supabase.
