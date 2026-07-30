# Imagen del AGENTE de build para el ExecEnv `fluxo_engine` (docs/17).
#
# El agente (Claude Code CLI) corre ADENTRO de este container, sobre una copia SIN .git del
# repo (nunca toca el remoto — el commit/push pasa AFUERA, en el runner). Necesita:
#   - node LTS + npm  → el toolchain de los proyectos web (Next/Vite) + correr sus tests
#   - git             → claude lo usa para diffs locales (NO para push; no hay credencial de git acá)
#   - python3         → paridad con proyectos python / scripts
#   - @anthropic-ai/claude-code → el CLI del agente (protocolo stream-json)
#
# Auth: el token Pro/Max entra por -e CLAUDE_CODE_OAUTH_TOKEN (lo inyecta el runner desde la bóveda).
# Egress (F3): el runner lo corre en la red allowlist con HTTPS_PROXY → solo anthropic/github/npm.
#
# Build:  docker build -t fluxo-agent:local -f scripts/agent/Dockerfile scripts/agent
FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git ca-certificates python3 python3-venv python3-pip curl && \
    npm install -g @anthropic-ai/claude-code && \
    npm cache clean --force && \
    rm -rf /var/lib/apt/lists/*

# Non-root (defense in depth): el código no-confiable del repo corre como este usuario.
# El runner monta el workdir con ownership de 'node' (uid 1000) y pasa --user 1000:1000.
USER node
WORKDIR /work

# Sin ENTRYPOINT/CMD: el runner pasa el comando exacto (claude -p --output-format stream-json …).
