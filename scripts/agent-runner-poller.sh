#!/usr/bin/env bash
# agent-runner-poller.sh — poller host-level del ExecEnv `fluxo_engine` (docs/17).
# Gemelo del fluxo-preview-runner: levanta build_jobs 'pending', corre scripts/agent-runner.sh
# (docker + token Pro/Max) y reconcilia el status de las stories + el PR. Corre en el HOST del VPS
# (systemd), porque agent-runner.sh hace `docker run` a nivel host (los containers no tienen socket).
set -euo pipefail
ENVF="${ENVF:-/opt/fluxo/deploy/.env.prod}"
RUNNER="${RUNNER:-/opt/fluxo/agent-runner.sh}"
INTERVAL="${INTERVAL:-20}"
SUPA_URL="$(grep -E '^SUPABASE_URL=' "$ENVF" | cut -d= -f2- | tr -d '"')"
SVC="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"')"
B="$SUPA_URL/rest/v1"
H=(-H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json")
log(){ echo "[$(date +%H:%M:%S)] $*"; }

set_story(){ # $1=story_key(csv-safe) $2=project $3=status $4=pr_url|null
  local sid; sid="$(curl -s "${H[@]}" "$B/stories?project_id=eq.$2&key=eq.$1&select=id" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["id"] if d else "")')"
  [ -n "$sid" ] || return 0
  local pr="$4"; [ "$pr" = "null" ] && pr=null || pr="\"$pr\""
  curl -s "${H[@]}" -X POST "$B/rpc/project_external_status" \
    -d "{\"p_story_id\":\"$sid\",\"p_status\":\"$3\",\"p_pr_url\":$pr,\"p_agent_lost\":null}" >/dev/null || true
}

log "poller fluxo-agent-runner arriba (interval=${INTERVAL}s)"
while true; do
  JOB="$(curl -s "${H[@]}" "$B/build_jobs?status=eq.pending&order=created_at.asc&limit=1")"
  ID="$(echo "$JOB" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["id"] if d else "")' 2>/dev/null || true)"
  if [ -z "$ID" ]; then sleep "$INTERVAL"; continue; fi

  # claim (pending -> running); si otro lo tomó, seguimos
  CLAIM="$(curl -s "${H[@]}" -H "Prefer: return=representation" -X PATCH "$B/build_jobs?id=eq.$ID&status=eq.pending" -d '{"status":"running","updated_at":"now()"}')"
  [ "$(echo "$CLAIM" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)" = "1" ] || { sleep 2; continue; }

  PROJECT="$(echo "$JOB" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["project_id"])')"
  LABEL="$(echo "$JOB" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["label"])')"
  ISSUES="$(echo "$JOB" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0].get("issues") or "")')"
  MODEL="$(echo "$JOB" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0].get("model") or "claude-opus-4-8")')"
  mapfile -t KEYS < <(echo "$JOB" | python3 -c 'import json,sys;[print(k) for k in json.load(sys.stdin)[0].get("story_keys") or []]')
  echo "$JOB" | python3 -c 'import json,sys;open("/tmp/build-'"$ID"'.txt","w").write(json.load(sys.stdin)[0]["prompt"])'
  log "job $ID → build $LABEL (issues=$ISSUES, stories=${KEYS[*]:-none})"

  set +e
  OUT="$("$RUNNER" "$PROJECT" "/tmp/build-$ID.txt" "$LABEL" "$ISSUES" "$MODEL" 2>&1)"
  RC=$?
  set -e
  PR="$(printf '%s' "$OUT" | sed -nE 's/.*PR=([0-9]+).*/\1/p' | tail -1)"
  if [ "$RC" = "0" ] && [ -n "$PR" ]; then
    PRURL="https://github.com/$(curl -s "${H[@]}" "$B/projects?id=eq.$PROJECT&select=repo" | python3 -c 'import json,sys,re;u=json.load(sys.stdin)[0]["repo"];print(re.sub(r".*github.com/([^/]+/[^/.]+).*",r"\1",u))')/pull/$PR"
    curl -s "${H[@]}" -X PATCH "$B/build_jobs?id=eq.$ID" -d "{\"status\":\"done\",\"pr_url\":\"$PRURL\",\"updated_at\":\"now()\"}" >/dev/null
    for k in "${KEYS[@]}"; do set_story "$k" "$PROJECT" review "$PRURL"; done
    log "✓ job $ID done → PR $PRURL"
  else
    ERR="$(printf '%s' "$OUT" | tail -3 | tr '\n' ' ' | sed 's/"/'"'"'/g')"
    curl -s "${H[@]}" -X PATCH "$B/build_jobs?id=eq.$ID" -d "{\"status\":\"failed\",\"error\":\"rc=$RC $ERR\",\"updated_at\":\"now()\"}" >/dev/null
    for k in "${KEYS[@]}"; do set_story "$k" "$PROJECT" backlog null; done
    log "✗ job $ID FALLÓ (rc=$RC): $ERR"
  fi
done
