# Casello

Hub per agentificare applicazioni: registri le tue app, le configuri come agenti autonomi dotati di
strumenti e istruzioni, lanci esecuzioni (run) e le monitori. Casello è lo strato agentico comune a
tutti i prodotti di Ivan (Mister, The Hub Up, ReMove, Vimini, TradeFlow).

Lingua: italiano per commenti, documentazione, issue e messaggi di commit. Codice e identificatori in inglese.

## Stato (ottobre 2026)

- API completa per il CRUD di App / Agent / Tool / Run e per l'esecuzione delle run con gli account AI degli utenti.
- Fase 1 "Agenti che agiscono": gli agenti chiamano i tool HTTP delle app (catalogo per app), con
  timeline dei passi; le azioni L2 passano dalla coda «Da confermare» (vedi "Strumenti MCP e coda delle conferme").
- Fase 3 "Architetto": analizza un'app (codice da GitHub o zip, OpenAPI, descrizione) e propone tool,
  agenti, skill, endpoint mancanti, piano di completamento ed evoluzione; nulla si attiva senza
  approvazione nella console (vedi "Architetto").
- Chat del piano: l'utente discute con un modello il piano di un'app e ne accetta le modifiche come schede
  (vedi "Chat del piano").
- Squadre (definizione): catalogo di skill, modelli di squadra e istanze legate a un lavoro di riferimento, con
  aggiornamenti proposti e «salva come modello» (vedi "Squadre (definizione)").
- Squadre (esecuzione): una squadra attiva ha un capo a turni, un PLAN versionato da approvare, compiti per i ruoli
  `cloud`, eventi e bollettino, centralino su `/mcp`; i ruoli `node` restano in attesa del nodo locale (vedi "Squadre (esecuzione)").
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
  ai_accounts, ai_models, providers, models, model_offers, catalog_runs, plan_conversations, plan_messages, plan_proposals,
  skills, skill_versions, team_templates, team_template_versions, team_instances, team_instance_skills,
  team_plans, team_plan_versions, team_tasks, team_task_steps, team_turns, team_turn_steps, team_events)
