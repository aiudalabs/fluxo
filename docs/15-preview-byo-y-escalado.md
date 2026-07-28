# 15 · Preview efímero — BYO-compose + plan de escalado

> Continúa `docs/14` (diseño del preview efímero). Acá: el modo **BYO (bring-your-own-compose)** que
> generaliza el preview a cualquier app, lo que se implementó **para probar E2E**, y el **plan de
> escalado** a infraestructura dedicada (pedido explícito del usuario, 2026-07-28).

## Qué cambió (y por qué)

El preview v2 (`docs/14`) corría una **receta por-stack** de Fluxo (`registry/templates/.../\.fluxo/preview/compose.yml.tmpl`).
Solo existía la receta **`react-supabase`**. Al pedir el preview de **Salonara** (un app Next.js + Prisma +
Postgres + Redis + BullMQ, stack `null`), el runner cayó al default `react-supabase` — arquitectónicamente
incompatible (sin Redis, emulación Supabase en vez de Prisma, env equivocado) → la app nunca dio `/api/health`
200 → timeout → *"la app no respondió a tiempo"*.

**Decisión (opción B):** en vez de mantener una receta por cada stack, el runner usa el
**`docker-compose.yml` PROPIO del repo** cuando existe. La app **se auto-describe**: se previsualiza con la
MISMA fuente de verdad con la que se buildea. La receta por-stack queda de **fallback** para repos sin compose.

### Cómo funciona el BYO (implementado en `scripts/preview-runner.sh`)

1. Clonar el repo. Si trae `docker-compose.yml` en la raíz → **BYO**; si no → receta del stack.
2. **`.env` efímero** (`gen_env`): llena cada `${VAR:?required}` del `.env.example` para que la app BOOTEE —
   secrets → random, la URL pública → la del preview, modes/emails → demo. No es para login real; es un
   preview **navegable y descartable**.
3. **Edge same-origin**: un `edge` (Caddy) que proxya `:80 → web:3000`, en la red de la app **+** la red de
   ingress (`fluxo-preview-ingress`). El Caddy de prod lo alcanza **por nombre** (`fluxo-preview-<pid>-edge-1`)
   y le pega TLS + el subdominio `sslip.io`. El edge **no publica puerto de host** (la app ya publica `web` en
   `WEB_PORT`, que usa el health-check).
4. `docker compose -p fluxo-preview-<pid> -f <repo>/docker-compose.yml -f edge-override.yml up -d --build`.
5. Esperar `/api/health` = 200 (hasta ~12 min: build + migrate + boot). Seed opcional (`.fluxo/preview/seed.sh`).
6. `status=live` + `preview_url` + `expires_at`. Reaper baja el `live` vencido (TTL 6h).

**Validado E2E (2026-07-28):** Salonara → `https://preview-p05b415c1cc.2.25.78.202.sslip.io` →
`/api/health` `{"status":"ok","checks":{"database":true,"redis":true}}`, `/` = 200. Los 5 contenedores
(edge, web, worker, postgres, redis) sanos.

### Por qué funcionó tan directo

El scaffold de Fluxo genera composes **preview-friendly** por construcción: puerto parametrizado (`WEB_PORT`),
wiring interno (`DATABASE_URL→postgres`, `REDIS_URL→redis`), **healthcheck** incorporado, **self-migrate** en
el entrypoint, **límites de recursos**, y cero directivas peligrosas. BYO **aprovecha** ese trabajo.

---

## ⚠️ Esto es un STOPGAP — no es la arquitectura final

Lo implementado corre **en el VPS de producción** (el mismo box que console/worker/caddy) y **NO sanitiza** el
compose de la app (asume scaffold limpio). Aceptable para **probar Salonara**; **no** para producción multi-cliente.

Dos razones por las que hay que escalar (dirección del usuario):

1. **Aislamiento de infra.** El preview corre código de build del repo del cliente (`npm ci`, `next build`,
   Dockerfiles) **en el box de prod**. Un preview que consuma toda la RAM/CPU, o escape de red, degrada prod.
2. **Apps arbitrarias en el futuro.** Hoy Salonara trae un compose limpio. Pero se va a construir cualquier
   cosa: multi-contenedor, contenedores de email, colas, servicios raros. No se puede asumir que el compose
   sea seguro ni acotado.

