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
