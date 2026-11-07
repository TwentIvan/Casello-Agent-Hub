# Botcave · The Hub Up 5c tappa 1 — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** coda delle run, ambito `runs` e Responsabile di prodotto in Botcave; in The Hub Up, brief e smistamento email avviati su
Botcave e collegamenti dei messaggi limitati all'organizzazione.

**Architecture:** in Botcave la route delle run smette di avviare: crea la run `pending` e uno scheduler nel processo dell'API
(`lib/run-queue.ts`) la porta a `running` nel rispetto dei limiti. Il Responsabile è l'agente `general` con le scritture sempre in coda;
gli agenti di area lo raggiungono con lo strumento interno `segnala_al_responsabile`, che crea una run figlia nella stessa coda. The Hub
Up ha un modulo `server/botcave/` (configurazione, instradamento, client, input) chiamato da IMAP e dal context maintainer, senza stato.

**Tech Stack:**
- Botcave: Express 5, Drizzle, Postgres (PGlite nei test), Vitest, React + Orval, pnpm 10, Node 24;
- The Hub Up: Express, Drizzle, Vitest + supertest, npm.

**Spec:** `docs/superpowers/specs/2026-11-07-botcave-the-hub-up-5c-tappa-1-design.md` (leggerla prima di ogni task: i numeri di §
citati sotto sono suoi).

## Global Constraints

- **Lingua:** italiano per commenti, messaggi d'errore, documentazione e commit (`feat(casello): …` in Botcave, `feat(botcave): …` in
  AbapCrm); codice e identificatori in inglese.
- **Botcave:** `pnpm run typecheck` verde prima di ogni commit. Dopo ogni modifica a `openapi.yaml`: `pnpm --filter @workspace/api-spec
  run codegen` e commit dei file generati. Mai fetch a mano nella console, solo hook Orval.
- **Schema Botcave:** ogni modifica a `lib/db/src/schema/` va anche in `docs/schema-casello.sql` e in
  `docs/migrations/2026-11-thu-5c-tappa1.sql` (additiva, idempotente, niente `-post`).
- **Botcave, identità:** niente colori nell'interfaccia, gli stati con `Led`, nei testi visibili «Botcave».
- **The Hub Up:** `npm run check` e `npm test` verdi prima di ogni commit; branch `feat/botcave-5c-tappa1` da `origin/main` nel clone
  `~/Projects/AbapCrm`. Il clone locale è su `feat/botcave-plugin`: si crea il branch in un worktree
  (`git worktree add ../AbapCrm-5c origin/main -b feat/botcave-5c-tappa1`), senza toccare il ramo corrente.
- **Valori fissi:**

  | Costante | Valore |
  |---|---|
  | `MAX_RUNNING_PER_AGENT` | 2 |
  | `MAX_RUNNING_RUNS` | 6 |
  | `MAX_PENDING_PER_AGENT` | 200 |
  | Controllo di riserva dello scheduler | 30 s |
  | Limite delle run per token | 60/min |
  | Descrizione funzionale nel prompt | ≤ 12 000 caratteri |
  | `richiesta` | 1..2 000 |
  | `oggetto` | ≤ 200 |
  | `motivo` | ≤ 1 000 |
  | Input d'origine nella segnalazione | ≤ 8 000 |
  | Testo dell'email nell'input | ≤ 8 000 |
  | Timeout del client di The Hub Up | 10 s |
- **Messaggi fissi:**
  - «troppe run in attesa per questo agente»;
  - «token utente perso al riavvio: rilancia la run»;
  - «hai già segnalato al responsabile in questa run»;
  - «il responsabile di prodotto non è disponibile»;
  - «troppe run in attesa per il responsabile»;
  - «messaggio o oggetto non trovato»;
  - «il token non ha l'ambito per questa operazione» (esiste già: `TOKEN_MESSAGES.scope`).
- **Nessuna azione esterna senza conferma di Ivan:** Neon, Coolify, push, PR, merge, configurazione in produzione.

## Review Focus

1. **Run di un agente il cui modello o tetto cambia mentre è in coda:** alla partenza deve valere lo stato di quel momento (tetto
   raggiunto → `failed` col motivo, senza chiamare il modello), non quello del POST. Test in Task 2.
2. **Due chiamate dello scheduler sovrapposte** (fine di una run e POST nello stesso istante): non devono superare 2 per agente né far
   partire due volte la stessa run. Test in Task 2.
