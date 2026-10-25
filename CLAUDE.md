# Casello

Hub per agentificare applicazioni: registri le tue app, le configuri come agenti autonomi dotati di
strumenti e istruzioni, lanci esecuzioni (run) e le monitori. Casello è lo strato agentico comune a
tutti i prodotti di Ivan (Mister, The Hub Up, ReMove, Vimini, TradeFlow).

Lingua: italiano per commenti, documentazione, issue e messaggi di commit. Codice e identificatori in inglese.

## Stato (ottobre 2026)

- API completa per il CRUD di App / Agent / Tool / Run e per l'esecuzione delle run via AI gateway.
- Frontend `artifacts/casello` completo: login Google, dashboard, App, Agenti (con Tool), lancio e
  monitoraggio delle Run. Pagine in `src/pages/`, componenti per area in `src/components/`; solo hook
  generati da Orval, mai fetch a mano.
- In produzione su https://casello.fantamister.cloud (vedi "Deploy").

## Comandi

- `pnpm install` — installa tutto (pnpm 10, Node 24)
- `pnpm run dev` — avvia insieme API (`API_PORT`, default 3000) e frontend (`WEB_PORT`, default 5173);
  serve `DATABASE_URL` nell'ambiente. Il frontend Vite inoltra `/api` a `http://localhost:${API_PORT}`.
  Senza credenziali Google l'API non parte: in locale si usa `AUTH_DISABLED=true pnpm run dev`
- `pnpm run dev:api` / `pnpm run dev:web` — gli stessi due processi separati (es. in due terminali)
- `pnpm --filter @workspace/api-server run dev` — solo API su `PORT` (richiesta: es. `PORT=3000`)
- `pnpm --filter @workspace/casello run dev` — solo frontend (richiede `PORT` e `BASE_PATH=/`; proxy
  `/api` verso `API_PORT`, default 3000)
- `pnpm run typecheck` — typecheck di tutti i package (da far passare prima di ogni commit)
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — rigenera hook React Query e schemi Zod da `openapi.yaml`
- `pnpm --filter @workspace/db run push` — applica lo schema Drizzle al DB (`DATABASE_URL` richiesta)

## Dove stanno le cose

- `lib/api-spec/openapi.yaml` — contratto API, fonte di verità (contract-first)
- `lib/api-client-react/src/generated/` — client generato da Orval: NON modificare a mano
- `lib/db/src/schema/` — schema Drizzle, una tabella per file (apps, agents, tools, runs, sessions)
- `artifacts/api-server/src/routes/` — route Express 5 (`/api/apps`, `/api/agents`, `/api/agents/:id/tools`,
  `/api/agents/:id/runs`, `/api/runs`, `/api/dashboard/stats`, `/api/models`, `/api/healthz`)
- `artifacts/api-server/src/lib/auth.ts` — login Google (OIDC), sessione e middleware che protegge `/api`
- `artifacts/api-server/src/lib/models.ts` — modelli selezionabili e default (`openrouter/auto`)
- `artifacts/api-server/src/lib/ai-gateway.ts` — client verso i modelli (LiteLLM proxy o provider diretti)
- `artifacts/api-server/src/lib/run-executor.ts` — esecuzione di una run (context pack + prompt caching).
  `POST /api/agents/:id/runs` risponde subito con la run `pending` e la esegue in background (la UI fa
  polling su `GET /api/runs/:id`); all'avvio le run rimaste `pending`/`running` vengono chiuse come fallite.
- `artifacts/casello/src/` — frontend React + Vite + Tailwind + shadcn/ui (`components/ui/` pronti)
- `artifacts/mockup-sandbox/` — sandbox di mockup: NON va in produzione, non toccare
- `gateway/` — config LiteLLM storica; la copia viva è nel repo `TwentIvan/AIGateway`
- `docker/`, `.github/workflows/deploy.yml` — build e deploy (vedi sotto)

## Modello di dominio

- **App**: applicazione registrata (nome, `base_url`, stato)
- **Agent**: appartiene a una App; `system_prompt`, `model`, stato (draft/active/inactive)
- **Tool**: strumento HTTP di un Agent (metodo, endpoint, `parameters_schema` JSON)
- **Run**: esecuzione di un Agent: input, output, errore, durata, stato (pending/running/succeeded/failed)

## Modelli AI

