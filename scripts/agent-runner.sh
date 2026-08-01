#!/usr/bin/env bash
# agent-runner.sh — ExecEnv `fluxo_engine` (docs/17). Corre el BUILD de una story/sprint en un
# container docker en el VPS con el token Claude Pro/Max (cero GitHub Actions, cero API metered).
#
# Constitución (de v1): el agente (claude) corre ADENTRO del container sobre el clone montado; el
# git commit/push + PR pasa AFUERA (el token de git NO entra al container). El agente solo edita
# y corre tests; el runner se encarga de la rama, el commit, el push y el PR.
#
# Uso:  agent-runner.sh <PROJECT_ID> <PROMPT_FILE> <LABEL> [ISSUES_CSV] [MODEL]
#   PROJECT_ID  uuid del proyecto (para repo + owner token)
#   PROMPT_FILE archivo con el prompt del kernel (storyPrompt/sprintPrompt)
#   LABEL       slug para la rama/log (ej. s-vfix-6)
#   ISSUES_CSV  "88" o "87,88,90" — para el "Closes #N" del PR
#   MODEL       claude-opus-4-8 (default)
set -euo pipefail
# Bajo systemd (el poller) HOME puede no estar → `git config --global` (safe.directory) no aplicaría y
# git como root sobre el repo del agente (uid 1000) fallaría con "dubious ownership" → los push mueren
# en silencio (commitea local pero no pushea). Forzamos HOME para que la config global valga.
export HOME=/root

PROJECT_ID="${1:?PROJECT_ID}"; PROMPT_FILE="${2:?PROMPT_FILE}"; LABEL="${3:?LABEL}"
ISSUES_CSV="${4:-}"; MODEL="${5:-claude-opus-4-8}"
ENVF="${ENVF:-/opt/fluxo/deploy/.env.prod}"
AGENT_IMG="${AGENT_IMG:-fluxo-agent:local}"
AGENT_DIR="${AGENT_DIR:-/opt/fluxo/agent}"  # Dockerfile de la imagen del agente (para rebuild-si-falta)
WORKROOT="${WORKROOT:-/opt/fluxo/runs}"

log(){ echo "[$(printf '%(%H:%M:%S)T')] $*"; }

# ── creds (del .env.prod + github_tokens) ─────────────────────────────────────────────
CLAUDE_TOK="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENVF" | cut -d= -f2- | tr -d '"')"
SUPA_URL="$(grep -E '^SUPABASE_URL=' "$ENVF" | cut -d= -f2- | tr -d '"')"
SVC="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"')"
[ -n "$CLAUDE_TOK" ] || { echo "falta CLAUDE_CODE_OAUTH_TOKEN en $ENVF"; exit 1; }

rest(){ curl -s -H "apikey: $SVC" -H "Authorization: Bearer $SVC" "$SUPA_URL/rest/v1/$1"; }
REPO_URL="$(rest "projects?id=eq.$PROJECT_ID&select=repo" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["repo"] if d else "")')"
OWNER_ID="$(rest "projects?id=eq.$PROJECT_ID&select=owner_id" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["owner_id"] or "" if d else "")')"
# git token: preferí el PAT del tenant sembrado en el VPS (Contents+PR write; sirve para git via
# x-access-token). Fallback al owner OAuth token de github_tokens.
GIT_TOK="$(cat /opt/fluxo/.git-token 2>/dev/null | tr -d '\n' || true)"
[ -n "$GIT_TOK" ] || GIT_TOK="$(rest "github_tokens?user_id=eq.$OWNER_ID&select=access_token" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["access_token"] if d else "")')"
REDACT='s#x-access-token:[^@]*@#x-access-token:***@#g'
SLUG="$(printf '%s' "$REPO_URL" | sed -E 's#.*github.com/([^/]+/[^/.]+).*#\1#')"
[ -n "$SLUG" ] && [ -n "$GIT_TOK" ] || { echo "no pude resolver repo ($SLUG) / git token"; exit 1; }
# Auth de git por header Basic base64 (robusto ante cualquier char del token; el token NO va en la URL).
AUTHHDR="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GIT_TOK" | base64 | tr -d '\n')"
log "proyecto=$SLUG · label=$LABEL · model=$MODEL · issues=${ISSUES_CSV:-none}"

# ── clone (AFUERA, con el token de git) ───────────────────────────────────────────────
WD="$WORKROOT/$LABEL-$(printf '%(%s)T')"; mkdir -p "$WORKROOT"; rm -rf "$WD"
BRANCH="engine/$LABEL"
git -c http.extraheader="$AUTHHDR" clone --depth 1 "https://github.com/$SLUG.git" "$WD" 2>&1 | tail -1
cd "$WD"
git config user.name "fluxo-engine[bot]"; git config user.email "engine@fluxo.local"
git checkout -b "$BRANCH"
# el remote NO debe filtrar el token al container: lo saco del montaje quitando credenciales de la URL
git remote set-url origin "https://github.com/$SLUG.git"
chown -R 1000:1000 "$WD"   # el container corre como uid 1000 (node) y edita el workdir montado