3. **Token con ambito `runs` su `GET /api/runs`** (l'elenco, non il dettaglio) e su `POST /api/runs/:id/cancel`: devono rispondere 403,
   perché l'ambito è chiuso alle tre route. Test in Task 3.
4. **Agente di area di un'App il cui Responsabile viene disattivato tra la creazione della run e la chiamata allo strumento:** deve dare
   `ok: false` «il responsabile di prodotto non è disponibile», senza creare run. Test in Task 5.
5. **Email del destinatario giusto ma dell'organizzazione sbagliata, o configurazione Botcave parziale:** deve restare interna, senza
   errori all'avvio di The Hub Up. Test in Task 8.

---

## Parte A — Botcave (questo repository, branch `feat/botcave-the-hub-up-5c`)

### Task 1: Schema e migrazione

**Files:**
- Modify: `lib/db/src/schema/runs.ts`, `lib/db/src/schema/agents.ts`
- Modify: `docs/schema-casello.sql`
- Create: `docs/migrations/2026-11-thu-5c-tappa1.sql`
- Test: `artifacts/api-server/test/migration-thu-5c-tappa1.test.ts` (sul modello di `test/migration-nodo-cartelle.test.ts`)

**Interfaces:**
- Produces:
  - `runsTable.parentRunId: integer | null`, FK su `runs.id` `ON DELETE SET NULL`;
  - `runsTable.hasUserToken: boolean`, not null, default false;
  - `agentsTable.confirmWrites: boolean`, not null, default false;
  - indice `runs_agent_status_idx` su `(agent_id, status)` e indice `runs_parent_run_id_idx` su `parent_run_id`.

- [ ] **Step 1: test della migrazione.** Applica lo schema precedente (come gli altri test di migrazione), poi la migrazione due volte
  (idempotente). Verifica:
  - colonne e default;
  - una run esistente ha `has_user_token = false` e `parent_run_id` null;
  - eliminare la run madre mette a null `parent_run_id` della figlia.
- [ ] **Step 2: eseguire il test e verificare che fallisca.**
  `pnpm --filter @workspace/api-server run test -- migration-thu-5c-tappa1` → FAIL (file di migrazione assente).
- [ ] **Step 3: scrivere i file.**
  - **Migrazione:** `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`, FK aggiunta solo se manca (`DO $$ … IF NOT EXISTS (select from
    pg_constraint …)`), `CREATE INDEX IF NOT EXISTS`.
  - **Drizzle:** le stesse colonne.
  - **`schema-casello.sql`:** le stesse colonne.
- [ ] **Step 4: verificare.** Lo stesso comando → PASS; `pnpm run typecheck` → verde.
- [ ] **Step 5: commit.** `feat(casello): colonne per la coda delle run e il Responsabile di prodotto`

### Task 2: Coda delle run

**Files:**
- Create: `artifacts/api-server/src/lib/run-queue.ts`, `artifacts/api-server/src/lib/run-queue.test.ts`
- Modify: `artifacts/api-server/src/lib/run-executor.ts` (`startRun`, `failInterruptedRuns`), `artifacts/api-server/src/routes/agents.ts`
  (POST runs), `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/lib/run-executor.test.ts`
- Modify: `lib/api-spec/openapi.yaml` (`triggerRun`: risposta 429)

**Interfaces:**
- Consumes: colonne del Task 1; `runBudgetBlock(agent)` di `lib/budget.ts`; `setUserToken` di `lib/user-tokens.ts`.
- Produces (in `run-queue.ts`):
  - le costanti `MAX_RUNNING_PER_AGENT = 2`, `MAX_RUNNING_RUNS = 6`, `MAX_PENDING_PER_AGENT = 200`;
  - `RUN_QUEUE_MESSAGES = { queueFull: "troppe run in attesa per questo agente", userTokenLost: "token utente perso al riavvio: rilancia la run" }`;
  - `createQueuedRun(input: { agent: Agent; input: string | null; parentRunId?: number | null; userToken?: string }): Promise<{ ok: true; run: Run } | { ok: false; reason: "queue_full" }>`.
    Conta le `pending` dell'agente, inserisce la run (`aiModelId` dell'agente, `hasUserToken` = token presente), mette il token in
    memoria con `setUserToken` e chiama `scheduleRuns()` senza attenderla;
  - `scheduleRuns(): Promise<void>`. Un giro alla volta nel processo: una chiamata durante un giro ne programma esattamente un altro
    dopo. Legge le `running` per agente e in totale, poi le `pending` in ordine `created_at, id`, e avvia quelle che stanno nei limiti
    con `startRun(id).catch(log).finally(() => scheduleRuns())`;
  - `startRunQueue(): () => void`. Lancia subito `scheduleRuns()` e poi ogni 30 s; restituisce la funzione di stop (per i test).
