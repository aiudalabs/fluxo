# Runbook: E2E del CONDUCTOR (idea → despacho → PR → review → merge → done)

**Qué es esto:** una corrida REAL, guiada, del loop del conductor (Fases F1–F4, ya en `main`).
NO es un test automatizado de browser: **v2 no tiene harness Playwright** (el runner de console es
`node:test`). Se ejecuta con el worker + se OBSERVA vía `gh`/API/DB + el board del console. Valida
F1–F4 con un run de verdad, no solo unit tests.

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
(Settings → Autonomía. O por DB: `update projects set settings='{"execution_unit":"story","merge_mode":"manual","max_concurrency":1}' where id='0b4a923c-...';`)

## 4. Correr el worker (NO dry-run)
```
set -a; source .env; set +a
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="$(supabase status | awk '/anon key/{print $NF}')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status | awk '/service_role key/{print $NF}')"
export SUPABASE_JWT_SECRET="$(supabase status | awk '/JWT secret/{print $NF}')"
node --experimental-strip-types design/src/worker.ts --interval=20
# (deja el diseño en paz —Idearium ya tiene stories— y hace projection + build cada 20s)
```

## 5. Observar el LOOP (qué esperar en orden)
| # | Qué pasa | Cómo verificar |
|---|---|---|
| 1 | Worker despacha S1-01 (o S1-02) → `workflow_dispatch` a claude.yml | log del worker `▶ build story: … despachado`; DB story → `running` |
| 2 | Claude corre en Actions, implementa, abre PR con `Closes #1` | `gh run list -R nmlemus/idearium`; `gh pr list -R nmlemus/idearium` |
| 3 | **Proyección** (F1): PR abierto → story `review` (+pr_url) | board: la card pasa a "en review"; `select status,pr_url from stories where key='S1-01'` |
| 4 | `claude-review.yml` corre en el PR → deja un review | `gh pr view <n> -R nmlemus/idearium --json reviewDecision,reviews` |
| 5 | (manual) VOS mergeás el PR | `gh pr merge <n> -R nmlemus/idearium --squash --delete-branch` |
| 6 | Issue cierra → **proyección** marca story `done` | board: card a "done"; `select status from stories where key='S1-01'` |
| 7 | (si había deps) el dependiente se desbloquea y se despacha | siguiente tick del worker |

## 6. Criterios de éxito (F1–F4 probados)
- ✅ Un PR REAL abierto por el agente, ligado al issue por `Closes #N`.
- ✅ La story recorrió `backlog → running → review → done` en el board (proyección = F1).
- ✅ `claude-review` dejó un review en el PR (reviewer = F3).
- ✅ En **sprint-mode**: un solo PR cierra TODOS los issues del sprint; SP2 despacha SOLO tras mergear SP1 (gate cross-sprint = F2).
- ✅ Sin doble-run: cada issue se despachó una sola vez.

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
