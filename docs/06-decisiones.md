# 06 · Decisiones (ADR ligero)

Decisiones tomadas (✅) y abiertas (⚠️ — bloquean tareas del roadmap; no adivinar si tienen costo/lock-in irreversible).

## ✅ D0 · Rebuild, no refactor ni greenfield (2026-07-11)
La versión actual (aiuda-forge v1) se **rehace** sobre la arquitectura v2, **cargando el método** (registry, consola,
harnesses) y **reemplazando el sustrato** (store/conductor/scoping/tokens/canales → Postgres-RLS/Maestro/Vault/
Runtime×Provider). Razón: los bugs son arquitectónicos y recurren; no hay tenants de pago vivos; el activo valioso es
portable; el tiempo no es restricción. NO es el "trap del rewrite" porque lo bueno es portable y lo malo es
alquilable. Ejecución por strangler. (Ver auditoría aiuda-forge 2026-07-11 + `04-lecciones`.)

## ✅ D1 · Apuesta de plataforma del sustrato: **Supabase managed** (2026-07-11)
**Decidido: Supabase** (Postgres + RLS + Realtime + Auth GitHub-OAuth + Vault + Edge Functions) + **Vercel/CF** para
preview. Razón (análisis de costos): la comparación NO es "Supabase vs nuestra Postgres" — es **baterías alquiladas
vs baterías DIY**. RLS es de Postgres (gratis en cualquiera); el costo real son Auth/Realtime/Vault/Edge, que
self-hostear una Postgres pelada te obliga a **construir a mano** — exactamente la costura de auth + Vault-plaintext +
polling que la auditoría de v1 marcó como bugs (L-SEC-3, L-ARCH-4). El ahorro (~$25/mo Pro vs ~$0 en el VPS) es ruido
frente a las semanas de dev + ops que ahorra; matchea la tesis "casi cero infra bespoke".
**Salida futura (bajo lock-in de datos):** abajo es Postgres estándar → los datos son portables (pg_dump). El lock-in
está en las baterías. Reconsiderar self-host (Supabase OSS en el VPS, o Postgres+baterías propias) cuando haya
escala/ingresos que paguen el ops, o cuando Realtime/bandwidth sean una línea material. Mantener el schema como
Postgres+RLS estándar para que esa salida sea barata.

## ✅ D2 · Runtime SDK de los agentes de diseño: **Claude Agent SDK** (2026-07-12)
**Decidido: Claude Agent SDK** (el loop en el SDK, el rol en markdown → cumple "el agente vive en markdown").
Confirmado por el fundador. La versión/pineo se fija al llegar a **F5-01** (aún no se instala nada). No bloqueaba
F1-02: el tool MCP `brain_write` es protocolo abierto y se construyó/verificó standalone (cualquier cliente MCP lo
consume); el Agent SDK lo consumirá en F5.

## ✅ D3 · Alcance de la "última milla" en v1.0: **CUT — web + link de prueba** (2026-07-19)
**Decidido:** v1.0 corta en **"web publicada (Vercel) + backend/worker (Railway) + app móvil a link de prueba
(App Distribution/TestFlight)"**. Las **tiendas** (App Store Connect / Play Console, signing Apple, macOS runner)
y el **provisioning automático de la infra del cliente** se difieren a **v1.1**. Rationale: es la milla más corta
que entrega valor real y matchea el ICP (agencias LATAM que quieren desplegar rápido); el pipeline de tiendas es
una inversión grande y cert-heavy. Nota: MiSalon es web-only ("SaaS 100% web, sin app nativa") → su última milla
es solo deploy web. **Sprint P3** implementa: `deploy.yml` (frontend→Vercel, backend/worker→Railway, con secrets
del cliente) + data-migrations en change-requests + (stacks Flutter) build firmado a link de prueba. El deploy REAL
lo dispara el humano con SUS tokens (Vercel/Railway) — es BYO-credencial, no COGS de Fluxo.