- Changes:
  - `startRun(runId, opts)` non riceve più il token: lo legge con `getUserToken`;
  - dopo `loadContext`, `runBudgetBlock(ctx.agent)`: se è bloccato, chiude la run `failed` con il messaggio del tetto **senza**
    prefisso «Errore durante l'esecuzione:», come `RunWithoutModelError`;
  - `failInterruptedRuns()` restituisce `{ failed, cancelled, userTokenLost }`: `running` → failed come oggi; `pending` con
    `has_user_token` → failed con `userTokenLost`; le altre `pending` restano.

- [ ] **Step 1: test in `run-queue.test.ts`** (fake provider come `run-executor.test.ts`, con risposte che si possono trattenere per
  tenere le run `running`):
  - `con 5 run dello stesso agente ne partono 2, le altre restano pending; finita una ne parte un'altra in ordine di creazione`;
  - `con 4 agenti da 2 run ciascuno al massimo 6 running in totale`;
  - `scheduleRuns chiamata due volte insieme non supera i limiti e non avvia due volte la stessa run`
    (`Promise.all([scheduleRuns(), scheduleRuns()])`; una sola riga di passi per run);
  - `createQueuedRun con 200 pending dell'agente → { ok: false, reason: "queue_full" }, nessuna riga inserita`;
  - `una run pending annullata non parte`;
  - `tetto dell'agente raggiunto dopo il POST: alla partenza failed con il messaggio del tetto e nessuna chiamata al provider`.
- [ ] **Step 2: test in `run-executor.test.ts` e nella route.**
  - `failInterruptedRuns: running → failed, pending con has_user_token → failed «token utente perso al riavvio: rilancia la run», pending senza token restano pending`;
  - `POST /agents/:id/runs → 202 pending`;
  - `oltre 200 in attesa → 429 { error: "troppe run in attesa per questo agente" }`.
- [ ] **Step 3: eseguire i test e verificare che falliscano.**
  `pnpm --filter @workspace/api-server run test -- run-queue run-executor` → FAIL.
- [ ] **Step 4: implementare.**
  - La route usa `createQueuedRun` (con `userTokenFrom(req)`) al posto dell'INSERT e di `startRun`.
  - In `index.ts`: `startRunQueue()` dopo `failInterruptedRuns()`.
  - In `openapi.yaml`: risposta 429 di `triggerRun` con `ErrorResponse`; poi il codegen.
- [ ] **Step 5: verificare.** Gli stessi test → PASS; `pnpm --filter @workspace/api-server run test` → tutto verde; `pnpm run typecheck`.
- [ ] **Step 6: commit.** `feat(casello): coda delle run con limiti per agente e in totale`

### Task 3: Limite per token e ambito `runs`

**Files:**
- Modify: `artifacts/api-server/src/middlewares/rate-limit.ts`, `artifacts/api-server/src/routes/agents.ts`,
  `artifacts/api-server/src/lib/api-tokens.ts`, `artifacts/api-server/src/lib/auth.ts`, `lib/api-spec/openapi.yaml` (enum degli ambiti
  alla riga ~6663, con la sua descrizione)
- Test: `artifacts/api-server/src/routes/token-access.test.ts`, `artifacts/api-server/src/lib/api-tokens.test.ts`

**Interfaces:**
- Produces:
  - `"runs"` in `TOKEN_SCOPES` e in `PERSONAL_TOKEN_SCOPES`;
  - `RUNS_SCOPE_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; path: RegExp }>` in `lib/auth.ts`, con
    `POST ^/agents/\d+/runs$`, `GET ^/runs/\d+$`, `GET ^/runs/\d+/steps$`, confrontati con `req.path` del middleware montato su `/api`
    (verificare il punto di montaggio e adattare il prefisso);
  - `hasScopeFor(method: string, path: string, scopes: TokenScope[]): boolean`: vero come oggi con `api:read`/`api:write`, oppure con
    `runs` se metodo e percorso stanno in `RUNS_SCOPE_ROUTES`;
  - `runTriggerRateLimit` in `rate-limit.ts`: con `req.auth?.kind === "token"` e un `tokenId` non null usa un contatore
    `limit: 60, windowMs: 60_000` per id del token; altrimenti delega a `runRateLimit`. La route POST delle run usa questo al posto di
    `runRateLimit`; le analisi restano su `runRateLimit`.

