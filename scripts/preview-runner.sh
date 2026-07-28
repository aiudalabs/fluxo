#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# Fluxo preview-runner (release v2 · docs/14) — el "Docker especial" para previews efímeros navegables.
#
# Corre HOST-level en el VPS (systemd), NO en el worker: el worker es non-root sin docker socket (modelo
# de seguridad). Este runner tiene docker + cloudflared y poll-ea la cola `preview_requests` en Supabase.
#
# Por cada pedido `pending`:  clona/actualiza el repo @ref → renderiza la receta del stack
# (registry/templates/github-native/<stack>/.fluxo/preview) → docker compose up (red aislada, DB efímera,
# emulación Supabase + edge same-origin) → espera healthy → seed opcional → estampa preview_url
# (https://preview-<pid>.<sslip-host>) + status=live + expires_at.  Reaper: baja los `live` vencidos.
#
# EXPOSE: el edge del preview se une a la red `fluxo-preview-ingress` (compartida con el Caddy de prod);
# Caddy lo alcanza por nombre y le da TLS + el subdominio sslip.io (DNS wildcard automático a la IP del
# VPS, cero setup del cliente; NO trycloudflare, que muchas redes bloquean). pid = por-PROYECTO → el
# subdominio/cert es estable entre regeneraciones (no churnea certs de Let's Encrypt).
#
# Env requerido:  SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY
# Env opcional:   REGISTRY_DIR(=/opt/fluxo/registry)  PREVIEW_DIR(=/opt/fluxo/previews)
#                 GITHUB_TOKEN(clona repos privados)  PREVIEW_TTL_HOURS(=6)  INTERVAL(=15)
#                 PORT_BASE(=8900)  DEFAULT_STACK(=react-supabase)
#                 PREVIEW_BASE_HOST(=2.25.78.202.sslip.io)  INGRESS_NET(=fluxo-preview-ingress)
#                 CADDY_CONTAINER(=deploy-caddy-1)
# ─────────────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail
export GIT_TERMINAL_PROMPT=0   # nunca prompteés user/pass → un repo privado sin token FALLA rápido, no cuelga

REGISTRY_DIR="${REGISTRY_DIR:-/opt/fluxo/registry}"
PREVIEW_DIR="${PREVIEW_DIR:-/opt/fluxo/previews}"
PREVIEW_TTL_HOURS="${PREVIEW_TTL_HOURS:-6}"
INTERVAL="${INTERVAL:-15}"
PORT_BASE="${PORT_BASE:-8900}"
DEFAULT_STACK="${DEFAULT_STACK:-react-supabase}"
PREVIEW_BASE_HOST="${PREVIEW_BASE_HOST:-2.25.78.202.sslip.io}"   # sslip.io → IP del VPS, DNS wildcard auto
INGRESS_NET="${INGRESS_NET:-fluxo-preview-ingress}"              # red compartida edge↔Caddy de prod
CADDY_CONTAINER="${CADDY_CONTAINER:-deploy-caddy-1}"
# GitHub App: para clonar repos PRIVADOS del cliente sin token estático (misma credencial headless que
# el worker). El pem en el HOST (el .env.prod trae GITHUB_APP_PRIVATE_KEY_PATH = path DENTRO del container).
GITHUB_APP_PEM="${GITHUB_APP_PEM:-/opt/fluxo/deploy/app.pem}"

: "${SUPABASE_URL:?falta SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?falta SUPABASE_SERVICE_ROLE_KEY}"
REST="${SUPABASE_URL%/}/rest/v1"
mkdir -p "$PREVIEW_DIR"

log() { echo "[preview-runner $(date -u +%H:%M:%S)] $*"; }

# ── Supabase REST (service_role → bypassa RLS) ──────────────────────────────────────────────────
rest_get() { # $1 = path+query
  curl -sS -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$REST/$1"
}
rest_patch() { # $1 = path+query   $2 = json body
  curl -sS -X PATCH -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    "$REST/$1" -d "$2" >/dev/null
}
# json escape (para error strings)
jesc() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""'; }

