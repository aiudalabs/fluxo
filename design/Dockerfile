# Worker (design/src/worker.ts) — el conductor: proyección (GitHub=verdad) · despacho · auto-merge ·
# approvals · costos, Y el workflow de DISEÑO (idea→backlog) que corre el agente LOCALMENTE vía el
# Claude Agent SDK. El SDK spawnea su CLI `claude` BUNDLEADO (node_modules/.../cli.js) — no hace
# falta instalar claude-code aparte.
#
# ⚠️ CORRE COMO NO-ROOT (usuario `node`): el CLI de Claude RECHAZA --dangerously-skip-permissions
# (que el SDK usa por permissionMode:bypassPermissions) cuando corre como root. Como root la corrida
# de diseño falla con "exited code 1". El pem montado debe ser legible por uid 1000 (ver compose:
# el host chownea app.pem a 1000:1000).
#
# Base Debian (glibc) — más fiable para el CLI + su ripgrep que alpine (musl). Node 22
# (--experimental-strip-types, 22.6+). registry/ en repo-root/registry. BUILD CONTEXT = RAÍZ:
#   docker build -f design/Dockerfile -t fluxo-worker .
FROM node:22-slim AS build
WORKDIR /app
# git: el agente de diseño trabaja en un workdir con git; ca-certificates para HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY design/package*.json ./design/
RUN cd design && npm ci
COPY design ./design
COPY registry ./registry
ENV NODE_ENV=production
# El usuario `node` (uid 1000) viene en la imagen. Corremos como él (no root) por lo de arriba.
USER node
WORKDIR /app/design
CMD ["node", "--experimental-strip-types", "src/worker.ts", "--interval=20"]