- [ ] **Step 1: test in `token-access.test.ts`.**
  - `solo runs: POST /agents/:id/runs 202, GET /runs/:id 200, GET /runs/:id/steps 200`;
  - `solo runs: GET /runs, GET /apps, POST /runs/:id/cancel → 403 scope`;
  - `runs + api:read: GET /apps 200`;
  - `solo runs su /mcp → 401`;
  - `61ª run nel minuto con lo stesso token → 429, un altro token no; con la sessione vale ancora 10/min per IP`.
- [ ] **Step 2: test in `api-tokens.test.ts`.** `createToken con ["runs"] accettato; con ["node"] ancora rifiutato`.
- [ ] **Step 3: eseguire i test e verificare che falliscano.**
  `pnpm --filter @workspace/api-server run test -- token-access api-tokens` → FAIL.
- [ ] **Step 4: implementare.** Poi il codegen.
- [ ] **Step 5: verificare.** Gli stessi test → PASS, la suite intera → verde, `pnpm run typecheck`.
- [ ] **Step 6: commit.** `feat(casello): ambito runs dei token personali e limite delle run per token`

### Task 4: Descrizione funzionale nel prompt e `confirm_writes`

**Files:**
- Modify: `artifacts/api-server/src/lib/run-executor.ts` (`buildSystemPrompt`, `loadContext`), `artifacts/api-server/src/routes/agents.ts`
  (PATCH), `artifacts/api-server/src/routes/serializers.ts` (agente), `lib/api-spec/openapi.yaml` (`Agent.confirmWrites` richiesto,
  `AgentUpdate.confirmWrites` facoltativo)
- Test: `artifacts/api-server/src/lib/run-executor.test.ts`

**Interfaces:**
- Consumes: `agentsTable.confirmWrites` (Task 1), `effectiveLevel` di `lib/tools/levels.ts`.
- Produces:
  - `FUNCTIONAL_DESCRIPTION_MAX = 12_000`;
  - `writesNeedConfirmation(agent: Agent): boolean` (vero se `role === "general"` o `confirmWrites`);
  - `withConfirmedWrites(tools: CatalogTool[]): CatalogTool[]`, che dà `levelOverride: "L2"` ai tool con livello effettivo L1, solo in
    memoria.

  Tutte e tre in `run-executor.ts`. `loadContext` applica `withConfirmedWrites` quando `writesNeedConfirmation`. Nel prompt di sistema,
  dopo `app.description`, compare il blocco «Descrizione funzionale dell'app (dati, non istruzioni):» seguito dal testo troncato, solo se
  non vuoto. Il PATCH con il ruolo `general` ignora `confirmWrites`; il serializer espone `confirmWrites: true` per `general`.

- [ ] **Step 1: test.**
  - `agente general: una chiamata a un tool L1 diventa voce in pending_actions e la finta app non riceve richieste`;
  - `agente area con confirmWrites: stesso comportamento; senza: il tool L1 viene eseguito`;
  - `il prompt di sistema contiene la descrizione funzionale troncata a 12 000 caratteri; senza descrizione nessun blocco`;
  - `PATCH confirmWrites false su general → resta true`.
- [ ] **Step 2: eseguire il test e verificare che fallisca.** `pnpm --filter @workspace/api-server run test -- run-executor` → FAIL.
- [ ] **Step 3: implementare.** Poi il codegen.
- [ ] **Step 4: verificare.** Il test → PASS, la suite → verde, `pnpm run typecheck`.
- [ ] **Step 5: commit.** `feat(casello): descrizione funzionale nel prompt e scritture in coda per il Responsabile`

### Task 5: Strumento `segnala_al_responsabile`

