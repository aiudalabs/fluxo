#!/usr/bin/env bash
# Fluxo CI — the single source of truth for what "green" means (F0-03).
#
# Both a developer (`scripts/ci.sh`) and GitHub Actions (.github/workflows/ci.yml)
# run these same stages, so local and CI can never drift. Run all stages, or a
# subset by name:  scripts/ci.sh                # all
#                  scripts/ci.sh registry control
#                  scripts/ci.sh migrations leak # (needs DATABASE_URL)
#
# Stages whose artifacts do not exist yet SKIP cleanly rather than fail, so the
# pipeline is valid from day one and each phase turns a skip into a real gate as
# it lands its artifact:
#   - migrations  → real once supabase/migrations/*.sql exist (F1-01)
#   - leak        → real once the pgTAP suite exists (F1-05 / F2-04)
#   - console     → real once console/package.json exists (F6)
#
# A SKIP is always announced (never silent): a silent skip reads as "covered"
# when it is not (docs/04-lecciones L-AUTO-3: the green-but-empty gate).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
skip() { printf '\033[33m∅ SKIP %s\033[0m\n' "$1"; }
banner() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

stage_registry() {
  banner "registry validate"
  python3 registry/validate.py
  pass "registry"
}

stage_control() {
  banner "control (Go)"
  if [ -f control/go.mod ]; then
    ( cd control && go vet ./... && go test ./... )
    pass "control"
  else
    skip "control (no control/go.mod)"
  fi
}

stage_migrations() {
  banner "migrations"
  if ! compgen -G "supabase/migrations/*.sql" >/dev/null; then
    skip "migrations (none yet — F1-01)"
  elif [ -z "${DATABASE_URL:-}" ]; then
    skip "migrations (DATABASE_URL unset — needs Postgres)"
  else
    for m in supabase/migrations/*.sql; do
      echo "  applying $m"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"
    done
    pass "migrations"
  fi
}

stage_leak() {
  banner "cross-tenant leak test (L-ARCH-1, bloqueante)"
  if ! compgen -G "supabase/tests/*.sql" >/dev/null; then
    skip "leak test (no supabase/tests/*.sql yet — F1-05/F2-04)"
  elif [ -z "${DATABASE_URL:-}" ]; then
    skip "leak test (DATABASE_URL unset)"
  else
    pg_prove --ext .sql supabase/tests
    pass "leak test"
  fi
}

stage_console() {
  banner "console lint"
  if [ -f console/package.json ]; then
    ( cd console && npm ci && npm run lint )
    pass "console"
  else
    skip "console lint (no console/package.json yet — F6)"
  fi
}

ALL_STAGES=(registry control migrations leak console)

main() {
  local stages=("$@")
  [ ${#stages[@]} -eq 0 ] && stages=("${ALL_STAGES[@]}")
  for s in "${stages[@]}"; do
    "stage_${s}"
  done
  printf '\n\033[32m✓ CI green (%s)\033[0m\n' "${stages[*]}"
}

main "$@"
