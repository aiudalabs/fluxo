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

# Flutter SDK (canal stable) — para que el agente COMPILE/testee su propio Dart (flutter analyze /
# flutter test) ANTES del PR, como su persona ya le indica. Sin esto el agente escribía código Flutter
# sin compilar nunca (no había toolchain) → bugs de API y de versiones de deps (CardTheme→CardThemeData
# de Flutter 3.44, google_fonts incompatible) llegaban al repo y solo la CI los cazaba a posteriori.
# Mismo canal `stable` que la CI (subosito channel:stable) → elimina el skew agente↔CI. precache --web
# baja los artefactos de dart2js para que el primer `flutter build web` del agente no tarde de más.
ENV FLUTTER_HOME=/opt/flutter \
    PATH="/opt/flutter/bin:/opt/flutter/bin/cache/dart-sdk/bin:${PATH}"
RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip xz-utils libglu1-mesa && \
    git clone --depth 1 --branch stable https://github.com/flutter/flutter.git /opt/flutter && \
    git config --system --add safe.directory /opt/flutter && \
    flutter config --no-analytics --enable-web && \
    flutter precache --web --universal && \
    chown -R node:node /opt/flutter && \
    rm -rf /var/lib/apt/lists/*

# Non-root (defense in depth): el código no-confiable del repo corre como este usuario.
# El runner monta el workdir con ownership de 'node' (uid 1000) y pasa --user 1000:1000.
USER node
WORKDIR /work

# Sin ENTRYPOINT/CMD: el runner pasa el comando exacto (claude -p --output-format stream-json …).