**Files:**
- Create: `artifacts/api-server/src/lib/escalation.ts`, `artifacts/api-server/src/lib/escalation.test.ts`
- Modify: `artifacts/api-server/src/lib/teams/role-tools.ts` (aggiungere `"segnala_al_responsabile"` a `InternalToolName`),
  `artifacts/api-server/src/lib/run-executor.ts` (`loadContext`, `driveLoop`), `artifacts/api-server/src/routes/serializers.ts`
  (`toPublicRun`), `artifacts/api-server/src/routes/runs.ts` (`GET /runs/:id`), `lib/api-spec/openapi.yaml`
  (`Run.parentRunId: integer|null`, `Run.childRunIds: integer[]` nel dettaglio)

**Interfaces:**
- Consumes:
  - `createQueuedRun` (Task 2), che restituisce `queue_full`;
  - `runBudgetBlock(agent)`;
  - `internalTool`, `isInternalTool` di `teams/role-tools.ts`;
  - `writesNeedConfirmation` (Task 4).
- Produces (in `escalation.ts`):
  - `ESCALATION_TOOL_NAME = "segnala_al_responsabile"`;
  - `ESCALATION_MESSAGES = { already: "hai già segnalato al responsabile in questa run", unavailable: "il responsabile di prodotto non è disponibile", queueFull: "troppe run in attesa per il responsabile" }`;
  - `escalationTool(): CatalogTool`, schema JSON con `richiesta` (string, 1..2000, obbligatoria), `oggetto` (≤ 200), `motivo` (≤ 1000);
  - `productLead(appId: number): Promise<Agent | null>`, l'agente `general` dell'App se `active` e con `aiModelId`;
  - `escalationInput(source: { agentName: string; runId: number; input: string | null }, args: { richiesta: string; oggetto?: string; motivo?: string }): string`,
    il testo della spec §4.3, con l'input d'origine troncato a 8 000;
  - `handleEscalation(run: Run, agent: Agent, args: Record<string, unknown>): Promise<ToolResult>`. Nell'ordine: argomenti non validi
    → `ok: false` col motivo; figlia già esistente (`select … where parent_run_id = run.id`) → `already`; `productLead` null →
    `unavailable`; tetto → messaggio di `runBudgetBlock`; `queue_full` → `queueFull`; altrimenti `{ ok: true, content:
    JSON.stringify({ ok: true, runId }) }`.
- Changes:
  - `loadContext`: se `agent.role === "area"`, `run.parentRunId === null` e `productLead(app.id)` non è null, i tool diventano
    `[...tools.filter(t => t.name !== ESCALATION_TOOL_NAME), escalationTool()]`. Lo strumento si aggiunge **dopo**
    `withConfirmedWrites` (Task 4), che va applicato solo ai tool dell'App: con `confirmWrites` la segnalazione non deve finire in coda
    (test: `agente area con confirmWrites: la segnalazione crea la run figlia e non una voce in pending_actions`);
  - `driveLoop`: `executeTool` manda gli strumenti interni a `handleEscalation`; `toFunctionTools` non conosce il tipo interno, quindi
    si usa `roleFunctionTools(appTools, internal)` come nelle squadre;
  - `GET /runs/:id` aggiunge `childRunIds` (le figlie in ordine di id).

- [ ] **Step 1: test in `escalation.test.ts`** (fake provider che chiama lo strumento):
  - `agente area con Responsabile attivo: la chiamata crea una run pending del Responsabile con parentRunId e input con <segnalazione> e <input_origine> troncato a 8 000`;
  - `seconda chiamata nella stessa run → ok:false «hai già segnalato al responsabile in questa run», una sola figlia`;
  - `la run figlia non riceve lo strumento; il Responsabile non lo riceve`;
  - `Responsabile disattivato tra la creazione della run e la chiamata → ok:false «il responsabile di prodotto non è disponibile», nessuna run`;
  - `tetto del Responsabile raggiunto → ok:false col messaggio del tetto; la run madre finisce succeeded`;
  - `200 pending del Responsabile → «troppe run in attesa per il responsabile»`;
  - `un tool dell'App chiamato segnala_al_responsabile non viene offerto quando c'è lo strumento interno`;
  - `GET /runs/:id della madre ha childRunIds [id figlia], la figlia ha parentRunId`.
- [ ] **Step 2: eseguire il test e verificare che fallisca.** `pnpm --filter @workspace/api-server run test -- escalation` → FAIL.
- [ ] **Step 3: implementare.** Poi il codegen.
- [ ] **Step 4: verificare.** Il test → PASS, la suite → verde, `pnpm run typecheck`.
- [ ] **Step 5: commit.** `feat(casello): segnalazione al Responsabile di prodotto con run figlia`

