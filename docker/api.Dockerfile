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
COPY artifacts/api-server ./artifacts/api-server
RUN pnpm --filter @workspace/api-server run build

# Albero di sole dipendenze di produzione dell'API (node_modules "piatto", senza symlink al workspace)
RUN pnpm --filter @workspace/api-server --prod deploy --legacy /deploy \
 && cp -r artifacts/api-server/dist /deploy/dist

# ---------- stage 2: runtime ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy /app
USER node
EXPOSE 3000
# node:24-slim non ha curl/wget: l'healthcheck usa fetch di Node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