---

## Plan de escalado (pending)

**Objetivo:** un **servicio de contenedores efímeros dedicado** — levantar el stack completo de una app
(todo adentro), mostrar el preview navegable al usuario final, y **apagarlo** al expirar. Separado de prod,
seguro para apps arbitrarias.

### Fase E1 — Mover los previews FUERA del box de prod
- Un **VPS/cluster aparte solo para previews** (el runner + docker, nada de prod). El console/worker le hablan
  por la misma cola `preview_requests` (Supabase) — cero acoplamiento nuevo.
- El Caddy de prod deja de compartir red con los edges; el box de previews expone su propio ingress + TLS.
- **Beneficio inmediato:** un preview no puede tocar prod (CPU/RAM/red). Bajo esfuerzo, alto retorno.

### Fase E2 — Guard de seguridad del compose (apps NO confiables)
Antes del `up`, **rechazar** (no "sanear") composes con directivas peligrosas, con motivo claro:
- `privileged: true`, `cap_add`, `network_mode: host`, montaje del docker socket (`/var/run/docker.sock`),
  bind-mounts a paths del host, `pid: host`, `userns`.
- **Forzar** (via override): límites de CPU/mem/pids por servicio, red aislada sin ruta a la LAN de prod,
  `read_only` donde se pueda, `no-new-privileges`, sin secrets del host.
- Si el compose no pasa el guard → `failed` con "compose no apto para preview: <razón>".

### Fase E3 — Contrato de compose preview-friendly (en el scaffold)
Para que BYO generalice de verdad, el scaffold debe **garantizar** (y `verify` chequear) que todo compose:
- parametrice el puerto web (`${WEB_PORT}`), wiree servicios internamente, se auto-limite, se auto-migre en el
  entrypoint, exponga `/api/health` (o declare su healthcheck), y **bootee con `.env.example` + los pocos
  valores que inyecta el runner**. Salonara ya cumple; hay que hacerlo un **contrato**, no un accidente.

### Fase E4 — Servicio de contenedores efímeros (evaluar)
Reemplazar el "runner + docker en un VPS" por una plataforma que dé aislamiento fuerte + escala + auto-teardown.
Candidatos a evaluar (con su tradeoff):
- **VPS/pool propio con el runner actual** (lo más barato; aislamiento = docker + red; escala manual).
- **Fly.io Machines / Railway / Render** — microVMs/containers efímeros por API, teardown por TTL; multi-contenedor
  vía su compose/manifest. COGS por uso.
- **Kubernetes con namespaces efímeros** (o vcluster) — el stack de la app en un namespace aislado + NetworkPolicy;
  teardown = borrar el namespace. Más operación, mejor aislamiento y escala.
- **microVMs (Firecracker / Kata)** — aislamiento a nivel VM para código realmente no confiable. Máximo aislamiento,
  máxima complejidad.
> **Criterio:** correr un `docker compose`/stack multi-contenedor arbitrario, aislado, con TTL, barato en idle.
> Empezar por E1 (VPS aparte) + E2 (guard) cubre el 90% del riesgo sin comprometerse a una plataforma todavía.

### Fase E5 — COGS y lifecycle
- El **compute** del preview pasa a ser de Fluxo (a diferencia del build BYO en las Actions del cliente). Acotar:
  TTL corto (ya 6h), teardown agresivo al cerrar el sprint, límites duros, y un tope de previews concurrentes.
- Métrica de costo del preview (como el spend del build) para no tener sorpresas.

## Checklist pendiente
- [ ] E1 · VPS/cluster de previews separado de prod.
- [ ] E2 · Guard de seguridad del compose (rechazo + límites forzados + red aislada).
- [ ] E3 · Contrato de compose preview-friendly en el scaffold + chequeo en `verify`.
- [ ] E4 · Evaluar/elegir plataforma de contenedores efímeros (PoC de 1-2 candidatos).
- [ ] E5 · Métrica de costo + topes de concurrencia/TTL.
- [ ] Hardening del `.env` efímero: hoy `ADMIN_PASSWORD_HASH`/secrets son random (la app bootea pero el login
      admin no sirve). Si un demo necesita login, seedear un admin real via `.fluxo/preview/seed.sh`.
