# supabase/ — el sustrato alquilado (schema + RLS + Edge Functions)

```
migrations/   schema Postgres + RLS policies (brain_events, stories, runs, events, sprints, …)
              Toda tabla: tenant_id/project_id + policy. pgTAP de aislamiento por tabla.
functions/    Edge Functions (Deno/TS) = el ÚNICO pegamento determinista:
                webhook/   receptor de webhooks GitHub firmados (F3-01)
                maestro/   reconciliador determinista con histéresis (F3-02) — NO LLM
                tokens/    minting de installation tokens / token-mint
```

Reglas: el aislamiento vive SOLO acá (RLS) — prohibido replicarlo con WHERE a mano en `control/`. El Maestro es
código determinista con máquina de estados; la democión de estado solo por evento terminal explícito (ver
`docs/04-lecciones` L-ARCH-2). Realtime se usa para proyectar a la UI (sin polling).

## Flujo de dev (CLI, local-first)
Inicializado con `supabase init` (`config.toml`, project_id `fluxo`, Postgres 17). **El dev es local, $0, sin tocar la
nube** (solo se linkea un proyecto hosted para staging/prod más adelante).

```bash
# requiere Docker Desktop corriendo
supabase start                 # levanta Postgres + Auth + Realtime + Studio local (127.0.0.1)
supabase status                # URLs + anon/service keys locales → copiar a .env
supabase migration new <name>  # crea supabase/migrations/<ts>_<name>.sql
supabase db reset              # aplica todas las migraciones desde cero (corre pgTAP/seed)
supabase stop                  # baja el stack local

# hosted (staging/prod, cuando toque — D4):
supabase link --project-ref <ref>
supabase db push               # sube las migraciones al proyecto hosted
```
Las **RLS policies** y el **schema** van en `migrations/` (versionado). El test de fuga cross-tenant (pgTAP) corre en
`supabase db reset` y en CI. GitHub OAuth se configura en `[auth.external.github]` de `config.toml` (con client
id/secret) cuando se cablee auth.
