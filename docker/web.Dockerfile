# syntax=docker/dockerfile:1
# Casello web (SPA statica) — build su GitHub Actions, run su Coolify (immagine ghcr.io/twentivan/casello-web)
# NB: immagini glibc (slim), non alpine: pnpm-workspace.yaml esclude i binari *-linux-x64-musl di rollup/esbuild/tailwind

# ---------- stage 1: build ----------
FROM node:24-slim AS build
RUN npm install -g pnpm@10
WORKDIR /repo

# vite.config.ts esige PORT e BASE_PATH anche solo per buildare (PORT non viene usata nel bundle)
ENV PORT=5173
ENV BASE_PATH=/
# Casello chiama /api con URL relativi: nginx fa da proxy verso il container API (vedi nginx.conf)

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY artifacts/casello/package.json artifacts/casello/
COPY lib ./lib
COPY scripts ./scripts
# NB: niente NODE_ENV=production qui — le dipendenze di build del web sono devDependencies
RUN pnpm install --frozen-lockfile --filter @workspace/casello...

COPY artifacts/casello ./artifacts/casello
RUN pnpm --filter @workspace/casello run build

# ---------- stage 2: runtime ----------
FROM nginx:alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/artifacts/casello/dist/public /usr/share/nginx/html
EXPOSE 80
