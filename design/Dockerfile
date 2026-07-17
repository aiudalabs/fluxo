# Worker (design/src/worker.ts) — el conductor: proyección (GitHub=verdad) · despacho · auto-merge ·
# approvals · costos, y también corre el workflow de DISEÑO (idea→backlog) vía el Claude Agent SDK.
# Node 22: el worker corre con --experimental-strip-types (22.6+) y spawnea main.ts igual. El
# registry/ vive en repo-root/registry (design/src lo resuelve como ../../registry) → lo copiamos
# preservando el layout. BUILD CONTEXT = RAÍZ del repo:
#   docker build -f design/Dockerfile -t fluxo-worker .
FROM node:22-alpine AS build
WORKDIR /app
COPY design/package*.json ./design/
RUN cd design && npm ci
COPY design ./design
COPY registry ./registry
ENV NODE_ENV=production
WORKDIR /app/design
# --interval configurable por CMD override; default 20s (mismo que dev).
# NOTA: el workflow de DISEÑO (no el conductor) usa @anthropic-ai/claude-agent-sdk, que spawnea el
# CLI `claude`. Si vas a correr design runs en prod, agregá `RUN npm i -g @anthropic-ai/claude-code`.
# El CONDUCTOR (proyección/despacho/merge/costos) NO lo necesita — es GitHub API + DB puro.
CMD ["node", "--experimental-strip-types", "src/worker.ts", "--interval=20"]
