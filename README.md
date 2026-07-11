# Fluxo v2

Fábrica de software gobernada para agencias — rebuild v2 (agent-native, orchestration-as-data). Por **AIuda Labs**.

> Reconstrucción del kernel de `aiuda-forge` sobre un sustrato alquilado (Postgres+RLS · GitHub · Vercel), cargando el
> método. Ver la auditoría 2026-07-11 que lo motivó.

## Empezá acá
1. **`CLAUDE.md`** — la constitución (golden rules, layout, protocolo de build).
2. **`docs/`** — el diseño, en orden:
   - `00-vision` · `01-arquitectura` · `02-capa-runtime` · `03-roadmap` (el backlog ejecutable) ·
     `04-lecciones` (bugs a no repetir) · `05-ejemplo-e2e` (spec de aceptación) · `06-decisiones`.
3. **`GOAL.md`** — la misión de build autónomo para sesiones nuevas.

## Layout
```
docs/       diseño (fuente de verdad)
registry/   el método como data (agents·skills·workflows·templates·stacks·providers)
control/    pegamento Go mínimo (API · tenant-resolve · dispatch a runtime)
supabase/   migrations (schema+RLS) · functions (webhooks · Maestro · token-mint)
console/    UI Next.js (vista sobre el brain)
```

## Estado
Bootstrap (2026-07-11): docs + skeleton, sin código. La construcción arranca siguiendo `docs/03-roadmap.md`.
Decisión abierta que gatea todo: `06-decisiones` D1 (apuesta de plataforma — Supabase por defecto, a confirmar).
