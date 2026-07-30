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

PROJECT_ID="${1:?PROJECT_ID}"; PROMPT_FILE="${2:?PROMPT_FILE}"; LABEL="${3:?LABEL}"
ISSUES_CSV="${4:-}"; MODEL="${5:-claude-opus-4-8}"
ENVF="${ENVF:-/opt/fluxo/deploy/.env.prod}"
AGENT_IMG="${AGENT_IMG:-fluxo-agent:local}"
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
# Prompt override: el agente NO pushea ni abre PR (no tiene creds de git); solo implementa+commitea local.
PROMPT="$(cat "$PROMPT_FILE")
NOTA (runner fluxo_engine): estás en un container aislado sobre la rama $BRANCH. Implementá y corré los tests. Podés hacer git add/commit LOCAL, pero NO intentes push ni abrir PR (no hay credenciales de git acá; el runner se encarga afuera)."
LOGF="$WD/../$LABEL.stream.json"
log "corriendo el agente en $AGENT_IMG (network=egress pendiente F3; por ahora default)…"
set +e
docker run --rm --user 1000:1000 \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOK" \
  -v "$WD:/work" -w /work "$AGENT_IMG" \
  claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model "$MODEL" "$PROMPT" \
  > "$LOGF" 2>"$WD/../$LABEL.err"
RC=$?
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
cd "$WD"; chown -R "$(id -u):$(id -g)" "$WD" 2>/dev/null || true
git add -A
if git diff --cached --quiet; then echo "el agente no dejó cambios — nada que pushear"; exit 3; fi
# "Closes #N" (una var limpia, sin expansiones anidadas frágiles)
CLOSES=""
if [ -n "$ISSUES_CSV" ]; then for n in ${ISSUES_CSV//,/ }; do CLOSES="${CLOSES}Closes #$n"$'\n'; done; fi
git -c user.name="fluxo-engine[bot]" -c user.email="engine@fluxo.local" commit -q -m "build($LABEL): via fluxo_engine"$'\n\n'"$CLOSES" || true
git -c http.extraheader="$AUTHHDR" push "https://github.com/$SLUG.git" "$BRANCH" -f 2>&1 | tail -2
# PR (afuera): gh via API con el token
BODY="Build de \`$LABEL\` en el **fluxo_engine** (docker en VPS, token Pro/Max — sin GitHub Actions)."$'\n\n'"$CLOSES"
PRJSON="$(curl -s -X POST "https://api.github.com/repos/$SLUG/pulls" \
  -H "Authorization: token $GIT_TOK" -H "Accept: application/vnd.github+json" -H "User-Agent: fluxo" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"title":"build: %s (fluxo_engine)"%sys.argv[1],"head":sys.argv[2],"base":"main","body":sys.argv[3]}))' "$LABEL" "$BRANCH" "$BODY")")"
PRNUM="$(echo "$PRJSON" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("number") or ("ERR:"+str(d.get("message"))))')"
log "✓ pusheado a $BRANCH · PR #$PRNUM · cost $RESULT"
echo "PR=$PRNUM BRANCH=$BRANCH WD=$WD"
