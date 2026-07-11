# 02 · Capa de ejecución agnóstica — Runtime × Provider × ExecEnv

## Problema que resuelve
v1 cableó la ejecución a 2 executors (`copilot | claude_action`) con `switch`/`otherExecutor`/`capacityBlock` en Go
— viola la regla de oro (metodología en código), sumar un canal exige editar Go, y la liveness era frágil (404 de
Copilot = "sin veredicto" → sesión colgada). v2 lo hace **data-driven en 3 ejes ortogonales** (modelo tomado de
*multica*, referencia externa — NO dependencia).

## Los tres ejes
| Eje | Pregunta | Valores |
|---|---|---|
| **Runtime** | ¿DÓNDE corre? | `github_actions` · `local_daemon` · `docker_isolated` (E2E) · `cloud` |
| **Provider** | ¿QUÉ CLI? | `claude` · `copilot` · `codex` · `opencode` · `cursor` · … |
| **ExecEnv** | ¿cómo se AÍSLA? | runner de Actions · dir local · contenedor egress-deny |

## La frontera con Fluxo (no se toca)
Multica despacha **tickets sueltos**. Fluxo despacha por **sprint (goal-mode) / story / orden-de-deps** con el grafo
`blocked_by` — esa orquestación es la diferenciación y vive ARRIBA. **El runtime es agnóstico a la granularidad**:
recibe "corré este prompt en este repo" y lo corre; no sabe si es una story o un sprint.

```
FLUXO decide la UNIDAD (sprint/story/deps) → entrega { prompt, repo, contexto, lane }
   ▼
CAPA DE RUNTIME: Policy elige (runtime, provider) por lane + fallback ORDENADO
   Runtime.Dispatch → Provider(data) arma la invocación → ExecEnv aísla → sessionRef
```

## Contrato Go del `Runtime`
```go
type Runtime interface {
    ID() string
    Dispatch(ctx, work WorkUnit, provider Provider) (SessionRef, error)   // fire
    Probe(ctx, provider Provider, repo string) (ok bool, reason string)   // capacidad (motivo visible; fail-open)
    Liveness(ctx, ref SessionRef) (State, error)   // running|done|failed|lost — de la fuente ROBUSTA del runtime
    Isolation() Isolation
}
type WorkUnit struct { Prompt string; Repo string; Issues []int; Lane string; Context map[string]string }
```
`Policy` elige `(runtime, provider)` por lane; ids **abiertos** (cualquiera registrado), no 2 strings. `fallback` =
lista ordenada (no swap binario).

## Provider registry — `registry/providers/*.yaml`
```yaml
# claude.yaml
id: claude
runtimes: [github_actions, local_daemon, docker_isolated]
invoke:
  github_actions: { workflow: claude.yml, inputs: { prompt: $prompt, issues: $issues } }
  local:         { argv: [claude, -p, --output-format, stream-json, --permission-mode, acceptEdits] }
credential: { source: repo_secret, name: CLAUDE_CODE_OAUTH_TOKEN, owner: client }   # ← org del CLIENTE
capacity_probe: repo_secret_exists
liveness: workflow_run             # cierra L-AUTO-4: deriva del run, NO del 404
running_signal: label:agent:running
prompt_preamble: claude_ephemeral.md   # disciplina del runner efímero, en MARKDOWN (no en Go)
```
```yaml
# copilot.yaml
id: copilot
runtimes: [github_actions]
invoke: { github_actions: { api: agent_tasks, model: $model } }
credential: { source: client_copilot, owner: client }
capacity_probe: none
liveness: workflow_run
```
Sumar `codex.yaml`/`cursor.yaml`/`opencode.yaml` = un YAML, **cero Go**.

## Matriz credencial-por-runtime (dónde vive la plata)
| Runtime | Credencial | Dónde vive | Gasto de | Aislamiento |
|---|---|---|---|---|
| `github_actions` (default) | secret repo / Copilot cliente | **org del cliente** | **cliente (BYO, cero COGS)** | runner Actions |
| `local_daemon` | env local | máquina operador | operador | dir + git |
| `docker_isolated` | inyectado/vendorizado | contenedor efímero | según provider | **egress-deny (E2E)** |
| `cloud` (opcional) | key efímera de Vault | Fluxo | **Fluxo (upsell)** | sandbox cloud |

## Refactor vs v1
`fireChannel` switch → `runtime.Dispatch` genérico · `otherExecutor` binario → `fallback` lista · `capacityBlock`
if-por-canal → `runtime.Probe` (declarado en provider) · liveness → `runtime.Liveness` (declarado) · preámbulo
horneado → `provider.prompt_preamble` (markdown). Unifica los dos universos de v1 (worker+sandbox y GitHub-native)
bajo una interfaz.