## ✅ D4 · Repo remoto / org: **github.com/aiudalabs/fluxo (privado)** (2026-07-12)
**Decidido:** el repo vive en `github.com/aiudalabs/fluxo`, **privado**. `origin` seteado, commits pusheados, CI
corriendo en Actions. El módulo Go `github.com/aiudalabs/fluxo/control` (elegido en F0-04) **coincide** con la org →
sin rename. Desde acá, el flujo puede pushear.
> **Pendiente menor (no bloqueante):** el flip del gate `db`/leak a **required check** en branch protection espera
> plan pago de GitHub. Por ahora la CI corre en cada push/PR y va **roja ante una fuga** (probado localmente que el
> stage `db` sale exit 1) — suficiente en trunk. Cuando haya branch protection, marcar `db` (y `control`) como
> required en `main`.

## ✅ D5 · Captura de artefactos del diseño: **workdir-harvest, no reply-text** (2026-07-12)
**Decidido:** el runtime de diseño le da al agente de fase una **tool de escritura scopeada a un workdir temporal** y
lo deja escribir los archivos **como el rol ya pide** (`docs/BRIEF.md`, `docs/ARCHITECTURE.md` + `docs/provisioning.yaml`,
`docs/mockups/*.html`, …). El runtime **cosecha** (harvest) esos archivos del workdir → los escribe al **brain**
(artefactos + provenance, vía el tool de F1-02), los muestra en **Studio** (F6-02), y (en F5-03) los commitea al repo
del cliente. **Se retira la directiva de "ponelo en el reply"** — el hack `OUTPUT_DIRECTIVE` de F5-01 deja de hacer
falta (el rol escribe a disco, que es su forma natural).
**Rationale:** reply-text obliga a un solo blob de texto por fase y no modela fases multi-archivo (arquitectura =
ARCHITECTURE.md + provisioning.yaml) ni mockups (un HTML por superficie). Workdir-harvest maneja ambos naturalmente,
respeta la regla de oro (el rol/método no se toca — sólo cambia que el archivo se cosecha del disco en vez de del
texto), y da un punto único de captura → brain + Studio + repo. Alternativa rechazada: parsear artefactos del texto
de respuesta (frágil, un blob por fase, no multi-archivo).

## ✅ D6 · IA de rutas de la console = **project-first** (2026-07-12)
**Decidido:** las rutas son project-first — `app/projects/[projectId]/{studio,board,brain}` con un **layout de
proyecto** (`lib/project.tsx · ProjectShell`) que carga el contexto del proyecto, arma el **cliente supabase + el
tenant token en el socket de realtime UNA sola vez** (`realtime.setAuth`) y renderiza la nav entre vistas; las
features leen el cliente de `useProject()` y **no re-arman** nada. `app/projects/page.tsx` = lista/switcher. Se
**retiraron** las rutas viejas feature-first (`/studio|/board|/brain/[projectId]`).
**Rationale:** el modelo mental correcto es "estás **dentro de un proyecto** y cambiás de vista", no "estás en una
feature y elegís proyecto" — como en v1. Centralizar contexto + tenant en un solo lugar (el layout) elimina que cada
feature re-arme el token/cliente (hoy cada una lo hacía), y deja un único punto donde luego enchufar la sesión real de
GitHub-OAuth. La URL sigue llevando el estado (proyecto + vista). Sin tabla `projects` aún (dev usa
`NEXT_PUBLIC_DEV_PROJECT_ID` + JWT pre-minteado); "cargar el proyecto" hoy = establecer ese contexto compartido.