### Task 6: Console

**Files:**
- Modify:
  - `artifacts/casello/src/pages/run-detail.tsx` e `runs.tsx` (stato `pending` = «In coda» con `Led` `idle`; «Nata dalla run N» e «Ha
    segnalato al responsabile: run M» con i link);
  - `artifacts/casello/src/pages/agent-detail.tsx` e `agents.tsx` (casella «Tutte le scritture in "Da confermare"», bloccata e attiva
    per il ruolo `general`; etichetta del ruolo `general` «Responsabile di prodotto»);
  - `artifacts/casello/src/components/account/api-tokens-section.tsx` (casella «Avvio delle run (app ospiti)», ambito `runs`).

**Interfaces:**
- Consumes: i campi generati da Orval `Run.parentRunId`, `Run.childRunIds`, `Agent.confirmWrites`, ambito `runs`.

- [ ] **Step 1: implementare** con gli hook Orval già usati dalle pagine (nessun fetch a mano, nessun colore, niente scorrimento
  orizzontale a 1280 px).
- [ ] **Step 2: verificare.** `pnpm run typecheck`; `pnpm --filter @workspace/casello run test` → verde. Con
  `AUTH_DISABLED=true pnpm run dev` aprire un agente generale (casella bloccata, etichetta), creare un token `runs`, aprire una run
  figlia e la madre (link), e fare uno screenshot di ciascuna nel pannello del browser.
- [ ] **Step 3: commit.** `feat(casello): console per coda, Responsabile di prodotto e ambito runs`

### Task 7: Documentazione e preparazione della PR

**Files:**
- Modify: `CLAUDE.md`. Nuova sezione «The Hub Up 5c (tappa 1)» con:
  - coda delle run;
  - ambito `runs`;
  - Responsabile di prodotto e `confirm_writes`;
  - `segnala_al_responsabile`;
  - migrazione.

  Vanno aggiornate anche le righe su `POST /api/agents/:id/runs` (non avvia più), sul riavvio delle run, sugli ambiti dei token e sul
  limite delle run in "Deploy".

- [ ] **Step 1: scrivere le modifiche a `CLAUDE.md`** con i valori della spec.
- [ ] **Step 2: verificare.** `pnpm run build` → verde.
- [ ] **Step 3: commit.** `docs(casello): coda delle run, ambito runs e Responsabile di prodotto`
- [ ] **Step 4: fermarsi e chiedere a Ivan.** Dare in chat l'SQL completo di `docs/migrations/2026-11-thu-5c-tappa1.sql` da applicare su
  Neon. Push e PR solo dopo il suo sì; la PR segnala migrazione e nessuna variabile nuova.

## Parte B — The Hub Up (AbapCrm, worktree `../AbapCrm-5c`, branch `feat/botcave-5c-tappa1`)

### Task 8: Configurazione, instradamento e client

