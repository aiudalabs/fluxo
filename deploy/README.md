# Deploy de Fluxo v2 (VPS + Docker + Supabase managed)

> Topología: el VPS corre **solo el plano de control** — `console` (Next) + `worker` (conductor) +
> `caddy` (TLS). **Supabase es managed** (Postgres/RLS/Realtime/Auth en la nube). La **ejecución de
> agentes corre en GitHub Actions** con el token del **cliente** (BYO, cero COGS) → el VPS queda chico.
> El manual de instalación detallado va en `docs/` (pendiente). Esto es el quickstart.

## 0. Prerrequisitos
- VPS con Docker + Docker Compose y un dominio apuntando a su IP (A record).
- Un proyecto **Supabase** (free alcanza — la data de Fluxo pesa ~13 MB; ver `docs/06-decisiones` D1).
- La **GitHub App** de Fluxo creada (App ID, client id/secret, private key PEM, webhook secret).

## 1. Aplicar las migraciones a la Supabase managed
```bash
# desde tu máquina, contra la DB de la nube (Project Settings → Database → Connection string):
psql "$SUPABASE_DB_URL" -f supabase/migrations/<cada-migración>.sql
# ⚠️ el historial de migraciones tiene drift (ver CLAUDE.md) → aplicá por psql, no `supabase db push`.
```

## 2. Configurar el env
```bash
cp deploy/.env.prod.example deploy/.env.prod
# completá TODOS los valores (Supabase API keys, GitHub App, dominio). NO lo commitees.
```

## 3. Levantar
```bash
cd deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```
Caddy saca el cert TLS solo. El console queda en `https://$PUBLIC_DOMAIN`, el worker corre headless.

## 4. Apuntar la GitHub App
- **Callback URL** → `https://$PUBLIC_DOMAIN/auth/github/callback`
- **Webhook URL** → (opcional; los webhooks aún no están cableados al conductor — el worker poll cubre)

## 5. Backups (free tier no trae backups gestionados)
```bash
# cron nocturno en el VPS:
pg_dump "$SUPABASE_DB_URL" | gzip > /backups/fluxo-$(date +%F).sql.gz
```

## Notas
- **El worker es siempre-on**: su polling mantiene activa la DB (evita la pausa por inactividad del
  free tier) y es quien proyecta/despacha/mergea/aprueba/costea. `restart: always` lo repone si crashea.
- **Escala**: hoy el worker es poll-serial single-instance (ver la evaluación de escalabilidad).
  Para más tenants: cablear webhooks (`supabase/functions/github-webhook`) + claim de worker. Diseñado,
  no construido.
- **Design runs en prod**: el workflow idea→backlog corre el agente EN el worker (Agent SDK). Si lo vas
  a usar en prod, agregá el CLI `claude` a la imagen del worker (ver `design/Dockerfile`). El conductor
  NO lo necesita.
