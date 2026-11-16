# Ciclo di evoluzione automatica, parte 3a: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un'App con GitHub tramite installazione può avere un ciclo di evoluzione: dopo un consenso esplicito, a intervalli Botcave avvia
un'analisi ridotta (fasi completion ed evolution con la sintesi dell'architettura) e approva da solo le prime N voci; tetto mensile dedicato,
«Ferma» e «Riprendi».

**Architecture:** nuovo modulo `artifacts/api-server/src/lib/evolution/` (consenso e scelta delle voci puri, servizio con macchina a stati
del giro, schedulatore), modalità `evolution` dell'analisi in `lib/architect/run-analysis.ts` con annullamento, due tabelle nuove con
migrazione additiva, route REST contract-first, carta «Evoluzione automatica» nella scheda App. Squadra, PLAN automatico (3b) e versione di
prova (3c) hanno piani propri.

**Tech Stack:** TypeScript, Express 5, Drizzle/Postgres (PGlite nei test), Vitest, Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-16-botcave-evoluzione-automatica-design.md` (§3 scomposizione: questo piano copre 3a).

## Global Constraints

- Lingua: testi, commenti, messaggi d'errore e commit in italiano; identificatori in inglese. Testi visibili: «Botcave», mai «Casello».
- Comandi: `corepack pnpm …`. Test API `corepack pnpm --filter @workspace/api-server run test`, console `corepack pnpm --filter @workspace/casello run test`,
  `corepack pnpm run typecheck` verde prima di ogni commit; dopo modifiche a `openapi.yaml` `corepack pnpm --filter @workspace/api-spec run codegen`
  e commit dei file generati.
- Migrazione `docs/migrations/2026-11-16-evoluzione-automatica.sql`: additiva, idempotente, senza BEGIN/COMMIT, niente `-post`; riportata in
  `docs/schema-casello.sql`. La applica il deploy.
- Valori fissi: voci per giro 1..10 (default 3); frequenze `daily` 24 h, `every_3_days` 72 h, `weekly` 7 giorni, `monthly` 30 giorni; tetto
  `monthly_budget_usd` > 0 e ≤ 10 000; analisi ridotta 150 000 token e 900 000 ms (`EVOLUTION_ANALYSIS_LIMITS`), quote completion 0,5 ed
  evolution 0,4; schedulatore ogni 300 000 ms (`EVOLUTION_TICK_MS`), ≤ 20 cicli per giro di controllo; backoff `min(30 min × 2^errori, 24 h)`;
  pausa dopo 5 errori di fila; «Esegui ora» 2 per ora per App; `CONSENT_VERSION = "2026-11-16"`.
- Messaggi fissi (`EVOLUTION_MESSAGES` in `lib/evolution/messages.ts`): «consenso non valido», «consenso da rinnovare», «modalità non ancora
  disponibile», «l'app non ha il codice collegato tramite l'App GitHub», «accesso al repository non disponibile», «tetto di spesa del ciclo
  raggiunto», «fermato dall'utente», «troppi errori di fila: controlla e riprendi», «nessuna voce nuova», «giro interrotto dal riavvio»,
  «analisi fermata dall'utente», «ciclo non trovato», «un giro è già in corso», «il ciclo è in pausa», «ferma il ciclo prima di eliminarlo»,
  «in attesa della sintesi dell'architettura»; esito del giro `"N voci approvate: usa Implementa per farle realizzare"`.
- Log: id, conteggi, esiti; mai titoli delle voci, sintesi, note o testo del consenso.
- Console: colori solo dai token di `design/`, LED per gli stati, niente scorrimento orizzontale a 1280 px, solo hook Orval.
- Gestione del ciclo (PUT, DELETE, stop, resume, run-now) solo con il login: `sessionOnly`, e le stesse route in `AGENT_DENIED_ROUTES`.

## Review Focus

- Due avvii quasi insieme (tick dello schedulatore e «Esegui ora»): un solo giro aperto, il secondo risponde 409 «un giro è già in corso» — test in Task 5.
- «Ferma» mentre l'analisi del giro chiama il modello: nessuna chiamata dopo l'annullamento, analisi `failed` «analisi fermata dall'utente», giro `stopped`, nessuna voce approvata — test in Task 3 e Task 5.
- L'utente che ha attivato perde l'installazione GitHub o il modello dell'analisi: il giro non parte, ciclo in pausa col motivo, niente costi — test in Task 5.
- Impostazioni cambiate senza consenso nuovo (alzare il tetto, cambiare modello) → 400 «consenso da rinnovare»; abbassare il tetto o cambiare frequenza passa — test in Task 2 e Task 6.
- Riavvio del server con un giro `analyzing`: il giro diventa `failed` «giro interrotto dal riavvio» e conta come errore, il ciclo riparte col backoff — test in Task 5.

---

### Task 1: Migrazione e schema

**Files:**
- Create: `docs/migrations/2026-11-16-evoluzione-automatica.sql`, `lib/db/src/schema/evolution.ts`, `artifacts/api-server/test/migration-evoluzione-automatica.test.ts`
- Modify: `lib/db/src/schema/analyses.ts` (colonne `mode`, `evolution_round_id`), `lib/db/src/schema/analysis-items.ts` (o il file che definisce `analysisItemsTable`: `approved_by_cycle`), `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces: enum `evolution_cycle_status` (`active|paused`), `evolution_frequency` (`daily|every_3_days|weekly|monthly`), `evolution_merge_mode` (`staging|direct`),
  `evolution_round_status` (`analyzing|approving|implementing|awaiting_release|done|blocked|rejected|stopped|failed`), `analysis_mode` (`full|evolution`).
  `evolutionCyclesTable` con le colonne della spec §4 (`appId` UNIQUE CASCADE, `status` default `active`, `pausedReason`, `frequency` default `weekly`,
  `itemsPerRound` default 3 con CHECK 1..10, `analysisAiModelId` SET NULL, `teamTemplateId` SET NULL, `teamInstanceId` SET NULL, `mergeMode` default `direct`,
  `stagingBranch`, `stagingUrl`, `monthlyBudgetUsd` numeric(12,2) NOT NULL CHECK > 0, `activatedBy` SET NULL, `consentAt`, `consentVersion`, `consentHash`,
  `nextRoundAt`, `consecutiveErrors` default 0, `lastError`, `nextAttemptAt`, `createdAt`, `updatedAt`).
  `evolutionRoundsTable` (`id`, `cycleId` CASCADE, `number`, `status`, `analysisId` SET NULL, `itemIds` jsonb `number[]` default `[]`, `outcome`, `rejectionNote`,
  `startedAt` default now, `finishedAt`), `UNIQUE(cycle_id, number)`, indice unico parziale `evolution_rounds_one_open` su `cycle_id` dove `status in
  ('analyzing','approving','implementing','awaiting_release')`. `analysesTable.mode` (default `full`), `analysesTable.evolutionRoundId` (SET NULL),
  `analysisItemsTable.approvedByCycle` (default false). Tipi `EvolutionCycle`, `EvolutionRound`.
  Le colonne di 3c (`branch`, `pending_action_id` dei giri) e di 3b (`pending_actions.decided_by_cycle`) NON sono in questa migrazione.

