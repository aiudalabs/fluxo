# Preview efímero — contrato del stack `react-supabase`

Esta carpeta es la **receta de preview** del stack (DATA, en el método). El `preview-runner`
(`scripts/preview-runner.sh`) la lee para levantar la app **navegable end-to-end** en un contenedor
descartable y exponerla por un túnel público. Ver el diseño en `docs/14-preview-efimero-diseno.md`.

## Piezas

| Archivo | Qué es |
|---|---|
| `compose.yml.tmpl` | Los servicios del preview (install · db · backend · frontend · edge). El runner sustituye los `{{placeholders}}`. |
| `edge.Caddyfile` | El edge same-origin: `/api` → backend, resto → frontend. El túnel apunta acá. |
| `00-extensions.sql` | Extensiones que Supabase trae y un Postgres pelado no (pgcrypto). Corre en el init-dir. |
| `supabase-emulation.sql` | Emulación GENÉRICA del `auth` schema de Supabase (fallback si el repo no trae la suya). |

## Placeholders que el runner sustituye

- `{{preview_id}}` · id corto del preview (nombre del proyecto compose).
- `{{repo_path}}` · path absoluto al repo clonado en el host.
- `{{preview_port}}` · puerto local (127.0.0.1) donde escucha el `edge`; el túnel lo apunta.
- `{{extensions_sql}}` · path a `00-extensions.sql` (de esta carpeta).
- `{{emulation_sql}}` · path a la emulación: **la del repo** (`backend/test/setup/supabase-emulation.sql`)
  si existe, si no la genérica de acá.
- `{{edge_caddyfile}}` · path a `edge.Caddyfile`.
- `{{jwt_secret}}` · secreto JWT DESCARTABLE que el runner genera por-preview.

## Los 4 problemas que este recipe resuelve (validado con misalon, 2026-07-23)

1. **Supabase-ismos en el schema.** Las migraciones (`backend/drizzle/*.sql`) referencian `auth.users`
   y `auth.uid()`. Un Postgres pelado no tiene el schema `auth` → la migración `0000` explota con
   *schema "auth" does not exist*. Fix: montar la emulación en el **init-dir** de Postgres (corre en el
   boot, antes de migrar).
2. **Auth local.** El backend firma sesiones con `SUPABASE_JWT_SECRET` y usa `AUTH_PROVIDER=local`
   (LocalAuthProvider, sin GoTrue). El recipe lo setea explícito.
3. **Ruteo same-origin.** El front llama a la API **desde el browser**. Una URL interna
   (`http://backend:4000`) no la resuelve el navegador del usuario. Fix: `NEXT_PUBLIC_API_URL=/api` +
   el `edge` rutea `/api` → backend. Same-origin, sin CORS.
4. **El túnel apunta al `edge`**, no al frontend suelto — si no, `/api` no existe y la UI queda vacía.

## Seed (opcional) — para que el preview no abra vacío

Si el repo trae `.fluxo/preview/seed.sh`, el runner lo ejecuta después de migrar (con `API_BASE` y las
credenciales del contenedor `db` en el entorno). Debe sembrar datos mínimos por la **API real** del
backend (no INSERTs a mano cuando se pueda), para que el directorio/listados abran con contenido. Sin
seed, la app corre igual — el usuario puede registrarse y crear datos desde el onboarding real.

## Readiness (cuándo el runner lo da por "live")

El runner espera a que **el frontend responda cualquier 2xx/3xx** (la app levantó; puede redirigir
`/` → `/login`) **y el backend dé una respuesta HTTP concreta** en `/api/health` — un `404` cuenta
(el backend está arriba aunque no tenga ruta `/health`; solo `000/502/503/504` = todavía no alcanza al
backend). No hace falta que el repo exponga `/health`; si lo hace, mejor señal.

## Fidelidad

Para un stack Supabase, la máxima fidelidad sería un **Supabase local** (Postgres + GoTrue + PostgREST).
Este recipe usa Postgres + emulación del `auth` schema: alcanza para apps con **auth local** (la mayoría
de lo que Fluxo construye). Una app que dependa de features server de Supabase (Realtime, Storage,
Edge Functions) declararía su propia receta.