set_status() { # $1=id  $2=status  $3=json-extra("" o ,"k":v)
  rest_patch "preview_requests?id=eq.$1" "{\"status\":\"$2\",\"updated_at\":\"$(date -u +%FT%TZ)\"${3:-}}"
}
# ids de un array JSON [{id,...}] por stdin, uno por línea
json_ids() { python3 -c 'import json,sys
try:
  [print(r["id"]) for r in json.load(sys.stdin) if r.get("id")]
except Exception: pass'; }
pid_of() { echo "p$(echo "$1" | tr -d '-' | cut -c1-10)"; }  # pid corto y estable de un uuid

# ── GitHub App: installation token para clonar el repo privado del cliente (replica design/src/github.ts) ─
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }   # base64url de stdin
gh_api() { curl -s -H "Authorization: Bearer $1" -H "Accept: application/vnd.github+json" -H "User-Agent: fluxo" "${@:2}"; }
github_token() { # $1 = owner  → imprime un installation token (vacío si no hay app / falla → repo público)
  local owner="$1" now head payload jwt insts inst_id
  [ -n "${GITHUB_APP_ID:-}" ] && [ -r "$GITHUB_APP_PEM" ] || return 0
  now=$(date +%s)
  head=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now-60)) $((now+540)) "$GITHUB_APP_ID" | b64url)
  jwt="$head.$payload.$(printf '%s' "$head.$payload" | openssl dgst -sha256 -sign "$GITHUB_APP_PEM" -binary | b64url)"
  insts=$(gh_api "$jwt" "https://api.github.com/app/installations")
  inst_id=$(printf '%s' "$insts" | python3 -c 'import json,sys
o=sys.argv[1].lower()
try:
  d=json.load(sys.stdin)
  if not isinstance(d,list) or not d: print(""); sys.exit()
  m=[i for i in d if (i.get("account") or {}).get("login","").lower()==o]
  print((m[0] if m else d[0]).get("id",""))
except Exception: print("")' "$owner")
  [ -n "$inst_id" ] || return 0
  gh_api "$jwt" -X POST "https://api.github.com/app/installations/$inst_id/access_tokens" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("token","") or "")
except Exception: print("")'
}

# ── un free port a partir de PORT_BASE ──────────────────────────────────────────────────────────
free_port() {
  local p="$PORT_BASE"
  while ss -ltn 2>/dev/null | grep -q ":$p " || [ -f "$PREVIEW_DIR/.port-$p" ]; do p=$((p+1)); done
  echo "$p"
}

# ── red de ingress: la crea (idempotente) y conecta el Caddy de prod para que alcance los edges ──
ensure_ingress() {
  docker network inspect "$INGRESS_NET" >/dev/null 2>&1 || docker network create "$INGRESS_NET" >/dev/null 2>&1
  if docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1; then
    docker inspect "$CADDY_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw "$INGRESS_NET" \
      || docker network connect "$INGRESS_NET" "$CADDY_CONTAINER" >/dev/null 2>&1
  fi
}

# ── teardown de un preview (compose down) ───────────────────────────────────────────────────────
teardown() { # $1 = preview_id
  local pid="$1"
  local wd="$PREVIEW_DIR/$pid"
  [ -f "$wd/compose.yml" ] && docker compose -f "$wd/compose.yml" down -v >/dev/null 2>&1
  # BYO (docs/15): el stack corre bajo el proyecto `fluxo-preview-<pid>` (app compose + edge override).
  # `down` por nombre de proyecto usa labels → baja todo aunque no tengamos los -f a mano.
  docker compose -p "fluxo-preview-$pid" down -v >/dev/null 2>&1
  [ -f "$wd/.port" ] && rm -f "$PREVIEW_DIR/.port-$(cat "$wd/.port" 2>/dev/null)" 2>/dev/null
  rm -rf "$wd" 2>/dev/null
}

# ── BYO (bring-your-own-compose) — el camino GENERAL (docs/15) ────────────────────────────────────
# Si el repo trae su propio docker-compose.yml, la app SE AUTO-DESCRIBE: la corremos tal cual en vez de
# una receta por-stack de Fluxo. Así previsualiza CUALQUIER app bien scaffoldeada (no solo react-supabase),
# usando la MISMA fuente de verdad con la que se buildea. LIMITACIÓN de esta versión (a mover a un cluster
# aparte — docs/15): corre en el VPS de prod y NO sanitiza el compose (asume scaffold limpio: sin
# privileged/host-net/socket, con límites). El hardening (guard de compose + cluster efímero dedicado)
# es el pending documentado en docs/15.

