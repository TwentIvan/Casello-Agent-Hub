# syntax=docker/dockerfile:1
# Botcave web (SPA statica; nome in codice Casello) — build su GitHub Actions, run su Coolify (immagine ghcr.io/twentivan/casello-web)
# NB: immagini glibc (slim), non alpine: pnpm-workspace.yaml esclude i binari *-linux-x64-musl di rollup/esbuild/tailwind

# ---------- stage 1: build ----------
FROM node:24-slim AS build
RUN npm install -g pnpm@10
WORKDIR /repo

# vite.config.ts esige PORT e BASE_PATH anche solo per buildare (PORT non viene usata nel bundle)
ENV PORT=5173
ENV BASE_PATH=/
# Casello chiama /api con URL relativi: nginx fa da proxy verso il container API (vedi nginx.conf.template)

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY artifacts/casello/package.json artifacts/casello/
COPY lib ./lib
COPY scripts ./scripts
# NB: niente NODE_ENV=production qui — le dipendenze di build del web sono devDependencies
RUN pnpm install --frozen-lockfile --filter @workspace/casello...

# design/ è la fonte dell'identità Botcave: token, logo e icone li legge la build di Vite
COPY design ./design
COPY artifacts/casello ./artifacts/casello
RUN pnpm --filter @workspace/casello run build

# ---------- stage 2: runtime ----------
FROM nginx:alpine AS runtime
# Il template lo elabora l'entrypoint di nginx (envsubst sulle variabili definite: $uri e simili restano intatti).
# 15-embed-origins.envsh gira prima di 20-envsubst-on-templates.sh e calcola EMBED_ALLOWED_ORIGINS_CSP.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 docker/15-embed-origins.envsh /docker-entrypoint.d/15-embed-origins.envsh
# Origini (separate da virgola) che possono incorporare /embed; vuota = nessuna
ENV EMBED_ALLOWED_ORIGINS=""
# envsubst sostituisce solo le variabili EMBED_*: le altre (anche quelle aggiunte da Coolify) restano testo di nginx
ENV NGINX_ENVSUBST_FILTER=EMBED_
COPY --from=build /repo/artifacts/casello/dist/public /usr/share/nginx/html
EXPOSE 80
