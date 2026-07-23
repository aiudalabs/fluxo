# 14 · Preview efímero Fluxo-hosted (release v2) — diseño

**Objetivo:** ver la app que se está construyendo **corriendo de verdad** (end-to-end: frontend +
backend + DB efímera), en un subdominio temporal de Fluxo, **sin que el cliente configure nada**
(estilo Lovable/Replit). Es el "release v2" que reemplaza el stub actual (link a `dev`) del paso
`release` de la ceremonia de Review, y alimenta una pestaña **"App en vivo"** del workspace.

> **Relación con D7:** D7 eligió BYO (deploy a la infra del cliente, cero COGS) para SHIPPEAR a
> prod. Esto es COMPLEMENTARIO, no lo reemplaza: el preview efímero es para MOSTRAR (descartable,
> auto-teardown → costo acotado), no para publicar. Dos modos distintos: **mostrar** (Fluxo-hosted
> efímero) vs **shippear** (BYO Vercel/Firebase).

## El VPS ya banca esto (inspección 2026-07-23)
- **4 cores · 15Gi RAM (14 libres) · 193G disco (157 libres)** — el stack actual (console+worker+
  caddy) usa ~150 MiB. Margen de sobra para varios previews concurrentes.
- **Docker 29.6.1.** Caddy 2 con **Admin API en :2019** (rutas dinámicas sin reiniciar).
- **DNS:** `fluxo.aiudalabs.com → 2.25.78.202`. **Falta wildcard** `*.fluxo.aiudalabs.com` (Fase 0).

## Arquitectura (3 piezas)
1. **Receta de preview por stack (DATA, en el registry):** `preview.compose.yml.tmpl` por stack —
   declara los servicios para correr la app end-to-end: frontend buildeado, backend, **DB efímera**
   (postgres/mysql según el stack) + migraciones + seed demo. Un stack nuevo trae su receta; cero
   hardcode (mismo patrón que la CI). react-supabase = next + fastify + postgres:16.
2. **preview-runner (el "Docker especial" / orquestador):** dado (project, branch) → clona el repo →
   `docker compose up` de la receta del stack en una **red aislada** y puertos efímeros → registra la
   ruta en Caddy (Admin API) → devuelve `preview_url` → **agenda teardown** (reaper a las N horas).
3. **Integración:** el `release` executor llama al runner → `preview_url` → lo consume (a) el reporte
   de la ceremonia de Review y (b) la pestaña **"App en vivo"** de la UI (iframe navegable).

## Seguridad (NO negociable — corre código UNTRUSTED del repo del cliente)
- Contenedores en **red propia sin acceso** a la red de prod (console/worker/caddy/su DB) ni al host.
- **No-root, read-only FS donde se pueda, límites de CPU/mem/pids, sin secrets del sistema**, sin
  Docker socket. La DB del preview es EFÍMERA y propia (nunca la de Fluxo ni la del cliente).
- **Caddy on-demand TLS con `ask` guard:** solo emite cert para subdominios de previews ACTIVOS
  (evita que cualquiera pida certs). El runner registra/da de baja la ruta.
- **Efímero de verdad:** teardown por tiempo (reaper) + al cerrar el sprint. Nada persiste.

## Plan por fases (Strangler — cada una se valida sola; NADA toca prod hasta la Fase 2)
- **Fase 0 · DNS (prereq, bajo riesgo):** wildcard `*.fluxo.aiudalabs.com → 2.25.78.202` (MCP
  Hostinger). No toca el record existente de `fluxo.aiudalabs.com`.
- **Fase 1 · PoC del sandbox (AISLADO, cero impacto prod):** la receta compose de react-supabase +
  correr misalon@dev end-to-end en un contenedor en el VPS, en red/puertos propios, y curlearlo
  internamente. Valida lo más difícil (correr la app full-stack efímera) sin tocar caddy/console/worker.
- **Fase 2 · Caddy dinámico + on-demand TLS (con cuidado):** ruta `preview-<id>… → puerto del
  contenedor` vía Admin API + on-demand TLS con `ask`. Probado contra el contenedor de la Fase 1, sin
  romper la ruta del dominio principal (backup del Caddyfile + rollback listo).
- **Fase 3 · preview-runner:** el servicio que orquesta clone→build→up→ruta→teardown. Lo llama el
  `release`.
- **Fase 4 · cablear `release`:** el paso release de sprint-review (hoy stub) usa el runner → preview_url real.
- **Fase 5 · UI "App en vivo":** pestaña del workspace con iframe navegable + rebuild + estado
  (building/live/expira) + selector de rama/sprint.

## Verificación
- Fase 1: `curl` interno a la app corriendo (frontend + una ruta de API que pegue a la DB efímera).
- Fase 2: `https://preview-<id>.fluxo.aiudalabs.com` responde con cert válido, y el dominio principal
  sigue intacto.
- E2E: un incremento → build → merge → Review → **preview navegable** en la pestaña, se navega la app
  de verdad, y expira sola.