# ── agente ADENTRO del container (claude -p stream-json) ──────────────────────────────
# Prompt: el agente COMMITEA LOCAL después de cada unidad (como la action → pocos commits semánticos).
# NO pushea (no tiene creds); el runner pushea cada commit nuevo apenas aparece (abajo). Así no se
# pierde trabajo si crashea, el token de git queda AFUERA, y los commits los decide el agente.
PROMPT="$(cat "$PROMPT_FILE")
NOTA (runner fluxo_engine): estás en un container aislado sobre la rama $BRANCH. Implementá y corré los tests (podés npm/node/build/test con libertad). IMPORTANTE — para no perder trabajo: hacé \`git add -A && git commit\` LOCAL después de completar CADA unidad de trabajo con sus tests en verde (mensaje descriptivo). NO pushees ni abras PR (no hay credenciales de git acá; el runner pushea tus commits solo y abre el PR al final)."
LOGF="$WD/../$LABEL.stream.json"
# git como root sobre un repo que el agente (uid 1000) commitea → evitar "dubious ownership".
git config --global --add safe.directory "$WD" 2>/dev/null || true
# Imagen del agente: si un `docker prune` (o presión de disco) la borró, `docker run` intentaría hacer PULL
# de un registry inexistente → falla con rc=2 y el build muere de arranque (nos pasó con u-gaps1). Rebuildeala
# local si falta, ANTES de correr — es idempotente y barato (capas cacheadas).
if ! docker image inspect "$AGENT_IMG" >/dev/null 2>&1; then
  log "imagen $AGENT_IMG ausente (¿prune?) — rebuildeando desde $AGENT_DIR…"
  docker build -t "$AGENT_IMG" "$AGENT_DIR" >"$WD/../$LABEL.imgbuild.log" 2>&1 \
    || { echo "no pude rebuildear $AGENT_IMG (ver $LABEL.imgbuild.log)"; exit 1; }
  log "imagen $AGENT_IMG reconstruida"
fi
log "corriendo el agente en $AGENT_IMG (network=egress pendiente F3; por ahora default)…"
set +e
docker run --rm --user 1000:1000 \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOK" \
  -v "$WD:/work" -w /work "$AGENT_IMG" \
  claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model "$MODEL" "$PROMPT" \
  > "$LOGF" 2>"$WD/../$LABEL.err" &
AGENT_PID=$!
# Push incremental DRIVEN BY COMMITS (no timer): mientras el agente trabaja, cuando el HEAD cambia
# (el agente hizo un commit), pusheamos esa rama. Pocos pushes, semánticos, sin perder trabajo.
LASTPUSHED=""
while kill -0 "$AGENT_PID" 2>/dev/null; do
  HEAD="$(git -C "$WD" -c safe.directory="$WD" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$HEAD" ] && [ "$HEAD" != "$LASTPUSHED" ]; then
    if git -C "$WD" -c safe.directory="$WD" -c http.extraheader="$AUTHHDR" push "https://github.com/$SLUG.git" "$BRANCH" 2>"$WD/../$LABEL.push.err"; then
      LASTPUSHED="$HEAD"; log "↑ push incremental (commit ${HEAD:0:8})"
    else
      log "⚠ push incremental falló: $(tail -1 "$WD/../$LABEL.push.err" 2>/dev/null)"
    fi
  fi
  sleep 15
done
wait "$AGENT_PID"; RC=$?
set -e
RESULT="$(tail -80 "$LOGF" | python3 -c 'import json,sys
res=None
for ln in sys.stdin:
  try: o=json.loads(ln)
  except: continue
  if o.get("type")=="result": res=o
print(json.dumps({"is_error":res.get("is_error"),"cost":res.get("total_cost_usd"),"turns":res.get("num_turns"),"reason":res.get("terminal_reason")}) if res else "{}")' 2>/dev/null)"
log "agente terminó (rc=$RC): $RESULT"
echo "$RESULT" | grep -q '"is_error": *false' || { echo "::agente falló:: $RESULT (ver $WD/../$LABEL.err)"; tail -5 "$WD/../$LABEL.err"; exit 2; }

# ── commit + push + PR (AFUERA, con el token de git) ──────────────────────────────────
cd "$WD"
CLOSES=""
if [ -n "$ISSUES_CSV" ]; then for n in ${ISSUES_CSV//,/ }; do CLOSES="${CLOSES}Closes #$n"$'\n'; done; fi
# Commiteá lo que el agente dejó SIN commitear (restos). Sus commits semánticos ya están (y pusheados).
git add -A
if ! git diff --cached --quiet; then
  git -c user.name="fluxo-engine[bot]" -c user.email="engine@fluxo.local" commit -q -m "build($LABEL): via fluxo_engine (restos)" || true
fi
# Abrir PR si la rama tiene TRABAJO (HEAD movido vs main), no solo si había cambios sin commitear.
if [ "$(git rev-parse HEAD 2>/dev/null)" = "$(git rev-parse origin/main 2>/dev/null)" ]; then
  echo "el agente no dejó cambios (HEAD == origin/main) — nada que pushear"; exit 3
fi
git -c http.extraheader="$AUTHHDR" push "https://github.com/$SLUG.git" "$BRANCH" -f 2>&1 | tail -2
# PR (afuera): gh via API con el token
BODY="Build de \`$LABEL\` en el **fluxo_engine** (docker en VPS, token Pro/Max — sin GitHub Actions)."$'\n\n'"$CLOSES"
PRJSON="$(curl -s -X POST "https://api.github.com/repos/$SLUG/pulls" \
  -H "Authorization: token $GIT_TOK" -H "Accept: application/vnd.github+json" -H "User-Agent: fluxo" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"title":"build: %s (fluxo_engine)"%sys.argv[1],"head":sys.argv[2],"base":"main","body":sys.argv[3]}))' "$LABEL" "$BRANCH" "$BODY")")"
PRNUM="$(echo "$PRJSON" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("number") or ("ERR:"+str(d.get("message"))))')"
COST="$(printf '%s' "$RESULT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("cost") or 0)' 2>/dev/null || echo 0)"
log "✓ pusheado a $BRANCH · PR #$PRNUM · cost \$$COST"
echo "PR=$PRNUM BRANCH=$BRANCH WD=$WD COST=$COST"