## ✅ D7 · Modelo de deploy / preview / verify: **BYO auto-provision (Nivel 2), NO Fluxo-hosted (Nivel 3)** (2026-07-20)
**Decidido:** Fluxo entrega apps que el **cliente posee** — deploy/preview/verify siempre contra la **infra del cliente**
(BYO, cero COGS), NO a un sustrato hosteado por Fluxo. Tres niveles: **N1** (hoy) `deploy.yml` BYO a Vercel/Railway con
tokens pegados. **N2 (objetivo)** el *feel* de "un click" sin ser hosting company: OAuth con Vercel/Supabase/Firebase +
**provisioning-auto** que crea el proyecto **en la cuenta del usuario** vía la API de la plataforma → deploy. El app
queda en su cuenta (BYO intacto). Es el provisioning-auto que D3 difirió a v1.1. **N3 (DESCARTADO)** ser Lovable/Replit
(`*.fluxo.app`, Fluxo hostea): sería otro producto (COGS + ops de hosting multi-tenant + inversión del lock-in) y rompe
la golden rule #5.
- **N2 auto-provision (Deploy · A3) — diferido a v1.1, diseño en `docs/13`:** el *cómo* de N2 (OAuth app de Fluxo,
  crear el proyecto vía Resource Manager/Firebase Management/Billing APIs, mintear la SA umbrella) está diseñado en
  `docs/13-A3-auto-provision-diseno.md` con **5 decisiones abiertas ⚠️** (OAuth app + verification de Google · storage
  del refresh token/Vault · scopes mínimos · parent org-vs-sin-org · fallo parcial/idempotencia). El build espera esas
  decisiones — A1/A2 (N1 self-serve) ya entregan el valor; A3 es optimización de fricción, no desbloqueo.
- **Preview/verify por plataforma (todo BYO, cableado como targets en `provisioning.yaml`, estilo `deploy.yml`):**
  - **Web:** preview = URL de Vercel; verify = **Playwright** (`e2e-verify` + art-director, ya existe).
  - **Mobile (Flutter+Firebase):** preview cliente = **Flutter Web build → Firebase Hosting** (URL que el cliente toca
    en el browser, cubre el 90%) + **App Distribution** (P3-3, app firmada en su teléfono). Verify server = **Firebase
    Test Lab** (Google levanta el device, corre integration tests, devuelve video/screenshots — BYO sobre su Firebase)
    + golden tests de Flutter. **Emulador nativo streameado al browser** (Appetize/Test-Lab-interactivo) = **opcional
    premium** (rompe cero-COGS si lo hosteás) → se prefiere Flutter-web.
- **Distinción a no confundir:** *emulador de Firebase* (Firestore/Auth local, para que el AGENTE testee lógica) ≠
  *emulador de dispositivo / Flutter-web* (corre la UI para que un HUMANO la pruebe). Son cosas separadas.
**Rationale:** el ICP son **agencias que entregan a un cliente**; el cliente (ej. Rosa/MiSalon) quiere su app en **su**
Supabase/Vercel/Firebase, auditable y de su propiedad — no atada a que Fluxo siga vivo. El diferenciador vs Lovable es
entregar algo que el cliente **POSEE**. Hostear rompería el "cero COGS" que hace rentable el modelo de agencia.

## ✅ D8 · **Capabilities como data + diseño capability-aware** (2026-07-20)
**Decidido:** las integraciones externas (Firebase, Vercel, Railway, Supabase, Gemini, Test Lab…) son **capabilities
declaradas en `registry/` (data)** — cada una: pasos de provisioning humano one-time, el/los secret(s) BYO, un probe
🟢, y qué habilita al agente. El stack declara qué capabilities necesita. El diseño es **capability-aware**: lo que
está en `docs/provisioning.yaml` (el "declared boundary contract" que el architect ya emite) es la **frontera humana**
y **NUNCA** se re-escribe como AC de build. Un **gate determinista** (estilo P8-B) falla el backlog si un AC re-enuncia
un item de provisioning. El onboarding self-serve resuelve las capabilities (checklist + semáforos 🟢 + siembra el
Actions secret, canal BYO como el token de Claude). Un **readiness gate** en el dispatch: una story no se despacha
hasta que su capability esté 🟢.
- ⚠️ **NO parchear a mano** (editar ACs / sembrar keys por sesión). El producto es self-serve; todo gap se cierra como
  capacidad del sistema, no con un fix por-sesión que me necesita a mí.
**Rationale:** el E2E (2026-07-20) probó que el scrum-master emitió un AC no-despachable ("crear el proyecto Firebase +
billing") — un bug de diseño que rompe el self-serve para todo stack con provisioning. La cura es método+data, no un
parche. Detalle y secuencia de construcción en `docs/11` (P6-2b).

---
*Cuando una decisión se resuelve, moverla a ✅ con fecha y una línea de por qué, y desbloquear su tarea en el roadmap.*
