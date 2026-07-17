# Console (Next.js) — plano de control de Fluxo. OJO: NO es self-contained: importa el kernel de
# design/src/*.ts (dispatch/approve) cross-paquete y lee registry/ en runtime (/api/registry). Por
# eso el BUILD CONTEXT es la RAÍZ del repo y la imagen incluye console/ + design/ + registry/.
#   docker build -f console/Dockerfile -t fluxo-console .   (desde la raíz del repo)
# Node 22: el kernel de design usa import de extensión .ts que Next transpila; 22 es el piso.
FROM node:22-alpine AS build
WORKDIR /app
# deps primero (capa cacheable)
COPY console/package*.json ./console/
RUN cd console && npm ci
# fuentes: console + el kernel importado + el registry leído en runtime
COPY console ./console
COPY design ./design
COPY registry ./registry
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* se INLINEAN en el bundle del browser en build-time → van como build-args, NO como
# env de runtime (si no, el browser no llega a Supabase). El compose los pasa desde .env.prod.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
RUN cd console && npm run build

# ── runtime ────────────────────────────────────────────────────────────────
# next start sirve el build con node_modules presente (robusto para el monorepo; no usamos
# `output: standalone` por el import cross-paquete + la lectura de registry/). gh CLI para
# `gh secret set` (sembrar el token del canal en el Actions secret del repo del cliente).
RUN apk add --no-cache github-cli
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    REGISTRY_DIR=/app/registry
EXPOSE 3000
WORKDIR /app/console
CMD ["npm", "run", "start"]
