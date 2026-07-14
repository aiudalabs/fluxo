# Runbook: E2E del CONDUCTOR (idea → despacho → PR → review → merge → done)

**Qué es esto:** una corrida REAL, guiada, del loop del conductor (Fases F1–F4 + F6, ya en `main`).
NO es un test automatizado de browser: **v2 no tiene harness Playwright** (el runner de console es
`node:test`). Ahora es **BROWSER-DRIVEN**: el despacho lo disparás con el botón **▶ Despachar** del
board (F6a) y monitoreás en la vista **Agentes** (F6b); el worker corre en paralelo SOLO para
proyectar (GitHub→DB) y auto-mergear. Se OBSERVA vía el console + `gh`/API/DB. Valida F1–F4 + F6
con un run de verdad, no solo unit tests.

> ⚠️ **CUESTA PLATA.** Dispara un agente Claude real en las GitHub Actions del repo destino, con TU
> `CLAUDE_CODE_OAUTH_TOKEN`. Empezá con **UNA story** (story-mode, una story sin deps) para minimizar
> costo; recién después probá sprint-mode / auto-merge.

Proyecto de prueba (Idearium, ya diseñado y con backlog publicado):
- project_id `0b4a923c-f295-431a-9f51-af461462dd80` · repo `github.com/nmlemus/idearium` · org `nmlemus`
- owner_id `69ee9f33-8a21-4214-86df-485448f95aa5` · tenant `cc057f2f-d946-42cd-a113-5cae97ca2bb4`
- 20 stories / 8 sprints. Sin deps: `S1-01` (flutter, issue #1), `S1-02` (python, issue #2). SP1 = issues #1,#2,#3.

---

## 0. Prerrequisitos (checklist)
- [ ] Supabase local corriendo (`supabase status`).
- [ ] `.env` con `SUPABASE_*`, `GITHUB_APP_*`, y el `.pem` de la App. `set -a; source .env; set +a`.
- [ ] Console en :3000 (`cd console && npm run dev`) — para observar en el board.
- [ ] La Fluxo App **instalada en `nmlemus`** con el permiso **Secrets** aprobado (ya está, 2026-07-13).
- [ ] Token de GitHub del owner válido (si expiró, el probe/rescaffold refresca solo vía getUserToken).

## 1. Sembrar el secret del canal (lo hace el USUARIO)
En el console: **Settings → Canal de build** del proyecto Idearium → pegar el `CLAUDE_CODE_OAUTH_TOKEN`
**ROTADO** (generá uno nuevo con `claude setup-token`; NO uses el que se expuso en el chat). El probe
debe pasar a 🟢 ("listo"). Verificación por API:
```
curl -s "http://localhost:3000/api/projects/0b4a923c-f295-431a-9f51-af461462dd80/channel" \
  -H "Authorization: Bearer <session-jwt>" | python3 -m json.tool   # available: true
```
(El token NUNCA se guarda en Fluxo — va al Actions secret del repo. BYO.)

## 2. Re-scaffold del repo (agrega claude-review.yml + suite-integrity.yml)
Idearium se creó antes de F3, así que le falta el reviewer. Idempotente (putFile):
```
set -a; source .env; set +a
node --experimental-strip-types design/src/rescaffold.ts 0b4a923c-f295-431a-9f51-af461462dd80
# dry-run primero si querés: agregá --dry-run
```
Verificá que quedaron los 3 workflows en el repo:
```
gh api repos/nmlemus/idearium/contents/.github/workflows --jq '.[].name'
# claude.yml, claude-review.yml, suite-integrity.yml
```

## 3. Elegir modo + merge (en Settings del proyecto)
Para la PRIMERA corrida, lo más barato y observable:
- `execution_unit = story` (una story, no un sprint entero).
- `merge_mode = manual` (vos mergeás — sin riesgo de auto-merge en el primer run).
- `max_concurrency = 1` (una sola a la vez).
- `dispatch_mode = manual` (**el despacho lo disparás vos desde el board**, no el worker — así ves
  el botón ▶ y controlás cuándo se paga el run; el worker sigue proyectando + auto-mergeando).
(Settings → Autonomía. O por DB: `update projects set settings='{"execution_unit":"story","merge_mode":"manual","max_concurrency":1,"dispatch_mode":"manual"}' where id='0b4a923c-...';`)

> **dispatch_mode** (F6a): `manual` = botón-only (la UI despacha; el worker NO auto-despacha) ·
> `auto` (default) = el worker despacha por tick. En `auto` el worker te ganaría de mano y
> despacharía solo — por eso el E2E browser-driven usa `manual`.

## 4. Correr el worker (NO dry-run) — para PROYECCIÓN + AUTO-MERGE
En modo browser-driven (`dispatch_mode=manual`) el worker NO despacha; corre igual porque es
quien **proyecta** (mueve la story running→review→done leyendo GitHub) y **auto-mergea** (si
`merge_mode=auto`). Sin el worker corriendo, la card despachada quedaría en `running` para siempre.
```
set -a; source .env; set +a
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="$(supabase status | awk '/anon key/{print $NF}')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status | awk '/service_role key/{print $NF}')"
export SUPABASE_JWT_SECRET="$(supabase status | awk '/JWT secret/{print $NF}')"
node --experimental-strip-types design/src/worker.ts --interval=20
# (con dispatch_mode=manual: hace SOLO projection + auto-merge cada 20s; el disparo va por el board)
```
También necesitás el console en :3000 (`cd console && npm run dev`) — ahí está el botón ▶ y la
vista Agentes. La sesión del console debe tener el token OAuth del usuario (login con GitHub) para
que POST /dispatch pueda `workflow_dispatch` como vos.

## 5. Despachar desde el BOARD + observar el LOOP (qué esperar en orden)
| # | Qué pasa | Cómo verificar |
|---|---|---|
| 1 | **En el board (kanban) clickeás ▶ Despachar** en la card S1-01 (o S1-02) → POST /api/projects/[id]/dispatch marca `running` (RPC, money-safe) y dispara `workflow_dispatch` a claude.yml con TU token | la card salta a "running" sola (Realtime); en la vista **Agentes** aparece bajo "Sesiones activas" con link "ver sesión" |
| 2 | Claude corre en Actions, implementa, abre PR con `Closes #1` | `gh run list -R nmlemus/idearium`; `gh pr list -R nmlemus/idearium`; o vista Agentes |
| 3 | **Proyección** (F1, worker): PR abierto → story `review` (+pr_url) | board: la card pasa a "en review"; vista Agentes → "Cola de PRs"; `select status,pr_url from stories where key='S1-01'` |
| 4 | `claude-review.yml` corre en el PR → deja un review | `gh pr view <n> -R nmlemus/idearium --json reviewDecision,reviews` |
| 5 | (si el CI quedó `action_required`) **aprobás el workflow** desde la vista **Agentes** → "Aprobar workflow" | el run sale de la lista; `gh run list -R nmlemus/idearium` |
| 6 | (manual) VOS mergeás el PR | `gh pr merge <n> -R nmlemus/idearium --squash --delete-branch` |
| 7 | Issue cierra → **proyección** (worker) marca story `done` | board: card a "done"; `select status from stories where key='S1-01'` |
| 8 | (si había deps) el dependiente se desbloquea → aparece su ▶ en el board para el próximo despacho manual | board: la card gana el botón ▶ |

## 6. Criterios de éxito (F1–F4 + F6 probados)
- ✅ El despacho arrancó desde un **click en ▶ Despachar en el board** (F6a), no del worker.
- ✅ Un PR REAL abierto por el agente, ligado al issue por `Closes #N`.
- ✅ La story recorrió `backlog → running → review → done` en el board (proyección = F1).
- ✅ La vista **Agentes** mostró la sesión activa (link "ver sesión") y el PR en la cola (F6b).
- ✅ `claude-review` dejó un review en el PR (reviewer = F3); si hubo un run `action_required`,
  se aprobó desde la vista Agentes ("Aprobar workflow", F6b).
- ✅ En **sprint-mode**: el botón ▶ del board dispara el sprint entero (1 PR cierra TODOS los issues);
  SP2 recién ofrece su ▶ tras mergear SP1 (gate cross-sprint = F2).
- ✅ Sin doble-run: cada issue se despachó una sola vez (el POST re-deriva y marca `running` ANTES de disparar).

## 7. Probar el AUTO-MERGE + el gate del reviewer (segunda pasada)
Recién cuando la pasada manual ande. **Requiere branch protection** para que el gate sea REAL:
```
# Requerir 1 review + los checks del reviewer (nombres de job de los workflows: leelos con
#   gh api repos/nmlemus/idearium/actions/workflows  y los job names de claude-review.yml/suite-integrity.yml)
# Vía GitHub UI: Settings → Branches → Add rule main → Require PR review + Require status checks.
# O gh api (sketch):
gh api -X PUT repos/nmlemus/idearium/branches/main/protection \
  --input branch-protection.json   # required_status_checks + required_pull_request_reviews
```
Luego `merge_mode = auto` en Settings. El worker mergea SOLO si
`!draft && OPEN && mergeStateStatus==CLEAN && reviewDecision != CHANGES_REQUESTED` (F4).
- ⚠️ **SIN branch protection el gate NO bloquea**: un PR puede quedar `CLEAN` antes de que corra
  `claude-review`, y `reviewDecision` viene `null` → el auto-merge mergea sin revisión real.

## 8. Reset / rollback (para re-correr)
```
# Devolver stories a backlog (limpia run/pr) — requeue:
update stories set status='backlog', pr_url=null, run_id=null, session_url=null, agent_lost=null
  where project_id='0b4a923c-...';
# Cerrar/borrar PRs y ramas de prueba:
gh pr list -R nmlemus/idearium --json number --jq '.[].number' | xargs -I{} gh pr close {} -R nmlemus/idearium -d
```

## 9. Caveats conocidos
- Drift de la history table: `supabase migration up` falla (schema_migrations quedó en 20260712090000).
  Las migraciones ya están aplicadas al DB local; para una nueva usá psql directo.
- `liveRunCount` es repo-level: en story-mode con varios runs, una story perdida no se marca `agent_lost`
  mientras otra tenga run vivo (aceptable; se afina con run-por-story).
- Copilot channel no está cableado (solo `claude_action`): si una lane pide copilot, el worker avisa y omite.