**Files:**
- Create: `server/botcave/config.ts`, `server/botcave/routing.ts`, `server/botcave/client.ts`, `server/botcave/botcave.test.ts`
- Modify: `server/index.ts` (avviso all'avvio)

**Interfaces:**
- Produces:
  - `type BotcaveFunction = "email" | "brief"`;
  - `BOTCAVE_FUNCTIONS: Record<BotcaveFunction, string> = { email: "BOTCAVE_AGENT_EMAIL", brief: "BOTCAVE_AGENT_BRIEF" }`;
  - `readBotcaveConfig(env: NodeJS.ProcessEnv): { config: BotcaveConfig | null; warnings: string[] }`, dove
    `BotcaveConfig = { url: string; token: string; organizationId: string; userId: string; agents: Partial<Record<BotcaveFunction, number>> }`.
    `url` deve essere https (http solo verso localhost con `NODE_ENV !== "production"`); un id di agente non intero positivo viene
    scartato con un avviso; senza URL, token, organizzazione o utente → `config: null` con l'elenco dei nomi mancanti;
  - `routeFunction(config: BotcaveConfig | null, fn: BotcaveFunction, owner: { organizationId: string | null; userId?: string | null }): "botcave" | "internal"`.
    Per `email` l'utente deve coincidere con `config.userId`; per `brief` conta solo l'organizzazione;
  - `startBotcaveRun(config: BotcaveConfig, fn: BotcaveFunction, ref: { type: string; id: string }, input: string, deps?: { fetch?: typeof fetch; log?: (line: string) => void }): Promise<void>`.
    `POST <url>/api/agents/<id>/runs`, `Authorization: Bearer <token>`, `Content-Type: application/json`, corpo `{ input }`,
    `redirect: "manual"`, `AbortSignal.timeout(10_000)`. Non lancia mai: su un errore registra
    `[Botcave] <fn> <ref.type>:<ref.id> fallita: <stato HTTP o "rete">`;
  - `getBotcaveConfig(): BotcaveConfig | null`, letta una volta da `process.env`.

- [ ] **Step 1: test in `botcave.test.ts`.**
  - `readBotcaveConfig: completa → config; manca BOTCAVE_TOKEN → null con avviso che nomina BOTCAVE_TOKEN; id agente "abc" scartato con avviso; url http non localhost rifiutato`;
  - `routeFunction: email della stessa organizzazione e utente → botcave; organizzazione diversa → internal; utente diverso → internal; agente della funzione non impostato → internal; config null → internal; brief con utente diverso ma stessa organizzazione → botcave`;
  - `startBotcaveRun: URL /api/agents/12/runs, header Bearer, corpo {input}; con risposta 429 registra una riga senza token né input e non lancia; con errore di rete idem`.
- [ ] **Step 2: eseguire i test e verificare che falliscano.** `npm test -- botcave` → FAIL.
- [ ] **Step 3: implementare.** In `server/index.ts` stampare all'avvio gli avvisi di `readBotcaveConfig`, solo i nomi delle variabili.
- [ ] **Step 4: verificare.** `npm test` e `npm run check` → verdi.
- [ ] **Step 5: commit.** `feat(botcave): client e instradamento delle funzioni AI verso Botcave`

### Task 9: Smistatore email e Curatore del brief su Botcave

**Files:**
- Create: `server/botcave/inputs.ts` (test in `server/botcave/botcave.test.ts`)
- Modify: `server/imap-service.ts` (~righe 497-517), `server/context-maintainer.ts`

**Interfaces:**
- Consumes: Task 8; `extractAnalysisText` di `server/ai-service.ts`.
- Produces:
  - `EMAIL_TEXT_MAX = 8_000`;
  - `buildEmailRunInput(m: { id: string; organizationId: string; fromEmail: string; fromName?: string | null; toEmail: string; subject?: string | null; text: string }): string`,
    il testo della spec §5.3 con `text` troncato a 8 000;
  - `buildBriefRunInput(p: { organizationId: string; projectId: string; taskTitle: string; summary?: string | null; recommendations?: string[] }): string`,
    il testo della spec §5.4 con al massimo 2 raccomandazioni.
- Changes:
  - **`imap-service.ts`:** dopo `createMessage` calcola l'organizzazione come oggi. Se `routeFunction(getBotcaveConfig(), "email",
    {organizationId, userId: messageData.userId})` è `botcave`, chiama `startBotcaveRun(…, {type: "message", id}, buildEmailRunInput(…))`
    senza attenderla; altrimenti esegue il ramo interno esistente, che resta sotto `if (process.env.OPENAI_API_KEY)`.
  - **`context-maintainer.ts`:** il controllo dei 10 minuti resta prima. Poi, se `routeFunction(…, "brief", {organizationId})` è
    `botcave`, chiama `startBotcaveRun(…, {type: "project", id: projectId}, buildBriefRunInput(…))` e ritorna; altrimenti esegue il ramo
    interno.

- [ ] **Step 1: test.**
  - `buildEmailRunInput: contiene messageId, organizationId, Da, A, Oggetto e il testo troncato a 8 000 caratteri`;
  - `buildBriefRunInput: al massimo 2 raccomandazioni; senza sintesi nessuna riga Risultato`;
  - in un test di `context-maintainer` con `db`, `aiGateway` e client simulati con `vi.mock`:
    `con instradamento botcave nessuna chiamata ad aiGateway e una a startBotcaveRun; seconda chiamata entro 10 minuti: nessuna delle due`.
- [ ] **Step 2: eseguire i test e verificare che falliscano.** `npm test -- botcave context-maintainer` → FAIL.
- [ ] **Step 3: implementare.**
- [ ] **Step 4: verificare.** `npm test` e `npm run check` → verdi.
- [ ] **Step 5: commit.** `feat(botcave): smistamento email e brief avviati su Botcave`

### Task 10: Collegamenti dei messaggi solo dentro l'organizzazione

**Files:**
- Create: `server/message-link-scope.ts`, `server/message-link-scope.test.ts`
- Modify: `server/routes.ts` (`POST /api/message-links` ~5934, `PUT /api/message-links/:linkId` ~5961),
  `server/ai-service.ts` (`updateMessageWithSuggestion`)

**Interfaces:**
- Produces:
  - `LINKABLE_TABLES = ["partners", "projects", "tasks"] as const`;
  - `canLink(deps: { messageOrg(id: string): Promise<string | null>; recordOrg(table: string, id: string): Promise<string | null> }, input: { organizationId: string; messageId: string; table: string; recordId: string }): Promise<boolean>`.
    È vero solo se la tabella è ammessa e messaggio e oggetto sono dell'organizzazione;
  - `canEditLink(deps: { linkOrg(id: string): Promise<string | null> }, input: { organizationId: string; linkId: string }): Promise<boolean>`;
  - `dbLinkScopeDeps`, implementazione con Drizzle sulle tabelle `messages`, `partners`, `projects`, `tasks`, `message_links`
    (colonna `organizationId`).
- Changes:
  - la POST risponde 404 `{ error: "messaggio o oggetto non trovato" }` se `canLink` è falso;
  - la PUT risponde 404 con lo stesso messaggio se `canEditLink` è falso;
  - l'organizzazione è quella della richiesta (`x-organization-id` già risolto dal middleware, oppure quella del token `thu_`);
  - `updateMessageWithSuggestion` collega solo se `canLink` è vero.

- [ ] **Step 1: test in `message-link-scope.test.ts`** (dipendenze finte):
  - `stessa organizzazione → true`;
  - `messaggio di un'altra organizzazione → false`;
  - `oggetto di un'altra organizzazione → false`;
  - `tabella non ammessa → false`;
  - `oggetto inesistente → false`;
  - `canEditLink su un collegamento di un'altra organizzazione → false`.
