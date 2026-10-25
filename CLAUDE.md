# Casello

Hub per agentificare applicazioni: registri le tue app, le configuri come agenti autonomi dotati di
strumenti e istruzioni, lanci esecuzioni (run) e le monitori. Casello è lo strato agentico comune a
tutti i prodotti di Ivan (Mister, The Hub Up, ReMove, Vimini, TradeFlow).

Lingua: italiano per commenti, documentazione, issue e messaggi di commit. Codice e identificatori in inglese.

## Stato (ottobre 2026)

- API completa per il CRUD di App / Agent / Tool / Run e per l'esecuzione delle run via AI gateway.
- Fase 1 "Agenti che agiscono": gli agenti chiamano i tool HTTP delle app (catalogo per app), con
  conferma dell'utente per le azioni marcate, timeline dei passi e pausa/ripresa (vedi "Agenti operativi").
- Fase 3 "Architetto": analizza un'app (codice da GitHub o zip, OpenAPI, descrizione) e propone tool,
  agenti, skill, endpoint mancanti, piano di completamento ed evoluzione; nulla si attiva senza
  approvazione nella console (vedi "Architetto").
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
- `pnpm --filter @workspace/api-server run test` — test dell'API (Vitest; Postgres in memoria con PGlite,
  schema da `docs/schema-casello.sql`, nessun DB esterno necessario)
- `pnpm run typecheck` — typecheck di tutti i package (da far passare prima di ogni commit)
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — rigenera hook React Query e schemi Zod da `openapi.yaml`
- `pnpm --filter @workspace/db run push` — applica lo schema Drizzle a un DB di SVILUPPO (`DATABASE_URL`
  richiesta). MAI in produzione: vedi "Schema DB" in "Deploy"

## Dove stanno le cose

- `lib/api-spec/openapi.yaml` — contratto API, fonte di verità (contract-first)
- `lib/api-client-react/src/generated/` — client generato da Orval: NON modificare a mano
- `lib/db/src/schema/` — schema Drizzle, una tabella per file (apps, agents, app_tools, agent_tools, runs,
  run_steps, sessions, analyses, analysis_items, agent_skills)
