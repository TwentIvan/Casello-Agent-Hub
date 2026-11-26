# Collaudo del lavoro prima di «Porta in produzione» — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a ogni lavoro in `awaiting_release` un agente collaudatore avvia l'App su un runner di GitHub del repository di
collaudo di Botcave, la prova e consegna video, screenshot, resoconto e un link dal vivo nella voce «Porta in produzione».

**Architecture:** modulo `lib/collaudo/` nell'API (dati, protocollo con token d'ambito proprio, coda dei comandi con attesa
lunga, lancio del workflow, agente con `runAgentLoop`, scheduler e sorveglianza), programma `artifacts/casello-collaudo/` che
gira sul runner e fa solo connessioni in uscita, servito da `casello-web` sotto `/downloads/collaudo/`; console: sezione
«Collaudo» della voce di rilascio, carta «Collaudo» della scheda App e di Account.

**Tech Stack:** TypeScript, Express 5, Drizzle, Vitest con PGlite, OpenAPI + Orval, React + shadcn, Playwright (solo sul
runner), `cloudflared` (solo sul runner).

**Spec:** `docs/superpowers/specs/2026-11-26-botcave-collaudo-rilascio-design.md`

## Global Constraints

- Testi visibili in italiano, «Botcave» e mai «Casello»; identificatori in inglese; nessun riferimento a Batman.
- Errori con messaggi fissi (`COLLAUDO_MESSAGES`), mai il testo di GitHub, del modello o del DB; nei log solo id, sha a 7, conteggi, esiti.
- Migrazione additiva e idempotente in `docs/migrations/2026-11-26-collaudo-rilascio.sql`, senza BEGIN/COMMIT, riportata in `docs/schema-casello.sql`; la applica il deploy.
- Contract-first: ogni route pubblica in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen`; la console usa solo hook Orval.
- Console: solo token di `design/tokens.css` (niente colori Tailwind né esadecimali), stati con `Led`, niente scorrimento orizzontale a 1280 px.
- Limiti della spec, valori esatti: codice monouso 32 byte, 15 minuti; token del collaudo ≤ 80 minuti, lease 5 minuti; attesa lunga 25 s; risultato di un comando ≤ 6 minuti; `shell` timeout ≤ 300 s e uscita ≤ 8 000 caratteri; snapshot ≤ 12 000; video ≤ 30 MB; ≤ 20 screenshot PNG ≤ 2 MB; file cancellati dopo 30 giorni; agente 40 giri (avvio ≤ 15), 300 000 token, 40 minuti attivi; link dal vivo 30 minuti; al più 3 collaudi `running` per installazione e uno per App; «Riaccendi» ≤ 6 al giorno per voce; correzioni automatiche ≤ 2 per lavoro; resoconto ≤ 8 000, ≤ 20 problemi, ≤ 20 note non provabili; ricetta ≤ 20 passi, comandi su una riga ≤ 500.
- Variabile nuova facoltativa `COLLAUDO_REPO` (`owner/nome`) su `casello-api`; senza, collaudo `skipped` «Collaudo non configurato: preparalo in Account (una volta sola)».
- Modello: quello del capo; con un modello Claude Code (nodo) il ripiego cloud del suo account; altrimenti `skipped`. Spesa nel tetto della squadra (o del ciclo) e in utente, modello, account.
- `pnpm run typecheck` verde prima di ogni commit; commit in italiano `feat(casello): …` con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Due lavori che finiscono quasi insieme per App diverse con 3 collaudi già in corso: il quarto resta `queued` e parte quando uno finisce, senza doppio lancio dello stesso collaudo (Task 6, test `scheduler rispetta i limiti e lancia una volta`).
2. Runner che non arriva mai (workflow non partito, repository di collaudo senza permesso): il collaudo chiude `failed` «runner non partito entro 15 minuti» e la voce resta decidibile (Task 6, test `codice scaduto chiude il collaudo`).
3. Lavoro rimandato e richiuso mentre il vecchio collaudo è ancora `running`: il vecchio passa a `cancelled`, i suoi comandi e report ricevono 401, il nuovo parte sulla nuova testa (Task 6, test `nuovo collaudo annulla il precedente`).
4. Uscite dei comandi o resoconto che contengono una chiave: salvati con `***` (Task 3, test `uscite ripulite dalle credenziali`; Task 5, test `resoconto ripulito`).
5. Approvare o rifiutare la voce mentre il collaudo è in corso: la decisione vale, il collaudo prosegue e non rifiuta da solo una voce già decisa (Task 6, test `correzione automatica salta una voce già decisa`).

---

### Task 1: dati e migrazione

**Files:**
- Create: `lib/db/src/schema/release-tests.ts` (esportato da `lib/db/src/schema/index.ts`)
- Modify: `lib/db/src/schema/apps.ts`, `lib/db/src/schema/team-works.ts`
- Create: `docs/migrations/2026-11-26-collaudo-rilascio.sql`; Modify: `docs/schema-casello.sql`
- Test: `artifacts/api-server/test/migration-collaudo-rilascio.test.ts`

**Interfaces:**
- Produces: tabelle `releaseTestsTable`, `releaseTestStepsTable`, `releaseTestCommandsTable`, `releaseTestFilesTable`, `appTestRecipesTable`; enum `release_test_status` (`queued|dispatching|running|done|failed|skipped|cancelled`), `release_test_outcome` (`ok|problems|not_startable`), `release_test_mode` (`full|relight`), `release_test_command_status` (`pending|sent|done|failed|expired`), `release_test_file_kind` (`video|screenshot`), `app_test_recipe_source` (`agent|user`); colonne `apps.test_recipe` jsonb, `apps.test_recipe_version` int default 0, `apps.test_auto_fix` boolean default false, `team_works.test_auto_rejects` int default 0. Tipi `ReleaseTestRow`, `ReleaseTestCommandRow`, `ReleaseTestFileRow`.
- Colonne di `release_tests` come §5 della spec, più `lease_expires_at`; indice unico parziale `release_tests_one_open_per_app` su `app_id` con `status in ('queued','dispatching','running')`; indice su `(status, created_at)`.
- `release_test_steps` copia le colonne di `team_task_steps` con `test_id` al posto di `task_id`.

- [ ] **Step 1: test di migrazione** — `migration-collaudo-rilascio.test.ts`: applica il file due volte su `docs/schema-casello.sql` senza errori; inserire due collaudi `queued` per la stessa App viola `release_tests_one_open_per_app`; un collaudo `done` e uno `queued` per la stessa App convivono.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run test/migration-collaudo-rilascio.test.ts` → FAIL (file mancante).
- [ ] **Step 3:** schema Drizzle, migrazione (`CREATE TYPE` dentro `DO $$ … EXCEPTION WHEN duplicate_object`, `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) e `docs/schema-casello.sql`.
- [ ] **Step 4:** test → PASS; `pnpm --filter @workspace/api-server exec vitest run test/migrations-auto.test.ts` → PASS.
- [ ] **Step 5:** typecheck e commit `feat(casello): tabelle del collaudo dei lavori`.

### Task 2: regole pure (ricetta, esiti, correzione automatica, messaggi)

**Files:**
- Create: `artifacts/api-server/src/lib/collaudo/messages.ts`, `recipe.ts`, `outcome.ts`
- Test: `artifacts/api-server/src/lib/collaudo/recipe.test.ts`, `outcome.test.ts`

**Interfaces:**
- Produces:
  - `COLLAUDO_MESSAGES` con almeno: `notConfigured` «Collaudo non configurato: preparalo in Account (una volta sola)», `noModel` «il capo non ha un modello cloud per il collaudo», `nodeNoFallback` «il capo usa Claude Code (nodo) senza ripiego cloud: il collaudo serve un modello cloud», `runnerNotStarted` «runner non partito entro 15 minuti», `timeout` «tempo del collaudo scaduto», `interrupted` «collaudo interrotto», `notDelivered` «collaudo non consegnato», `autoFixExhausted` «2 correzioni automatiche non sono bastate», `invalidRecipe(detail)` «ricetta non valida: …», `dispatchFailed` «lancio del collaudo non riuscito: controlla il repository di collaudo in Account».
  - `type TestRecipe = { install: string[]; build: string[]; services: { name: string; command: string; port: number; readyPath: string }[]; postgres: boolean; schema: string[]; env: Record<string, string>; startUrl: string; login: string | null }`.
  - `validateRecipe(input: unknown): { ok: true; recipe: TestRecipe } | { ok: false; error: string }` — comandi su una riga 1..500, passi totali (install + build + services + schema) ≤ 20, porta 1..65535, `env` ≤ 40 chiavi `^[A-Z_][A-Z0-9_]{0,63}$` con valori ≤ 500 senza `looksLikeCredential`, nessun comando con `looksLikeCredential`, `startUrl` percorso che comincia con `/`.
  - `type DeliveredOutcome = "ok" | "problemi" | "non_avviabile"`; `toDbOutcome(o: DeliveredOutcome): "ok" | "problems" | "not_startable"`.
  - `autoFixDecision(input: { outcome: "ok" | "problems" | "not_startable"; autoFix: boolean; autoRejects: number; itemPending: boolean }): "reject" | "keep" | "keep_exhausted"` — `reject` solo con esito negativo, `autoFix`, `autoRejects < 2`, voce ancora `pending`; `keep_exhausted` con esito negativo, `autoFix` e `autoRejects >= 2`.

- [ ] **Step 1: test** — `recipe.test.ts`: una ricetta valida passa; comando con `\n` → errore che contiene «una riga»; 21 passi → errore; `env` con `OPENAI_API_KEY: "sk-…"` di 40 caratteri → errore; porta 0 → errore. `outcome.test.ts`: tabella dei casi di `autoFixDecision` (negativo+autoFix+0 → reject; +2 → keep_exhausted; ok → keep; voce non pending → keep; autoFix spento → keep); `toDbOutcome` per i tre valori.
- [ ] **Step 2:** vitest dei due file → FAIL.
- [ ] **Step 3:** implementazione (riusa `looksLikeCredential` di `lib/memory/` o dov'è definita).
- [ ] **Step 4:** vitest → PASS.
- [ ] **Step 5:** commit `feat(casello): regole del collaudo`.

### Task 3: protocollo del runner e coda dei comandi

**Files:**
- Create: `artifacts/api-server/src/lib/collaudo/tokens.ts`, `commands.ts`, `protocol.ts`, `auth.ts`; `artifacts/api-server/src/routes/collaudo-runner.ts`
- Modify: `artifacts/api-server/src/app.ts` (montaggio di `/api/collaudo` con parser JSON da 256 KB e `requireCollaudoToken` prima di `requireAuth`, come `/api/node`), `artifacts/api-server/src/middlewares/rate-limit.ts`
- Test: `artifacts/api-server/src/lib/collaudo/commands.test.ts`, `artifacts/api-server/src/routes/collaudo-runner.test.ts`

**Interfaces:**
- Consumes: Task 1, `COLLAUDO_MESSAGES`.
- Produces:
  - `issueCode(testId: number): Promise<string>` (32 byte base64url, salva hash e scadenza +15 min); `claimTest(testId: number, code: string): Promise<ClaimPackage | null>`; `type ClaimPackage = { token: string; repo: string; sha: string; repoToken: string; recipe: TestRecipe | null; mode: "full" | "relight" }`. Token `ctk_` + 32 byte, solo hash nel DB, scadenza +80 min, lease +5 min; il claim porta il collaudo a `running` con UPDATE condizionato a `dispatching` e codice non scaduto (una volta sola). `repoToken` = token d'installazione dell'App, `contents: read`, ristretto al repository.
  - `requireCollaudoToken` (Express): `Bearer ctk_…` di un collaudo `running` non scaduto → `req.collaudo = { testId }`, altrimenti 401 `{error}`.
  - `enqueueCommand(testId: number, kind: "shell" | "browser", args: Record<string, unknown>): Promise<number>`; `waitCommandResult(commandId: number, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }>` (scaduto → `expired` e `{ok:false, output:"comando scaduto"}`); `nextCommand(testId: number, waitMs: number): Promise<{ id: number; kind: string; args: unknown } | null>` (attesa lunga con avviso in memoria, come `subscribeNodeSignal`; con l'esito già consegnato la route `next` risponde 410 «collaudo consegnato» e il runner passa al tunnel); `saveCommandResult(testId: number, commandId: number, r: { ok: boolean; output: string }): Promise<boolean>` (output ripulito con `looksLikeCredential` parola per parola → `***`, tagliato a 8 000).
  - Route runner: `POST /api/collaudo/claim` (pubblica, 10/min per IP), `POST /api/collaudo/next`, `POST /api/collaudo/results/:commandId`, `POST /api/collaudo/ping` (rinnova la lease), `POST /api/collaudo/tunnel {url, until}` (solo `https://<qualcosa>.trycloudflare.com`, `until` ≤ ora + 31 min), `POST /api/collaudo/files` (corpo grezzo, `X-File-Kind` `video|screenshot`, `X-File-Name`; tipo dai primi byte: WebM o PNG; limiti della spec → 413), `POST /api/collaudo/report {status: "done" | "failed", error?}` (revoca il token).

- [ ] **Step 1: test** — `commands.test.ts`: `enqueueCommand` + `nextCommand` restituisce il comando e lo segna `sent`; `nextCommand` senza comandi torna null dopo l'attesa; `saveCommandResult` sveglia `waitCommandResult`; **`uscite ripulite dalle credenziali`**: un output con `ghp_` seguito da 36 caratteri si salva con `***`. `collaudo-runner.test.ts`: claim con codice giusto → 200 e pacchetto, secondo claim → 401; codice scaduto → 401; `next` senza token → 401; `tunnel` con `https://evil.example` → 400; screenshot non PNG → 400; report revoca il token (la `next` dopo → 401).
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implementazione; nel finto GitHub dei test (`test/fake-github.ts`) il token d'installazione esiste già.
- [ ] **Step 4:** vitest → PASS.
- [ ] **Step 5:** commit `feat(casello): protocollo del runner di collaudo`.

### Task 4: lancio del workflow e configurazione

**Files:**
- Create: `artifacts/api-server/src/lib/collaudo/config.ts`, `dispatch.ts`, `setup.ts`
- Modify: `artifacts/api-server/test/fake-github.ts` (registra `POST /repos/{o}/{r}/actions/workflows/{file}/dispatches` → 204 e li elenca in `dispatches`)
- Test: `artifacts/api-server/src/lib/collaudo/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `collaudoRepo(): string | null` (legge `COLLAUDO_REPO` a ogni chiamata, formato `owner/nome` valido altrimenti null con un avviso).
  - `COLLAUDO_WORKFLOW = "collaudo.yml"`.
  - `dispatchTest(testId: number, code: string): Promise<{ ok: true } | { ok: false; error: string }>` — trova l'installazione con `repoInstallationId(cfg, repo)`, token ristretto con `{ actions: "write" }`, `POST …/dispatches` con `ref: "main"`, `inputs: { collaudo: String(testId), codice: code }`; 401/403/404 → `COLLAUDO_MESSAGES.dispatchFailed`.
  - `collaudoSetup(): Promise<{ repo: string | null; installed: boolean; workflow: boolean; actionsWrite: boolean }>` (legge il file del workflow con `contents: read` e prova il token `actions: write`).

- [ ] **Step 1: test** — `dispatch.test.ts`: con `COLLAUDO_REPO` impostato e il finto GitHub il lancio registra un dispatch con gli input attesi; senza variabile `collaudoRepo()` è null; installazione assente → `{ok:false, error: dispatchFailed}`; `collaudoSetup` riporta `workflow: false` se il file non c'è.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implementazione.
- [ ] **Step 4:** vitest → PASS.
- [ ] **Step 5:** commit `feat(casello): lancio del workflow di collaudo`.

### Task 5: collaudatore (agente)

**Files:**
- Create: `artifacts/api-server/src/lib/collaudo/prompts.ts`, `model.ts`, `run-test.ts`
- Modify: `artifacts/api-server/src/lib/teams/role-tools.ts` (nomi riservati `shell`, `browser`, `salva_ricetta`, `consegna_collaudo` in `INTERNAL_TOOL_NAMES`), `artifacts/api-server/src/lib/teams/team-spend.ts` e `artifacts/api-server/src/lib/budget.ts` (spesa di `release_tests` con `instance_id` e `ai_model_id`)
- Test: `artifacts/api-server/src/lib/collaudo/run-test.test.ts`, `model.test.ts`

**Interfaces:**
- Consumes: Task 2 (`validateRecipe`, `toDbOutcome`), Task 3 (`enqueueCommand`, `waitCommandResult`), `runAgentLoop`, `modelChatDeps`, `stepWriter`, `teamBudgetBlock`.
- Produces:
  - `testModelFor(instance: TeamInstanceRow): Promise<{ aiModelId: number; resolved: ResolvedModel } | { skip: string }>` — modello del ruolo capo; `kind: "node"` → ripiego dell'account come `usableLeadFallback` di `turn-runner.ts` (estrarre una funzione condivisa `usableNodeFallback(instanceId, node)` in `teams/turn-runner.ts` o in `lib/ai/`), altrimenti `skip` con `nodeNoFallback`; tetti con `teamBudgetBlock`.
  - `COLLAUDO_LIMITS: LoopLimits = { maxRounds: 40, maxActiveMs: 2_400_000, maxTokens: 300_000 }`; `MAX_START_ROUNDS = 15` (oltre il 15° giro senza ricetta valida salvata o usata il prompt dice di consegnare `non_avviabile`).
  - `runReleaseTest(testId: number, signal?: AbortSignal): Promise<void>` — messaggi: istruzioni fisse di `prompts.ts`; dati in messaggi `user` delimitati: App, repository, sha, ricetta salvata o null, sintesi dell'architettura (`app_architecture.summary`, se c'è), compiti del lavoro (id, titolo, issue, esito). Strumenti: `shell {command, cwd?, timeoutSec?, background?}`, `browser {action, url?, selector?, text?}`, `salva_ricetta {ricetta}` (scrive `apps.test_recipe`, `test_recipe_version + 1` e una riga di `app_test_recipes` con `source: agent`), `consegna_collaudo {esito, resoconto, problemi, nonProvabile}` (una volta, poi il ciclo si chiude). Resoconto e campi dei problemi ripuliti con `looksLikeCredential`. Fine: con consegna → `outcome`, `report`, `problems`, `not_testable`; senza → `error = notDelivered`. Token e costo su `release_tests`.

- [ ] **Step 1: test** — `model.test.ts`: capo cloud → il suo modello; capo nodo con ripiego → il ripiego; senza → `skip` con `nodeNoFallback`; tetto della squadra raggiunto → `skip`. `run-test.test.ts` (provider finto, coda dei comandi risolta da un finto runner in processo che risponde ai comandi): l'agente chiama `shell`, `salva_ricetta`, `consegna_collaudo {esito: "problemi"}` → collaudo con `outcome: problems`, ricetta salvata versione 1; **`resoconto ripulito`**: resoconto con una chiave `sk-` → salvato con `***`; ricetta non valida → risultato `{ok:false}` al modello e niente salvato; nessuna consegna → `error: notDelivered`; costo sommato e visibile in `teamSpend`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implementazione.
- [ ] **Step 4:** vitest → PASS; `pnpm --filter @workspace/api-server exec vitest run src/lib/teams` → PASS.
- [ ] **Step 5:** commit `feat(casello): agente collaudatore`.

### Task 6: ciclo di vita, scheduler, correzione automatica

**Files:**
- Create: `artifacts/api-server/src/lib/collaudo/service.ts`, `scheduler.ts`
- Modify: `artifacts/api-server/src/lib/teams/works.ts` (`ensureReleaseItem` chiama `requestReleaseTest(work.id)` dopo aver accodato la voce), `artifacts/api-server/src/lib/teams/release.ts` (a `released` azzera nulla: il contatore resta; espone `rejectReleaseForTest(actionId, note)` che usa `rejectRelease` in una transazione e accoda il turno come il rifiuto dell'utente), `artifacts/api-server/src/index.ts` (`startCollaudoScheduler()` dopo le pulizie dell'avvio)
- Test: `artifacts/api-server/src/lib/collaudo/service.test.ts`

**Interfaces:**
- Consumes: Task 2–5.
- Produces:
  - `requestReleaseTest(workId: number, mode: "full" | "relight" = "full"): Promise<number | null>` — annulla (`cancelled`, token revocato) un collaudo aperto della stessa App per un lavoro diverso o una testa diversa; crea `queued` con `sha = work.headSha`; idempotente per (lavoro, sha, mode) aperto. Senza `collaudoRepo()` crea direttamente `skipped` con `notConfigured`.
  - `scheduleReleaseTests(): Promise<void>` — al più 3 `running|dispatching` in tutto; prende i `queued` più vecchi, `dispatching` con UPDATE condizionato, `issueCode`, `dispatchTest`; errore → `failed` con il messaggio; per `mode: full` dopo il claim avvia `runReleaseTest` in background (avvio dal claim: `claimTest` chiama `onTestClaimed`).
  - `finishReleaseTest(testId: number)` — dopo l'esito: `autoFixDecision` con voce `release` del lavoro, `apps.test_auto_fix`, `team_works.test_auto_rejects`; `reject` → `rejectReleaseForTest` e `test_auto_rejects + 1` nella stessa transazione + evento `bloccato` «Collaudo del lavoro N: problemi, rimandato alla squadra»; `keep_exhausted` → evento con `autoFixExhausted`.
  - `sweepReleaseTests(now?: Date)` ogni 60 s: `dispatching` con codice scaduto → `failed` `runnerNotStarted`; `running` con lease scaduta → `failed` `interrupted`; token scaduto → `failed` `timeout`; file più vecchi di 30 giorni cancellati.
  - All'avvio: nessuna chiusura dei `running` (li chiude la lease); i `dispatching` restano allo sweep.

- [ ] **Step 1: test** — `service.test.ts`: **`scheduler rispetta i limiti e lancia una volta`** (4 App, 4 `queued`: 3 dispatch, il quarto parte dopo un `done`; due `scheduleReleaseTests` concorrenti non lanciano lo stesso collaudo due volte); **`codice scaduto chiude il collaudo`**; **`nuovo collaudo annulla il precedente`** (il vecchio `cancelled`, la sua `next` → 401); correzione automatica: esito `problems` con `testAutoFix` → voce `release` rifiutata, lavoro `open`, `test_auto_rejects = 1`, turno `request` del capo con il resoconto; al terzo → voce resta `pending` ed evento `autoFixExhausted`; **`correzione automatica salta una voce già decisa`**; senza `COLLAUDO_REPO` → `skipped` `notConfigured`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implementazione.
- [ ] **Step 4:** vitest → PASS; `pnpm --filter @workspace/api-server exec vitest run src/lib/teams test/code-team-flow.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(casello): ciclo di vita del collaudo`.

### Task 7: API pubblica, permessi, registro

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (tag `collaudo`: `ReleaseTest`, `ReleaseTestDetail` con `steps`, `files`, `activity`; `TestRecipe`; `CollaudoSetup`; `App.testAutoFix`, `App.testRecipeVersion`; `QueuedAction.releaseTest` facoltativo `{id, status, outcome}`), poi codegen
- Create: `artifacts/api-server/src/routes/release-tests.ts`
- Modify: `artifacts/api-server/src/routes/apps.ts` (PATCH `testAutoFix`), `artifacts/api-server/src/routes/pending-actions.ts` (campo `releaseTest`), `artifacts/api-server/src/lib/teams/centralino.ts` (esito del collaudo in `coda_da_confermare`), `artifacts/api-server/src/lib/auth.ts` (`AGENT_DENIED_ROUTES`), `artifacts/api-server/src/lib/audit/actions.ts` (`AUDIT_ROUTES`), `artifacts/api-server/src/middlewares/rate-limit.ts` (`consumeTestRelight`, 6 al giorno per voce)
- Test: `artifacts/api-server/src/routes/release-tests.test.ts`

**Interfaces:**
- Consumes: Task 6 (`requestReleaseTest`), `rejectRelease`.
- Produces route (ambiti per metodo): `GET /api/release-tests?workId=|appId=` (ultimi 20), `GET /api/release-tests/:id`, `GET /api/release-tests/:id/files/:fileId` (`attachment`, `nosniff`, `no-store`), `POST /api/release-tests/:id/relight` (solo con il collaudo `done` della voce ancora `pending`, 202), `POST /api/release-tests/:id/send-back` (rifiuto della voce con nota = resoconto ≤ 4 000, solo login, 409 se la voce non è più `pending`), `GET|PUT /api/apps/:id/test-recipe` (PUT valida con `validateRecipe`, `source: user`), `GET /api/collaudo/setup` e `POST /api/collaudo/setup/verify` (solo login). `agent` negato su relight, send-back, PUT ricetta, PATCH con `testAutoFix` (già coperto dal PATCH dell'App). Audit: `release_test.relight`, `release_test.send_back`, `app.test_recipe.update`.

- [ ] **Step 1: test** — `release-tests.test.ts`: elenco per lavoro; dettaglio con passi e file; scarico di un file altrui (collaudo di un'App inesistente) → 404; `relight` su collaudo non `done` → 409; `send-back` rifiuta la voce e risponde 204, poi di nuovo → 409; PUT ricetta non valida → 400 col messaggio; token `agent` su `relight` → 403; `GET /api/pending-actions` porta `releaseTest` sulla voce `release`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** OpenAPI, codegen (commit anche dei file generati), route.
- [ ] **Step 4:** vitest → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): API del collaudo`.

### Task 8: programma `casello-collaudo`

**Files:**
- Create: `artifacts/casello-collaudo/` (`package.json` versione `0.1.0`, `tsconfig.json`, `src/index.ts`, `src/client.ts`, `src/shell.ts`, `src/browser.ts`, `src/tunnel.ts`, `src/recipe-run.ts`, `src/loop.ts`, `scripts/build.mjs` con esbuild in un solo `dist/casello-collaudo.mjs`, README)
- Test: `artifacts/casello-collaudo/src/*.test.ts`

**Interfaces:**
- Consumes: protocollo del Task 3.
- Produces:
  - Uso: `node casello-collaudo.mjs --url <botcave> --collaudo <id> --codice <codice>` (il codice arriva dall'ambiente `COLLAUDO_CODICE` nel workflow, mai negli argomenti stampati).
  - `interface BrowserDriver { open(url: string): Promise<string>; click(sel: string): Promise<string>; fill(sel: string, text: string): Promise<string>; press(key: string): Promise<string>; snapshot(): Promise<string>; screenshot(): Promise<Buffer>; wait(ms: number): Promise<string>; close(): Promise<{ video: Buffer | null }> }`; `playwrightDriver()` con `import("playwright")` dinamico, contesto con `recordVideo`, snapshot con `page.locator("body").ariaSnapshot()` tagliato a 12 000.
  - `runShell(cmd: { command: string; cwd?: string; timeoutSec?: number; background?: boolean }, root: string): Promise<{ ok: boolean; output: string }>` — `bash -lc`, cwd dentro la cartella del repository (`realpath`, niente uscite), timeout ≤ 300 s con SIGTERM e SIGKILL dopo 5 s, uscita ≤ 8 000; `background` → processo staccato, risposta dopo 5 s con le prime righe e `id`.
  - `runRecipe(recipe: TestRecipe, root: string): Promise<{ ok: boolean; output: string; port: number }>` (per `relight`: install, build, schema, servizi in background, attesa di `readyPath` fino a 5 minuti).
  - `openTunnel(port: number): Promise<{ url: string; close(): void }>` — scarica `cloudflared` (URL fisso della release Linux amd64 con sha256 nel codice), avvia `tunnel --url http://localhost:<port>`, legge l'indirizzo `https://….trycloudflare.com` dall'uscita.
  - Ciclo (`loop.ts`): claim, clone (`git clone --depth 1` con il token nell'header `http.extraheader` solo nell'ambiente del comando), `next`/esecuzione/`results` fino a quando Botcave non risponde 410 «collaudo consegnato», ping ogni 30 s, upload screenshot dopo ogni `screenshot` e video a fine prova, tunnel 30 minuti, `report`. `mode: relight` salta l'agente: `runRecipe`, tunnel, report.

- [ ] **Step 1: test** — `shell.test.ts`: comando che esce 1 → `ok:false`; timeout di 1 s su `sleep 5` → `ok:false` con «tempo scaduto»; `cwd: "../"` → rifiutato; uscita di 20 000 caratteri → 8 000. `loop.test.ts` (server HTTP finto che fa da Botcave e `BrowserDriver` finto): claim → due comandi → risultati mandati nell'ordine → upload dello screenshot → tunnel finto → report `done`; un 401 sulla `next` → fine senza report. `recipe-run.test.ts`: ricetta con un servizio `node -e` che risponde su `readyPath` → `ok`.
- [ ] **Step 2:** `pnpm --filter @workspace/casello-collaudo run test` → FAIL.
- [ ] **Step 3:** implementazione.
- [ ] **Step 4:** test → PASS; `pnpm --filter @workspace/casello-collaudo run build` produce `dist/casello-collaudo.mjs`.
- [ ] **Step 5:** commit `feat(casello): programma del runner di collaudo`.

### Task 9: distribuzione e modello del repository di collaudo

**Files:**
- Modify: `docker/web.Dockerfile` (build di `casello-collaudo` e copia in `/usr/share/nginx/html/downloads/collaudo/` con `collaudo-manifest.json` `{version, file, sha256, size}` generato da `scripts/build.mjs`), `docker/nginx.conf.template` (`^~ /downloads/collaudo/` come `/downloads/nodo/`: file con versione nel nome cache 1 anno, manifest 1 ora), `.github/workflows/deploy.yml` (prova dell'immagine web: `expect /downloads/collaudo/collaudo-manifest.json "200 OK"`), `pnpm-workspace.yaml` se serve
- Create: `docs/collaudo/collaudo.yml` (workflow del modello, da copiare nel repository `TwentIvan/botcave-modello-collaudo` con una PR a parte) e `docs/collaudo/README.md`

**Interfaces:**
- Produces: workflow `collaudo.yml` con `on: workflow_dispatch: inputs: {collaudo, codice}`, `runs-on: ubuntu-latest`, `timeout-minutes: 80`, `permissions: {}`, servizio `postgres:16` con `POSTGRES_PASSWORD: collaudo` e porta 5432, passi: `actions/setup-node` (Node 24), scarica manifest e programma da `https://casello.fantamister.cloud/downloads/collaudo/`, verifica sha256, `npx playwright@<versione fissa> install --with-deps chromium`, `node casello-collaudo.mjs --url https://casello.fantamister.cloud --collaudo ${{ inputs.collaudo }}` con `COLLAUDO_CODICE: ${{ inputs.codice }}` e `::add-mask::` del codice come primo passo.

- [ ] **Step 1:** costruire l'immagine web in locale (`docker build -f docker/web.Dockerfile .`) e verificare che `/downloads/collaudo/collaudo-manifest.json` risponda 200 con `docker run` + `curl`.
- [ ] **Step 2:** `actionlint docs/collaudo/collaudo.yml` (se disponibile) oppure revisione a mano contro gli input del Task 4.
- [ ] **Step 3:** commit `feat(casello): distribuzione del programma di collaudo`.

### Task 10: console

**Files:**
- Create: `artifacts/casello/src/components/actions/release-test-section.tsx`, `artifacts/casello/src/components/apps/release-test-card.tsx`, `artifacts/casello/src/components/account/collaudo-setup-card.tsx`, `artifacts/casello/src/lib/release-test.ts`
- Modify: `artifacts/casello/src/components/actions/release-detail.tsx`, `artifacts/casello/src/pages/app-detail.tsx` (carta), `artifacts/casello/src/pages/account.tsx` (carta), `artifacts/casello/src/components/panel/tabs/pending-tab.tsx` (esito e «Apri in Botcave»)
- Test: `artifacts/casello/src/lib/release-test.test.ts`

**Interfaces:**
- Consumes: hook Orval del Task 7.
- Produces: `releaseTestLed(t: { status; outcome }): "ok" | "ko" | "work" | "idle"`, `releaseTestLabel(t)` (testi: «Collaudo in coda», «Collaudo in corso», «Collaudo superato», «Problemi trovati», «L'App non si avvia», «Collaudo saltato: <motivo>», «Collaudo non riuscito: <motivo>», «Collaudo annullato»), `tunnelRemaining(until: string, now: Date): string | null` («23 min»; null se scaduto), `autoFixCounter(n: number): string` («correzioni automatiche n di 2»).
- Sezione nella voce: LED e testo, attività dal vivo (polling 5 s mentre `queued|dispatching|running`), resoconto Markdown, problemi con miniatura dello screenshot (apertura a tutta pagina), `<video controls>` del file video, «Prova dal vivo» (link `target="_blank"` `rel="noopener"`) con tempo residuo e la nota «link pubblico temporaneo, dati di prova», «Riaccendi», «Rimanda alla squadra» (conferma), contatore. Carta App: interruttore «Correggi da solo i problemi del collaudo», ricetta in sola lettura con «Modifica» (dialogo JSON validato dal server), ultimi collaudi. Carta Account: tre passi con LED dal `GET /api/collaudo/setup` e «Verifica».

- [ ] **Step 1: test** — `release-test.test.ts`: `releaseTestLed` per ogni stato ed esito; `tunnelRemaining` con 23 minuti residui e con scadenza passata; `autoFixCounter(1)`.
- [ ] **Step 2:** `pnpm --filter @workspace/casello run test` → FAIL.
- [ ] **Step 3:** implementazione delle funzioni pure e dei componenti.
- [ ] **Step 4:** test → PASS; typecheck; controllo a 1280 px senza scorrimento orizzontale con `pnpm run dev` (`AUTH_DISABLED=true`) su una voce `release` con un collaudo finto inserito nel DB di sviluppo.
- [ ] **Step 5:** commit `feat(casello): collaudo nella console`.

### Task 11: prova di flusso e documentazione

**Files:**
- Create: `artifacts/api-server/test/release-test-flow.test.ts`
- Modify: `CLAUDE.md` (sezione «Collaudo del lavoro», righe in «Stato», «Dove stanno le cose», tabelle in «Dove stanno le cose», variabile in «Deploy»)

**Interfaces:**
- Consumes: tutto.

- [ ] **Step 1: test di flusso** — API in memoria con finto GitHub (dispatch registrato) e finto provider; il «runner» è il ciclo vero di `casello-collaudo` (Task 8) in processo con `BrowserDriver` finto e `runShell` su una cartella temporanea: lavoro chiuso → `awaiting_release` → collaudo `queued` → dispatch → claim → l'agente scopre e salva la ricetta → `consegna_collaudo {esito: "problemi"}` → con `testAutoFix` voce rifiutata, capo svegliato con il resoconto, `test_auto_rejects = 1` → lavoro richiuso con nuova testa → nuovo collaudo `ok` con la ricetta salvata → «Riaccendi» parte in `relight` senza chiamate al modello (`fake.requests` invariato) e manda il link.
- [ ] **Step 2:** vitest del file → PASS (dopo eventuali correzioni nei task precedenti).
- [ ] **Step 3:** `pnpm run typecheck`, test dell'API (`pnpm --filter @workspace/api-server run test`), della console e di `casello-collaudo` → tutti verdi.
- [ ] **Step 4:** CLAUDE.md aggiornato; commit `docs(casello): collaudo del lavoro`.

## Dopo il merge (a mano, una volta)

1. PR verso `TwentIvan/botcave-modello-collaudo` con `docs/collaudo/collaudo.yml` in `.github/workflows/`, segnata come «Template repository».
2. Creare il repository di collaudo privato dal modello, aggiungerlo all'installazione dell'App GitHub, accettare il permesso Actions: write.
3. Impostare `COLLAUDO_REPO` su `casello-api` e rifare il deploy; in Account → «Collaudo» premere «Verifica».
4. Chiudere un lavoro reale di «Sviluppo Botcave» e controllare video, resoconto e link nella voce.
