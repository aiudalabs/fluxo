# 12 · Plan de mejoras UX/UI de la consola — restyle + hardening a11y

> **⚡ ACTUALIZACIÓN 2026-07-21 — DIRECCIÓN VISUAL DECIDIDA (aprobada por el dueño):**
> La regla de marca de abajo (preservar la estética editorial de aiudalabs.com; MD3 como método) quedó
> **REVERTIDA por decisión explícita del dueño.** Tras iterar 3 direcciones (editorial-brand → Material 3 puro →
> **Mission Control**), la aprobada es **"Mission Control"**: dark-first, near-black, un acento ámbar que
> *brilla* (#FF5E2C), el board como **pipeline vivo** (la card del agente activo glow + dot que pulsa), un
> **event-stream en vivo** en el Overview (glass box), tipografía Space Grotesk + Inter + JetBrains Mono,
> iconos SVG propios. Linaje Linear × Temporal × Raycast — fundamentado en las tendencias 2025-26 de dev-tools/AI.
> **Preview navegable aprobado:** `docs/ui-restyle-preview.html` (Overview · Pipeline · Agentes · Studio; light+dark;
> responsive). Las fases P0–P5 de abajo (a11y, tokens, responsive, feedback, shells) siguen válidas como método de
> implementación; lo que cambió es el **lenguaje visual objetivo** — ya no "elevar lo editorial" sino **portar la
> app real a Mission Control**. El plan de aplicación al `globals.css` real se re-deriva de esta dirección.

> **Estado (original):** propuesto (esperando ejecución). **Alcance:** completo (P0–P5) + preview visual (Fase A).
> **Regla de marca (SUPERSEDED — ver actualización arriba):** se preserva la estética/paleta de aiudalabs.com; MD3 se adopta como **método, no como skin**.

## Contexto

La consola (`console/`, Next.js) es un **port verbatim** del UI de v1 (aiuda-forge), documentado en
`docs/07-ui-port-v1.md` ("semanas de diseño", regla dura de "no rediseñar"). Su estética es **editorial/boutique**
(Satoshi + Instrument Serif + JetBrains Mono, cremas cálidos, naranja) y su paleta está **verificada 1:1 contra el
sitio real aiudalabs.com**: `#E8440A` accent, `#FAF8F4` bg, `#0D0D0F` ink, `#8A8A92` gris (el sitio además usa un
naranja brillante `#ff7546` que hoy NO está en el theme).

El usuario pidió hacer la UI **más user-friendly** con **UX best practices + Material Design 3**, **manteniendo el
esquema de colores** de aiudalabs.com. Decisiones tomadas: **alcance completo (P0–P5)** y **apertura a un restyle
visual** (no solo plomería de tokens).

**Tesis (resuelve la tensión MD3 ↔ marca):** MD3 y la estética de aiudalabs.com **no pueden coexistir como
apariencia** (MD3 = superficies tonales, Roboto, elevación de Google). Se adopta **el MÉTODO de MD3** — tokens
sistemáticos, state layers, elevación, escala de espaciado/tipografía, motion tokens, tamaños de control accesibles —
**no su skin**. La paleta y las fuentes se preservan; el "restyle" *eleva* el lenguaje editorial existente, no lo
materializa. Como el restyle es subjetivo, la **primera entrega es un preview visual (style-tile)** para aprobar el
*look* antes de refactorizar ~4900 líneas.

> ⚠️ **Nota consciente:** este plan supera deliberadamente la regla de "port verbatim / no rediseñar" de `docs/07`.
> Es una decisión del dueño (pedido explícito de restyle), no un olvido.

**Problema que arregla:** `console/app/globals.css` (4909 líneas a mano) no tiene escala de espaciado, z-index ni
motion; tiene `:focus-visible` en **cero** lugares; hit-areas por debajo de 44px (incluido el botón que dispara un
agente **pago**); y **dark mode roto** — cientos de `#fff` hardcodeados + tokens inexistentes (`--bg1`/`--ink1`) que
no flipean. El propio código admite la deuda ("el barrido de #fff es un paso siguiente", `globals.css:42`).

---

## Estrategia de ejecución

- **Una tarea = un branch = un PR** (golden rule #8). Cada fase (o sub-fase) es su propio PR chico, convencional, verde.
- **Verificación real por fase:** `npm run typecheck` + `npm run build` en `console/`, tests existentes
  (design 94/94, console), y **drive del browser en light Y dark** para las fases visuales.
- **Regla dura heredada de v1** (`docs/07`, `globals.css:2633`): `.wrap`/`.tickets-shell`/`.studio-shell` animan SOLO
  `opacity`, NUNCA `transform` (un transform los vuelve containing-block de los `.drawer position:fixed`). No reintroducir.
- Empezar por lo aditivo/bajo riesgo (tokens) y validar contra la realidad antes de tocar lo estructural (shells).

---

## Fase A — Preview de dirección visual (gate de aprobación) · *primero, antes de editar la app*

Producir un **style-tile / galería de componentes** que muestre el restyle propuesto sobre la paleta real, en
**light + dark**, para sign-off. Mostrar: botones (primary/ghost/sm), cards + stats, pills de estado (los 6 de
`statusToken.ts`), nav item activo, una fila de board/ticket, un input con focus ring, un badge, un toast. Incluir la
nueva capa de tokens (espaciado/elevación/motion) aplicada.

- **Entregable:** HTML self-contained (estilo `navegable-mockups`) o Artifact. No toca la app.
- **AC:** el usuario aprueba el lenguaje visual (o pide ajustes) antes de P2+.

---

## Fase P0 — Cerrar la tokenización → dark mode funcional · *bajo riesgo; light no cambia*

Enrutar lo hardcodeado a los tokens que YA existen. Patrón repetido en `console/app/globals.css`:

- **`background: #fff` → `var(--panel)`** (~39 ocurrencias). Representativas: `.card` (:956), `.stat` (:543),
  `.run` (:594), `.ttable` (:1383), `.phase-panel` (:1096), `.chat` (:1351), `.inp` (:1745), `.chip` (:1763),
  `.x` (:1558), `.dag` (:1425), `.proj`/`.proj-menu` (:256/:287), `.cost` (:352), `.bell` (:387), `.kb-card` (:2969),
  `.sprint-card` (:3175), `.flow-node` (:4314). + los `#fff` **inline en TSX**: `Studio.tsx:455` (objeto `inp`) y
  celdas/pills inline en `Board.tsx`/`Agents.tsx`.
- **Bug real:** `--bg1` y `--ink1` NO están definidos → cards de Agentes sin fondo (`globals.css:3540, 3570, 3652`).
  Fix: usar `--panel`/`--ink` (o definir los alias en `:root`).
- **Consolidar los 4 sistemas de color de estado** a los tokens (`--danger/--amber/--emerald/--navy`):
  `.pill.*` (:643, ya tokenizado — referencia) vs `.st-*`/`.ov-sprint-tag.st-*` (`#c55`/`#b48c14`/`#9a2020`,
  :2679-2688) vs flow `.flow-glyph.ph-*` (:4352-4361) vs stepper `.ph-*` (:1080-1089). `statusToken.ts` es la única
  fuente de verdad de estado — alinear el CSS a ella.
- **Off-palette one-offs → tokens:** `.link` `#2563c0` (:519), `.link.danger` `#c0392b` (:526), MCP `#2a6` (:507).
- Glass backdrops blancos que se ven como manchas en dark: `.dag-toolbar`/`.dag-legend`/`.flow-sprint-head`
  (`rgba(255,255,255,.86/.92)`, :2295/:3144/:4473) → tokenizar por tema.

**Verificación:** capturar cada vista en light y dark; diff visual en light debe ser ~cero.

---

## Fase P1 — Accesibilidad base (WCAG 2.5.5 / AA) · *bajo riesgo*

- **`:focus-visible` global** (hoy cero en 4909 líneas):
  `:where(a,button,input,select,textarea,[tabindex]):focus-visible{ outline:2px solid var(--accent); outline-offset:2px }`
  y **eliminar los `outline:none` sin reemplazo** (`.log-filter` :782, `.entry-name-inp` :2457,
  `.studio-refine-in input` :4183, `.stg-field` :4808). Los dos textareas con ring por box-shadow ya OK.
- **Tamaños de control ≥44px** (`min-height`/`min-width`): `.bell` (34, :385), `.x` (30, :1557), `.ava`/`.sh-ava`,
  `.sh-theme`/`.ob-theme`, `.btn.sm` (~28, :721), y **prioritario** los micro-botones de kanban `.kb-run`/`.kb-dispatch`
  (padding 2px, :3042/:3057) — el `▶ dispatch` dispara un agente **pago** y es el hit-area más chico.
- **`prefers-reduced-motion`** ampliado (hoy ~2 de ~10): incluir los `transform: translateY` de hover
  (`.run`/`.card.click`), `fadeUp`, y los pulses (`livePulse`/`agentPulse`/`v-pulse`/`flowRunPulse`).
- **Semántica en TSX:** `aria-label` en botones icon-only (`.x`, `.bell`, toggle `☾/☀`); `aria-expanded`/`role="menu"`/
  cierre con Escape en los menús de `components/shell/TopBar.tsx` (:43-89, hoy solo backdrop click); `role="tab"`/
  `aria-selected` en los tabs del Board (`Board.tsx:208-213`). (`Board.tsx:374` ya setea `aria-expanded` — a replicar.)

---

## Fase P2 — Capa de tokens sistemática (core "MD3-método") · *riesgo medio*

Agregar a `:root` (y su override `:root[data-theme="dark"]`) lo que hoy es ad-hoc:

```css
/* Espaciado — escala 4px */
--sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px; --sp-8:48px;
/* Elevación */
--elev-1:var(--shadow-soft); --elev-2:0 4px 12px rgba(13,13,15,.08); --elev-3:0 12px 32px rgba(13,13,15,.12);
/* Motion */  --motion-fast:120ms; --motion-base:200ms; --motion-slow:320ms;
/* Z-index */  --z-nav:10; --z-drawer:50; --z-modal:60; --z-toast:70;
/* Naranja brillante del sitio real (hoy ausente) */  --accent-bright:#ff7546;
```

- Migrar px sueltos de padding/gap y radios inconsistentes (`8/9/10/11/14/16/18px`) a la escala/tokens de radio
  (`--r/--r-lg/--r-xl` ya existen). Incremental, componente por componente — **no big-bang**.
- Unificar z-index dispersos y shadows sueltos a los tokens de elevación.

---

## Fase P3 — Feedback e interacción · *riesgo medio*

- **Reemplazar `window.confirm`/`window.alert`** (Board dispatch, `Board.tsx:109,118-119`) por la superficie
  toast/`.notif-pop` que **ya existe** en CSS (`:2034-2082`). Reusarla, no crear otra.
- **Confirmaciones de éxito** donde hoy no las hay: Agentes approve (`Agents.tsx:74`, optimista + silencioso en error,
  depende del poll de 15s) y gates de Studio (`Studio.tsx:416-445`, `busy` sin confirmación; `onError` puede tragarse
  tras el load inicial, :173).
- **Empty-state compartido**: hoy cada vista tiene el suyo (Studio rico :216-244; Board una línea :365; Agents 12.5px
  :184; kanban `.kb-empty`; Settings frase). Extraer un componente usando el patrón de Studio + `.stg-msg` ok/err de
  Settings (`Settings.tsx:129,252`) como modelo.
- **Guards consistentes** en acciones destructivas (borrar lanes, seed de secretos `Settings.tsx:146`).

---

## Fase P4 — Responsive real · *riesgo medio*

- Reflow móvil de grillas fijas que hoy solo clipean: `.trow` (8 cols ~900px, :1392), `.mcp-row` (5 cols, :481),
  kanban (`overflow-x:auto`, :2890). Colapsar a 1-col / tarjeta bajo ~640px.
- `.drawer` (480px, close 30px, :1524) y `.modal` (:1703) → full-width + close accesible en teléfono.
- Reemplazar los `calc(100vh - 56px/70px)` con número mágico (`:2359,:2828,:4741`) por `var(--topbar-h)`.
- Revisar el `overflow-x:hidden` del `body` (:79) — mantiene drawers off-canvas pero **enmascara** overflow real.

---

## Fase P5 — Unificar los dos app-shells · *mayor riesgo, al final*

Hoy coexisten el shell legacy (`.app`/`aside.nav`/`header.top`, :113-409) y el nuevo (`.sh-*` de `TopBar.tsx`,
:4670-4749) con nav, avatares (`.ava` círculo 30px vs `.sh-ava` cuadrado 34px) y tipografía distintos → dos lenguajes
de diseño. Consolidar a UNO (el nuevo `.sh-*` como canónico), migrar las vistas legacy, borrar el muerto. Va último,
con su propio PR y drive completo.

---

## Archivos críticos

- `console/app/globals.css` — el design system entero (todas las fases lo tocan).
- `console/app/projects/[projectId]/board/Board.tsx` — inline styles, confirm/alert, tabs.
- `console/app/projects/[projectId]/agents/Agents.tsx` — `--bg1`/`--ink1` rotos, approve sin feedback.
- `console/app/projects/[projectId]/studio/Studio.tsx` — objeto `inp` con `#fff` inline, gates sin confirmación.
- `console/app/projects/[projectId]/settings/Settings.tsx` — patrón de feedback bueno (a reusar).
- `console/components/shell/TopBar.tsx` + `ThemeToggle.tsx` — menús sin aria, shell nuevo.
- `console/lib/statusToken.ts` — **única fuente** de color por estado; el CSS se alinea a ella (no al revés).

## Reuso (no crear de nuevo)

- Toast: `.notif-pop`/`.notif-item` ya en CSS (`:2034`).
- Feedback ok/err: patrón `.stg-msg` de Settings (`Settings.tsx:129,252`).
- Empty/loading rico: patrón `studio-livebanner` (`Studio.tsx:216-244`).
- Tokens de color/estado: `statusToken.ts` + `--danger/--amber/--emerald/--navy` ya definidos.
- Radios: `--r/--r-lg/--r-xl` ya existen.

## Verificación end-to-end

1. Por fase: `cd console && npm run typecheck && npm run build` (EXIT 0) + tests existentes.
2. Drive del browser en **light y dark** (toggle `data-theme`): cada vista tocada (board, agents, studio, settings,
   flow) — dark coherente; light sin cambios en P0/P1.
3. A11y: navegación 100% por teclado (focus visible), hit-areas ≥44px, `prefers-reduced-motion` → sin animaciones de transform.
4. Responsive: 360/768/1024/1440px — sin overflow horizontal, grillas reflowean, drawer/modal usables en teléfono.
