#!/usr/bin/env bash
# Correr Fluxo local COMPLETO (F5-P9): console + el WORKER de diseño/build. El worker es lo
# que hace que "crear proyecto → arranca el diseño" funcione — sin él, un proyecto nuevo
# queda inerte (era el bug: el worker no corría). Este script levanta ambos y los baja juntos.
#
# Uso:  ./scripts/dev.sh                 # workflow de diseño completo
#       WORKFLOW=demo-design ./scripts/dev.sh   # workflow lean (demo, más barato)
set -euo pipefail
cd "$(dirname "$0")/.."

# Envs para el worker (Supabase local + credenciales). Toma el .env y overridea a local.
set -a; [ -f .env ] && source .env; set +a
export SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
export SUPABASE_ANON_KEY="$(supabase status 2>/dev/null | awk '/anon key/{print $NF}')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status 2>/dev/null | awk '/service_role key/{print $NF}')"
export SUPABASE_JWT_SECRET="$(supabase status 2>/dev/null | awk '/JWT secret/{print $NF}')"
WORKFLOW="${WORKFLOW:-design}"

echo "▶ Fluxo local: console (:3000) + worker [workflow=$WORKFLOW]"
pids=()
( cd console && npm run dev ) & pids+=($!)
( node --experimental-strip-types design/src/worker.ts --workflow="$WORKFLOW" ) & pids+=($!)

# Ctrl-C baja los dos.
trap 'echo "▪ bajando…"; kill "${pids[@]}" 2>/dev/null || true; exit 0' INT TERM
wait