# gen_env: escribe un .env efímero llenando CADA var del .env.example del repo. Objetivo: que la app
# BOOTEE (los ${VAR:?required} no vacíos) y su /api/health de 200. Secrets → random; la URL pública →
# la del preview; modes/emails → demo. No es para login real — es un preview NAVEGABLE, descartable.
gen_env() { # $1=repodir  $2=port  $3=url
  python3 - "$1/.env.example" "$2" "$3" <<'PY'
import sys, os, secrets, re
path, port, url = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines() if os.path.exists(path) else []
out = []
for ln in lines:
    m = re.match(r'^([A-Z][A-Z0-9_]*)=(.*)$', ln)
    if not m:
        continue
    k, default = m.group(1), m.group(2)
    if k == 'WEB_PORT' or k.endswith('_PORT'):        v = port if k == 'WEB_PORT' else (default or '')
    elif k in ('NEXTAUTH_URL',) or k.endswith(('PUBLIC_URL',)) or k in ('APP_URL', 'BASE_URL'): v = url
    elif k.endswith('_MODE'):                          v = default or 'mock'
    elif k.endswith('_EMAIL'):                         v = 'demo@preview.fluxo.dev'
    elif 'SMTP' in k and k.endswith('URL'):            v = 'smtp://localhost:1025'
    elif k.endswith(('_PASSWORD', '_SECRET', '_HASH', '_KEY', '_TOKEN')): v = secrets.token_hex(24)
    else:                                              v = default   # DATABASE_URL/REDIS_URL: internos → default
    out.append('%s=%s' % (k, v))
print('\n'.join(out))
PY
}

# byo_preview: corre el compose PROPIO del repo + un edge Caddy (same-origin) en la red de ingress.
byo_preview() { # $1=id  $2=pid  $3=wd  $4=repodir
  local id="$1" pid="$2" wd="$3" repodir="$4"
  local port; port=$(free_port); echo "$port" > "$wd/.port"; touch "$PREVIEW_DIR/.port-$port"
  local url="https://preview-$pid.$PREVIEW_BASE_HOST"
  log "BYO $id → compose propio del repo (puerto $port)"

  # 1) .env efímero (llena los ${VAR:?required} del compose para que bootee).
  if ! gen_env "$repodir" "$port" "$url" > "$repodir/.env" 2>"$wd/env.log"; then
    set_status "$id" failed ",\"error\":$(jesc "no se pudo generar el .env del preview: $(tail -1 "$wd/env.log")")"; teardown "$pid"; return
  fi

  # 2) edge Caddy same-origin (app en /, y /api la sirve el mismo Next). Proxya a web:3000 por la red
  #    de la app; se une a la red de ingress → el Caddy de prod lo alcanza POR NOMBRE (no por puerto de
  #    host) y le da TLS+sslip. SIN `ports:`: la app ya publica web en WEB_PORT=$port (health check +
  #    acceso directo); el edge solo necesita la red de ingress. Publicar el edge en $port chocaría con web.
  printf ':80 {\n\treverse_proxy web:3000\n}\n' > "$wd/edge.Caddyfile"
  cat > "$wd/edge-override.yml" <<EOF
services:
  edge:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [web]
    volumes:
      - "$wd/edge.Caddyfile:/etc/caddy/Caddyfile:ro"
    networks: [default, fpingress]
networks:
  fpingress:
    external: true
    name: $INGRESS_NET
EOF

  # 3) levantar (proyecto fluxo-preview-<pid> → el edge queda como fluxo-preview-<pid>-edge-1, el
  #    nombre que el Caddy de prod rutea). --build: la app trae Dockerfile(s) propios.
  ensure_ingress
  local proj="fluxo-preview-$pid"
  if ! docker compose -p "$proj" -f "$repodir/docker-compose.yml" -f "$wd/edge-override.yml" --env-file "$repodir/.env" up -d --build >"$wd/up.log" 2>&1; then
    set_status "$id" failed ",\"error\":$(jesc "docker compose up (BYO) falló: $(tail -3 "$wd/up.log" | tr '\n' ' ')")"; teardown "$pid"; return
  fi

  # 4) esperar /api/health=200 vía el edge. Hasta ~12 min (build de la imagen + migrate + boot).
  local ok=""
  for _ in $(seq 1 90); do
    sleep 8
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health" 2>/dev/null || echo 000)" = "200" ] && { ok=1; break; }
  done
  if [ -z "$ok" ]; then
    set_status "$id" failed ",\"error\":$(jesc "la app (BYO) no respondió /api/health a tiempo — up.log: $(tail -2 "$wd/up.log" | tr '\n' ' ')")"; teardown "$pid"; return
  fi

  # 5) seed opcional del repo + LIVE
  [ -f "$repodir/.fluxo/preview/seed.sh" ] && ( cd "$repodir" && API_BASE="$url/api" PREVIEW_ID="$pid" bash .fluxo/preview/seed.sh ) >"$wd/seed.log" 2>&1 || true
  local exp; exp=$(date -u -d "+${PREVIEW_TTL_HOURS} hours" +%FT%TZ 2>/dev/null || date -u -v+${PREVIEW_TTL_HOURS}H +%FT%TZ)
  set_status "$id" live ",\"preview_url\":$(jesc "$url"),\"expires_at\":\"$exp\""
  log "LIVE $id (BYO) → $url (expira $exp)"
}

