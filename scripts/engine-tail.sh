#!/usr/bin/env bash
# engine-tail.sh — observabilidad del ExecEnv fluxo_engine (docs/17). Independiente del poller: para
# cada build_job 'running', parsea su stream-json (/opt/fluxo/runs/<label>.stream.json) a un resumen
# legible + un progress json y los escribe en build_jobs.log/progress. El console los muestra por
# Realtime → el usuario VE lo que el agente hace, sin depender de nadie. systemd: fluxo-engine-tail.
set -euo pipefail
ENVF="${ENVF:-/opt/fluxo/deploy/.env.prod}"
RUNS="${RUNS:-/opt/fluxo/runs}"
INTERVAL="${INTERVAL:-8}"
SUPA_URL="$(grep -E '^SUPABASE_URL=' "$ENVF" | cut -d= -f2- | tr -d '"')"
SVC="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"')"
B="$SUPA_URL/rest/v1"
H=(-H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json")
GITTOKF="${GITTOKF:-/opt/fluxo/.git-token}"  # tenant PAT — para consultar el estado del PR (merge→done)
GIT_TOK="$( [ -f "$GITTOKF" ] && tr -d '\n' < "$GITTOKF" || true )"

parse_stream() { # $1 = stream file → imprime JSON {log, progress} para el PATCH
  python3 - "$1" <<'PY'
import json,sys
try: lines=open(sys.argv[1]).read().splitlines()
except: print(json.dumps({"log":"(esperando el stream…)","progress":{}})); sys.exit()
events=[]; bash=0; edits=0; reads=0; last_text=""; turns=0; cost=0.0; started=False
for ln in lines:
    try: o=json.loads(ln)
    except: continue
    t=o.get("type")
    if t=="system" and o.get("subtype")=="init": started=True; events.append("▶ sesión iniciada")
    elif t=="assistant":
        for c in o.get("message",{}).get("content",[]):
            k=c.get("type")
            if k=="text" and c.get("text","").strip():
                last_text=c["text"].strip(); events.append("💬 "+last_text.replace("\n"," ")[:120])
            elif k=="tool_use":
                n=c.get("name",""); inp=c.get("input",{})
                if n=="Bash": bash+=1; events.append("$ "+inp.get("command","").replace("\n"," ")[:110])
                elif n in ("Edit","Write"): edits+=1; events.append(("✎ " if n=="Edit" else "＋ ")+str(inp.get("file_path","")).split("/work/")[-1])
                elif n=="Read": reads+=1
                else: events.append("· "+n)
    elif t=="result":
        turns=o.get("num_turns",turns); cost=o.get("total_cost_usd",cost)
log="\n".join(events[-600:])  # historial completo (acotado a 600 eventos para no explotar la fila)
prog={"turns":turns,"bash":bash,"edits":edits,"reads":reads,"cost":round(cost,4),"last":last_text[:200]}
print(json.dumps({"log":log,"progress":prog}))
PY
}

# revert_story: story key → backlog (bypass state-machine, como el poller). $1=key $2=project
revert_story() {
  local sid; sid="$(curl -s "${H[@]}" "$B/stories?project_id=eq.$2&key=eq.$1&select=id" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["id"] if d else "")')"
  [ -n "$sid" ] && curl -s "${H[@]}" -X POST "$B/rpc/project_external_status" -d "{\"p_story_id\":\"$sid\",\"p_status\":\"backlog\",\"p_pr_url\":null,\"p_agent_lost\":true}" >/dev/null || true
}

# reconcile_merged: cierra el hueco merge→done del ExecEnv fluxo_engine. El path de Actions lo hacía la
# proyección del worker; el engine NO pasa por ahí, así que una story quedaba pegada en 'review' aunque su
# PR ya estuviera mergeado (el usuario mergea y "no ve que ya mergeé"). Acá, para cada story en 'review' con
# PR de un build del engine (status done), consultamos el PR real en GitHub:
#   merged → story done · closed sin merge → story backlog (re-despachable) · open → se deja en review.
reconcile_merged() {
  [ -z "$GIT_TOK" ] && return 0
  local STORIES ENGKEYS
  STORIES="$(curl -s "${H[@]}" "$B/stories?status=eq.review&pr_url=not.is.null&select=id,key,pr_url")"
  ENGKEYS="$(curl -s "${H[@]}" "$B/build_jobs?status=eq.done&pr_url=not.is.null&select=story_keys")"
  GIT_TOK="$GIT_TOK" python3 - "$STORIES" "$ENGKEYS" <<'PY' | while IFS=$'\t' read -r SID NEW; do
import json,sys,os,re,urllib.request
tok=os.environ.get("GIT_TOK","")
try: stories=json.loads(sys.argv[1])
except: stories=[]
try: eng=json.loads(sys.argv[2])
except: eng=[]
keys=set(k for row in eng for k in (row.get("story_keys") or []))  # solo stories con build del engine
for s in stories:
    if s.get("key") not in keys: continue                          # no tocar el path de Actions
    m=re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", s.get("pr_url") or "")
    if not m: continue
    api="https://api.github.com/repos/%s/%s/pulls/%s"%(m.group(1),m.group(2),m.group(3))
    req=urllib.request.Request(api, headers={"Authorization":"Bearer "+tok,"Accept":"application/vnd.github+json","User-Agent":"fluxo-engine-tail"})
    try: pr=json.load(urllib.request.urlopen(req, timeout=15))
    except Exception: continue                                     # error de red → reintenta el próximo ciclo
    if pr.get("merged"): print(s["id"]+"\tdone")
    elif pr.get("state")=="closed": print(s["id"]+"\tbacklog")     # cerrado sin merge
PY
    [ -z "$SID" ] && continue
    if [ "$NEW" = "done" ]; then
      curl -s "${H[@]}" -X POST "$B/rpc/project_external_status" -d "{\"p_story_id\":\"$SID\",\"p_status\":\"done\",\"p_pr_url\":null,\"p_agent_lost\":false}" >/dev/null || true
      echo "[engine-tail] ✅ PR mergeado → story $SID a done"
    else
      curl -s "${H[@]}" -X POST "$B/rpc/project_external_status" -d "{\"p_story_id\":\"$SID\",\"p_status\":\"backlog\",\"p_pr_url\":null,\"p_agent_lost\":false}" >/dev/null || true
      echo "[engine-tail] ↩ PR cerrado sin merge → story $SID a backlog"
    fi
  done
}

echo "[engine-tail] arriba (interval=${INTERVAL}s)"
while true; do
  JOBS="$(curl -s "${H[@]}" "$B/build_jobs?status=in.(running,cancelling)&select=id,label,project_id,story_keys,status")"
  echo "$JOBS" | python3 -c 'import json,sys;[print(j["id"]+"\t"+j["label"]+"\t"+j["project_id"]+"\t"+",".join(j.get("story_keys") or [])+"\t"+j.get("status","")) for j in json.load(sys.stdin)]' 2>/dev/null | while IFS=$'\t' read -r ID LABEL PROJ KEYS ST; do
    [ -z "$ID" ] && continue
    # ── DETENER: el console marcó 'cancelling' → matamos el proceso + container del agente, failed + revert.
    if [ "$ST" = "cancelling" ]; then
      pkill -9 -f "agent-runner.sh.*$LABEL" 2>/dev/null || true
      docker kill $(docker ps -q --filter ancestor=fluxo-agent:local) 2>/dev/null || true
      curl -s "${H[@]}" -X PATCH "$B/build_jobs?id=eq.$ID" -d '{"status":"failed","error":"detenido por el usuario","updated_at":"now()"}' >/dev/null || true
      for k in ${KEYS//,/ }; do revert_story "$k" "$PROJ"; done
      echo "[engine-tail] ⏹ build $LABEL detenido por el usuario → failed + stories a backlog"
      continue
    fi
    S="$(ls -t "$RUNS/${LABEL}"*.stream.json 2>/dev/null | head -1)"
    [ -z "$S" ] && S="$RUNS/${LABEL}.stream.json"
    PATCH="$(parse_stream "$S")"
    curl -s "${H[@]}" -X PATCH "$B/build_jobs?id=eq.$ID" -d "$PATCH" >/dev/null || true
    # ── WATCHDOG de huérfanos: sin proceso del build Y stream viejo (>180s) → murió sin que el poller
    # lo reconcilie (kill, reboot, poller caído). Lo marcamos failed + revertimos las stories a backlog.
    if ! pgrep -f "agent-runner.sh.*$LABEL" >/dev/null 2>&1; then
      AGE=$(( $(date +%s) - $(stat -c %Y "$S" 2>/dev/null || echo 0) ))
      # 600s: el poller reconcilia en segundos al terminar el runner; el watchdog es solo backstop
      # para builds VERDADERAMENTE huérfanos (poller caído/reboot). No debe correrle la carrera al poller.
      if [ "$AGE" -gt 600 ]; then
        curl -s "${H[@]}" -X PATCH "$B/build_jobs?id=eq.$ID" -d '{"status":"failed","error":"el proceso del build murió sin reconciliar (engine-tail watchdog)","updated_at":"now()"}' >/dev/null || true
        for k in ${KEYS//,/ }; do revert_story "$k" "$PROJ"; done
        echo "[engine-tail] ⚠ build $LABEL huérfano (sin proceso, stream ${AGE}s viejo) → failed + stories a backlog"
      fi
    fi
  done
  reconcile_merged   # merge→done / closed→backlog para stories del engine en review (path sin worker)
  sleep "$INTERVAL"
done