- `artifacts/api-server/src/routes/` — route Express 5: `/api/apps`, `/api/apps/:id/tools` (catalogo dei
  tool dell'app, CRUD), `/api/agents`, `PUT /api/agents/:id/tools` (tool collegati a un agente di area),
  `POST /api/agents/:id/runs`, `/api/runs`, `GET /api/runs/:id/steps` (timeline dei passi),
  `/api/dashboard/stats`, `/api/pending-actions` (coda delle conferme), `POST /api/apps/:id/mcp-tools/refresh`,
  `GET|PUT /api/budget` (tetti di spesa), `/api/healthz`; architetto: `GET|POST /api/apps/:id/analyses`,
  `POST /api/apps/:id/analyses/zip` (corpo zip grezzo), `GET /api/analyses/:id`,
  `GET /api/analyses/:id/issues`, `PATCH /api/analysis-items/:id`, `GET|DELETE /api/agents/:id/skills`; GitHub: `GET /api/github/installations`, `GET /api/github/repos`
  (login e collegamento in `/api/auth/github/*`, vedi "Autenticazione"). Body, parametri e query si leggono con `parseRequest` (errore → 400);
  le risposte con `*Response.parse` (errore → 500, è un bug del server)
- `artifacts/api-server/src/lib/auth.ts` — login Google (OIDC), sessione e middleware che protegge `/api` (`requireAuth`: sessione o token personale; `sessionOnly`; `TOKEN_MESSAGES`); token in `lib/api-tokens.ts`, limite per token in `middlewares/rate-limit.ts`; UI in `components/account/api-tokens-section.tsx`
- `artifacts/api-server/src/lib/ai/` — account AI: provider e indirizzi (`providers.ts`), scoperta dei modelli
  (`discovery.ts`), esecutore unico (`executor.ts`), tipi condivisi delle chiamate (`chat-types.ts`), scelta del modello
  (`choice.ts`), riverifica e arricchimento dei modelli (`accounts.ts`), stato effettivo e preselezione
  (`model-status.ts`), prova con 1 token (`probe.ts`), modello predefinito e ripiego degli agenti
  (`default-model.ts`); route in `src/routes/ai.ts`; `GET|PUT /api/account/default-model` in
  `src/routes/account-model.ts`; `PUT /api/apps/:id/agent-models` in `src/routes/agents.ts`
- `artifacts/api-server/src/lib/catalog/` — catalogo dei modelli: fonti pubbliche (`sources.ts`), normalizzazione
  e fusione (`normalize.ts`, `merge.ts`), riepilogo delle novità (`summary.ts`), aggiornamento (`refresh.ts`),
  avvio settimanale (`scheduler.ts`); route in `src/routes/catalog.ts`; fonti finte per i test in
  `artifacts/api-server/test/fake-sources.ts`
- `artifacts/api-server/src/lib/agent-loop.ts` — ciclo dell'agente (puro, senza DB né rete): chiamate al
  modello, esecuzione dei tool, pause, limiti del turno
- `artifacts/api-server/src/lib/run-executor.ts` — orchestrazione delle run: collega il ciclo al DB,
  all'esecutore dei tool e all'esecutore dei modelli; scrive i passi in `run_steps`; le chiamate L2 diventano voci
  di `pending_actions` e la run prosegue senza fermarsi (niente più pausa). `POST /api/agents/:id/runs` risponde subito con la run
  `pending` e la esegue in background (la UI fa polling su `GET /api/runs/:id`); all'avvio le run rimaste
  `pending`/`running` vengono chiuse come fallite.
- `artifacts/api-server/src/lib/tools/` — client MCP (`mcp-client.ts`), sincronizzazione degli strumenti MCP
  (`mcp-sync.ts`), livelli d'azione (`levels.ts`), catalogo (`catalog.ts`), validazione delle definizioni
  (`definition.ts`), esecutore HTTP (`executor.ts`), oscuramento degli argomenti sensibili (`sensitive.ts`)
- `artifacts/api-server/src/lib/secrets.ts` — cifratura AES-256-GCM dei segreti di servizio (anche il token GitHub)
- `artifacts/api-server/src/lib/users.ts` — utenti e identità (`isAllowed`, `resolveLogin`, `linkIdentity`, `unlinkIdentity`)
- `artifacts/api-server/src/lib/github/` — GitHub App: configurazione (`config.ts`), client con JWT e token di
  installazione (`app.ts`), login/collegamento/callback (`oauth-routes.ts`), sincronizzazione delle installazioni
  (`installations.ts`); finto GitHub per i test in `artifacts/api-server/test/fake-github.ts`
- `artifacts/api-server/src/lib/actions/` — coda delle azioni da confermare: accodamento (`queue.ts`), controllo del
  testo (`text-check.ts`), approvazione/rifiuto (`decide.ts`); route in `src/routes/pending-actions.ts`; pagina
  `artifacts/casello/src/pages/pending-actions.tsx`; server MCP finto per i test in `artifacts/api-server/test/fake-mcp.ts`
- `artifacts/api-server/src/lib/architect/` — architetto: sorgenti in memoria (`source-tree.ts`, `zip-reader.ts`,
  `search-worker.ts`, `sources.ts`), schemi ed esempi delle fasi (`schemas.ts`, `prompts.ts`), ciclo di fase
  (`phase-loop.ts`), orchestrazione (`run-analysis.ts`), differenze/applicazione/issue (`diff.ts`, `apply.ts`, `issues.ts`),
  fonte MCP (`mcp-source.ts`) e testi condivisi (`text.ts`)
- `artifacts/api-server/src/lib/plan-chat/` — chat del piano: contesto (`context.ts`), strumenti (`tools.ts`), turno
  (`turn.ts`), decisione sulle schede (`decide.ts`), esecuzione in background (`run-turn.ts`); route in
  `src/routes/plan-chat.ts`; pagina `/apps/:id/plan` in `artifacts/casello/src/pages/app-plan.tsx` e `components/plan/`
- `artifacts/api-server/src/lib/plan-issues/` e `lib/github/issues.ts` — issue GitHub dalle voci del piano: contenuto
  ed etichette (`content.ts`), prenotazione/creazione/aggiornamento (`service.ts`), client GitHub e token `issues: write`
  (`issues.ts`); route in `src/routes/plan-issues.ts` (`POST /api/apps/:id/plan/issues`, `POST /api/apps/:id/plan/issues/refresh`);
  console in `artifacts/casello/src/components/plan/` (`create-issues-dialog.tsx`, `issues-summary.tsx`, `issue-badge.tsx`)
- `artifacts/api-server/src/lib/teams/` — squadre: skill del catalogo (`skills.ts`), manifesto dei ruoli (`manifest.ts`),
  regole di salvataggio (`rules.ts`), modelli (`templates.ts`), istanze (`instances.ts`), aggiornamenti proposti
  (`updates.ts`), salva come modello (`save-as-template.ts`); route in `src/routes/skills.ts`, `team-templates.ts` e
  `team-instances.ts`; console: pagine `skills.tsx`, `skill-detail.tsx`, `team-templates.tsx`, `team-template-detail.tsx`,
  `teams.tsx`, `team-detail.tsx` in `artifacts/casello/src/pages/` (route `/skills`, `/team-templates`, `/teams`; vedi "Squadre (definizione)")
- Esecuzione delle squadre (vedi "Squadre (esecuzione)"): in `artifacts/api-server/src/lib/teams/` PLAN (`plan.ts`),
  decisione sulle voci di piano (`plan-decisions.ts`), coda dei turni (`turn-queue.ts`), strumenti dei ruoli (`role-tools.ts`),
  strumenti del capo (`lead-tools.ts`), turni del capo (`turn-runner.ts`), compiti (`task-runner.ts`), eventi (`events.ts`),
  tetto della squadra (`team-budget.ts`), centralino (`centralino.ts`); ciclo e costi condivisi con le run in
  `artifacts/api-server/src/lib/loop-wiring.ts`; route nuove in `src/routes/team-instances.ts` (attivazione, PLAN, messaggi,
  compiti, turni, eventi, tetto) e `src/routes/account-model.ts` (modello del centralino); console: componenti in
  `artifacts/casello/src/components/teams/` (`plan-card.tsx`, `plan-approval-card.tsx`, `plan-editor-dialog.tsx`,
  `team-activity.tsx`, `team-bulletin.tsx`, `lead-message.tsx`, `team-budget.tsx`) usati da `pages/team-detail.tsx`
- `artifacts/casello/src/` — frontend React + Vite + Tailwind + shadcn/ui (`components/ui/` pronti)
- `artifacts/api-server/src/lib/mcp/` e `lib/architect/local-executor.ts` — server MCP `/mcp` e coda/lease delle analisi locali
- `docs/skills/casello-architetto-locale/` — skill dell'agente locale (da copiare in `~/.claude/skills/`)
- `artifacts/mockup-sandbox/` — sandbox di mockup: NON va in produzione, non toccare
- `gateway/` — config LiteLLM storica (gateway dismesso, vedi "Modelli AI"); non è più usata dal codice
- `docker/`, `.github/workflows/deploy.yml` — build e deploy (vedi sotto)

## Modello di dominio

- **App**: applicazione registrata: nome, `slug`, `base_url`, `internal_base_url` (raggiunto
  dall'esecutore al posto di `base_url`), autenticazione utente/servizio (header + scheme), segreto di
  servizio cifrato (mai esposto: l'API dice solo `serviceSecretSet`), `mcp_url` (server MCP dell'app, facoltativo), stato
- **Agent**: appartiene a una App; `system_prompt`, `model` (facoltativo: senza modello le run rispondono 409), stato (draft/active/inactive), ruolo:
  `general` (uno per app, creato con l'app, non eliminabile, usa tutti i tool `active` dell'app) o `area`
  (usa solo i tool collegati in `agent_tools`)
- **Tool** (`app_tools`): catalogo per App; `kind` (`http`, `mcp`, `ui`, `composite`: al modello si offrono
  solo `http` e `mcp`; `mcp` ha `definition {mcpName}`), `identity` (`user`: token dell'utente da `X-App-User-Token`; `service`:
  segreto di servizio), `level` (L0–L3) e `levelOverride` (al posto dei vecchi flag `requiresConfirmation`/`readOnly`), stato (draft/active/disabled), definizione
  (metodo, path, posizione dei parametri) e `params_schema` JSON (`"x-sensitive": true` oscura un parametro)
- **Run**: esecuzione di un Agent: input, output, errore, durata, token, stato
  (pending/running/awaiting_client/succeeded/failed/cancelled; `awaiting_client` è solo storico); i passi in `run_steps`

## Strumenti MCP e coda delle conferme

- Spec: `docs/superpowers/specs/2026-11-03-casello-strumenti-mcp-design.md`.
- Livelli d'azione dei tool (`app_tools.level`): L0 lettura, L1 scrittura reversibile/a basso rischio (eseguita dalla
  run), L2 azione con effetti verso terzi (mai eseguita dalla run: va in coda e la decide l'utente), L3 mai offerta al
  modello. `levelOverride` può solo alzare il livello. Livello dei tool MCP: `_meta["casello/level"]` del server; senza,
  `readOnlyHint` → L0, altrimenti L2.
- Server MCP dell'app: `apps.mcp_url` (stesse regole di indirizzo e autenticazione dell'app); i suoi strumenti diventano
  tool `kind mcp` con `definition {mcpName}`. «Aggiorna strumenti» = `POST /api/apps/:id/mcp-tools/refresh` (6/min): nuovi
  → `draft`, cambiati → aggiornati, spariti → `disabled`; omonimi di tool esistenti o nomi non validi → `conflicts`;
  nomi ripetuti dal server → 502. Client (`lib/tools/mcp-client.ts`): `tools/list` 30 s e max 500 strumenti,
  `tools/call` 15 s e risposta max 1 MiB, nessun redirect, nessun flusso SSE con GET; credenziali e valori
  `x-sensitive` oscurati; messaggi fissi in italiano.
- Coda (`pending_actions`, numerata per utente, `UNIQUE(user_id, number)`): i tool L2 hanno `destinatario` e `sintesi`;
  proprietario = chi possiede l'account AI del modello della run. Controllo del testo (`text-check.ts`): segnaposto e
  menzioni sugli argomenti oscurati. Max 50 azioni `pending` per utente. Argomenti cifrati (`args_enc`), copia pubblica
  oscurata (`args_public`). Tipi di voce (`pending_actions.kind`, default `action`): `action` (L2 di un tool), `plan` e
  `plan_change` (piano o modifica del PLAN proposti dal capo di una squadra, vedi "Squadre (esecuzione)"); colonne
  `team_instance_id` (squadra, `SET NULL`) e `plan_version`; per `plan`/`plan_change` `tool_id` e `app_id` sono null
  (CHECK: obbligatori solo con `kind = action`) e `args_enc`/`args_public` contengono la proposta; l'approvazione non
  vuole `userToken`. Numerazione e limite di 50 valgono per tutti i tipi.
- Route (`routes/pending-actions.ts`; il limite di 20/min vale solo per approvare e rifiutare, non per le GET): `GET /api/pending-actions`, `GET /api/pending-actions/:number`,
  `POST …/approve` (con `userToken` se l'identità del tool è `user`), `POST …/reject` (nota ≤ 500 caratteri). Ambiti
  token `api:read` (GET) e `api:write` (approvare/rifiutare). Esecuzione esattamente una volta: UPDATE condizionato
  `pending` → `executing`; all'avvio le azioni `executing` diventano `failed` («esito incerto: verifica sul servizio»).
  Nessuna scadenza. `pending_actions.tool_id` è `ON DELETE RESTRICT`: eliminare un tool con azioni in coda o già
  decise è rifiutato (409 «il tool ha azioni in coda o già decise: disattivalo invece di eliminarlo»), si disattiva;
  eliminando un'app si elimina anche il suo storico della coda (stessa transazione).
- Console: pagina «Da confermare» con contatore (`pendingActions` in `/api/dashboard/stats`, conta tutti i tipi) e colonne
  tipo (Azione / Piano / Modifica del piano) e squadra.
- Migrazioni: `docs/migrations/2026-11-strumenti-mcp.sql` (additiva: PRIMA del merge) e
  `2026-11-strumenti-mcp-post.sql` (DOPO il deploy: toglie `app_tools.requires_confirmation|read_only` e
  `runs.pending_action|loop_state|paused_at`). Il codice non legge più quelle colonne.

## Squadre (definizione)

- Spec: `docs/superpowers/specs/2026-11-03-casello-squadre-definizione-design.md` (sottoprogetto 3a). Una squadra è un
  insieme di ruoli con un capo, skill e strumenti: si definisce come **modello** riusabile e si applica a un lavoro come
  **istanza** (es. The Hub Up · WI 1174). Struttura a stella: un solo capo, gli altri ruoli riferiscono a lui. Squadra
  trasversale alle app: ogni ruolo sceglie strumenti (`app_tools`) di qualunque app; l'istanza è legata a un'app e a un
  lavoro (`ref_app_id`, `ref_type`, `ref_id`, `ref_title`).
- **Skill** (`skills` + `skill_versions`): codice unico (`^[a-z0-9][a-z0-9._-]{1,63}$`), tipo `casello` (istruzioni, max
  20 000 caratteri, non vuote; `tool_hints` informativi) o `node` (nome della skill sul nodo, `^[a-zA-Z0-9:_-]{1,100}$`, niente
  `tool_hints`). Versioni immutabili: `PATCH` di `content`/`toolHints` crea la versione `current_version + 1` (riga bloccata
  FOR UPDATE; max 200 versioni → 409), nome e descrizione si cambiano senza nuova versione. Deprecata (`POST …/deprecate`):
  resta dove già usata, non entra in ruoli nuovi.
- **Modello** (`team_templates` + `team_template_versions`): ogni `PUT` (nome, descrizione e ruoli insieme, tutto o niente)
  crea una versione con il suo manifesto jsonb; le skill nel modello sono codici senza versione. Nome unico tra i non
  archiviati (409 «nome già usato»); modello archiviato → 409 «modello archiviato» (non si salva né si copia). `DELETE`
  cancella se non ha istanze, altrimenti archivia e risponde `{deleted, archived}`.
- **Manifesto del ruolo** (`manifest.ts`): `key` (`^[a-z0-9_-]{1,40}$`, stabile tra versioni), `name` (1..80), `task`
  (max 8 000), `isLead`, `runsOn` `cloud`|`node`, `aiModelId`, `tools` (id di `app_tools`), `skills`; nell'istanza le skill
  sono `{code, version}` fissate e c'è `localSkills` (codici delle skill specializzate).
- **Regole** (`rules.ts`, `validateRoles`, a ogni salvataggio di modello o istanza; violazione → 400 con messaggio fisso in
  `TEAM_MESSAGES`, nulla salvato): un solo capo («una squadra ha esattamente un capo»); 1..20 ruoli, `key` e `name` unici,
  ≤ 30 skill per ruolo (catalogo + specializzate); `cloud` → `aiModelId` di un modello dei propri account («modello non
  disponibile»), `node` → `aiModelId` null; skill `node` solo su ruoli `node`; skill inesistenti o deprecate rifiutate,
  salvo quelle già nel ruolo della versione precedente (stessa `key`); nelle istanze la versione fissata deve esistere;
  strumenti `active` e con livello effettivo ≠ L3 («lo strumento <nome> non può essere usato da una squadra»), salvo
  quelli già nel ruolo precedente. La validazione legge dal pool ed è SEMPRE fuori dalla transazione di scrittura.
  Strumento poi disattivato o L3 resta nel ruolo e si legge con `available: false` (eliminato: nome «strumento eliminato»).
- **Istanza** (`team_instances`, `roles` jsonb, `team_instance_skills`): `POST /team-instances` copia il manifesto della
  versione corrente del modello fissando ogni skill alla sua `current_version` (`template_version`), `draft`; senza modello
  i `roles` sono obbligatori. `ref_title` di default `<tipo> · <id>`. Skill specializzate (max 100 per istanza, codice
  unico per istanza e con il formato del catalogo, stesse regole di contenuto delle skill): `PUT` sostituisce ruoli e
  skill specializzate insieme, può portare `status` `draft`↔`active`; `POST …/close` chiude (non si riapre né si salva più:
  409 «squadra chiusa», anche su `GET …/updates`). `ref_app_id` è `RESTRICT`, `template_id` `SET NULL`.
- **Aggiornamenti proposti** (`updates.ts`): `GET /api/team-instances/:id/updates` confronta il modello corrente con la
  versione copiata (`template_version`) e le skill con la loro versione corrente. Tipi: `role_added`, `role_removed`,
  `role_changed` (per campo: nome, compito, luogo, modello, strumenti, capo), `skill_added`, `skill_removed`, `skill_version`;
  `id` stabile (es. `role_changed:<key>:<campo>`). Una voce compare solo se il modello è cambiato rispetto alla versione
  copiata E l'istanza non ha già il valore proposto: le modifiche fatte solo nella squadra e i valori già uguali non
  generano voci; dopo un'applicazione parziale un valore può essere riproposto finché non si applicano tutte le
  modifiche del modello.
  `POST …/updates/apply` con `{ids}` (senza ripetizioni, 400 «aggiornamenti ripetuti»): tutto o niente, valida il
  risultato (es. senza capo → 400), un id non più attuale o un'istanza cambiata nel frattempo → 409 «aggiornamenti
  cambiati: ricarica». `template_version` passa alla versione corrente solo se non restano voci del modello (le
  `skill_version` non contano).
- **Salva come modello** (`POST …/save-as-template`, 201): `{mode: "new" | "new_version", name?, promote?: [{localCode, code}]}`
  (max 100). `new` richiede il nome (400) e crea un modello con le skill del catalogo senza versione; le specializzate
  elencate in `promote` entrano nel catalogo (v1) con il codice nuovo (già usato → 409, formato non valido → 400, ripetizioni
  → 400), le altre vengono tolte; `new_version` crea la versione successiva del modello d'origine, che ne conserva nome e
  descrizione (409 se l'istanza non ha modello o è archiviato) e riallinea l'istanza d'origine: `template_version` alla
  nuova versione e, per le skill promosse, nei ruoli la skill del catalogo (v1) al posto di quella specializzata (che
  si toglie dall'istanza), così non restano aggiornamenti spuri. Tutto o niente, in una transazione.
- Regole e legami: ruoli con strumenti o skill ripetuti → 400 («strumenti/skill ripetuti nel ruolo <nome>», verificati da
  `validateRoles` con gli schemi del manifesto). Copiando da un modello, skill deprecate e strumenti non più usabili già
  presenti nel modello restano ammessi. Un'app che è il lavoro di riferimento di una squadra non si elimina: `DELETE
  /api/apps/:id` → 409 «l'app è il lavoro di riferimento di <n> squadre».
- Route: `GET|POST /api/skills`, `GET|PATCH /api/skills/:code`, `POST …/deprecate`, `GET …/versions`, `GET …/versions/:version`;
  `GET|POST /api/team-templates` (`archived`), `GET|PUT|DELETE /api/team-templates/:id`, `GET …/versions/:version`;
  `GET|POST /api/team-instances` (filtri `status`, `appId`, `refType`, `refId`), `GET|PUT /api/team-instances/:id`,
  `POST …/close`, `GET …/updates`, `POST …/updates/apply`, `POST …/save-as-template`. Con un token personale valgono gli
  ambiti per metodo (`api:read` / `api:write`); errori con `{error}` in italiano, mai il testo del DB.
- Console: voci di menu «Skill» (elenco con filtri, scheda con versioni e confronto), «Modelli di squadra» (ruoli, capo
  evidenziato, editor) e «Squadre» (istanze, skill specializzate, riquadro «Aggiornamenti disponibili», «Salva come
  modello», «Attiva»/«Chiudi»); niente scorrimento orizzontale a 1280 px.
- Migrazione: `docs/migrations/2026-11-squadre.sql` (additiva e idempotente, nessuna modifica a tabelle esistenti, niente
  `-post`): da applicare in produzione PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`.
- L'esecuzione (3b) è descritta in "Squadre (esecuzione)". Non ancora fatto: 4 nodo locale (esecuzione dei ruoli `node`,
  scambio di file con la cartella della CR, verifica delle skill presenti sul nodo). Organizzazioni e policy dei dati (2) e
  The Hub Up (5) restano fuori.

## Squadre (esecuzione)

- Spec: `docs/superpowers/specs/2026-11-04-casello-squadre-esecuzione-design.md` (sottoprogetto 3b). Dove il codice differisce
  dalla spec vale il codice, descritto qui. Una squadra `active` lavora sul suo lavoro di riferimento: il capo tiene il PLAN,
  assegna compiti ai ruoli `cloud`, riceve gli esiti; gli eventi alimentano il bollettino; l'utente decide da console o dal
  centralino. Esecuzione in background nel processo dell'API (come run e analisi), senza `run-executor` né la tabella `agents`.
- **Attivazione**: `POST /api/team-instances/:id/activate` (`draft` → `active`, `activated_by` = chi attiva, che riceve le
  voci in coda e paga con i propri account; già attiva → 409 «la squadra è già attiva», chiusa → 409 «squadra chiusa»):
  crea il PLAN `draft` se manca e accoda un turno con motivo `activation`, tutto in una transazione. Si attiva SOLO così:
  `PUT /api/team-instances/:id` non cambia più lo stato (`status: "active"` → 400 «usa Attiva per avviare la squadra»,
  `draft` su una squadra attiva → 409 «una squadra attiva non torna in bozza: chiudila»). `POST …/close` annulla i
  compiti `queued` (`cancelled`, nel PLAN `failed`), rifiuta le voci `plan`/`plan_change` aperte («squadra chiusa») e fa
  fallire i turni in coda; compiti e turni `running` finiscono da soli ma non fanno partire altri turni.
- **Capo a turni** (`turn-runner.ts`): non resta acceso; riceve un turno per un motivo (`team_turns.reasons` jsonb: `activation`,
  `restart`, `request` con testo, `task_finished` con id, `decision` con numero, esito e nota). Al più un turno `queued` e uno
  `running` per squadra (indici unici parziali): un motivo nuovo si accoda al turno `queued` con un'unica INSERT … ON CONFLICT
  (`turn-queue.ts`); presa in carico con UPDATE condizionato `queued` → `running`; finito un turno parte quello accumulato.
  Limiti: 6 giri, 90 s di tempo attivo, 40 000 token. Il modello è quello del ruolo capo (ruolo `node` → turno `failed`).
  Richieste e note di rifiuto dell'utente arrivano come messaggi `user`, mai nel prompt di sistema; i risultati degli
  strumenti sono dati. Un turno fallito chiude `failed` con l'errore ed emette `bloccato`; `team_instances.last_turn_at`.
- **PLAN** (`plan.ts`; `team_plans` una riga per squadra, `team_plan_versions` una riga per versione): `status`
  `draft` | `proposed` | `approved`, `version` (+1 a ogni versione), `approved_version`; obiettivo ≤ 2 000, vincoli e punti
  aperti ≤ 30 da 500, compiti ≤ 50 (`id` `t1`, `t2`… stabile, titolo ≤ 200, `roleKey`, istruzioni ≤ 4 000, stato
  `planned|running|waiting_node|done|blocked|failed`, esito ≤ 300), azioni manuali ≤ 30 (`m1`… , testo ≤ 500, `done`).
  Due modi di scrivere: `writePlanVersion` (versione nuova: proposte e correzioni) e `patchPlan` / `setPlanStatus` (sul
  posto, senza versione nuova: stato ed esito dei compiti, azioni manuali, punti aperti, approvazione/rifiuto). La versione
  approvata si legge da `team_plan_versions` (`getApprovedPlan`): la riga corrente può già essere una proposta.
  Ordine dei lock: riga della squadra → riga del PLAN → righe di `pending_actions`; letture e validazioni dal pool, fuori
  dalle transazioni di scrittura.
- **Strumenti del capo** (`lead-tools.ts`, risultati `ok: false` con messaggio fisso, mai eccezioni): `leggi_piano`;
  `proponi_piano` (obiettivo, vincoli, punti aperti, compiti con `id` per gli esistenti, senza per i nuovi; id sconosciuto →
  «id di compito sconosciuto: ometti l'id per i compiti nuovi»; ruolo inesistente rifiutato); `aggiorna_piano` (punti aperti,
  azioni manuali, stato/esito dei compiti non in corso: `planned|done|blocked|failed`, compito in corso →
  «il compito <id> è in corso: aspetta il suo esito»); `assegna_compito` (solo compito del PLAN approvato in `planned|blocked|failed`,
  altrimenti «il compito non è nel piano approvato: proponi una modifica» o «il compito è già in corso»); `leggi_esito`;
  `segnala` (`bloccato|decisione_richiesta|azione_manuale_richiesta`, bollettino ≤ 300, dettaglio ≤ 4 000;
  `azione_manuale_richiesta` aggiunge l'azione al PLAN, max 30); `chiudi_lavoro` (evento `lavoro_finito`: la squadra resta
  attiva finché l'utente non la chiude). Tutti i capo-strumenti che scrivono bloccano la squadra e falliscono con «la squadra
  non è attiva» se non lo è. Il capo usa anche i suoi strumenti di app (livelli di sempre; L2 in coda con `team_instance_id`).
- **Proposte e approvazioni**: senza versione approvata `proponi_piano` scrive la versione `proposed` e accoda una voce
  `plan`; con una versione approvata, una modifica rilevante (obiettivo, vincoli, compiti aggiunti/tolti, titolo/ruolo/istruzioni
  di un compito: `isRelevantChange`) accoda una `plan_change` con le differenze (`diffSummary`); una modifica non rilevante
  non chiede approvazione (solo punti aperti sul posto, oppure versione nuova già `approved` se la riga corrente non era
  la versione approvata, e allora una proposta aperta è ritirata con evento «Il capo ha ritirato la proposta di piano»).
  Una proposta nuova rifiuta le voci `plan`/`plan_change` ancora aperte («superata da una nuova proposta»). Versione nuova,
  rifiuti e voce in coda stanno nella stessa transazione: se la voce non si può accodare (es. 50 in attesa) non resta
  scritto nulla, evento `bloccato` «Piano non proposto: …». Stato ed esito dei compiti si conservano dalla riga corrente,
  dall'ultima esecuzione o dalla versione approvata; i compiti nuovi partono `planned`. Decisione (`plan-decisions.ts`,
  chiamata da `approveAction`/`rejectAction` per i tipi ≠ `action`): approvare rende approvata la versione proposta
  (`setPlanStatus`), rifiutare riporta il PLAN allo stato di prima (`approved` se c'è una versione approvata, altrimenti
  `draft`; nessuna versione nuova); poi un turno con motivo `decision` (numero, esito, nota). Proposta non più attuale
  (versione o stato cambiati) → la voce passa a `failed` «proposta superata da una versione più recente»; squadra chiusa:
  approvare → 409 «squadra chiusa», rifiutare toglie la voce senza turno.
- **Correzione dell'utente**: `PUT /api/team-instances/:id/plan` (stesso schema del PLAN; ruolo inesistente → «ruolo <key>
  inesistente», id ripetuto → «compito <id> ripetuto») scrive una versione nuova già `approved` (l'approvatore è l'utente),
  stato ed esito dei compiti esistenti restano quelli registrati (i nuovi sono `planned`), rifiuta le voci di piano aperte
  («superata dalla modifica dell'utente») e accoda al capo un turno `request` con le differenze. `POST
  …/plan/manual-actions/:actionId/done` segna «Fatto» sul posto (404 «azione manuale non trovata»). `GET …/plan` legge il PLAN
  (se manca lo crea `draft`).
- **Compiti** (`task-runner.ts`; `team_tasks` + `team_task_steps`, stati `queued|running|waiting_node|done|blocked|failed|cancelled`):
  `startTask` (da `assegna_compito`) crea l'esecuzione di un compito del PLAN approvato con la squadra bloccata:
  «la squadra non è attiva» se non lo è, «il compito è già in corso» se lo stesso compito ha già un'esecuzione
  `queued|running|waiting_node`. Ruolo `node` → `waiting_node` (lo prenderà il nodo locale, sottoprogetto 4), altrimenti
  `queued` e lo scheduler li porta a `running` (UPDATE con la squadra bloccata): al massimo 3 `running` per squadra, gli altri
  in coda. Il ruolo `cloud` esegue il ciclo dell'agente con prompt del ruolo, contenuto delle sue skill `casello` (versione
  fissata dell'istanza e specializzate), PLAN in sola lettura (messaggio `user`), istruzioni del compito, strumenti del ruolo
  (`app_tools` di più app, ognuno con la connessione della sua app, solo `active`, `http`/`mcp`, livello effettivo ≠ L3,
  identità solo di servizio: un tool `user` risponde «token utente mancante»; nome ripetuto o uguale a uno interno →
  `<nome>_<appId>`) più `riferisci` (`status` `done|blocked`, `outcome` ≤ 300, `detail` ≤ 20 000). Limiti come una run: 8 giri,
  120 s, 60 000 token. Fine: con `riferisci` l'esito è quello riferito; senza, l'ultimo messaggio (troncato a 300) con stato
  `done`; errore o limite → `failed`. Poi, in ogni caso: stato ed esito nel PLAN, evento (`compito_finito` se `done`, altrimenti
  `bloccato`) e turno del capo con motivo `task_finished`. Le azioni L2 di un ruolo vanno in coda all'utente che ha attivato la
  squadra (voce `action` con `team_instance_id`, la run non si ferma).
- **Eventi e bollettino** (`events.ts`; `team_events`): tipi `piano_proposto`, `compito_finito`, `bloccato`, `decisione_richiesta`,
  `azione_manuale_richiesta`, `lavoro_finito`, `interrotto`; bollettino ≤ 300 caratteri, dettaglio ≤ 4 000; mai segreti né
  indirizzi delle app. Il bollettino è dell'utente che ha attivato la squadra. `GET /api/team-instances/:id/events`,
  `GET /api/team-events?unread=true|false` (dell'utente, al massimo 200; altro valore → 400), `POST /api/team-events/read`
  con `{ids}` (risponde `{updated}`).
- **Centralino** (strumenti su `/mcp`, ambito `mcp`, 60 chiamate/min per utente; logica in `lib/teams/centralino.ts`, solo dati
  dell'utente: una squadra di un altro è «squadra non trovata»): `squadre_stato` (una riga per squadra attiva), `bollettino`
  (fino a 100 eventi non letti, li segna letti; `remaining` per gli altri), `squadra_dettaglio` (PLAN, ultimi 30 compiti,
  ultimi 20 eventi), `invia_al_capo` (`id`, `testo` ≤ 4 000: turno `request`; vuoto → «messaggio vuoto»; stesso contatore di
  10/min per utente di `POST …/messages`, oltre → «Troppe richieste: riprova tra poco»), `coda_da_confermare` (fino a 50
  voci `pending` con tipo, squadra, sintesi, `needsUserToken`), `approva` (`numero`, `userToken?`) e `rifiuta` (`numero`, `nota?`
  ≤ 500) per tutti i tipi. **Modello del centralino**: `users.centralino_ai_model_id`, `GET|PUT /api/account/centralino-model`
  (solo login; modello dei propri account, altrimenti 400; null = modello predefinito); oggi serve solo a `squadre_stato`
  quando le squadre attive sono più di 5 (riassunto in al massimo 5 righe, 30 s, 1 000 token; senza modello disponibile o in
  caso di errore, elenco completo; costo del riassunto solo nel log). In console: Account, carta «modello del centralino».
- **Costi e tetti**: ogni turno e compito registra token e costo (`prompt_tokens`, `completion_tokens`, `cached_tokens`,
  `cost_usd`; null = prezzo mancante). Prima di ogni turno o compito (`team-budget.ts`): tetto mensile della squadra
  (`team_instances.monthly_budget_usd`, `PUT /api/team-instances/:id/budget` `{monthlyBudgetUsd}`, null = nessuno; spesa del
  mese di turni e compiti dell'istanza ≥ tetto → «tetto di spesa della squadra raggiunto»), poi modello, account AI e utente
  come per le run; l'utente controllato è il proprietario dell'account del modello del ruolo (non per forza chi attiva). Un
  compito bloccato dal tetto chiude `blocked` (evento `bloccato`), un turno `failed` (evento `bloccato`). Restano i limiti
  tecnici per turno e per compito.
- **Avvio e riavvio** (`index.ts`): turni e compiti `running` diventano `failed` («interrotto dal riavvio») con un evento
  `interrotto` e il compito nel PLAN `failed`; le squadre `active` coinvolte ricevono un turno `restart`; poi ripartono i turni
  rimasti `queued` e i compiti `queued` delle squadre attive. Turno e compito presi in carico con UPDATE condizionato: una sola
  esecuzione alla volta.
- Route: `POST /api/team-instances/:id/activate`, `POST …/messages` (`{text}` ≤ 4 000, 202 `{queued}`, vuoto → 400
  «messaggio vuoto», squadra non attiva → 409 «la squadra non è attiva», 10/min per utente), `GET|PUT …/plan`, `POST
  …/plan/manual-actions/:actionId/done`, `GET …/tasks` (ultimi 200), `GET …/tasks/:taskId` (con i passi; 404 «compito non
  trovato»), `GET …/turns` (ultimi 50, con i passi), `GET …/events`, `PUT …/budget`, `GET /api/team-events`, `POST
  /api/team-events/read`. Con un token personale valgono gli ambiti per metodo.
- Console (scheda squadra, `pages/team-detail.tsx`): «Piano da approvare» (Approva / Rifiuta con nota), «Piano» (compiti con
  stato ed esito, azioni manuali con «Fatto», punti aperti, «Modifica»), «Scrivi al capo», «Attività» (turni e compiti con i
  passi), «Bollettino» («Segna come letti»), tetto di spesa, «Attiva». Polling ogni 5 s finché un turno o un compito è in
  coda o in corso, più un periodo di grazia di ~10 s dopo la fine o dopo un'azione dell'utente che accoda un turno. Niente
  scorrimento orizzontale a 1280 px.
- Migrazione: `docs/migrations/2026-11-squadre-esecuzione.sql` (additiva e idempotente, nessuna colonna tolta, niente `-post`):
  tabelle `team_plans`, `team_plan_versions`, `team_tasks`, `team_task_steps`, `team_turns`, `team_turn_steps`, `team_events`;
  colonne su `team_instances` (`activated_by`, `monthly_budget_usd`, `last_turn_at`), `pending_actions` (`kind`,
  `team_instance_id`, `plan_version`; `tool_id`/`app_id` nullable) e `users` (`centralino_ai_model_id`). Da applicare in produzione
  PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`.
- Non ancora fatto: 4 nodo locale (esecuzione dei ruoli `node` e dei loro compiti `waiting_node`, scambio di file con la
  cartella della CR, verifica delle skill sul nodo), chat del portale col modello del centralino, interfaccia in The Hub Up (5).

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
- "Chi configura paga": un utente sceglie solo modelli dei propri account; le run usano il modello salvato
  nell'agente (`agents.ai_model_id`; senza modello `POST /agents/:id/runs` risponde 409), le analisi quello scelto
  da chi le avvia (obbligatorio per le analisi cloud).
  Costi in `runs.cost_usd` e `analyses.cost_usd` (null = costo parziale, prezzo mancante); stima prima
  dell'analisi (`GET /api/ai/estimate`).
- Indirizzi dei provider: solo `https`; "Consenti rete privata" (solo personalizzato) ammette `http` e reti
  private, mai loopback, link-local o metadata. Nessun redirect seguito.
- Il gateway LiteLLM (account di sistema "Gateway Casello", variabili `AI_GATEWAY_*`) è dismesso e il codice è
  stato rimosso. Finché in produzione non si applica `docs/migrations/2026-10-pulizia-gateway-post.sql` (dopo il
  deploy), l'account senza proprietario, i suoi modelli e la riga `system_gateway` di `providers` restano nel DB e
  il codice li ignora (`LEGACY_GATEWAY_PROVIDER` in `lib/ai/providers.ts`): fuori da elenchi, scelte e catalogo,
  `resolveModel` li tratta come modello non disponibile. I nomi storici (`agents.model`, `analyses.model`) e i
  costi registrati restano.
- Route: `/api/ai/accounts` (+ `/:id/verify`, `/:id/default`, `/:id/models`), `/api/ai/models`,
  `POST /api/ai/models/:id/probe`, `/api/ai/estimate`.
- Modello predefinito e mappa: `users.default_ai_model_id` (`GET|PUT /api/account/default-model`, solo sessione).
  Per gli agenti che Casello crea (agente generale di un'app nuova, agenti approvati dall'architetto,
  `POST /agents`) `resolveAgentModel` sceglie: modello scelto → predefinito (solo se è ancora di un account
  dell'utente) → nessuno. `PUT /api/apps/:id/agent-models` imposta i modelli di tutti gli agenti dell'app: tutto
  o niente (un errore non salva nulla). Agente senza modello: run 409 «scegli un modello per l'agente»; analisi
  cloud: `aiModelId` obbligatorio.
- Migrazioni: `docs/migrations/2026-10-pulizia-gateway.sql` (additiva: PRIMA del merge; senza, ogni richiesta
  autenticata fallisce perché `users` si legge con select *) e `2026-10-pulizia-gateway-post.sql` (DOPO il deploy;
  prima verificare che `model_catalog` non esista più).
- Costi sempre sotto controllo: a parità di risultato si preferisce il modello o il percorso più economico.

## Dal piano alle issue

- Spec: `docs/superpowers/specs/2026-10-30-casello-piano-issue-design.md`. Le voci approvate del piano (capitoli
  `endpoint`, `completion`, `evolution`; da architetto o da chat) si creano come issue nel repo dell'app
  (`apps.source_repo`, installazione `source_installation_id`), una per voce. Niente PR/chiusura da Casello, niente webhook.
- Route (`routes/plan-issues.ts`, codice in `lib/plan-issues/`): `POST /api/apps/:id/plan/issues` con
  `{ itemIds (1..30, senza ripetizioni), dryRun? }`: `dryRun` dà l'anteprima (titolo, corpo, etichette, `skipped`) senza
  chiamare GitHub; altrimenti crea in sequenza e risponde per voce `created` | `skipped` | `failed`.
  `POST /api/apps/:id/plan/issues/refresh` rilegge lo stato e risponde col riepilogo. `GET /api/apps/:id/plan` espone
  `AppPlan.issues` (`available`, `unavailableReason`, `repo`, `open`, `closed`, `approvedWithoutIssue`, `checkedAt`) e
  `AnalysisItem.issue` (`repo`, `number`, `url`, `state`, `stateReason`, `checkedAt`; null anche durante la prenotazione).
- Dati: colonne `analysis_items.issue_repo|number|url|state|state_reason|created_at|checked_at` (indice parziale su
  repo + numero). Prenotazione: prima di chiamare GitHub la voce passa a `issue_state = 'creating'` con un UPDATE
  condizionato (`issue_number` e `issue_state` null): due richieste concorrenti non fanno doppioni; se la creazione su
  GitHub fallisce si toglie; se fallisce solo il collegamento alla voce (scrittura riprovata una volta) resta, la voce è
  `failed` («Issue creata su GitHub ma non collegata alla voce: ricollegala a mano (#n)») e il log riporta voce, repo,
  numero e indirizzo. All'avvio quelle rimaste si azzerano (`resetStaleIssueReservations`). Poi `open`/`closed` (+ `completed`,
  `not_planned`, `reopened`).
- Voci ammesse: `approved` e capitolo endpoint/completion/evolution, senza issue né prenotazione; le altre `skipped`;
  una voce non dell'app → 400. Ordine: completamento per fase e dipendenze, poi le altre; una dipendenza con issue
  diventa `#numero` nel corpo, altrimenti resta il titolo. Piè di pagina «Creata da Casello · piano di <app> · voce #id».
- Limiti: 30 voci per richiesta, 5 creazioni/min per utente (le anteprime no), refresh 6/min, pausa di 1 s tra due
  tentativi di creazione, lista delle issue di GitHub ≤ 10 pagine da 100 (con `since` = lettura più vecchia; un'issue non trovata
  resta com'era). Chiamate a `GITHUB_API_BASE`, niente redirect.
- Etichette (create sul repo se mancano, grigie): `casello`, capitolo (`endpoint`, `completamento`, `evoluzione`),
  `fase-N` (completamento), `P1`..`P5` (evoluzione).
- Repository e installazione: serve un'app con codice da GitHub tramite App (zip, nessun sorgente o solo token manuale
  → 409 «Collega il repository tramite l'App GitHub per creare le issue»); solo chi possiede l'installazione
  (`userHasInstallation`, altrimenti 403). Token di installazione ristretto al repo e a `issues: write`, solo in memoria.
- Errori: messaggi fissi in italiano (`ISSUE_MESSAGES`), mai il testo di GitHub. Fermano il lotto (le voci restanti
  `failed`): permesso Issues mancante, repo non trovato, issue disattivate, limite di richieste di GitHub. Solo la voce:
  GitHub non raggiungibile (rete, 5xx, 15 s), issue rifiutata (422). Errori sull'etichettatura o sul token e sul
  refresh → 502 col messaggio fisso.
- Console (pagina Piano): selezione delle voci approvate senza issue, anteprima e creazione, riepilogo con «Aggiorna
  stato» (parte da solo se l'ultima lettura ha più di 10 minuti), badge sulla voce (anche nella pagina dell'analisi).
- La rianalisi tratta le voci con issue come già pianificate (`chatPlannedItems`: origine chat o `issue_number` non
  null, capitoli endpoint, completion ed evolution) e non le ripropone: la fase catalog riceve quelle `endpoint`,
  completion ed evolution tutte. Anche il piano (`loadPlanItems`) porta con sé dalle analisi precedenti le voci
  approvate da chat o con un'issue, così badge e conteggi restano dopo una rianalisi.
- Migrazione: `docs/migrations/2026-10-piano-issue.sql` (additiva, da applicare in produzione PRIMA del merge e da
  segnalare nella PR, insieme al permesso Issues della GitHub App, vedi "Autenticazione").

## Tetti di spesa

- Tetto mensile in USD (null = nessun limite) per utente (`users.monthly_budget_usd`, pagina Account), per agente
  (`agents.monthly_budget_usd`, scheda agente), per account AI (`ai_accounts.monthly_budget_usd`: una chiave, il credito
  si carica per chiave) e per modello (`ai_models.monthly_budget_usd`); questi ultimi due nella pagina Account, solo sui
  propri account. Mese di calendario, ora italiana (`lib/budget.ts`).
- Spesa dell'utente (chi configura paga): run, analisi cloud e conversazioni del piano con un modello dei suoi account
  AI (una conversazione, a costo cumulativo, conta nel mese del suo ultimo turno). Spesa dell'agente: le sue
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
  finché il provider lo è). Un account `custom` con chiave, senza rete privata e con esattamente l'indirizzo
  predefinito di un provider gestito (es. Gemini) diventa quel provider alla lettura dei modelli (creazione,
  modifica, «Verifica», aggiornamento del catalogo), così i modelli prendono prezzi e strumenti dal catalogo.
  Gemini elenca i modelli come `models/<id>`, ma l'endpoint compatibile OpenAI li vuole senza prefisso:
  l'esecutore lo toglie nella chiamata (`providerModelName`).
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
  di tutti gli account degli utenti e ricollega `ai_models` alle offerte; all'avvio le esecuzioni rimaste
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
- Limiti noti: l'enum Postgres `ai_provider` resta nel DB inutilizzato fino alla migrazione
  `2026-10-pulizia-gateway-post.sql`, che lo elimina insieme al vecchio gateway.

## Agenti operativi (fase 1)

- Spec: `docs/superpowers/specs/2026-10-25-casello-agenti-operativi-design.md`.
- Limiti per turno: 8 giri di tool, 120 s di tempo attivo (ogni chiamata al
  modello è limitata dal tempo rimasto, minimo 1 s), 60 000 token. Per chiamata HTTP: 15 s, risposta
  massima 1 048 576 byte. Nessuna pausa per la conferma: i tool L2 vanno in coda e la run
  continua (vedi "Strumenti MCP e coda delle conferme"). Le run `awaiting_client` rimaste dal vecchio meccanismo si chiudono
  `cancelled` all'avvio.
- L'esecutore raggiunge solo `internal_base_url` (o `base_url`) + path del tool: dagli argomenti del
  modello arrivano solo valori codificati. Gli indirizzi e gli header di autenticazione si validano
  già al salvataggio dell'app.
- Il token dell'utente vive solo in memoria per la durata della run: mai nel DB né nei log. Credenziali
  rimandate dall'app nelle risposte vengono sostituite con `***`; gli argomenti `x-sensitive` sono
  oscurati nei passi e nell'azione in coda pubblica.

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
- Fonte MCP: se l'app ha `mcp_url` l'architetto legge gli strumenti del server (`list_mcp_tools`, `read_mcp_tool`) e
  propone tool con `kind` (`http`/`mcp`) e `level`; il livello proposto non scende mai sotto quello dichiarato dal
  server, nemmeno se modificato in revisione. Le lacune dello strumentario MCP diventano voci `endpoint`.

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
- La rianalisi dell'architetto riceve le voci da chat approvate (e quelle con un'issue) come "già pianificate" (fasi
  completion ed evolution; la fase catalog solo quelle `endpoint`) e non le ripropone. Nel piano restano anche le voci
  da chat approvate delle analisi precedenti.
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
- Alternativa al cookie: token personale `cas_…` con ambiti `api:read`/`api:write` (vedi "Token personali su `/api`").
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
- GitHub App su github.com: permessi Contents read, Issues read & write (per creare le issue del piano: ogni installazione deve accettare il
  nuovo permesso; il token con cui l'architetto legge il codice resta `contents: read`), Metadata read, Email
  addresses read (account); "Request
  user authorization (OAuth) during installation" attivo, nessun Setup URL, nessun webhook; Callback URL
  `${PUBLIC_APP_URL}/api/auth/github/callback`.

## Token personali su `/api`

- Spec: `docs/superpowers/specs/2026-10-31-casello-token-api-design.md`. Il token `cas_…` (Account → "Token personali")
  vale anche su `/api`, per agenti che agiscono su Casello stesso e per script/automazioni.
- Ambiti (`api_tokens.scopes`, almeno uno, senza ripetizioni, immutabili dopo la creazione): `mcp` (server `/mcp`),
  `api:read` (GET/HEAD su `/api`), `api:write` (tutti i metodi, include la lettura). Default alla creazione `["mcp"]`;
  i token esistenti sono diventati `{mcp}`: nessun permesso nuovo.
- Regola unica in `requireAuth` (`lib/auth.ts`): con l'header `Authorization` presente conta solo il token, mai il
  cookie (nemmeno con `AUTH_DISABLED`); header non `Bearer cas_…`, token sconosciuto/revocato/scaduto o utente non più
  in `ALLOWED_EMAILS` → 401 «token non valido o scaduto». Senza header vale la sessione. Ambito per metodo (GET/HEAD →
  `api:read` o `api:write`; POST/PUT/PATCH/DELETE → `api:write`), altrimenti 403 «il token non ha l'ambito per questa
  operazione». Messaggi in `TOKEN_MESSAGES`. `req.auth` = `{kind:"session"}` | `{kind:"token", tokenId, scopes}`.
- Solo con il login (`sessionOnly`; con un token 403 «operazione disponibile solo con il login»): `GET|POST
  /account/tokens`, `DELETE /account/tokens/:id`; `POST /ai/accounts`, `PATCH|DELETE /ai/accounts/:id`,
  `POST /ai/accounts/:id/verify|default|models`, `PATCH /ai/models/:id` (chiavi, indirizzi, prezzi, tetti);
  `PUT /budget`; `DELETE /auth/github` e `GET /auth/github/link` (con un token, l'account GitHub che completa il
  flusso verrebbe collegato all'utente del token e darebbe un login completo).
- `GET /api/auth/me` accetta anche il token e risponde con l'utente più `auth` (`{kind:"session"}` o
  `{kind:"token", scopes}`).
- Limite: 120 richieste/min per token (`tokenRateLimit`, chiave: id del token), oltre ai limiti per utente/IP → 429.
- Log: mai header `Authorization`, token o hash. Un errore del DB nella verifica del token risponde 500 fisso
  («errore interno») e registra solo il nome dell'errore (i parametri della query conterrebbero l'hash).
- Migrazione: `docs/migrations/2026-10-token-api.sql` (additiva, idempotente): da applicare in produzione PRIMA del
  merge e da segnalare nella PR.
- Casello come app di sé stesso: registrarlo come App con `internal_base_url` `http://casello-api:3000`,
  autenticazione utente header `Authorization` + scheme `Bearer`, tool con identità `user`; il token arriva come
  "Token di prova" della run oppure, con identità `service`, come segreto di servizio dell'app.
- In sviluppo con `AUTH_DISABLED=true` i token funzionano solo se `ALLOWED_EMAILS` include `dev@localhost`.

## Esecutore locale

Le analisi dell'architetto possono essere eseguite da Claude Code sul Mac dell'utente invece che dal cloud
(`analyses.executor`). L'agente si collega al server MCP su `/mcp` (Streamable HTTP stateless, solo POST,
60 chiamate/min per utente; nginx ha `location /mcp`) con un token personale `cas_…` creato in console
(Account → "Token personali", casella "Agente locale (MCP)", ambito `mcp`; tabella `api_tokens`, salvato come hash). `/mcp` richiede l'ambito `mcp`: un token senza riceve 401 («token non valido o scaduto»). Gli esiti di fase stanno in
`analysis_phase_results`; la lease dura 15 minuti (rinnovo con consegna o `ping_analysis`). Migrazione:
`docs/migrations/2026-10-esecutore-locale.sql` (da applicare in produzione e segnalare nella PR). Procedura
dell'agente: skill `docs/skills/casello-architetto-locale/SKILL.md`. Il server `/mcp` espone anche `read_mcp_tools`
(strumenti del server MCP dell'app, per l'analisi locale) e gli strumenti del centralino (`squadre_stato`, `bollettino`,
`squadra_dettaglio`, `invia_al_capo`, `coda_da_confermare`, `approva`, `rifiuta`; logica in `lib/teams/centralino.ts`, solo
dati dell'utente del token; `invia_al_capo` condivide il limite 10/min con `POST …/messages` via `consumeTeamMessage`;
modello del centralino: `GET|PUT /api/account/centralino-model`, solo login).

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
  `CASELLO_SECRET_KEY`
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
