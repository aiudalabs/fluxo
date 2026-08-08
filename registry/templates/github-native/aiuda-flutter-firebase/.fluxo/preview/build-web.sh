#!/usr/bin/env bash
# build-web.sh — compila la app Flutter a web APUNTANDO AL EMULADOR y la publica para el edge
# (docs/20 · P2). One-shot: corre, deja el build en /srv/web y termina.
set -uo pipefail

REPO="${REPO_PATH:-/repo}"
WEBROOT="${WEBROOT:-/srv/web}"
RECIPE="${RECIPE_DIR:-/etc/fluxo/recipe}"
PROJECT_ID="${PREVIEW_PROJECT_ID:-demo-fluxo}"
# Host FICTICIO a propósito: nunca resuelve y nunca hace falta que resuelva. El shim reescribe la URL
# al origen de la página ANTES de que el pedido salga (ver preview-shim.js). Si el shim faltara, el
# pedido fallaría por DNS — ruidoso, que es lo que queremos, en vez de un silencio raro.
EMULATOR_HOST="${EMULATOR_HOST:-fluxo-emulator}"
MAPS_API_KEY="${MAPS_API_KEY:-}"

log() { echo "[build-web] $*"; }
die() { echo "[build-web] ERROR: $*" >&2; exit 1; }

# ── 1) detectar la app Flutter primaria — MISMO criterio que ui-verify.yml (commit 89c4cc9) ────────
# Un path fijo dejaba el gate inerte cuando el agente nombraba la app distinto (apps/yomap vs
# apps/customer); acá el mismo problema haría un preview vacío.
APP_PATH="$(find "$REPO/apps" -maxdepth 2 -name pubspec.yaml 2>/dev/null | sort | head -1 | xargs -r dirname)"
[ -n "$APP_PATH" ] || die "no encontré ninguna app Flutter en $REPO/apps/*/pubspec.yaml — nada que previsualizar."
log "app detectada: ${APP_PATH#$REPO/}"

# ── 2) GATE: ¿la app es preview-aware? (docs/20 · P1) ──────────────────────────────────────────────
# Sin la init preview-aware la app arranca contra el Firebase REAL con un config placeholder: compila,
# carga… y no conecta con nada. Eso es exactamente el "cascarón" que docs/20 vino a matar. Fallamos
# FUERTE y con la instrucción concreta, en vez de publicar un preview que miente.
if ! grep -rqs "USE_FIREBASE_EMULATOR" "$REPO/apps" "$REPO/packages" 2>/dev/null; then
  die "la app NO es preview-aware: no hay ningún \`USE_FIREBASE_EMULATOR\` en apps/ ni packages/.
  Sin eso la app se conecta al Firebase real y el preview sería un cascarón vacío.
  Arreglo (una sola vez por proyecto, es la convención del stack — ver .github/instructions/app.instructions.md):
  la inicialización de Firebase tiene que leer los --dart-define de emulador y llamar a
  useAuthEmulator / useFirestoreEmulator / useFunctionsEmulator cuando USE_FIREBASE_EMULATOR es true."
fi

# ── 3) preparar el workspace ───────────────────────────────────────────────────────────────────────
export PATH="$PATH:$HOME/.pub-cache/bin"
( cd "$REPO" && dart pub global activate melos >/dev/null 2>&1 && melos bootstrap ) \
  || log "melos bootstrap best-effort falló; sigo (flutter build corre pub get)."

cd "$APP_PATH" || die "no pude entrar a $APP_PATH"
flutter config --enable-web >/dev/null 2>&1
# Idempotente: si la app se creó mobile-only, habilita web/ sin pisar lo existente (mismo fix que
# ui-verify — commit 527321e). Sin esto: "This project is not configured for the web".
flutter create . --platforms web >/dev/null 2>&1 || log "flutter create web best-effort"

# ── 4) Google Maps: la ÚNICA pieza que no se puede emular (los tiles los sirve Google) ─────────────
# Con key → el mapa renderiza de verdad. Sin key → el resto de la app se previsualiza igual y el mapa
# queda en blanco. La key sale de las credenciales del tenant (docs/20 · P3); todavía no está cableada.
if [ -n "$MAPS_API_KEY" ] && [ -f web/index.html ]; then
  sed -i "s/MAPS_API_KEY_PLACEHOLDER/$MAPS_API_KEY/g; s/YOUR_API_KEY/$MAPS_API_KEY/g" web/index.html
  log "Maps API key inyectada en web/index.html"
elif grep -qs "maps.googleapis.com" web/index.html 2>/dev/null; then
  log "AVISO: la app carga Google Maps pero no hay MAPS_API_KEY — el mapa va a salir en blanco (docs/20 P3)."
fi

# ── 5) build apuntando al emulador ─────────────────────────────────────────────────────────────────
log "compilando web contra el emulador (proyecto $PROJECT_ID)…"
flutter build web --release \
  --dart-define=USE_FIREBASE_EMULATOR=true \
  --dart-define=FIREBASE_EMULATOR_HOST="$EMULATOR_HOST" \
  --dart-define=FIREBASE_DEMO_PROJECT_ID="$PROJECT_ID" \
  --dart-define=FIREBASE_AUTH_EMULATOR_PORT=9099 \
  --dart-define=FIRESTORE_EMULATOR_PORT=8085 \
  --dart-define=FUNCTIONS_EMULATOR_PORT=5001 \
  --dart-define=FIREBASE_STORAGE_EMULATOR_PORT=9199 \
  || die "\`flutter build web\` falló — la app no compila para web (ver el log de este contenedor)."

[ -f build/web/index.html ] || die "el build terminó pero no hay build/web/index.html"

# ── 6) inyectar el shim http→same-origin ───────────────────────────────────────────────────────────
# Va INLINE y PRIMERO en el <head>: tiene que parchear fetch/XHR antes de que cargue cualquier script
# de Firebase. Inline (no <script src>) para que no haya carrera de red en el medio.
python3 - "$RECIPE/preview-shim.js" build/web/index.html <<'PY'
import sys, re
shim_path, index_path = sys.argv[1], sys.argv[2]
shim = open(shim_path, encoding='utf-8').read()
html = open(index_path, encoding='utf-8').read()
tag = '<script data-fluxo-preview-shim>\n%s\n</script>' % shim
if '<head>' in html:
    html = html.replace('<head>', '<head>\n' + tag, 1)
else:
    m = re.search(r'<head[^>]*>', html)
    if not m:
        sys.exit('no encontré <head> en index.html — no puedo inyectar el shim del preview')
    html = html[:m.end()] + '\n' + tag + html[m.end():]
open(index_path, 'w', encoding='utf-8').write(html)
print('[build-web] shim inyectado en build/web/index.html')
PY
[ $? -eq 0 ] || die "no pude inyectar el shim del preview en index.html"

# ── 7) publicar al volumen que sirve el edge ───────────────────────────────────────────────────────
# index.html AL FINAL, a propósito: el health-check del preview-runner pollea `/`, y publicar el HTML
# antes que los assets daría un 200 sobre una app que todavía no puede bootear.
mkdir -p "$WEBROOT"
tar -C build/web --exclude=./index.html -cf - . | tar -C "$WEBROOT" -xf - \
  || die "no pude publicar los assets en $WEBROOT"
cp build/web/index.html "$WEBROOT/index.html" || die "no pude publicar index.html en $WEBROOT"

log "listo: app publicada en $WEBROOT ($(find "$WEBROOT" -type f | wc -l) archivos)."