# ── procesar UN pedido ──────────────────────────────────────────────────────────────────────────
process_one() { # $1=id  $2=project_id  $3=ref
  local id="$1" project_id="$2" ref="$3"
  local pid wd
  pid="$(pid_of "$project_id")"   # por-PROYECTO: subdominio/cert estable entre regeneraciones
  wd="$PREVIEW_DIR/$pid"
  log "build $id (project $project_id, ref ${ref:-default}) → $pid"
  set_status "$id" building ""

  # 1) datos del proyecto (repo + stack)
  local prow repo stack
  prow=$(rest_get "projects?id=eq.$project_id&select=repo,settings")
  repo=$(printf '%s' "$prow" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0].get("repo","") if d else "")' 2>/dev/null)
  stack=$(printf '%s' "$prow" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=(d[0].get("settings") or {}) if d else {}; print(s.get("stack") or "")' 2>/dev/null)
  [ -z "$stack" ] && stack="$DEFAULT_STACK"
  if [ -z "$repo" ]; then
    set_status "$id" failed ",\"error\":$(jesc "el proyecto no tiene repo")"; return
  fi
  # `stack` viene de projects.settings (tenant-controlled) y arma un path → sanitizá (anti traversal).
  if ! printf '%s' "$stack" | grep -qE '^[a-z0-9-]+$'; then
    set_status "$id" failed ",\"error\":$(jesc "stack inválido: $stack")"; return
  fi

  # (La resolución de receta se DIFIERE hasta después del clone: si el repo trae su propio
  # docker-compose.yml va por BYO y no necesita receta — docs/15.)

  # Regenerar REEMPLAZA, no acumula: el pid es por-proyecto, así que el `teardown "$pid"` de abajo baja
  # el stack anterior del proyecto. Acá solo marco expiradas las filas activas previas de este proyecto
  # (otra request), para que la UI no muestre dos "live".
  rest_get "preview_requests?project_id=eq.$project_id&status=in.(live,building)&id=neq.$id&select=id" | json_ids | while read -r oid; do
    [ -n "$oid" ] && set_status "$oid" expired ""
  done

  teardown "$pid"   # limpia el stack previo del proyecto (mismo pid) y su workdir
  mkdir -p "$wd"

  # 2) clonar el repo. Token: GITHUB_TOKEN si está, si no un installation token de la GitHub App (repos
  #    privados del cliente, sin credencial estática). Sin token → clona anónimo (solo repos públicos).
  local clone_url="$repo" gh_tok owner
  case "$repo" in
    https://github.com/*)
      owner="${repo#https://github.com/}"; owner="${owner%%/*}"
      gh_tok="${GITHUB_TOKEN:-}"; [ -z "$gh_tok" ] && gh_tok="$(github_token "$owner")"
      [ -n "$gh_tok" ] && clone_url="https://x-access-token:${gh_tok}@github.com/${repo#https://github.com/}"
    ;;
  esac
  local repodir="$wd/repo"
  if ! git clone --depth 1 ${ref:+--branch "$ref"} "$clone_url" "$repodir" >"$wd/clone.log" 2>&1; then
    # ref puede no ser una rama (o repo privado): reintenta sin --branch
    if ! git clone --depth 1 "$clone_url" "$repodir" >>"$wd/clone.log" 2>&1; then
      # redactá el token si git lo eco en la URL del error (no filtrarlo a la DB)
      local cerr; cerr=$(tail -2 "$wd/clone.log" | sed 's#x-access-token:[^@]*@#x-access-token:***@#g' | tr '\n' ' ')
      set_status "$id" failed ",\"error\":$(jesc "git clone falló: $cerr")"; teardown "$pid"; return
    fi
  fi

  # BYO (docs/15): si el repo trae su propio docker-compose.yml, corré ESO (la app se auto-describe) en
  # vez de una receta por-stack. Es el camino GENERAL para cualquier app; la receta queda de fallback
  # para repos sin compose (p.ej. react-supabase, que no trae Dockerfile).
  if [ -f "$repodir/docker-compose.yml" ]; then
    byo_preview "$id" "$pid" "$wd" "$repodir"; return
  fi

  # RECIPE path (fallback): el repo NO trae compose → usa la receta del stack.
  local recipe="$REGISTRY_DIR/templates/github-native/$stack/.fluxo/preview"
  if [ ! -f "$recipe/compose.yml.tmpl" ]; then
    set_status "$id" failed ",\"error\":$(jesc "el repo no trae docker-compose.yml y no hay receta de preview para el stack $stack")"; teardown "$pid"; return
  fi

  # 3) emulación: la del repo (app-specific) si existe, si no la genérica del recipe
  local emulation="$recipe/supabase-emulation.sql"
  [ -f "$repodir/backend/test/setup/supabase-emulation.sql" ] && emulation="$repodir/backend/test/setup/supabase-emulation.sql"

  # 4) renderizar compose + copiar edge Caddyfile
  local port; port=$(free_port); echo "$port" > "$wd/.port"; touch "$PREVIEW_DIR/.port-$port"
  local jwt; jwt="preview-$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  local public_api_url="https://preview-$pid.$PREVIEW_BASE_HOST/api"   # absoluta → sirve SSR y browser
  cp "$recipe/edge.Caddyfile" "$wd/edge.Caddyfile"
  sed -e "s#{{preview_id}}#$pid#g" \
      -e "s#{{repo_path}}#$repodir#g" \
      -e "s#{{preview_port}}#$port#g" \
      -e "s#{{extensions_sql}}#$recipe/00-extensions.sql#g" \
      -e "s#{{emulation_sql}}#$emulation#g" \
      -e "s#{{edge_caddyfile}}#$wd/edge.Caddyfile#g" \
      -e "s#{{public_api_url}}#$public_api_url#g" \
      -e "s#{{jwt_secret}}#$jwt#g" \
      "$recipe/compose.yml.tmpl" > "$wd/compose.yml"

  # 5) levantar (la red de ingress tiene que existir para el edge)
  ensure_ingress
  if ! docker compose -f "$wd/compose.yml" up -d >"$wd/up.log" 2>&1; then
    set_status "$id" failed ",\"error\":$(jesc "docker compose up falló: $(tail -2 "$wd/up.log" | tr '\n' ' ')")"; teardown "$pid"; return
  fi

  # 6) esperar el edge (front + api arriba). Hasta 5 min (npm ci + migrate + next dev).
  local ok=""
  for _ in $(seq 1 40); do
    sleep 8
    local fe api
    # front: cualquier 2xx/3xx = la app respondió (puede redirigir / → /login con 302/303/307/308).
    fe=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port" 2>/dev/null || echo 000)
    # api: cualquier respuesta HTTP concreta = el backend está arriba (404 = sin ruta /health, pero vivo);
    #      000/502/503/504 = el edge todavía no alcanza al backend.
    api=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/api/health" 2>/dev/null || echo 000)
    case "$fe" in 2??|3??)
      case "$api" in 000|502|503|504) ;; *) ok=1; break;; esac
    ;; esac
  done
  if [ -z "$ok" ]; then
    set_status "$id" failed ",\"error\":$(jesc "la app no respondió a tiempo (front/api). Ver logs del contenedor.")"; teardown "$pid"; return
  fi

  # 7) seed opcional (si el repo lo trae)
  if [ -f "$repodir/.fluxo/preview/seed.sh" ]; then
    ( cd "$repodir" && API_BASE="http://127.0.0.1:$port/api" PREVIEW_ID="$pid" bash .fluxo/preview/seed.sh ) >"$wd/seed.log" 2>&1 || log "seed falló (no bloquea): $id"
  fi

  # 8) expose: el edge ya está en la red de ingress (por el compose) → el Caddy de prod lo alcanza por
  #    nombre y le da TLS + el subdominio sslip.io. La URL es determinística por-proyecto (cert estable).
  local url="https://preview-$pid.$PREVIEW_BASE_HOST"
  local exp; exp=$(date -u -d "+${PREVIEW_TTL_HOURS} hours" +%FT%TZ 2>/dev/null || date -u -v+${PREVIEW_TTL_HOURS}H +%FT%TZ)
  set_status "$id" live ",\"preview_url\":$(jesc "$url"),\"expires_at\":\"$exp\""
  log "LIVE $id → $url (expira $exp)"
}

