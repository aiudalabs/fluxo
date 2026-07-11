# AGENTS — cómo se construye Fluxo v2 (lanes de desarrollo)

Roster para construir ESTE repo (distinto del `registry/` que es el método que Fluxo aplica a los proyectos de los
clientes). Una sesión puede tomar cualquier lane según la tarea del `docs/03-roadmap.md`.

| Lane | Dueño de… | Toca |
|---|---|---|
| **data/rls** | schema Postgres, migraciones, RLS policies, pgTAP de aislamiento | `supabase/migrations/**` |
| **edge** | Edge Functions: webhook receiver, Maestro (reconciliador determinista), token-mint | `supabase/functions/**` |
| **control** | pegamento Go: API, tenant-resolve, dispatch a runtime, contrato `Runtime` | `control/**` |
| **runtime** | `registry/providers/*.yaml` + adaptadores de runtime (github_actions/local/docker/cloud) | `registry/providers/**`, `control/runtime/**` |
| **method** | el método como data: agents/skills/workflows/templates/stacks + `brain-write` | `registry/**` (no `providers/`) |
| **console** | UI Next.js sobre Supabase (board, grafo, studio, brain explorer, preview) | `console/**` |
| **verify** | harnesses de verificación (e2e, lint, ui-verify, juez-visión, cross-lane) | `registry/templates/**/.fluxo/verify/**`, `registry/templates/**/.github/**` |
| **delivery** | última milla: provisioning de infra del cliente, deploy web, build/distribución móvil | `registry/templates/**`, `control/delivery/**` |

## Reglas para todas las lanes
- Cumplir las golden rules de `CLAUDE.md` (cero metodología en Go; RLS; determinismo donde es barato; tests primero).
- No reintroducir ningún bug `L-*` de `docs/04-lecciones.md`.
- Cada tarea del roadmap = un branch/PR, verde, convencional.
- Los docs son la fuente de verdad: si tu tarea cambia el diseño, actualizá el doc en el mismo commit.
