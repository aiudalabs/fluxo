# 08 · Instalación y configuración

Guía para poner Fluxo v2 a correr — **local (dev)** y **producción (VPS + Docker)**. Fluxo es el
*plano de control*: la ejecución pesada (agentes) corre en **GitHub Actions** con el token del
cliente. El VPS/tu-máquina solo corren **console** (Next.js) + **worker** (el conductor) contra
**Supabase** (Postgres/RLS/Realtime/Auth).

---

## 1. Arquitectura de runtime (qué corre dónde)

```
┌───────────────── VPS / tu máquina (plano de control) ─────────────────┐
│  console (Next.js :3000) ──┐                                          │
│  worker  (conductor)     ──┼──► Supabase (Postgres + RLS + Realtime)  │  ← managed (cloud) o local
│  caddy   (TLS, solo prod)  ┘                                          │
└───────────────────────────────────────────────────────────────────────┘
                    │ dispara workflow_dispatch (token del CLIENTE)
                    ▼
        GitHub Actions (repo del cliente) ──► el agente implementa, abre PR
                    │
                    ▼  (GitHub = verdad)
        el worker PROYECTA el estado de vuelta a la DB
```

- **console** — la UI (board, studio, brain, registry, agents, spend) + API routes server-side.
- **worker** (`design/src/worker.ts`) — el loop del conductor: proyección → costos → approvals →
  auto-merge → despacho. Y el workflow de **diseño** (idea→backlog) que corre el agente localmente.
- **Supabase** — el sustrato alquilado. En prod: managed. En dev: local vía el CLI de Supabase.

---

## 2. Prerrequisitos

| Herramienta | Para qué | Notas |
|---|---|---|
| **Node 22+** | console + worker (el worker usa `--experimental-strip-types`, 22.6+) | `node --version` |
| **Docker** | Supabase local (dev) y las imágenes de prod | Desktop o engine |
| **Supabase CLI** | levantar Supabase local en dev | `supabase --version` |
| **gh CLI** | sembrar el secret del canal (`gh secret set`) en el repo del cliente | va en la imagen del console |
| **psql** | aplicar migraciones (hay drift en el history — ver §6) | cliente de Postgres |
| **Una GitHub App** | identidad de Fluxo (crear repos, Issues, Actions, secrets) | ver §5 |

---

## 3. Superficie de configuración (variables de entorno)

| Variable | Quién la usa | Secreto | Descripción |
|---|---|:--:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | console (browser) | | URL de la Supabase. **Se inlinea en build** (build-arg en Docker). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | console (browser) | | Anon key. **Se inlinea en build**. |
| `SUPABASE_URL` | console API + worker | | Igual que arriba, server-side. |
| `SUPABASE_ANON_KEY` | console API + worker | | Anon key server-side. |
| `SUPABASE_SERVICE_ROLE_KEY` | console API + worker | ✅ | Bypassa RLS — paths de sistema/admin. |
| `SUPABASE_JWT_SECRET` | console (firma el JWT de tenant) + worker | ✅ | Project Settings → API → JWT. |
| `GITHUB_APP_ID` | console + worker | | ID numérico de la App. |
| `GITHUB_APP_CLIENT_ID` | console (OAuth) | | `Iv1...` |
| `GITHUB_APP_CLIENT_SECRET` | console (OAuth) | ✅ | Client secret de la App. |
| `GITHUB_APP_PRIVATE_KEY` **o** `..._PATH` | console + worker | ✅ | El PEM (contenido en prod, path en dev). |
| `GITHUB_WEBHOOK_SECRET` | (webhook receiver) | ✅ | Opcional hoy (webhooks no cableados al conductor). |
| `CLAUDE_CODE_OAUTH_TOKEN` | worker (solo design runs) | ✅ | Solo el workflow de diseño local; el conductor NO lo usa. |
| `PUBLIC_URL` / `PUBLIC_DOMAIN` | prod (OAuth callback, Caddy) | | Tu dominio. |

> **El token del LLM del CONDUCTOR nunca vive en Fluxo.** Se siembra como Actions secret del repo del
> cliente (`CLAUDE_CODE_OAUTH_TOKEN` vía `gh secret set`, BYO). Fluxo solo lo pasa, no lo guarda.

