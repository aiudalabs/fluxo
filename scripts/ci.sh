#!/usr/bin/env bash
# Fluxo CI — the single source of truth for what "green" means (F0-03).
#
# Both a developer (`scripts/ci.sh`) and GitHub Actions (.github/workflows/ci.yml)
# run these same stages, so local and CI can never drift. Run all stages, or a
# subset by name:  scripts/ci.sh                # all
#                  scripts/ci.sh registry control
#                  scripts/ci.sh db             # needs supabase CLI + Docker + stack up
#
# Stages skip cleanly (announced, never silent — L-AUTO-3) when their prerequisite
# is absent, so the pipeline is valid from day one and each phase turns a skip into
# a real gate as it lands its artifact:
#   - db       → cross-tenant leak gate; needs supabase/tests + supabase CLI + stack
#   - console  → real once console/package.json exists (F6)
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

# stage_db runs the pgTAP suite via the Supabase CLI — including the cross-tenant
# leak test (L-ARCH-1) that MUST stay green to merge. We use `supabase test db`
# (not raw psql/pg_prove) because our migrations depend on Supabase primitives —
# the `authenticated`/`anon` roles, `auth.jwt()`, the supabase_realtime
# publication — that a vanilla Postgres does not have. `supabase test db` is
# transactional (rolls back), so it never mutates local data.
#
# In CI the job runs `supabase start` first (which also smoke-applies every
# migration). Locally it needs the stack already up.
stage_db() {
  banner "db: pgTAP incl. cross-tenant leak (L-ARCH-1, bloqueante)"
  if ! compgen -G "supabase/tests/*.sql" >/dev/null; then
    skip "db (no supabase/tests/*.sql yet)"
  elif ! command -v supabase >/dev/null 2>&1; then
    skip "db (supabase CLI not installed)"
  elif ! docker info >/dev/null 2>&1; then
    skip "db (Docker not running — supabase needs it)"
  elif ! supabase status >/dev/null 2>&1; then
    skip "db (supabase stack not running — run 'supabase start')"
  else
    supabase test db
    pass "db"
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

# stage_design runs the design runtime's PURE tests (the L-D2 resolver) + typecheck.
# The real agent run needs CLAUDE_CODE_OAUTH_TOKEN + the API and is not part of CI.
stage_design() {
  banner "design (Agent SDK runtime)"
  if [ -f design/package.json ]; then
    ( cd design && npm ci && npm test && npx tsc --noEmit )
    pass "design"
  else
    skip "design (no design/package.json yet — F5-01)"
  fi
}

ALL_STAGES=(registry control db console design)

main() {
  local stages=("$@")
  [ ${#stages[@]} -eq 0 ] && stages=("${ALL_STAGES[@]}")
  for s in "${stages[@]}"; do
    "stage_${s}"
  done
  printf '\n\033[32m✓ CI green (%s)\033[0m\n' "${stages[*]}"
}

main "$@"