- `artifacts/api-server/src/routes/` — route Express 5: `/api/apps`, `/api/apps/:id/tools` (catalogo dei
  tool dell'app, CRUD), `/api/agents`, `PUT /api/agents/:id/tools` (tool collegati a un agente di area),
  `POST /api/agents/:id/runs`, `/api/runs`, `GET /api/runs/:id/steps` (timeline dei passi),
  `POST /api/runs/:id/resume` (conferma o annulla l'azione in sospeso), `/api/dashboard/stats`,
  `/api/models`, `/api/healthz`; architetto: `GET|POST /api/apps/:id/analyses`,
  `POST /api/apps/:id/analyses/zip` (corpo zip grezzo), `GET /api/analyses/:id`,
  `GET /api/analyses/:id/issues`, `PATCH /api/analysis-items/:id`, `GET|DELETE /api/agents/:id/skills`. Body, parametri e query si leggono con `parseRequest` (errore → 400);
  le risposte con `*Response.parse` (errore → 500, è un bug del server)
- `artifacts/api-server/src/lib/auth.ts` — login Google (OIDC), sessione e middleware che protegge `/api`
- `artifacts/api-server/src/lib/models.ts` — modelli selezionabili e default (`openrouter/auto`)
- `artifacts/api-server/src/lib/ai-gateway.ts` — client verso i modelli (LiteLLM proxy o provider diretti)
- `artifacts/api-server/src/lib/agent-loop.ts` — ciclo dell'agente (puro, senza DB né rete): chiamate al
  modello, esecuzione dei tool, pause, limiti del turno
- `artifacts/api-server/src/lib/run-executor.ts` — orchestrazione delle run: collega il ciclo al DB,
  all'esecutore dei tool e al gateway; scrive i passi in `run_steps`, salva lo stato alla pausa
  (`awaiting_client`) e lo riprende con `resume`. `POST /api/agents/:id/runs` risponde subito con la run
  `pending` e la esegue in background (la UI fa polling su `GET /api/runs/:id`); all'avvio le run rimaste
  `pending`/`running` vengono chiuse come fallite.
- `artifacts/api-server/src/lib/tools/` — catalogo (`catalog.ts`), validazione delle definizioni
  (`definition.ts`), esecutore HTTP (`executor.ts`), oscuramento degli argomenti sensibili (`sensitive.ts`)
- `artifacts/api-server/src/lib/secrets.ts` — cifratura AES-256-GCM dei segreti di servizio (anche il token GitHub)
- `artifacts/api-server/src/lib/architect/` — architetto: sorgenti in memoria (`source-tree.ts`, `zip-reader.ts`,
  `search-worker.ts`, `sources.ts`), schemi ed esempi delle fasi (`schemas.ts`, `prompts.ts`), ciclo di fase
  (`phase-loop.ts`), orchestrazione (`run-analysis.ts`), differenze/applicazione/issue (`diff.ts`, `apply.ts`, `issues.ts`)
- `artifacts/casello/src/` — frontend React + Vite + Tailwind + shadcn/ui (`components/ui/` pronti)
- `artifacts/mockup-sandbox/` — sandbox di mockup: NON va in produzione, non toccare
- `gateway/` — config LiteLLM storica; la copia viva è nel repo `TwentIvan/AIGateway`
- `docker/`, `.github/workflows/deploy.yml` — build e deploy (vedi sotto)

## Modello di dominio

- **App**: applicazione registrata: nome, `slug`, `base_url`, `internal_base_url` (raggiunto
  dall'esecutore al posto di `base_url`), autenticazione utente/servizio (header + scheme), segreto di
  servizio cifrato (mai esposto: l'API dice solo `serviceSecretSet`), stato
- **Agent**: appartiene a una App; `system_prompt`, `model`, stato (draft/active/inactive), ruolo:
  `general` (uno per app, creato con l'app, non eliminabile, usa tutti i tool `active` dell'app) o `area`
  (usa solo i tool collegati in `agent_tools`)
- **Tool** (`app_tools`): catalogo per App; `kind` (`http`, `ui`, `composite`: nella fase 1 solo `http`
  viene offerto al modello), `identity` (`user`: token dell'utente da `X-App-User-Token`; `service`:
  segreto di servizio), `requiresConfirmation`, `readOnly`, stato (draft/active/disabled), definizione
  (metodo, path, posizione dei parametri) e `params_schema` JSON (`"x-sensitive": true` oscura un parametro)
- **Run**: esecuzione di un Agent: input, output, errore, durata, token, stato
  (pending/running/awaiting_client/succeeded/failed/cancelled); i passi in `run_steps`

## Modelli AI

Le chiamate passano da LiteLLM (`AI_GATEWAY_BASE_URL=https://aigateway.fantamister.cloud/v1`, chiave
virtuale in `AI_GATEWAY_API_KEY`). Il campo `agent.model` deve coincidere con un `model_name` di
LiteLLM. Non esistono più account OpenAI/Anthropic: i modelli disponibili sono quelli `openrouter/*`
(`openrouter/auto`, `openrouter/deepseek-chat`, `openrouter/qwen3-235b`, `openrouter/mistral-small`).
Il default è `openrouter/auto` (schema `agents` e fallback del gateway); la lista per la UI
arriva da `GET /api/models` (costante in `lib/models.ts`: va tenuta allineata a LiteLLM).

## Agenti operativi (fase 1)

- Spec: `docs/superpowers/specs/2026-10-25-casello-agenti-operativi-design.md`.
- Limiti per turno: 8 giri di tool, 120 s di tempo attivo (le pause non contano; ogni chiamata al
  modello è limitata dal tempo rimasto, minimo 1 s), 60 000 token. Per chiamata HTTP: 15 s, risposta
  massima 1 048 576 byte. Pausa per la conferma: massimo 10 minuti, poi la run diventa `cancelled`.
- L'esecutore raggiunge solo `internal_base_url` (o `base_url`) + path del tool: dagli argomenti del
  modello arrivano solo valori codificati. Gli indirizzi e gli header di autenticazione si validano
  già al salvataggio dell'app.
- Il token dell'utente vive solo in memoria per la durata della run: mai nel DB né nei log. Credenziali
  rimandate dall'app nelle risposte vengono sostituite con `***`; gli argomenti `x-sensitive` sono
  oscurati nei passi e nell'azione in sospeso pubblica.

## Architetto (fase 3)

- Spec: stessa di sopra, §4 e §6; piano `docs/superpowers/plans/2026-10-25-fase-3-architetto.md`.
- Sorgenti dell'app (`apps.source_*`, `openapi_url`, `functional_description`): codice da GitHub (zipball con
  token di sola lettura, cifrato, mai restituito: l'API dice solo `sourceTokenSet`) o da zip caricato
  (max 50 MB; nginx ha `client_max_body_size 51m`). Il codice vive SOLO in memoria per la durata
  dell'analisi: niente file su disco, niente log del contenuto.
- Limiti: zip letto con un parser proprio (anti zip bomb), regex di ricerca in un worker con timeout 2 s,
  OpenAPI max 2 MB; analisi max 30 minuti e 400 000 token (default), 40 giri e 2 correzioni per fase.
- Sei fasi (map, capabilities, catalog, agents, completion, evolution): ogni esito è validato con Zod
  (`schemas.ts`, esempi in `prompts.ts` verificati dai test). Gli elementi (`analysis_items`) sono
  confrontati con lo stato attuale dell'app (`diff`: new/changed/unchanged/removed).
- Revisione: approvare un tool/agente/skill lo applica in una transazione e lo rende `active` (un tool
  `removed` diventa `disabled`, mai cancellato); endpoint/completamento/evoluzione si esportano come issue.
  Un'analisi alla volta per app; all'avvio le analisi rimaste aperte diventano `interrupted`.

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
  `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY`, `AI_GATEWAY_FALLBACK_MODEL`, `CASELLO_SECRET_KEY`
  (64 caratteri esadecimali, `openssl rand -hex 32`; cifra i segreti a riposo, obbligatoria con
  `NODE_ENV=production`); `PUBLIC_APP_URL`
  (origine della UI, `https://casello.fantamister.cloud`: usata dal login e dal CORS, che in produzione
  accetta solo quella e in dev qualsiasi `localhost`); per il login `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS` (separati da virgola); `OIDC_ISSUER` solo per i test.
- nginx inoltra all'API l'`X-Forwarded-Proto` ricevuto da Traefik: serve al cookie `secure`.
- Healthcheck di `casello-api`: `GET /api/healthz` sulla porta 3000. È nel `HEALTHCHECK` di
  `docker/api.Dockerfile` (con `node`, l'immagine slim non ha curl/wget); su Coolify impostarlo anche
  in Health Check (path `/api/healthz`, porta 3000), altrimenti Coolify non lo usa per il deploy.
- `POST /api/agents/:id/runs` ha un rate limit in memoria (10 run/minuto per IP, `middlewares/rate-limit.ts`):
  l'IP reale arriva da `trust proxy` = 2 (Traefik di Coolify + nginx di `casello-web`).
- Schema DB: le modifiche arrivano in produzione SOLO con gli script SQL in `docs/migrations/`, applicati
  al DB Neon con `psql -v ON_ERROR_STOP=1 -f docs/migrations/<file>.sql` (prima del deploy dell'API
  che li usa). MAI `drizzle-kit push` in produzione: cancellerebbe dati (es. la vecchia tabella `tools`
  convertita dalla migrazione). Ogni modifica a `lib/db/src/schema/` va riportata in
  `docs/schema-casello.sql` (usato anche dai test) e in uno script di `docs/migrations/`, e va segnalata nella PR.

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