---

## 4. Instalación local (dev)

```bash
cd ~/projects/genai/fluxo

# 1) Supabase local (Postgres+RLS+Realtime). Levanta ~10 contenedores.
supabase status || supabase start

# 2) env: toma el .env y overridea a la Supabase local
set -a; source .env; set +a
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="$(supabase status | awk '/anon key/{print $NF}')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status | awk '/service_role key/{print $NF}')"
export SUPABASE_JWT_SECRET="$(supabase status | awk '/JWT secret/{print $NF}')"

# 3) console + worker juntos:
./scripts/dev.sh
#   … o por separado:
#   (cd console && npm run dev)                                    # :3000
#   node --experimental-strip-types design/src/worker.ts --interval=20
```

- Console en `http://localhost:3000`.
- `console/.env.local` ya apunta a la Supabase local para el browser.
- **Ojo (dev)**: NO corras `next build` mientras el `next dev` está vivo — pisa el `.next` compartido
  y lo corrompe (`Cannot find module vendor-chunks/...`). Si pasa: matar dev, `rm -rf console/.next`, relanzar.

---

## 5. Crear la GitHub App de Fluxo

Settings → Developer settings → **GitHub Apps** → New. Permisos requeridos (repo-level):
`Contents: R/W · Issues: R/W · Pull requests: R/W · Actions: R/W · Administration: R/W ·
Metadata: R · **Secrets: R/W** · Workflows: R/W` (y `copilot_agent_settings` si vas a usar Copilot).

> **HALLAZGO (crítico):** sin **Secrets: R/W** el `gh secret set` del canal da 401. Es un permiso
> que hay que agregar explícito + re-aprobar la instalación (ver `~/.devtrace/decisions/fluxo.md`).

- **Callback URL** → `https://<tu-dominio>/auth/github/callback` (dev: `http://localhost:3000/...`).
- Generá la **private key** (PEM) → va en `GITHUB_APP_PRIVATE_KEY`.
- Instalá la App en la cuenta/org donde vivirán los repos de los proyectos.

---

## 6. Migraciones (⚠️ drift en el history)

`supabase migration up` / `db push` **fallan** — el `schema_migrations` quedó desincronizado del
schema real (el schema está aplicado, el history no). **Aplicá cada migración por psql directo:**

```bash
# dev (DB local):
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -f supabase/migrations/<archivo>.sql
# prod (Supabase managed — Project Settings → Database → Connection string):
psql "$SUPABASE_DB_URL" -f supabase/migrations/<archivo>.sql
```

---

## 7. Deploy en producción (VPS + Docker + Supabase managed)

Ver **`deploy/README.md`** para el quickstart. Resumen:

```bash
# 1) Migraciones a la Supabase managed (§6, contra $SUPABASE_DB_URL de la nube).
# 2) Config:
cp deploy/.env.prod.example deploy/.env.prod   # completá TODO; NO lo commitees (está en .gitignore)
# 3) Levantar:
cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

- **Caddy** saca el TLS solo (Let's Encrypt) para `$PUBLIC_DOMAIN` y proxya al console.
- **`restart: always`** repone console/worker si crashean (el worker debe estar siempre-on).
- **Backups** (el free tier no trae): `pg_dump "$SUPABASE_DB_URL" | gzip > /backups/fluxo-$(date +%F).sql.gz` en un cron.
- **Design runs en prod**: si vas a diseñar (idea→backlog) en el VPS, agregá el CLI `claude` a la
  imagen del worker (`design/Dockerfile`). El conductor NO lo necesita.

---

## 8. Costo y escala (resumen — ver la evaluación completa en el decision log)

- **Supabase Free alcanza** para arrancar: la data de Fluxo pesa ~13 MB (vs 500 MB del límite). El
  worker siempre-on evita la pausa por inactividad. Pasá a **Pro ($25/mo)** con clientes que pagan
  (backups gestionados + no-pausa).
- **Cero COGS de ejecución**: los agentes corren en las Actions del cliente con SU token (BYO).
- **Límite de escala de hoy**: el worker es poll-serial single-instance. Para más tenants: cablear
  webhooks (`supabase/functions/github-webhook`) + un claim atómico de worker. Diseñado, no construido.
```