# id\tproject_id por fila (para derivar el pid por-proyecto en teardown)
json_id_proj() { python3 -c 'import json,sys
try:
  [print("%s\t%s"%(r["id"],r.get("project_id",""))) for r in json.load(sys.stdin) if r.get("id")]
except Exception: pass'; }

# ── reaper: baja los `live` vencidos ────────────────────────────────────────────────────────────
reap() {
  local now
  now=$(date -u +%FT%TZ)
  rest_get "preview_requests?status=eq.live&expires_at=lt.$now&select=id,project_id" | json_id_proj | while IFS=$'\t' read -r rid rproj; do
    [ -z "$rid" ] && continue
    log "reap $rid (vencido)"
    [ -n "$rproj" ] && teardown "$(pid_of "$rproj")"
    set_status "$rid" expired ""
  done
}

# ── sweep de arranque: los `building` que quedaron de una corrida anterior (deploy/restart) no se
#    re-toman (el loop toma solo `pending`) ni se reapean (el reaper toma solo `live`) → quedarían
#    zombies con spinner eterno. Bajalos y marcalos failed; el usuario regenera. ─────────────────
sweep_building() {
  rest_get "preview_requests?status=eq.building&select=id,project_id" | json_id_proj | while IFS=$'\t' read -r bid bproj; do
    [ -z "$bid" ] && continue
    log "sweep building huérfano $bid (runner reiniciado)"
    [ -n "$bproj" ] && teardown "$(pid_of "$bproj")"
    set_status "$bid" failed ",\"error\":$(jesc "el runner se reinició durante el build — regenerá el preview")"
  done
}

log "arrancado. registry=$REGISTRY_DIR previews=$PREVIEW_DIR ttl=${PREVIEW_TTL_HOURS}h host=$PREVIEW_BASE_HOST interval=${INTERVAL}s"
ensure_ingress || true
sweep_building || true
while true; do
  ensure_ingress || true   # self-heal: si el Caddy se recreó (deploy), reconectalo a la red de ingress
  reap || true
  # tomar pendientes (uno por vuelta para no saturar el VPS chico)
  pend=$(rest_get "preview_requests?status=eq.pending&select=id,project_id,ref&order=created_at.asc&limit=1")
  echo "$pend" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  if d: print("\t".join([d[0]["id"], d[0]["project_id"], d[0].get("ref") or ""]))
except Exception: pass' 2>/dev/null | while IFS=$'\t' read -r id project_id ref; do
    [ -n "$id" ] && process_one "$id" "$project_id" "$ref"
  done
  sleep "$INTERVAL"
done
