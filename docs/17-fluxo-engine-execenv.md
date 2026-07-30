# 17 · ExecEnv `fluxo_engine` — correr build+gates en docker propio (no GitHub Actions)

**Estado:** diseño aprobado (2026-07-29). Motivación: GitHub Actions cobra por minuto y se topó el
presupuesto de la cuenta del cliente en pleno sprint. Cada `ui-verify` hace un `docker compose up
--build` (imagen Next + Postgres + Redis + migrate + seed) → muchos minutos por PR. El **build** (agente
largo) + los **gates** (compose build) son el costo. Queremos moverlos a **docker en el VPS propio**
(costo flat que ya se paga) con el **token de Claude Code Pro/Max** (sub flat, no API por-token) → COGS ~0.

## Decisión

Agregar un **ExecEnv `fluxo_engine`** (docker en el VPS) **como alternativa a `github_actions`**, elegible
por **settings del proyecto** (`settings.exec_env`). Esto NO reconstruye el conductor — es exactamente la
golden rule #5 (**Runtime × Provider × ExecEnv en data**). El conductor de v2 (worker, dispatch, gates,
proyección, auto-merge) **queda igual**; solo cambia *dónde* corre el agente y *dónde* corren los gates.

- `settings.exec_env = "github_actions"` (default) → BYO, cero COGS, token del cliente (lo actual).
- `settings.exec_env = "fluxo_engine"` → docker en el VPS de AIuda, token Pro/Max del tenant (bóveda).

Requisito del usuario: **toggle en la UI de Settings** — "correr en el Fluxo engine o en GitHub".

## Qué se REUSA de v1 (aiuda-forge) — el diseño, probado y auditado

Ruta: `~/projects/genai/aiuda-forge/engine/`.

| Pieza v1 | Qué aporta | Dónde |
|---|---|---|
| `internal/agent/claude.go` | corre `claude -p --output-format stream-json --permission-mode acceptEdits "$prompt"`; token Pro/Max como **`CLAUDE_CODE_OAUTH_TOKEN`** (auth OAuth, línea ~314); parsing stream-json (cost/tokens/turns). Data-driven: cualquier CLI con el protocolo (claude/opencode/copilot) sin código. | `defaultArgv`, `AuthOAuthToken` |
| `internal/sandbox/sandbox.go` | `DockerSandbox`: `dockerArgs()` (pure) arma el `docker run` — `--rm`, `--network <egress\|none>`, `--user uid:gid`, `-e KEY=VAL` (ExtraEnv = token), `-v` repo→workdir, `-w`, `--cidfile`, `--runtime runsc` (gVisor opcional). `RequireDocker` = hard-fail si no hay docker (nunca correr código no-confiable en el host). | `dockerArgs`, `WrapAgent` |
| `scripts/egress-up.sh` + `deploy/egress-proxy/` | red **interna** (sin gateway → sin internet) + `egress-proxy` (tinyproxy, **default-deny allowlist**) como única salida; el agente usa `HTTPS_PROXY=http://egress-proxy:8888`. Allowlist en `deploy/egress-proxy/filter` (api.anthropic.com + github + npm). | topología de aislamiento |
| `deploy/agent/Dockerfile` · `deploy/gate/Dockerfile` | imágenes: agente (node+git+claude-code) y gate (corre la verificación en docker, no en Actions). | `VIBEFORGE_AGENT_IMAGE` |

**Constitución de v1 (se mantiene):** *el código del LLM corre ADENTRO del container (aislado,
egress-allowlist); el `git commit/push` + abrir PR pasa AFUERA* (el token de git NUNCA entra al container).

## Análisis adversarial — qué cargar y qué NO

v2 existe porque v1 se construyó TODO el sustrato y ahí vivían los bugs. Cargamos SOLO el runner:

| CARGAR (el valor) | NO cargar (los bugs de v1) |
|---|---|
| runner docker + egress + token-por-`-e` + split adentro/afuera | **conductor serial 25s** → v2 ya tiene webhooks/histéresis |
| `claude.go` stream-json + auth OAuth | **store SQLite** → v2 = Postgres+RLS |
| `agent/Dockerfile` + `gate/Dockerfile` + egress filter | **minting de tokens / canales hardcodeados en Go** |
| `dockerArgs()` como blueprint del `docker run` | el **engine Go entero** (no se porta ni se corre; solo es referencia de diseño) |

## Arquitectura en v2 (host-runner, cero Go)

Patrón: igual que `scripts/preview-runner.sh` (runner en el host que el worker invoca). Reimplementación
en shell/TS del diseño de v1.

1. **Settings:** `settings.exec_env ∈ {github_actions, fluxo_engine}` (default `github_actions`). Migración
   aditiva; toggle en la UI de Settings del console.
2. **Dispatch:** `reconcileBuild` (worker) + `POST /dispatch` (console) leen `exec_env`. Si `fluxo_engine`,
   en vez de `workflow_dispatch` a `claude.yml`, encolan un job para el **agent-runner**.
3. **`scripts/agent-runner.sh`** (VPS): (a) clona la branch/base del repo (AFUERA, con el PAT del tenant);
   (b) `docker run` la imagen agente en la red egress con `CLAUDE_CODE_OAUTH_TOKEN` (bóveda) + el prompt
   del kernel (`storyPrompt/sprintPrompt`, el MISMO); corre `claude -p stream-json`; (c) captura output+cost
   → `run_costs`; (d) AFUERA: `git add/commit/push` a la branch + abre el PR (PAT del tenant).
4. **Gates en docker (fase 2):** `ui-verify`/`e2e`/`review` corren en el VPS (imagen `gate`) en vez de
   Actions → a GitHub solo va el commit/PR, sin disparar workflows (o se mergea directo sin PR).
5. **Egress (fase 3):** la red allowlist (anthropic+github+npm) para que el código no-confiable del repo
   no exfiltre el token Pro/Max.
6. **Concurrencia:** el VPS es una caja; un límite de N runs concurrentes (v1 tenía aislamiento por-task).
   El `ui-verify` compose build es pesado → cachear imágenes / no correr todo en paralelo.

## Fases

- **F1 — toggle + build-on-engine:** `settings.exec_env` + migración + `agent-runner.sh` (build en docker
  con el token) + branch en dispatch + costos. El PR sigue yendo a GitHub (gates en Actions por ahora).
  *Valor: el costo grande (agente largo) sale de Actions.*
- **F2 — gates-on-engine:** correr `ui-verify` (+e2e+review) en el VPS → fuera de Actions del todo.
- **F3 — egress hardening:** red allowlist + `RequireDocker` (nunca fallback al host).
- **F4 — Settings UI:** el toggle en el console + probe del engine (docker up, token 🟢).

## Referencias
- v1: `~/projects/genai/aiuda-forge/engine/internal/{agent/claude.go,sandbox/sandbox.go}`,
  `engine/scripts/egress-up.sh`, `engine/deploy/{agent,gate,egress-proxy}/`.
- v2: `scripts/preview-runner.sh` (patrón de host-runner), `design/src/dispatch.ts` (prompts, sin cambio),
  `design/src/worker.ts` (`reconcileBuild`), `console/app/api/projects/[id]/dispatch/route.ts`.
