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
ISSUES_CSV="${4:-}"; MODEL="${5:-claude-opus-4-8}"; KIND="${6:-build}"; JOB_ID="${7:-}"
REGISTRY_DIR="${REGISTRY_DIR:-/opt/fluxo/registry}"  # F4: persona del reviewer (reviewer.md)
ENVF="${ENVF:-/opt/fluxo/deploy/.env.prod}"
AGENT_IMG="${AGENT_IMG:-fluxo-agent-dev:local}"  # "máquina de dev real" (Flutter+Android SDK+Java+node); docs/19 F1. Fallback viejo: AGENT_IMG=fluxo-agent:local
AGENT_DIR="${AGENT_DIR:-/opt/fluxo/agent}"  # dir del Dockerfile.dev (para rebuild-si-falta)
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

# Imagen del agente: si un `docker prune` la borró, rebuildeala local (idempotente, capas cacheadas).
if ! docker image inspect "$AGENT_IMG" >/dev/null 2>&1; then
  log "imagen $AGENT_IMG ausente (¿prune?) — rebuildeando desde $AGENT_DIR…"
  docker build -f "$AGENT_DIR/Dockerfile.dev" -t "$AGENT_IMG" "$AGENT_DIR" >"$WD/../$LABEL.imgbuild.log" 2>&1 \
    || { echo "no pude rebuildear $AGENT_IMG (ver $LABEL.imgbuild.log)"; exit 1; }
fi

# ── REVIEW-job (F4/docs19): el REVIEWER de contexto fresco corre sobre el código YA MERGEADO (main),
#    buildea+corre el artefacto, y escribe findings a /work/findings.json. NO commitea, NO abre PR.
#    Su salida es la columna build_jobs.findings (la PATCHea acá); el worker la aplica (publishFindings).
if [ "$KIND" = "review" ]; then
  [ -n "$JOB_ID" ] || { echo "review job sin JOB_ID"; exit 1; }
  RPERSONA="$(cat "$REGISTRY_DIR/agents/reviewer.md" 2>/dev/null || true)"
  RPROMPT="$RPERSONA

$(cat "$PROMPT_FILE")

