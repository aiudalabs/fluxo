#!/usr/bin/env bash
# provision-runtime-config.sh — G1 (docs: provisioning de credenciales de RUNTIME).
#
# La capacidad que hace que una app Firebase salga CORRIENDO, no a medias: deriva el config de runtime
# REAL del proyecto Firebase conectado (el mismo que ya provisiona el FIREBASE_SERVICE_ACCOUNT) y lo
# materializa como ARCHIVO en el árbol de la app, ANTES de `flutter build`. Patrón FlutterFlow: si el app
# no está registrado en el proyecto para su package, lo REGISTRA (apps:create) y después baja el config.
#
# NO commitea nada: se corre en cada build/preview (engine, CI, App en vivo) y el archivo queda como
# artefacto de build (gitignoreado). Un proyecto SIN Firebase conectado → no escribe nada y sale 3
# (GAP DECLARADO, no un placeholder que pinta verde).
#
# Uso:  provision-runtime-config.sh <PROJECT_ID> <PACKAGE> <APP_DIR> [DISPLAY_NAME] [PLATFORMS]
#   PROJECT_ID   id del proyecto Firebase (ej. reservas-belleza) — sale del SA (field project_id)
#   PACKAGE      applicationId de la app (ej. com.aiuda.yomap)
#   APP_DIR      raíz de la app Flutter (donde vive android/, web/)
#   DISPLAY_NAME nombre para registrar el app si falta (default = PACKAGE)
#   PLATFORMS    csv de android,web (default android). ios pendiente.
#
# Auth: usa GOOGLE_APPLICATION_CREDENTIALS (el SA) si está seteado; si no, el login ambiente del firebase CLI.
set -euo pipefail

PROJECT="${1:?PROJECT_ID}"; PACKAGE="${2:?PACKAGE}"; APP_DIR="${3:?APP_DIR}"
DISPLAY="${4:-$PACKAGE}"; PLATFORMS="${5:-android}"

log(){ echo "[provision-runtime] $*" >&2; }
fb(){ firebase --project "$PROJECT" "$@"; }

command -v firebase >/dev/null 2>&1 || { log "firebase CLI ausente — no puedo derivar el config"; exit 2; }

# appIdForPackage: busca en el proyecto el app de la plataforma cuyo package/namespace == PACKAGE.
# Devuelve el appId o "" si no existe. (apps:list --json da appId + displayName; el package sale del
# sdkconfig, así que registramos por package y confiamos en la unicidad que Firebase impone por package.)
appIdForPackage(){ # $1=platform(ANDROID|WEB)
  local plat="$1"
  fb apps:list "$plat" --json 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except: sys.exit(0)
apps=(d.get("result") or []) if isinstance(d,dict) else d
pkg=sys.argv[1]
for a in apps:
  # Android: packageName; Web: no tiene package → lo matcheamos por displayName exacto.
  if a.get("platform")==sys.argv[2] and (a.get("packageName")==pkg or a.get("namespace")==pkg or a.get("displayName")==sys.argv[3]):
    print(a.get("appId") or a.get("appId","")); break
' "$PACKAGE" "$plat" "$DISPLAY"
}

ensureAndroid(){
  local id; id="$(appIdForPackage ANDROID || true)"
  if [ -z "$id" ]; then
    log "app Android $PACKAGE no existe en $PROJECT → registrando…"
    fb apps:create ANDROID "$DISPLAY" --package-name "$PACKAGE" >&2 || { log "apps:create falló"; return 1; }
    id="$(appIdForPackage ANDROID || true)"
  fi
  [ -n "$id" ] || { log "no pude resolver el appId Android"; return 1; }
  local out="$APP_DIR/android/app/google-services.json"
  mkdir -p "$(dirname "$out")"
  fb apps:sdkconfig ANDROID "$id" --out "$out" >&2 || { log "sdkconfig ANDROID falló"; return 1; }
  # Validación anti-placeholder: el config real tiene project_number != 000…
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));pn=d["project_info"]["project_number"];sys.exit(1 if set(pn)<=set("0") else 0)' "$out" \
    || { log "el google-services.json derivado sigue siendo placeholder (project_number 000)"; return 1; }
  log "✓ google-services.json REAL → $out (app $id)"
}

ensureWeb(){
  local id; id="$(appIdForPackage WEB || true)"
  if [ -z "$id" ]; then
    log "app Web $DISPLAY no existe en $PROJECT → registrando…"
    fb apps:create WEB "$DISPLAY" >&2 || { log "apps:create WEB falló"; return 1; }
    id="$(appIdForPackage WEB || true)"
  fi
  [ -n "$id" ] || { log "no pude resolver el appId Web"; return 1; }
  # El config web va a un JSON que el build inyecta como firebaseConfig (web/firebase-config.json).
  local out="$APP_DIR/web/firebase-config.json"
  mkdir -p "$(dirname "$out")"
  fb apps:sdkconfig WEB "$id" --out "$out" >&2 || { log "sdkconfig WEB falló"; return 1; }
  log "✓ firebase web config REAL → $out (app $id)"
}

wrote=0
for plat in ${PLATFORMS//,/ }; do
  case "$plat" in
    android) ensureAndroid && wrote=1 ;;
    web)     ensureWeb && wrote=1 ;;
    *) log "plataforma no soportada: $plat" ;;
  esac
done
[ "$wrote" = "1" ] || { log "no se derivó ningún config"; exit 3; }