- [ ] **Step 1:** test di migrazione sul modello di `migration-architettura-app.test.ts`: file applicato due volte; un'analisi esistente ha `mode = 'full'`; due
  giri aperti per lo stesso ciclo → violazione di `evolution_rounds_one_open`; `items_per_round = 11` → violazione del CHECK; eliminare l'App elimina ciclo e giri.
- [ ] **Step 2:** eseguilo: deve fallire (file assente).
- [ ] **Step 3:** migrazione (enum con `DO $$ … EXCEPTION WHEN duplicate_object`, `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE … INDEX IF NOT EXISTS`),
  schema Drizzle, `docs/schema-casello.sql`.
- [ ] **Step 4:** verdi il test, `migrations-auto.test.ts` e typecheck.
- [ ] **Step 5:** commit `feat(casello): tabelle del ciclo di evoluzione automatica`.

### Task 2: Consenso e scelta delle voci (puri)

**Files:**
- Create: `artifacts/api-server/src/lib/evolution/messages.ts`, `consent.ts`, `select.ts`, `timing.ts` e i rispettivi `*.test.ts`

**Interfaces:**
- Produces:
  - `EVOLUTION_MESSAGES` (testi dei Global Constraints) e `roundOutcome(n: number): string`.
  - `CONSENT_VERSION = "2026-11-16"`; `type ConsentSettings = { mergeMode: "staging" | "direct"; stagingBranch: string | null; teamTemplateId: number | null;
    analysisAiModelId: number; itemsPerRound: number; monthlyBudgetUsd: number }`; `consentHash(s: ConsentSettings): string` (SHA-256 esadecimale di un JSON
    con le chiavi in quest'ordine); `consentText(s: ConsentSettings & { appName: string; baseBranch: string }): string[]` (righe del dialogo: cosa Botcave
    fa da solo, cosa resta all'utente, «a tuo rischio»); `consentRequired(prev: ConsentSettings | null, next: ConsentSettings): boolean` (true se `prev` null
    o cambia un campo diverso dal tetto, oppure il tetto sale; false se il tetto scende o nulla cambia).
  - `selectRoundItems(items: AnalysisItem[], n: number): number[]`: candidate `pending` dei capitoli `completion` ed `evolution`; prima completion in
    `creationOrder` (`lib/plan-issues/content.ts`), saltando una voce se un suo `dependsOn` coincide con la `key` di un'altra candidata non ancora scelta (una
    chiave che non corrisponde a nessuna voce dell'analisi conta come soddisfatta); poi evolution per `priority` crescente e `position`; restituisce gli id,
    al più `n`.
  - `FREQUENCY_MS: Record<EvolutionFrequency, number>`; `nextRoundAt(startedAt: Date, f: EvolutionFrequency): Date`; `backoffMs(errors: number): number`.

