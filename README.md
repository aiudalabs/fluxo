# Fluxo

**Fábrica de software gobernada.** Convierte el brief de un cliente en un **backlog gateado y
trazable**, ejecuta el trabajo con **agentes de IA en el GitHub del propio cliente**, y guarda todo el
conocimiento operativo en un **registro auditable** (el *brain*). Por **[Aiuda Labs](https://fluxo.aiudalabs.com)**.
ICP: agencias y dev-shops boutique de LATAM.

> No es un generador de código más: es una **fábrica** — método, gates, trazabilidad y costo, sobre un
> sustrato determinista alquilado.

## Los dos planos

Fluxo separa el trabajo en dos planos con responsabilidades distintas:

- **DISEÑO (juicio).** Corre en la plataforma: el **worker** (`design/`) usa el **Claude Agent SDK** para
  convertir el brief en PRD → modelo de datos → backlog → sprints, con gates de aprobación humana. La
  salida vive en el *brain* (Supabase).
- **BUILD (ejecución).** Corre en el **GitHub del cliente**: cada unidad se despacha a una GitHub Action
  (`claude.yml`) que dispara un agente Claude con el **token del cliente (BYO)** — cero COGS para la
  plataforma. El agente implementa, commitea y abre un PR; el conductor proyecta el estado, aprueba y
  mergea con gates.

El **console** (`console/`) es la vista sobre el *brain*: board, studio, agentes, spend, brain explorer y
la **app en vivo** (preview efímero navegable).

## La tesis de arquitectura

**Alquilar el sustrato determinista** como configuración declarativa, y dejar como código propio **solo el
método** (data) + un pegamento fino:

| Se ALQUILA (el sustrato) | Es PROPIO (el valor) |
|---|---|
| Postgres + RLS + Realtime + Auth + Vault (Supabase) | El **método** en `registry/` (YAML + markdown) |
| GitHub (repos · Issues · Actions) | El conductor (`design/`) — pegamento delgado y testeado |
| Preview efímero (Caddy on-demand TLS) | El conocimiento operativo (`docs/04-lecciones`) como contratos |

Aislamiento multi-tenant = **RLS en un solo lugar**. Ejecución agnóstica (Runtime × Provider × ExecEnv) =
**data** en `registry/providers/`. Ver la constitución completa en [`CLAUDE.md`](CLAUDE.md).

## Layout

```
docs/       la fuente de verdad del diseño (leé en orden 00 → 16)
docs-site/  la documentación pública (Astro Starlight → docs.fluxo.aiudalabs.com)
registry/   EL MÉTODO como data: agents · skills · workflows · templates · stacks · providers
design/     el CONDUCTOR — worker (Node + Claude Agent SDK): reconcilers (diseño · proyección ·
            despacho gateado · auto-merge · costos · watchdog) + el kernel de dispatch + el Assistant
console/    la UI (Next.js sobre Supabase: board · studio+gates · agentes · spend · brain · preview)
supabase/   migrations (schema + RLS)
scripts/    operacional (preview-runner efímero, dev)
deploy/     docker-compose de producción + Caddy
control/    pegamento Go (mínimo)
```

## Cómo funciona (end-to-end)

1. **Brief → diseño.** El usuario crea un proyecto con su brief; el worker corre el workflow de diseño
   (Agent SDK) y produce el backlog gateado. El humano aprueba los gates en el Studio.
2. **Despacho.** Cada sprint/story lista se despacha (manual o auto) a la Action `claude.yml` del repo del
   cliente, money-safe (se marca `running` antes de disparar).
3. **Ejecución.** El agente implementa en el runner, commitea y abre un PR. El conductor **proyecta** el
   estado desde GitHub (labels/PR), **aprueba** workflows seguros y **mergea** con gates (CI verde + review).
4. **Trazabilidad.** Cada fase, gate, run y costo queda en el *brain* (auditable) y se ve en el console.

Diagramas de arquitectura, secuencia y despliegue: **[docs.fluxo.aiudalabs.com](https://docs.fluxo.aiudalabs.com)**
(fuente en `docs-site/src/content/docs/arquitectura/`).

## Empezá acá

- **[`CLAUDE.md`](CLAUDE.md)** — la constitución: golden rules, layout, decisiones firmes, protocolo de build.
- **`docs/`** en orden: `00-vision` · `01-arquitectura` · `02-capa-runtime` · `03-roadmap` ·
  `04-lecciones` (bugs a NO repetir) · `05-ejemplo-e2e` · `06-decisiones` · … · `16-credenciales-del-tenant`.

## Estado

**En producción** (2026-07). El loop completo corre end-to-end: proyectos reales van del brief al PR
mergeado con agentes en las Actions del cliente. El console + worker se despliegan por Docker Compose
detrás de Caddy; el sustrato es Supabase managed. Últimos hitos: watchdog de liveness para corridas
largas, credenciales a nivel tenant (bóveda), costo estimado de runs cancelados, y preview efímero
BYO-compose. La construcción sigue el backlog de `docs/03-roadmap.md`.

---

*Español en docs/UX; código en inglés. Commits chicos, convencionales, verdes. Una tarea = un branch = un PR.*