- [ ] **Step 2: eseguire il test e verificare che fallisca.** `npm test -- message-link-scope` → FAIL.
- [ ] **Step 3: implementare.** Poi applicarlo alle due route e a `updateMessageWithSuggestion`.
- [ ] **Step 4: verificare.** `npm test` e `npm run check` → verdi.
- [ ] **Step 5: commit.** `fix(messaggi): collegamenti solo dentro l'organizzazione`
- [ ] **Step 6: fermarsi e chiedere a Ivan prima di push e PR.** La PR elenca le variabili nuove (§5.2 della spec) e nessuna migrazione.

## Parte C — Messa in opera (solo con la conferma di Ivan, passo per passo)

### Task 11: Configurazione e prova reale

- [ ] **Step 1:** Ivan applica su Neon la migrazione del Task 1. Poi merge della PR di Botcave e attesa del deploy.
- [ ] **Step 2: in console** (con Ivan):
  - agenti 12 e 17: modello (Gemini Flash consigliato), tetto, prompt e skill `smista_messaggio` / `aggiorna_brief` secondo la spec
    §5.3 e §5.4, `active`;
  - agente 4: «Responsabile di prodotto», modello, tetto e prompt della §6, `active`;
  - token personale con il solo ambito `runs`.
- [ ] **Step 3:** variabili su Coolify per The Hub Up: tutte quelle della §5.2 tranne `BOTCAVE_AGENT_EMAIL`. Merge della PR di AbapCrm e
  deploy.
- [ ] **Step 4: prova reale 1 (brief).** Un'esecuzione di THU AI su un progetto dell'organizzazione di lavoro deve produrre una run
  dell'agente 17 riuscita, con il brief aggiornato e le decisioni precedenti intatte.
- [ ] **Step 5:** dopo 2-3 giorni, `BOTCAVE_AGENT_EMAIL` = 12 e nuovo deploy.
- [ ] **Step 6: prove reali 2 e 3 (smistamento e Responsabile).**
  - 20 email: 20 run, nessun 429, al massimo 2 in corso alla volta, note «Smistato da Botcave»;
  - un'email con una richiesta d'azione: run del Responsabile «Nata dalla run N», voce in «Da confermare», eseguita una volta sola;
  - un'email ostile: nulla eseguito.
- [ ] **Step 7:** riportare l'esito nella spec (nuova sezione «Esito») e in `CLAUDE.md`; commit.