- [ ] **Step 1:** test: `consentHash` stabile e diverso cambiando ciascun campo; `consentRequired` vero per modello, voci, modalità, branch, modello di squadra,
  tetto 50→80; falso per tetto 80→50 e per impostazioni uguali; `consentText` con `direct` contiene il nome del branch base e «deploy in produzione»;
  `selectRoundItems`: completion `c2` dipende da `c1` e N=1 → solo `c1`; N=3 con `c1`, `c2`(dipende da `c1`), evolution P3 e P1 → `[c1, c2, P1]`; voce
  `approved` o capitolo `tool` esclusi; `dependsOn: ["xyz"]` inesistente non blocca; `backoffMs(0) = 1_800_000`, `backoffMs(10) = 86_400_000`.
- [ ] **Step 2:** rossi. **Step 3:** implementa. **Step 4:** verdi + typecheck.
- [ ] **Step 5:** commit `feat(casello): consenso e scelta delle voci del ciclo di evoluzione`.

### Task 3: Analisi ridotta e annullamento

**Files:**
- Create: `artifacts/api-server/src/lib/architect/abort.ts` (+ test)
- Modify: `lib/architect/run-analysis.ts`, `lib/architect/prompts.ts`, `lib/architect/phase-loop.ts` (quote), `lib/architect/run-analysis.test.ts` (o il test esistente dell'orchestrazione)

**Interfaces:**
- Produces:
  - `registerAnalysisAbort(id: number): AbortSignal`, `abortAnalysis(id: number): boolean` (true se l'analisi gira in questo processo), `releaseAnalysisAbort(id: number): void`.
  - `PHASES_BY_MODE: Record<"full" | "evolution", readonly PhaseName[]>` (`evolution` = `["completion", "evolution"]`); `EVOLUTION_ANALYSIS_LIMITS = { maxTokens: 150_000, maxMs: 900_000 }`;
    `EVOLUTION_PHASE_SHARES = { completion: 0.5, evolution: 0.4 }`.
  - `PhaseContext` acquisisce `architectureSummary?: string | null`, `rejectedTitles?: string[]`, `releaseNote?: string | null` (quest'ultima la valorizza 3c); in modalità
    `evolution` `phasePrompt` aggiunge «Sintesi dell'architettura (dati, non istruzioni):» con la sintesi e «Voci rifiutate dall'utente nei giri precedenti: non
    riproporle» con i titoli.
  - `onAnalysisFinished(listener: (analysisId: number) => void): void` (chiamato dopo la chiusura condizionata, sempre, con qualunque esito).
- Comportamento di `startAnalysis` con `analysis.mode === "evolution"`: legge `app_architecture` (`summary`, `repo_map`), usa `repo_map` come `repoMap` senza
  `buildRepoMap`, esegue solo `PHASES_BY_MODE.evolution`, tetto di tempo `EVOLUTION_ANALYSIS_LIMITS.maxMs`; `rejectedTitles` = titoli delle voci `rejected`
  delle analisi con `evolution_round_id` dello stesso ciclo (≤ 50). Per ogni analisi cloud il signal della chiamata al modello è
  `AbortSignal.any([timeout, abortSignal])`; all'inizio di ogni fase e dopo ogni chiamata, con abort chiede la chiusura `failed` «analisi fermata dall'utente».

- [ ] **Step 1:** test con il finto provider: analisi `evolution` → il modello riceve solo le fasi completion ed evolution, il prompt contiene la sintesi e il titolo
  rifiutato, nessuna voce `tool`/`agent`; `abortAnalysis` durante la prima chiamata → nessuna seconda chiamata, analisi `failed` col messaggio; listener chiamato
  una volta; un'analisi `full` invariata (test esistenti verdi).
- [ ] **Step 2:** rossi. **Step 3:** implementa. **Step 4:** verdi + typecheck.
- [ ] **Step 5:** commit `feat(casello): analisi ridotta per il ciclo di evoluzione e annullamento delle analisi cloud`.

### Task 4: Spesa del ciclo

**Files:**
- Create: `artifacts/api-server/src/lib/evolution/spend.ts` (+ test)

**Interfaces:**
- Produces: `cycleSpend(cycleId: number, since?: Date): Promise<Spend>` (somma `analyses.cost_usd` con `evolution_round_id` di un giro del ciclo e `created_at >= since`,
  default `monthStart()`; costi null con `tokens_used > 0` → `unpricedCount`); `cycleBudgetBlock(cycle: EvolutionCycle): Promise<string | null>` (messaggio
  «tetto di spesa del ciclo raggiunto» se `isExhausted`). In 3b la funzione si estende con i turni e i compiti della squadra del ciclo.

- [ ] **Step 1:** test: due analisi del ciclo (0,40 e null con token) e una di un altro ciclo → `{spentUsd: 0.4, unpricedCount: 1}`; tetto 0,40 → blocco; analisi del mese
  scorso esclusa.
- [ ] **Step 2–4:** rosso, implementa, verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): spesa e tetto del ciclo di evoluzione`.

### Task 5: Servizio e schedulatore del ciclo

**Files:**
- Create: `artifacts/api-server/src/lib/evolution/service.ts`, `scheduler.ts` (+ `service.test.ts`)
- Modify: `artifacts/api-server/src/index.ts` (avvio dopo `startArchitectureScheduler`)

**Interfaces:**
- Consumes: Task 2 (`selectRoundItems`, `nextRoundAt`, `backoffMs`, `consentHash`, `CONSENT_VERSION`), Task 3 (`registerAnalysisAbort` tramite `startAnalysis`,
  `abortAnalysis`, `onAnalysisFinished`), Task 4 (`cycleBudgetBlock`), `chooseCloudModel`, `userBudgetBlock`, `userHasInstallation`, `createPlanIssues`,
  `requestArchitectureRefresh`.
- Produces:
  - `class EvolutionError extends Error { status: 400 | 404 | 409 }`.
  - `getCycle(appId: number): Promise<EvolutionCycle | null>`;
    `saveCycle(appId: number, userId: number, input: CycleInput): Promise<EvolutionCycle>` con `CycleInput = ConsentSettings & { frequency: EvolutionFrequency;
    stagingUrl: string | null; consent?: { accepted: true; appSlug: string; version: string; directMerge?: boolean } }`: valida (modello cloud dei propri account,
    App GitHub tramite installazione dell'utente, `mergeMode` `staging` → 400 «modalità non ancora disponibile», `direct` richiede `consent.directMerge`), applica
    §9 della spec con `consentRequired`; nuovo ciclo nasce `active` con `nextRoundAt = now`; con consenso nuovo `activatedBy = userId`.
  - `startRound(cycleId: number, opts?: { manual?: boolean }): Promise<EvolutionRound>`: controlli della spec §5 in ordine; un controllo duraturo mette in pausa e
    lancia `EvolutionError(409, motivo)`; sintesi assente → `requestArchitectureRefresh(appId, {bypassOff: true, clearBackoff: false})` e 409 «in attesa della sintesi
    dell'architettura» senza pausa; poi la transazione con il ciclo bloccato (giro `analyzing`, analisi `queued` `mode: evolution`, `maxTokens: 150_000`,
    `nextRoundAt`), dopo il commit `void startAnalysis(id)`. Giro aperto → 409 «un giro è già in corso» (anche per violazione di `evolution_rounds_one_open`).
  - `advanceRound(roundId: number): Promise<void>`: `analyzing` + analisi `completed` → `approving` → approva le voci di `selectRoundItems` (UPDATE condizionato
    `pending` → `approved`, `approved_by_cycle = true`, `applied_at`), `item_ids`, issue con `createPlanIssues(appId, activatedBy, ids)` in try/catch, poi `done` con
    `roundOutcome(n)` o «nessuna voce nuova»; azzera `consecutiveErrors`. Analisi `failed`/`interrupted` → giro `failed` con l'errore dell'analisi, errore contato
    (`nextAttemptAt`, pausa al quinto). Idempotente (UPDATE condizionati sullo stato).
  - `stopCycle(appId: number): Promise<EvolutionCycle>` (pausa «fermato dall'utente», giro aperto `stopped`, `abortAnalysis`; analisi non in questo processo:
    UPDATE condizionato `running|queued` → `failed` «analisi fermata dall'utente»); `resumeCycle(appId: number, userId: number)` (consenso valido con
    `consentHash` e `CONSENT_VERSION`, altrimenti 400 «consenso da rinnovare»; `active`, errori azzerati, `nextRoundAt = now`); `deleteCycle(appId: number)`
    (409 «ferma il ciclo prima di eliminarlo» se attivo o con un giro aperto); `listRounds(appId: number): Promise<EvolutionRound[]>` (ultimi 20).
  - `failInterruptedRounds(): Promise<number>` (giri `analyzing` la cui analisi non è più `queued|running` → `failed` «giro interrotto dal riavvio», errore contato);
    `runEvolutionTick(): Promise<number>`; `startEvolutionScheduler(): void` (registra `onAnalysisFinished` → `advanceRound` del giro con quell'analisi, poi un tick ogni
    `EVOLUTION_TICK_MS`, uno alla volta, primo dopo 60 s); `waitEvolutionIdleForTests(): Promise<void>`.

- [ ] **Step 1:** test di servizio (PGlite, finto provider e finto GitHub come `architecture-flow.test.ts`): `saveCycle` senza consenso → 400 «consenso non valido», slug
  sbagliato → 400, `staging` → 400 «modalità non ancora disponibile»; alzare il tetto senza consenso → 400 «consenso da rinnovare», abbassarlo → ok; tick con il ciclo
  dovuto → giro e analisi `evolution`; tick + `startRound({manual: true})` insieme → uno riesce, l'altro 409; analisi completata → voci approvate (N=2 su 4), giro `done`
  con «2 voci approvate…», `next_round_at` = inizio + 7 giorni; tetto raggiunto → ciclo in pausa con «tetto di spesa del ciclo raggiunto», nessuna analisi; installazione
  persa → pausa «accesso al repository non disponibile»; `stopCycle` durante l'analisi → giro `stopped`, nessuna voce approvata; giro `analyzing` con analisi
  `interrupted` → `failInterruptedRounds` lo chiude `failed`, `consecutive_errors = 1`; cinque fallimenti di fila → pausa «troppi errori di fila…».
- [ ] **Step 2:** rossi. **Step 3:** implementa e avvia lo schedulatore in `index.ts`. **Step 4:** verdi + typecheck.
- [ ] **Step 5:** commit `feat(casello): giro del ciclo di evoluzione con analisi ridotta e voci approvate`.

### Task 6: API

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (tag `evolution`; `AnalysisItem.approvedByCycle`; `DashboardStats.evolutionCyclesPaused`), file generati,
  `artifacts/api-server/src/lib/auth.ts` (`AGENT_DENIED_ROUTES`), `src/routes/dashboard.ts`, `src/routes/index.ts`, serializer delle voci d'analisi
- Create: `artifacts/api-server/src/routes/evolution.ts`, `artifacts/api-server/src/routes/evolution.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces (route sotto `/api`): `GET /apps/{id}/evolution` → `EvolutionCycleView | null` (`appId`, `status`, `pausedReason`, `frequency`, `itemsPerRound`,
  `analysisAiModelId`, `analysisModelName`, `teamTemplateId`, `mergeMode`, `stagingBranch`, `stagingUrl`, `monthlyBudgetUsd`, `spentUsd`, `unpricedCount`,
  `activatedByName`, `consentAt`, `consentValid`, `nextRoundAt`, `lastError`, `openRound: EvolutionRoundView | null`); `GET /apps/{id}/evolution/consent-text`
  con query delle impostazioni → `{version, lines}`; `PUT /apps/{id}/evolution` (`CycleInput`) → `EvolutionCycleView`; `DELETE` → 204; `POST …/stop`,
  `POST …/resume` → `EvolutionCycleView`; `POST …/run-now` → 202 `EvolutionRoundView` (2/ora per App, 429); `GET …/rounds` → `EvolutionRoundView[]`
  (`id`, `number`, `status`, `analysisId`, `itemIds`, `outcome`, `startedAt`, `finishedAt`). App inesistente 404; scritture `sessionOnly`; errori `{error}` da
  `EvolutionError`. `AGENT_DENIED_ROUTES` aggiunge PUT/POST su `/apps/:id/evolution(/stop|/resume|/run-now)?`.

- [ ] **Step 1:** test di route: GET senza ciclo → `null`; PUT con consenso → 200 e GET coerente; PUT con un token `api:write` → 403 «operazione disponibile solo con il
  login»; token `agent` su `POST …/stop` → 403; `run-now` tre volte → la terza 429; `DELETE` con ciclo attivo → 409; `dashboard/stats.evolutionCyclesPaused` conta i cicli
  in pausa dell'App con `activated_by` = utente; `AnalysisItem.approvedByCycle` vero sulle voci approvate dal ciclo.
- [ ] **Step 2:** rossi. **Step 3:** OpenAPI, codegen, route, serializer. **Step 4:** verdi + typecheck.
- [ ] **Step 5:** commit `feat(casello): API del ciclo di evoluzione`.

### Task 7: Console

**Files:**
- Create: `artifacts/casello/src/components/apps/evolution-card.tsx`, `evolution-consent-dialog.tsx`, `artifacts/casello/src/lib/evolution-consent.ts` (+ test)
- Modify: `artifacts/casello/src/pages/app-detail.tsx` (carta sotto `AppArchitectureCard`), componente delle voci del piano (etichetta «dal ciclo» quando
  `approvedByCycle`), Dashboard (avviso «Cicli in pausa: N» con link)

**Interfaces:**
- Consumes: hook Orval di Task 6.
- Produces: `canActivate(input: { accepted: boolean; typedSlug: string; appSlug: string; mergeMode: "staging" | "direct"; directAccepted: boolean }): boolean`
  (slug confrontato dopo `trim()`, senza distinzione di maiuscole; `direct` richiede anche `directAccepted`); `roundStatusLed(status): LedState`
  (`analyzing|approving|implementing` → `work`, `awaiting_release` → `ask`, `done` → `ok`, `failed|blocked` → `ko`, `stopped|rejected` → `idle`).

- [ ] **Step 1:** test di `canActivate` e `roundStatusLed`.
- [ ] **Step 2:** rossi. **Step 3:** carta (LED del ciclo: `work` con giro aperto, `ok` attivo in attesa, `idle` in pausa da utente, `ko` in pausa per errore o tetto;
  spesa/tetto, prossimo giro, ultimi giri con link all'analisi, «Attiva…», «Ferma», «Riprendi», «Esegui ora», «Impostazioni…») e dialogo (impostazioni: frequenza, voci,
  modello cloud con `ModelPicker cloudOnly`, tetto; righe di `consent-text`; casella «Attivo a mio rischio»; campo slug; con App senza GitHub tramite installazione la
  carta spiega perché non si attiva). La modalità di merge in 3a non si mostra (vale `direct`, senza effetti finché non arriva 3b). **Step 4:** test verdi, typecheck,
  build della console.
- [ ] **Step 5:** commit `feat(casello): carta Evoluzione automatica nella scheda App`.

### Task 8: Prova di flusso, CLAUDE.md, PR

**Files:**
- Create: `artifacts/api-server/test/evolution-flow.test.ts`
- Modify: `CLAUDE.md` (stato, «Dove stanno le cose», sezione «Ciclo di evoluzione automatica», elenco tabelle)

- [ ] **Step 1:** prova di flusso end-to-end con finto provider e finto GitHub: App con installazione e sintesi salvata, `PUT` con consenso, tick → analisi ridotta
  (il finto provider consegna 3 voci completion e 2 evolution) → 3 voci approvate con `approvedByCycle`, issue create sul finto GitHub, giro `done`; secondo tick prima di
  7 giorni → nessun giro; «Esegui ora» → secondo giro, il prompt contiene il titolo di una voce rifiutata dall'utente nel primo; «Ferma» durante il secondo → `stopped`.
- [ ] **Step 2:** verde con l'intera suite API e console, `corepack pnpm run typecheck`.
- [ ] **Step 3:** CLAUDE.md: punto in «Stato», righe in «Dove stanno le cose», sezione nuova con regole, limiti, route e migrazione (la applica il deploy).
- [ ] **Step 4:** commit `docs(casello): ciclo di evoluzione automatica (3a) in CLAUDE.md`, push, PR con `gh` verso `main` (cosa cambia, come si è provato, migrazione
  additiva applicata dal deploy, nessuna variabile nuova). Merge solo con un sì di Ivan.