NOTA (runner fluxo_engine · modo REVIEW): estás en una MÁQUINA DE DEV REAL con el toolchain del stack, sobre el código YA MERGEADO en /work. Para juzgar el incremento BUILDEÁ el artefacto real del target y CORRÉLO (flutter build apk / npm run build + servir / el binario) — NO te alcanza con \`flutter test\`. Cazá stubs/configs falsos (stub-certified-as-success). Cuando termines, ESCRIBÍ tus findings al archivo /work/findings.json con bash (ej: cat > /work/findings.json <<'EOF' … EOF) — SIEMPRE escribí ese archivo: un array JSON como el contrato de arriba, o EXACTAMENTE [] si el incremento está limpio. Es tu ÚNICA salida: NO commitees, NO pushees, NO abras PR."
  RLOG="$WD/../$LABEL.stream.json"
  git config --global --add safe.directory "$WD" 2>/dev/null || true
  log "corriendo el REVIEWER en $AGENT_IMG sobre el código mergeado…"
  set +e
  # El prompt entra por STDIN, no como argv — ver la nota en el despacho del agente (abajo): un prompt
  # en la línea de comando hace que `pkill -f <patrón>` del propio agente lo mate a él.
  printf '%s' "$RPROMPT" | docker run --rm -i --user 1000:1000 \
    -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOK" \
    -v "$WD:/work" -w /work "$AGENT_IMG" \
    claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model "$MODEL" \
    > "$RLOG" 2>"$WD/../$LABEL.err"
  RRC=$?
  set -e
  RRESULT="$(tail -80 "$RLOG" | python3 -c 'import json,sys
res=None
for ln in sys.stdin:
  try: o=json.loads(ln)
  except: continue
  if o.get("type")=="result": res=o
print(json.dumps({"is_error":res.get("is_error"),"cost":res.get("total_cost_usd")}) if res else "{}")' 2>/dev/null)"
  COST="$(printf '%s' "$RRESULT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("cost") or 0)' 2>/dev/null || echo 0)"
  log "reviewer terminó (rc=$RRC): $RRESULT"
  FF="$WD/findings.json"
  if [ ! -f "$FF" ] || ! python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if isinstance(d,list) else 1)' "$FF" 2>/dev/null; then
    echo "::el reviewer no dejó un /work/findings.json válido (array JSON):: (ver $WD/../$LABEL.err)"; tail -5 "$WD/../$LABEL.err" 2>/dev/null || true; exit 2
  fi
  NFIND="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$FF")"
  # PATCH build_jobs.findings (jsonb). --data-binary con el JSON envuelto {"findings":[...]}.
  curl -s -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" \
    -X PATCH "$SUPA_URL/rest/v1/build_jobs?id=eq.$JOB_ID" \
    --data-binary "$(python3 -c 'import json,sys;print(json.dumps({"findings":json.load(open(sys.argv[1]))}))' "$FF")" >/dev/null
  log "✓ reviewer: $NFIND finding(s) → build_jobs.findings (job $JOB_ID)"
  echo "REVIEW_OK JOB=$JOB_ID WD=$WD COST=$COST"
  exit 0
fi

# ── agente ADENTRO del container (claude -p stream-json) ──────────────────────────────
# Prompt: el agente COMMITEA LOCAL después de cada unidad (como la action → pocos commits semánticos).
# NO pushea (no tiene creds); el runner pushea cada commit nuevo apenas aparece (abajo). Así no se
# pierde trabajo si crashea, el token de git queda AFUERA, y los commits los decide el agente.
PROMPT="$(cat "$PROMPT_FILE")
NOTA (runner fluxo_engine): este container es una MÁQUINA DE DEV REAL, aislada sobre la rama $BRANCH — tenés el toolchain del stack (Flutter+Android SDK, node, etc.) y libertad para npm/node/flutter/build/test e instalar lo que falte. TU CRITERIO DE TERMINADO NO ES \"los tests pasan\": es que el ARTEFACTO DEL TARGET BUILDEA Y CORRE. Buildeá el artefacto real (flutter build apk / npm run build + servir / el binario) y CORRÉLO/booteálo — verificá que arranca y hace lo que pide la story, como en tu propia compu. Los tests son parte de tu verificación, no el objetivo. PROHIBIDO fingir una integración con configs/artefactos falsos (un google-services.json inventado, un \"success\" hardcodeado, data demo como si fuera real): si falta una credencial real, dejala como GAP DECLARADO, nunca un stub que pinta verde. Para no perder trabajo: \`git add -A && git commit\` LOCAL después de CADA unidad con su verificación real en verde. NO pushees ni abras PR (el runner pushea tus commits y abre el PR al final)."
LOGF="$WD/../$LABEL.stream.json"
# git como root sobre un repo que el agente (uid 1000) commitea → evitar "dubious ownership".
git config --global --add safe.directory "$WD" 2>/dev/null || true
# Imagen del agente: si un `docker prune` (o presión de disco) la borró, `docker run` intentaría hacer PULL
# de un registry inexistente → falla con rc=2 y el build muere de arranque (nos pasó con u-gaps1). Rebuildeala
# local si falta, ANTES de correr — es idempotente y barato (capas cacheadas).
if ! docker image inspect "$AGENT_IMG" >/dev/null 2>&1; then
  log "imagen $AGENT_IMG ausente (¿prune?) — rebuildeando desde $AGENT_DIR…"
  docker build -f "$AGENT_DIR/Dockerfile.dev" -t "$AGENT_IMG" "$AGENT_DIR" >"$WD/../$LABEL.imgbuild.log" 2>&1 \
    || { echo "no pude rebuildear $AGENT_IMG (ver $LABEL.imgbuild.log)"; exit 1; }
  log "imagen $AGENT_IMG reconstruida"
fi
log "corriendo el agente en $AGENT_IMG (network=egress pendiente F3; por ahora default)…"
set +e
# EL PROMPT VA POR STDIN, NUNCA COMO ARGV. Suena cosmético y no lo es: con el prompt en la línea de
# comando, TODO su texto queda en el argv del proceso `claude`, y `pkill -f <patrón>` matchea contra la
# línea de comando COMPLETA. Un agente que limpia procesos suyos (`pkill -f "firebase emulators:start"`)
# matchea su PROPIO proceso — porque ese texto está en el prompt — y SE SUICIDA a mitad del trabajo.
# Pasó de verdad (2026-08-08, story S-fb-emulator-init-1 de YoMap): el agente terminó la
# implementación, la pusheó, quiso bajar el emulador que había levantado para verificar, y se mató
# solo → rc=143 (SIGTERM) → job `failed` y 14 min de trabajo bueno sin PR. Por stdin el argv queda
# limpio, así que ningún patrón razonable puede matchearlo (y de paso el prompt deja de ser visible en
# `ps`/`docker top`). `-i` es imprescindible para que el contenedor reciba stdin.
# En un pipeline en background, $! es el PID del ÚLTIMO comando (el docker run) — que es el que queremos.
printf '%s' "$PROMPT" | docker run --rm -i --user 1000:1000 \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOK" \
  -v "$WD:/work" -w /work "$AGENT_IMG" \
  claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model "$MODEL" \
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
