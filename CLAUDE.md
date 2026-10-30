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
- Chat del piano: l'utente discute con un modello il piano di un'app e ne accetta le modifiche come schede
  (vedi "Chat del piano").
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
  run_steps, sessions, analyses, analysis_items, agent_skills, users, user_identities, github_installations,
  ai_accounts, ai_models, providers, models, model_offers, catalog_runs, plan_conversations, plan_messages, plan_proposals)
- `artifacts/api-server/src/routes/` — route Express 5: `/api/apps`, `/api/apps/:id/tools` (catalogo dei
  tool dell'app, CRUD), `/api/agents`, `PUT /api/agents/:id/tools` (tool collegati a un agente di area),
  `POST /api/agents/:id/runs`, `/api/runs`, `GET /api/runs/:id/steps` (timeline dei passi),
  `POST /api/runs/:id/resume` (conferma o annulla l'azione in sospeso), `/api/dashboard/stats`,
  `/api/models`, `GET|PUT /api/budget` (tetti di spesa), `/api/healthz`; architetto: `GET|POST /api/apps/:id/analyses`,
  `POST /api/apps/:id/analyses/zip` (corpo zip grezzo), `GET /api/analyses/:id`,
  `GET /api/analyses/:id/issues`, `PATCH /api/analysis-items/:id`, `GET|DELETE /api/agents/:id/skills`; GitHub: `GET /api/github/installations`, `GET /api/github/repos`
  (login e collegamento in `/api/auth/github/*`, vedi "Autenticazione"). Body, parametri e query si leggono con `parseRequest` (errore → 400);
  le risposte con `*Response.parse` (errore → 500, è un bug del server)
- `artifacts/api-server/src/lib/auth.ts` — login Google (OIDC), sessione e middleware che protegge `/api`
- `artifacts/api-server/src/lib/models.ts` — modelli selezionabili e default (`openrouter/auto`)
- `artifacts/api-server/src/lib/ai/` — account AI: provider e indirizzi (`providers.ts`), scoperta dei modelli
  (`discovery.ts`), esecutore unico (`executor.ts`), account di sistema (`system-account.ts`), scelta del modello
  (`choice.ts`), riverifica e arricchimento dei modelli (`accounts.ts`), stato effettivo e preselezione
  (`model-status.ts`), prova con 1 token (`probe.ts`); route in `src/routes/ai.ts`
- `artifacts/api-server/src/lib/catalog/` — catalogo dei modelli: fonti pubbliche (`sources.ts`), normalizzazione
  e fusione (`normalize.ts`, `merge.ts`), riepilogo delle novità (`summary.ts`), aggiornamento (`refresh.ts`),
  avvio settimanale (`scheduler.ts`); route in `src/routes/catalog.ts`; fonti finte per i test in
  `artifacts/api-server/test/fake-sources.ts`
- `artifacts/api-server/src/lib/ai-gateway.ts` — client storico verso LiteLLM (agenti non ancora su un account AI)
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
- `artifacts/api-server/src/lib/users.ts` — utenti e identità (`isAllowed`, `resolveLogin`, `linkIdentity`, `unlinkIdentity`)
- `artifacts/api-server/src/lib/github/` — GitHub App: configurazione (`config.ts`), client con JWT e token di
  installazione (`app.ts`), login/collegamento/callback (`oauth-routes.ts`), sincronizzazione delle installazioni
  (`installations.ts`); finto GitHub per i test in `artifacts/api-server/test/fake-github.ts`
- `artifacts/api-server/src/lib/architect/` — architetto: sorgenti in memoria (`source-tree.ts`, `zip-reader.ts`,
  `search-worker.ts`, `sources.ts`), schemi ed esempi delle fasi (`schemas.ts`, `prompts.ts`), ciclo di fase
  (`phase-loop.ts`), orchestrazione (`run-analysis.ts`), differenze/applicazione/issue (`diff.ts`, `apply.ts`, `issues.ts`)
- `artifacts/api-server/src/lib/plan-chat/` — chat del piano: contesto (`context.ts`), strumenti (`tools.ts`), turno
  (`turn.ts`), decisione sulle schede (`decide.ts`), esecuzione in background (`run-turn.ts`); route in
  `src/routes/plan-chat.ts`; pagina `/apps/:id/plan` in `artifacts/casello/src/pages/app-plan.tsx` e `components/plan/`
- `artifacts/casello/src/` — frontend React + Vite + Tailwind + shadcn/ui (`components/ui/` pronti)
- `artifacts/api-server/src/lib/mcp/` e `lib/architect/local-executor.ts` — server MCP `/mcp` e coda/lease delle analisi locali
- `docs/skills/casello-architetto-locale/` — skill dell'agente locale (da copiare in `~/.claude/skills/`)
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

## Modelli AI (account AI)

- Casello è l'unico centro di configurazione dei modelli: ogni utente aggiunge i propri **account AI**
  (tabella `ai_accounts`: DeepSeek, OpenRouter, Hugging Face, Mistral, Groq, Together o endpoint
  compatibile OpenAI "personalizzato") dalla pagina Account; la chiave è cifrata con `CASELLO_SECRET_KEY`
  e mai restituita. Al salvataggio Casello verifica la chiave e legge i modelli da `GET /models`
  (tabella `ai_models`, con prezzi USD per milione di token: dal provider, dalla tabella iniziale
  `lib/ai/price-seed.ts` o inseriti a mano). Una modifica di chiave o indirizzo si verifica PRIMA di salvare.
- Esecutore unico `lib/ai/executor.ts`: `resolveModel(aiModelId)` → account, indirizzo, chiave (solo in
  memoria) e prezzi; `modelChat` chiama il provider e calcola il costo. Errori con messaggi fissi in italiano
  (`lib/ai/discovery.ts`). Predisposto per un secondo esecutore (agente locale via MCP, prossimo sottoprogetto).
- "Chi configura paga": un utente sceglie solo modelli dei propri account o dell'account di sistema; le run
  usano il modello salvato nell'agente (`agents.ai_model_id`), le analisi quello scelto da chi le avvia.
  Costi in `runs.cost_usd` e `analyses.cost_usd` (null = costo parziale, prezzo mancante); stima prima
  dell'analisi (`GET /api/ai/estimate`).
- Indirizzi dei provider: solo `https`; "Consenti rete privata" (solo personalizzato) ammette `http` e reti
  private, mai loopback, link-local o metadata. Nessun redirect seguito.
- Transizione: con `AI_GATEWAY_BASE_URL`/`AI_GATEWAY_API_KEY` impostate, all'avvio Casello crea l'account di
  sistema "Gateway Casello" (LiteLLM, repo `TwentIvan/AIGateway`) con i modelli di `lib/models.ts` e vi collega
  agenti e analisi esistenti. Gli agenti con `ai_model_id` null usano ancora `lib/ai-gateway.ts`. AIGateway va
  dismesso (togliendo le variabili) solo dopo aver spostato gli agenti sugli account personali, con conferma.
- Route: `/api/ai/accounts` (+ `/:id/verify`, `/:id/default`, `/:id/models`), `/api/ai/models`,
  `POST /api/ai/models/:id/probe`, `/api/ai/estimate`; `GET /api/models` resta come alias del vecchio elenco.
- Costi sempre sotto controllo: a parità di risultato si preferisce il modello o il percorso più economico.

## Tetti di spesa

- Tetto mensile in USD (null = nessun limite) per utente (`users.monthly_budget_usd`, pagina Account), per agente
  (`agents.monthly_budget_usd`, scheda agente), per account AI (`ai_accounts.monthly_budget_usd`: una chiave, il credito
  si carica per chiave) e per modello (`ai_models.monthly_budget_usd`); questi ultimi due nella pagina Account, solo sui
  propri account (l'account di sistema non ha tetti). Mese di calendario, ora italiana (`lib/budget.ts`).
- Spesa dell'utente (chi configura paga): run, analisi cloud e conversazioni del piano con un modello dei suoi account
  AI (una conversazione, a costo cumulativo, conta nel mese del suo ultimo turno); l'account di sistema non conta. Spesa dell'agente: le sue
  run con qualsiasi modello. Spesa di un modello o di un account: run, analisi cloud e chat con quel modello o con i
  modelli dell'account. Ogni run ricorda il modello con cui è partita (`runs.ai_model_id`). I costi null (prezzo
  mancante) non si sommano: si contano come esecuzioni senza prezzo.
- Ordine dei controlli: agente, modello, account AI, utente (il primo raggiunto dà il messaggio).
- Raggiunto un tetto (spesa ≥ tetto) le nuove run, analisi cloud e messaggi della chat rispondono 409 con il motivo;
  le analisi locali e le riprese delle run in pausa no. `GET|PUT /api/budget`: riepilogo e tetto dell'utente; la
  console avvisa dall'80% e propone di annullare le run ancora attive su un tetto raggiunto (mai da sola).
- Migrazioni: `docs/migrations/2026-10-tetti-di-spesa.sql`, `docs/migrations/2026-10-tetti-modello-provider.sql`.

## Catalogo dei modelli

- Spec: `docs/superpowers/specs/2026-10-26-casello-catalogo-modelli-design.md` (base) e
  `docs/superpowers/specs/2026-10-26-casello-catalogo-universale-design.md` (catalogo universale e registro).
- **Provider come dati**: tabella `providers` (slug, nome, protocollo, indirizzo predefinito, nomi nelle fonti,
  stato `managed` | `coming` | `unmanaged`, origine `registry` | `discovered`). Il registro vive nel codice
  (`lib/catalog/provider-registry-data.ts`) ed è allineato all'avvio e a ogni aggiornamento
  (`ensureProviderRegistry`); `ai_accounts.provider` è testo con FK su `providers.slug`. `managed` = esecutore
  disponibile (oggi solo `openai_compatible`), `coming` = protocollo noto senza esecutore (Anthropic, Bedrock,
  Vertex, Azure), `unmanaged` = provider comparso nelle fonti e sconosciuto al registro. **Riconoscere un provider
  nuovo è un intervento evolutivo**: si aggiunge al registro (la pagina Modelli li elenca in "Da gestire in
  Casello" ed esporta il testo dell'issue). Un account su un provider `unmanaged` si configura come compatibile
  OpenAI con l'indirizzo dell'utente (regole di `custom`; rete privata solo per `custom`/`unmanaged` e solo
  finché il provider lo è).
- Aggiornamento deterministico, senza chiamare modelli: fonti pubbliche con indirizzi fissi (OpenRouter
  `/api/v1/models` e listino LiteLLM `model_prices_and_context_window.json`), 30 s, niente redirect, max 20 MB.
  Entra tutto (≈4 300 voci, ogni tipo di modello): `models` (chiave canonica: stesso modello tra provider
  diversi, al meglio) e `model_offers` (modello presso un provider, unico per provider + id). Precedenza: prezzi
  e strumenti da LiteLLM poi OpenRouter (che è solo riserva di un'offerta diretta già nota a LiteLLM; per il
  provider `openrouter` il contrario), data di rilascio da OpenRouter, dismissione da LiteLLM. Se una fonte cade
  l'esecuzione è `partial`, i campi che venivano da quella fonte restano e i modelli esistenti non cambiano.
- `catalog_runs` (ultime 20, una sola `running` per indice unico parziale, `newProviders` nel riepilogo); su
  `ai_models`: `availability`, `supports_tools`, `offer_id`, `last_probe_*`. I prezzi `manual` non si toccano
  mai; quelli presi dal catalogo hanno `price_source = catalog`.
- Quando: ogni 7 giorni o se `model_offers` è vuota (controllo all'avvio dopo 5 minuti e poi ogni 24 h) e a
  richiesta con `POST /api/catalog/refresh` (2/minuto; 409 se già in corso). Ogni esecuzione rilegge `/models`
  di tutti gli account non di sistema e ricollega `ai_models` alle offerte; all'avvio le esecuzioni rimaste
  `running` diventano `failed`.
- API: `GET /api/catalog/models` (ricerca, filtri, ordinamento, paginazione ≤ 100, pagina ≤ 10 000),
  `GET /api/catalog/models/:id/offers`, `GET /api/catalog/providers`, `GET /api/catalog/providers/:slug/issue`,
  `GET /api/catalog/status` (novità per account solo al proprietario), `GET /api/ai/providers` (registro per gli
  account). Console: pagina "Modelli" (vista per modello e per provider, filtri nell'indirizzo), scelta del
  provider e del modello con ricerca.
- Stato effettivo di un modello: ritirato (offerta ritirata o data di dismissione passata) > non disponibile
  (`availability = unavailable`, messo da un 404 o "model_not_found" di una chiamata vera) > disponibile. La
  tendina propone solo modelli disponibili con strumenti (o non noti, "?"); gli altri disponibili in "Altri
  modelli". "Prova" (5/minuto, solo sui propri account, 1 token, 20 s) riporta un modello a disponibile.
- Limiti noti: un modello dell'account di sistema segnato non disponibile non si può riprovare dalla console;
  l'enum Postgres `ai_provider` resta nel DB inutilizzato (da eliminare in un passo successivo); lo slug storico
  `system_gateway` contiene `_`.

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
  OpenAPI max 2 MB; analisi max 30 minuti e 1 000 000 token (default), 25 giri e 2 correzioni per fase.
  Ogni fase ha una quota del tetto di token (`PHASE_TOKEN_SHARES`, somma 0,88): all'80% della quota o
  dei giri il modello riceve un avviso a consegnare e ha 2 giri di margine (più le correzioni di una
  consegna non valida); il limite rigido resta il tetto complessivo. Chiamata al modello max 300 s
  (nessun nuovo tentativo sui timeout); letture da 200 righe / 12 000 caratteri per strumento
  (`list_operations` a pagine con `prefix`/`offset`), cronologia degli output di 24 000 caratteri.
- Sei fasi (map, capabilities, catalog, agents, completion, evolution): ogni esito è validato con Zod
  (`schemas.ts`, esempi in `prompts.ts` verificati dai test). Gli elementi (`analysis_items`) sono
  confrontati con lo stato attuale dell'app (`diff`: new/changed/unchanged/removed).
- Revisione: approvare un tool/agente/skill lo applica in una transazione e lo rende `active` (un tool
  `removed` diventa `disabled`, mai cancellato); endpoint/completamento/evoluzione si esportano come issue.
  Un'analisi alla volta per app; all'avvio le analisi rimaste aperte diventano `interrupted`.

## Chat del piano

- Spec: `docs/superpowers/specs/2026-10-29-casello-chat-del-piano-design.md`.
- Pagina `/apps/:id/plan` (`src/pages/app-plan.tsx`, `src/components/plan/`): piano dell'app e conversazioni con
  un modello. Il modello propone schede `add` / `update` / `discard`; solo quelle accettate dall'utente diventano
  voci `analysis_items` con `origin = chat` (e `conversation_id`). Niente lettura del codice.
- Route (`routes/plan-chat.ts`): `GET /api/apps/:id/plan`, `GET|POST /api/apps/:id/plan-conversations`,
  `GET|PATCH|DELETE /api/plan-conversations/:id`, `POST /api/plan-conversations/:id/messages`,
  `POST /api/plan-proposals/:id/decision`. Codice in `lib/plan-chat/` (`context.ts`, `tools.ts`, `turn.ts`,
  `decide.ts`, `run-turn.ts`).
- Limiti per turno: 6 giri, 40 000 token, 120 s di tempo attivo; messaggio max 8 000 caratteri; contesto
  ~30 000 token (la cronologia si riduce); 10 messaggi/min per utente.
- Nel contesto del modello non entrano segreti né indirizzi delle app. Il turno gira in background: la UI fa
  polling sulla conversazione; all'avvio i turni rimasti aperti (`failInterruptedPlanTurns`) vengono chiusi come falliti.
- La rianalisi dell'architetto riceve le voci da chat approvate come "già pianificate" (solo fasi completion ed
  evolution) e non le ripropone.
- Migrazione: `docs/migrations/2026-10-chat-del-piano.sql` (da applicare in produzione PRIMA del merge e da
  segnalare nella PR). Dipendenze frontend: `react-markdown`, `remark-gfm`.

## Autenticazione

- Login Google OIDC (`/api/auth/login` → Google → `/api/auth/callback`), sessione in Postgres (tabella
  `sessions`) con cookie `casello.sid` httpOnly. Accede solo chi è in `ALLOWED_EMAILS`.
- Tutto `/api` richiede la sessione tranne `/api/healthz` e `/api/auth/*`; senza sessione risponde 401 e
  il frontend (`AuthGate`) mostra la pagina di login.
- In produzione, se manca una variabile di login, l'API non parte (meglio giù che aperta).
  `AUTH_DISABLED=true` salta il login solo in sviluppo ed è rifiutata con `NODE_ENV=production`.
- Client OAuth su Google Cloud: redirect URI autorizzato `${PUBLIC_APP_URL}/api/auth/callback`.
- Utenti in `users`, identità (`google`, `github`) in `user_identities`; la sessione contiene `userId` (le
  sessioni vecchie con solo l'email vengono convertite alla prima richiesta). Chi entra lo decide solo
  `isAllowed` in `lib/users.ts` (oggi: un'email verificata in `ALLOWED_EMAILS`).
- Login con GitHub (facoltativo) tramite la GitHub App "Casello": `/api/auth/github/login`,
  `/api/auth/github/link` (da loggati), un'unica callback `/api/auth/github/callback` (anche per il ritorno
  dall'installazione: un `code` senza il nostro `state` non viene mai scambiato), `DELETE /api/auth/github`.
  `GET /api/auth/providers` (pubblica) dice alla pagina di login se GitHub è attivo. Pagina Account nella
  console per accessi e installazioni.
- Repository: le installazioni dell'App (`github_installations`, per utente) si sincronizzano a ogni
  callback; `GET /api/github/installations`, `GET /api/github/repos`. Un'app con `source_installation_id`
  fa scaricare all'architetto il codice con un token di installazione limitato a quel repo e a
  `contents: read` (un'ora, solo in memoria). Nessun token GitHub viene salvato. Il token manuale della
  fase 3 resta come alternativa.
- Limite noto: l'ambito di un'installazione può superare i repo a cui l'utente ha accesso su GitHub; prima
  di aprire Casello a chiunque va verificato l'accesso con il token dell'utente (spec GitHub, §5).
- GitHub App su github.com: permessi Contents read, Metadata read, Email addresses read (account); "Request
  user authorization (OAuth) during installation" attivo, nessun Setup URL, nessun webhook; Callback URL
  `${PUBLIC_APP_URL}/api/auth/github/callback`.

## Esecutore locale

Le analisi dell'architetto possono essere eseguite da Claude Code sul Mac dell'utente invece che dal cloud
(`analyses.executor`). L'agente si collega al server MCP su `/mcp` (Streamable HTTP stateless, solo POST,
60 chiamate/min per utente; nginx ha `location /mcp`) con un token personale `cas_…` creato in console
(Account → "Agenti locali"; tabella `api_tokens`, salvato come hash). Gli esiti di fase stanno in
`analysis_phase_results`; la lease dura 15 minuti (rinnovo con consegna o `ping_analysis`). Migrazione:
`docs/migrations/2026-10-esecutore-locale.sql` (da applicare in produzione e segnalare nella PR). Procedura
dell'agente: skill `docs/skills/casello-architetto-locale/SKILL.md`.

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
  GitHub (tutte facoltative: se ne manca una GitHub è disattivato e nei log compaiono i nomi mancanti):
  `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_PRIVATE_KEY` (PEM, a capo veri o `\n`); `GITHUB_API_BASE`/`GITHUB_WEB_BASE` solo per i test.
- nginx inoltra all'API l'`X-Forwarded-Proto` ricevuto da Traefik: serve al cookie `secure`.
- Healthcheck di `casello-api`: `GET /api/healthz` sulla porta 3000. È nel `HEALTHCHECK` di
  `docker/api.Dockerfile` (con `node`, l'immagine slim non ha curl/wget); su Coolify impostarlo anche
  in Health Check (path `/api/healthz`, porta 3000), altrimenti Coolify non lo usa per il deploy.
- `POST /api/agents/:id/runs` ha un rate limit in memoria (10 run/minuto per IP, `middlewares/rate-limit.ts`):
  l'IP reale arriva da `trust proxy` = 2 (Traefik di Coolify + nginx di `casello-web`).
- Schema DB: le modifiche arrivano in produzione SOLO con gli script SQL in `docs/migrations/`, applicati
  al DB Neon con `psql -v ON_ERROR_STOP=1 -f docs/migrations/<file>.sql` (prima del deploy dell'API
  che li usa: cioè PRIMA del merge, perché il merge deploya da solo). MAI `drizzle-kit push` in produzione: cancellerebbe dati (es. la vecchia tabella `tools`
  convertita dalla migrazione). Ogni modifica a `lib/db/src/schema/` va riportata in
  `docs/schema-casello.sql` (usato anche dai test) e in uno script di `docs/migrations/`, e va segnalata nella PR.
  Se uno script elimina tabelle o colonne che la versione in produzione usa ancora, si divide in due: la parte
  additiva prima del merge, quella distruttiva (`…-post.sql`) dopo il deploy.

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