Le chiamate passano da LiteLLM (`AI_GATEWAY_BASE_URL=https://aigateway.fantamister.cloud/v1`, chiave
virtuale in `AI_GATEWAY_API_KEY`). Il campo `agent.model` deve coincidere con un `model_name` di
LiteLLM. Non esistono più account OpenAI/Anthropic: i modelli disponibili sono quelli `openrouter/*`
(`openrouter/auto`, `openrouter/deepseek-chat`, `openrouter/qwen3-235b`, `openrouter/mistral-small`).
Il default è `openrouter/auto` (schema `agents` e fallback del gateway); la lista per la UI
arriva da `GET /api/models` (costante in `lib/models.ts`: va tenuta allineata a LiteLLM).

## Autenticazione

- Login Google OIDC (`/api/auth/login` → Google → `/api/auth/callback`), sessione in Postgres (tabella
  `sessions`) con cookie `casello.sid` httpOnly. Accede solo chi è in `ALLOWED_EMAILS`.
- Tutto `/api` richiede la sessione tranne `/api/healthz` e `/api/auth/*`; senza sessione risponde 401 e
  il frontend (`AuthGate`) mostra la pagina di login.
- In produzione, se manca una variabile di login, l'API non parte (meglio giù che aperta).
  `AUTH_DISABLED=true` salta il login solo in sviluppo ed è rifiutata con `NODE_ENV=production`.
- Client OAuth su Google Cloud: redirect URI autorizzato `${PUBLIC_APP_URL}/api/auth/callback`.

## Deploy (non toccare senza motivo)

- Push su `main` → GitHub Actions builda `ghcr.io/twentivan/casello-api` e `casello-web` e chiama i
  webhook Coolify. Push su `feat/**` builda soltanto (collaudo), senza deploy.
- Il tag `:latest` (quello che deploya Coolify) lo scrive solo `main`; ogni build ha anche il tag
  `:<sha>`. I run su `main` sono in coda uno alla volta e il job di deploy chiama i webhook con
  `force=true` e attende la fine del deploy su Coolify: merge ravvicinati non lasciano un'immagine vecchia.
- Due container su Coolify: `casello-api` (porta 3000, solo rete interna) e `casello-web` (nginx: SPA +
  proxy di `/api/` verso `casello-api:3000`). Il frontend chiama `/api` con URL relativi: un solo dominio.
- Immagini `node:24-slim` (non alpine: il workspace esclude i binari musl).
- Variabili dell'API: `DATABASE_URL` (Neon, stringa diretta), `PORT`, `NODE_ENV`, `LOG_LEVEL`,
  `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY`, `AI_GATEWAY_FALLBACK_MODEL`; `PUBLIC_APP_URL`
  (origine della UI, `https://casello.fantamister.cloud`: usata dal login e dal CORS, che in produzione
  accetta solo quella e in dev qualsiasi `localhost`); per il login `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS` (separati da virgola); `OIDC_ISSUER` solo per i test.
- nginx inoltra all'API l'`X-Forwarded-Proto` ricevuto da Traefik: serve al cookie `secure`.
- Healthcheck di `casello-api`: `GET /api/healthz` sulla porta 3000. È nel `HEALTHCHECK` di
  `docker/api.Dockerfile` (con `node`, l'immagine slim non ha curl/wget); su Coolify impostarlo anche
  in Health Check (path `/api/healthz`, porta 3000), altrimenti Coolify non lo usa per il deploy.
- `POST /api/agents/:id/runs` ha un rate limit in memoria (10 run/minuto per IP, `middlewares/rate-limit.ts`):
  l'IP reale arriva da `trust proxy` = 2 (Traefik di Coolify + nginx di `casello-web`).
- Schema DB: niente migrazioni, `drizzle-kit push`; in produzione lo schema è stato creato a mano
  (`docs/schema-casello.sql`). Ogni modifica a `lib/db/src/schema/` va applicata al DB di produzione
  con `push` o con SQL equivalente, e va segnalata nella PR.

## Flusso di lavoro

1. Ogni lavoro parte da una GitHub Issue; branch `feat/<slug-issue>`.
2. `pnpm run typecheck` verde prima del commit; commit piccoli, messaggi in italiano, tipo `feat(casello): ...`.
3. PR verso `main` con: cosa cambia, come si è provato, eventuali modifiche allo schema DB o alle variabili.
4. Il merge su `main` deploya in produzione da solo: niente merge di lavoro a metà.

## Gotchas

- Dopo ogni modifica a `openapi.yaml` rieseguire il codegen e committare anche i file generati.
- Non aggiungere `artifacts/casello` ai `references` del `tsconfig.json` di root (leaf package).
- `pnpm-workspace.yaml` ha `minimumReleaseAge`: una versione npm uscita da meno di un giorno non si installa.
- `vite.config.ts` del frontend pretende `PORT` e `BASE_PATH` anche solo per buildare.
- I residui di Replit sono stati rimossi; restano solo i plugin `@replit/*` di `artifacts/mockup-sandbox`.
