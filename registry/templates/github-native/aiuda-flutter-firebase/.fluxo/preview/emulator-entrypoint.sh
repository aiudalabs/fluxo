#!/usr/bin/env bash
# emulator-entrypoint.sh — levanta el Firebase Emulator Suite del preview (docs/20 · P2).
#
# El preview corre contra un proyecto DEMO (`demo-*`) emulado: cero credenciales reales, cero contacto
# con el Firebase del cliente. Eso es todo el punto de docs/20 §1.
#
# Decisiones que valen la pena saber:
#  · HOST 0.0.0.0 — por default los emuladores escuchan en 127.0.0.1 y NINGÚN otro contenedor los
#    alcanzaría (el edge Caddy vive en otro contenedor).
#  · PUERTOS = los que el stack YA declara en `.fluxo/verify/stack.verify.yaml` (auth 9099, firestore
#    8085, functions 5001). Un solo vocabulario para e2e-verify y para el preview.
#  · RULES ABIERTAS A PROPÓSITO — no le pasamos `firestore.rules` al emulador. El preview es para
#    EVALUAR LA UI: con las rules reales + una cuenta demo, media app renderiza vacía y el evaluador ve
#    "no anda". Quien verifica las rules es e2e-verify (`no_client_over_read`) y el reviewer autónomo,
#    no el preview.
#  · functions/storage son CONDICIONALES: si el repo no los trae, arrancar con `--only functions`
#    voltea el suite entero. Mejor un preview sin callables que ningún preview.
set -uo pipefail

PROJECT="${FIREBASE_PROJECT:-demo-fluxo}"
FIREBASE_TOOLS="${FIREBASE_TOOLS_VERSION:-firebase-tools@14}"
REPO="${REPO_PATH:-/repo}"
CONFIG="$REPO/.fluxo-preview-firebase.json"

log() { echo "[emulator] $*"; }

cd "$REPO" || { log "no existe $REPO"; exit 1; }

only="auth,firestore"
functions_block=""
storage_block=""

# ── functions (condicional): sin deps instaladas el emulador no puede cargarlas ──────────────────
if [ -f "$REPO/functions/package.json" ]; then
  log "functions/ detectado — instalando deps (best-effort) para el emulador…"
  if npm --prefix "$REPO/functions" install --no-audit --no-fund >/tmp/functions-install.log 2>&1; then
    # TypeScript necesita compilar antes de que el emulador cargue el `main` del package.json.
    npm --prefix "$REPO/functions" run build --if-present >/tmp/functions-build.log 2>&1 \
      || log "el build de functions falló — sigo sin callables (ver /tmp/functions-build.log)"
    only="$only,functions"
    functions_block='"functions": { "source": "functions" },'
  else
    log "npm install de functions falló — el preview arranca SIN callables (ver /tmp/functions-install.log)"
  fi
else
  log "sin functions/ en el repo — el preview arranca sin emulador de functions"
fi

# ── storage (condicional): el emulador de storage EXIGE un archivo de rules ──────────────────────
if [ -f "$REPO/storage.rules" ]; then
  only="$only,storage"
  storage_block='"storage": { "rules": "storage.rules" },'
fi

# Config generado (NO el firebase.json del repo): el del repo apunta a las rules reales y bindea a
# localhost. Se escribe DENTRO del repo para que los paths relativos (`functions`, `storage.rules`)
# resuelvan; el clon del preview es efímero y no se commitea nunca.
cat > "$CONFIG" <<EOF
{
  $functions_block
  $storage_block
  "emulators": {
    "auth":      { "host": "0.0.0.0", "port": 9099 },
    "firestore": { "host": "0.0.0.0", "port": 8085 },
    "functions": { "host": "0.0.0.0", "port": 5001 },
    "storage":   { "host": "0.0.0.0", "port": 9199 },
    "hub":       { "host": "0.0.0.0", "port": 4400 },
    "ui":        { "enabled": false },
    "singleProjectMode": false
  }
}
EOF

log "arrancando emuladores [$only] para el proyecto $PROJECT"
exec npx --yes "$FIREBASE_TOOLS" emulators:start \
  --only "$only" \
  --project "$PROJECT" \
  --config "$CONFIG"
