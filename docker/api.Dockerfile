# syntax=docker/dockerfile:1
# Casello API — build su GitHub Actions, run su Coolify (immagine ghcr.io/twentivan/casello-api)

# ---------- stage 1: build ----------
FROM node:24-slim AS build
RUN npm install -g pnpm@10
WORKDIR /repo

# Prima solo i manifest: così il layer "pnpm install" viene riusato finché non cambiano
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY lib ./lib
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --filter @workspace/api-server...

# Poi il sorgente
# design/tokens.json: colori di Botcave per la pagina di consenso OAuth (inclusi nel bundle)
COPY design/tokens.json ./design/tokens.json
COPY artifacts/api-server ./artifacts/api-server
RUN pnpm --filter @workspace/api-server run build

# Albero di sole dipendenze di produzione dell'API (node_modules "piatto", senza symlink al workspace)
RUN pnpm --filter @workspace/api-server --prod deploy --legacy /deploy \
 && cp -r artifacts/api-server/dist /deploy/dist

# ---------- stage 2: runtime ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# curl per l'Health Check di Coolify, che esegue un suo comando con curl o wget e ignora il HEALTHCHECK qui sotto
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /deploy /app
# Manifest di Botcave Nodo (versione corrente e minima, letto da lib/nodes/manifest.ts) senza zip né binario, che
# serve solo casello-web. Il glob con .gitkeep: senza manifest (build locale) la COPY non fallisce e non si propone
# nessun aggiornamento.
COPY docker/nodo-downloads/.gitkeep docker/nodo-downloads/nodo-manifest.jso[n] /app/nodo/
# Script SQL delle migrazioni, applicati all'avvio dall'API (lib/migrations/)
COPY docs/migrations /app/migrations
USER node
EXPOSE 3000
# Healthcheck di Docker con fetch di Node (indipendente da curl)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
