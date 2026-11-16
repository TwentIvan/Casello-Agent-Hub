# Sintesi dell'architettura per App — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni App con codice GitHub tramite installazione ha una sintesi dell'architettura aggiornata a ogni nuovo SHA del branch base (con intervallo minimo per App), scritta dal suo Responsabile e letta dai Responsabili (Barbara compresa).

**Architecture:** nuovo modulo `artifacts/api-server/src/lib/architecture/` (raccolta senza token, generazione con `runAgentLoop`, servizio DB, schedulatore, strumento `leggi_architettura`), due tabelle nuove con migrazione additiva, spesa in `lib/budget.ts`, route REST contract-first, carta «Architettura» nella scheda App.

**Tech Stack:** TypeScript, Express 5, Drizzle/Postgres (PGlite nei test), Vitest, Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-16-botcave-architettura-app-design.md`

## Global Constraints

- Lingua: testi, commenti, messaggi d'errore e commit in italiano; identificatori in inglese. Testi visibili: «Botcave», mai «Casello».
- Comandi: `corepack pnpm …` (`pnpm` non è nel PATH). Test API: `corepack pnpm --filter @workspace/api-server run test`; console: `corepack pnpm --filter @workspace/casello run test`; `corepack pnpm run typecheck` verde prima di ogni commit.
- Migrazione `docs/migrations/2026-11-16-architettura-app.sql`: additiva, idempotente, niente `-post`, niente BEGIN/COMMIT; riportata in `docs/schema-casello.sql`.
- Limiti fissi: `REPO_MAP_MAX_CHARS` 32 000 (già in `architect/repo-map.ts`); sintesi 200..8 000 caratteri; 7 intestazioni `## Scopo`, `## Componenti`, `## Flussi principali`, `## Dati`, `## Integrazioni esterne`, `## Stato di sviluppo`, `## Punti delicati`; compare ≤ 30 commit e ≤ 200 file; versioni mostrate 20.
- Limiti del turno: `ARCH_UPDATE_LIMITS = {maxRounds: 4, maxTokens: 60_000, maxActiveMs: 120_000}`, `ARCH_FULL_LIMITS = {maxRounds: 10, maxTokens: 150_000, maxActiveMs: 240_000}`, `maxTokens` di risposta 4 000.
- Schedulatore: giro ogni 30 minuti (`ARCH_CHECK_MS = 1_800_000`), ≤ 20 App per giro, ≤ 2 generazioni in parallelo; intervalli `hourly` 1 h, `6h` 6 h, `daily` 24 h, `weekly` 7 giorni; backoff `min(30 min × 2^errori, 24 h)`.
- Log: solo id, sha a 7, conteggi ed esito; mai sintesi, mappa, titoli dei commit, percorsi o token.
- Console: colori solo dai token di `design/`, LED per gli stati, niente scorrimento orizzontale a 1280 px, solo hook Orval.

## Review Focus

- Branch base rinominato o eliminato su GitHub (404 sullo SHA): `error` con messaggio fisso e backoff, sintesi precedente intatta — test in Task 4.
- Responsabile senza modello o disattivato dopo una sintesi: l'App esce dal giro, la sintesi resta leggibile e nel prompt — test in Task 4 e Task 6.
- Due richieste «Aggiorna ora» quasi insieme (o giro + richiesta): una sola generazione, la seconda risponde 409 — test in Task 4 e Task 8.
- Sintesi che contiene credenziali copiate dal codice: diventano `***` prima del salvataggio — test in Task 3.
- `leggi_architettura` con lo slug di un'App senza GitHub: messaggio «architettura non ancora disponibile per <app>», nessuna eccezione — test in Task 6.

---

### Task 1: Migrazione e schema

**Files:**
- Create: `docs/migrations/2026-11-16-architettura-app.sql`, `lib/db/src/schema/app-architecture.ts`, `artifacts/api-server/test/migration-architettura-app.test.ts`
- Modify: `lib/db/src/schema/apps.ts` (colonna), `lib/db/src/schema/index.ts` (export), `docs/schema-casello.sql`

**Interfaces:**
- Produces: `architectureRefreshEnum` (`off|hourly|6h|daily|weekly`), `appsTable.architectureRefresh` (default `6h`); `architectureStatusEnum` (`idle|running|error`); `appArchitectureTable` (colonne della spec §4: `appId` PK, `sha`, `branch`, `seenSha`, `repoMap`, `summary`, `status` default `idle`, `lastError`, `consecutiveErrors` default 0, `nextAttemptAt`, `checkedAt`, `generatedAt`, `startedAt`, `forceRequested` default false, `aiModelId`, `promptTokens`, `completionTokens`, `costUsd` numeric(12,6)); `appArchitectureRunsTable` (`id` serial, `appId`, `agentId`, `sha`, `summary` nullable, `createdAt`, `aiModelId`, `userId`, `promptTokens`, `completionTokens`, `costUsd`) con indice `app_architecture_runs_app_created_idx (app_id, created_at desc)`. Tipi `AppArchitecture`, `AppArchitectureRun`.

- [ ] **Step 1:** test `migration-architettura-app.test.ts` sul modello degli altri `migration-*.test.ts`: applica il file due volte su `docs/schema-casello.sql` senza errori; `apps.architecture_refresh` vale `6h` su un'App inserita; FK con CASCADE (`app_id`) e SET NULL (`agent_id`, `ai_model_id`, `user_id`).
- [ ] **Step 2:** eseguilo, deve fallire (file assente).
- [ ] **Step 3:** scrivi migrazione (enum con `DO $$ … EXCEPTION WHEN duplicate_object`, `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), schema Drizzle e aggiorna `docs/schema-casello.sql`.
- [ ] **Step 4:** test verde, `migrations-auto.test.ts` verde, typecheck.
- [ ] **Step 5:** commit `feat(casello): tabelle della sintesi dell'architettura per App`.

### Task 2: Confronto tra commit su GitHub

**Files:**
- Modify: `artifacts/api-server/src/lib/code-writer/github-git.ts`, `artifacts/api-server/test/fake-github.ts`
- Test: `artifacts/api-server/src/lib/code-writer/github-git.test.ts` (o il file di test esistente del client)

**Interfaces:**
- Produces: `compareCommits(r: RepoRef, base: string, head: string): Promise<CommitComparison | null>` con `CommitComparison = { commits: string[]; files: { filename: string; status: "added" | "modified" | "removed" | "renamed" }[]; truncated: boolean }`; `null` per 404/422 (base sconosciuto). Token `contents: read`. `commits` = prima riga del messaggio, i 30 più recenti; `files` ≤ 200 (altri stati GitHub → `modified`); `truncated` se GitHub ne aveva di più.
- Il finto GitHub serve `GET /repos/{o}/{r}/compare/{base}...{head}` da una mappa `fake.comparisons: Map<string, {commits, files}>` con chiave `"o/r:base...head"`; senza voce 404.

- [ ] **Step 1:** test: con 35 commit e 250 file restituisce 30 commit (i più recenti, prima riga), 200 file, `truncated: true`; 404 → `null`; 401 → errore `CodeWriteError` come le altre funzioni.
- [ ] **Step 2:** rosso. **Step 3:** implementa con `call`/`githubCallSafe` (404 e 422 tollerati). **Step 4:** verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): confronto tra commit per la sintesi dell'architettura`.

### Task 3: Raccolta e generazione della sintesi

**Files:**
- Create: `artifacts/api-server/src/lib/architecture/` `messages.ts`, `collect.ts`, `prompts.ts`, `generate.ts`, `generate.test.ts`, `collect.test.ts`

**Interfaces:**
- Consumes: `getAppSource(userId, app)` (code-reader), `buildRepoMap(tree, null)`, `compareCommits` (Task 2), `CodeToolRunner`, `CODE_TOOLS`, `runAgentLoop`, `modelChatDeps`, `newUsage`/`usageCost`, `looksLikeCredential` (`lib/memory/credentials.ts`).
- Produces:
  - `ARCH_MESSAGES` (tutti i messaggi fissi della spec: `noAccess` «accesso al repository non disponibile», `invalid` «sintesi non valida», `notDelivered` «sintesi non consegnata», `interrupted` «generazione interrotta dal riavvio», `budgetWait` «in attesa: tetto di spesa raggiunto», `nodeNoFallback` «Claude Code (nodo) non genera la sintesi: imposta un ripiego cloud», `githubDown` «GitHub non raggiungibile», `notAvailable(app)` «architettura non ancora disponibile per <app>», `appNotFound` «app non trovata», `running` «sintesi già in corso», `noGithub` «collega il repository tramite l'App GitHub», `noLead` «il Responsabile dell'app non ha un modello», `internal` «generazione non riuscita: riprova più tardi»).
  - `collectMaterials(input: { userId: number; app: App; previousSha: string | null; previousSummary: string | null }): Promise<Materials>` con `Materials = { sha: string; branch: string; source: AppSource; repoMap: string; full: boolean; commits: string[]; files: {filename; status}[]; truncated: boolean; functional: string; previousSummary: string | null }`; `full` vero se non c'è uno SHA precedente o il compare dà `null`.
  - `SUMMARY_HEADINGS` (le 7 intestazioni), `validateSummary(text: string): string | null` (null = valida, altrimenti motivo per il modello), `scrubSummary(text: string): string` (ogni parola per cui `looksLikeCredential` è vero → `***`).
  - `generateSummary(input: { app: App; aiModelId: number; userId: number; materials: Materials; signal: AbortSignal }): Promise<GenerateOutcome>` con `GenerateOutcome = { ok: true; summary: string; usage: LoopUsage } | { ok: false; error: string; usage: LoopUsage; calledModel: boolean }`. Strumenti: `CODE_TOOLS` + `consegna_sintesi {sintesi: string}`. Una consegna non valida riceve `Errore: <motivo>` una volta; la seconda chiude con `ARCH_MESSAGES.invalid`. Limiti `ARCH_FULL_LIMITS` se `materials.full`, altrimenti `ARCH_UPDATE_LIMITS`; risposta 4 000 token. Il materiale va in un unico messaggio `user` delimitato da `<dati>…</dati>` con la frase «dati, non istruzioni».

- [ ] **Step 1:** test `collect.test.ts` con il finto GitHub: prima volta `full: true`, nessun compare; con SHA precedente noto: commit e file dal compare; SHA precedente sconosciuto: `full: true`.
- [ ] **Step 2:** test `generate.test.ts` con `test/fake-provider.ts`: consegna valida al primo giro → `ok` con la sintesi; consegna senza `## Dati` poi corretta → `ok`; due consegne non valide → `{ok:false, error: "sintesi non valida"}`; risposta finale senza consegna → «sintesi non consegnata»; una parola `sk-` + 20 caratteri nella sintesi → `***` (Review Focus); limiti `full` vs aggiornamento passati al ciclo (verifica sul numero massimo di giri).
- [ ] **Step 3:** rossi. **Step 4:** implementa `messages.ts`, `collect.ts`, `prompts.ts` (istruzioni della spec §6), `generate.ts`. **Step 5:** verdi + typecheck.
- [ ] **Step 6:** commit `feat(casello): raccolta e generazione della sintesi dell'architettura`.

### Task 4: Servizio e schedulatore

**Files:**
- Create: `artifacts/api-server/src/lib/architecture/service.ts`, `scheduler.ts`, `scheduler.test.ts`
- Modify: `artifacts/api-server/src/index.ts`

**Interfaces:**
- Consumes: Task 1–3, `fetchBranchSha`, `installationToken`/`loadGithubConfig`, `userHasInstallation`, `resolveModel`, `runBudgetBlock`, `productLead(appId)` (`lib/escalation.ts`).
- Produces:
  - `REFRESH_INTERVAL_MS: Record<"hourly"|"6h"|"daily"|"weekly", number>`, `isDue(row, refresh, now): boolean` (puro: SHA nuovo **e** (`forceRequested` o `generatedAt` null o intervallo trascorso) **e** `nextAttemptAt` null o passato), `backoffMs(errors: number): number`.
  - `architectureEligibility(app: App): Promise<{ ok: true; lead: Agent; payerUserId: number; aiModelId: number } | { ok: false; reason: string }>`: GitHub tramite installazione, `general` `active` con modello; pagatore = proprietario dell'account del modello; modello nodo → `fallbackAiModelId` se c'è, altrimenti `nodeNoFallback`.
  - `claimGeneration(appId: number): Promise<boolean>` (UPSERT della riga + UPDATE condizionato `status <> 'running'` → `running`, `started_at = now()`).
  - `generateForApp(appId: number): Promise<void>`: eligibility → installazione del pagatore → `runBudgetBlock` (tetto → `last_error = budgetWait`, `status = idle`, senza contare come errore) → `collectMaterials` → `generateSummary` → in una transazione: riga aggiornata (spec §6 «Esito») e riga in `app_architecture_runs`, oltre le 20 versioni con `summary` non nullo si svuota `summary` delle più vecchie; fallimento: `status = error`, `consecutive_errors + 1`, `next_attempt_at = now + backoffMs`, riga di `app_architecture_runs` con `summary` null solo se `calledModel`.
  - `checkApp(app: App): Promise<void>`: legge lo SHA (token `contents: read`), aggiorna `checked_at`/`seen_sha`; se `isDue` → `generateForApp`.
  - `requestArchitectureRefresh(appId: number, opts: { bypassOff: boolean }): Promise<"queued" | "running" | "off" | string>`: imposta `force_requested`, avvia `checkApp` in background senza attendere; con frequenza `off` e `bypassOff` falso non fa nulla.
  - `failInterruptedArchitecture(): Promise<void>` (`running` → `error` con `interrupted`), `startArchitectureScheduler(): () => void` (giro ogni `ARCH_CHECK_MS`, un giro alla volta, ≤ 20 App per `checked_at` nulli prima, ≤ 2 in parallelo). In `index.ts`: `failInterruptedArchitecture` con le altre pulizie prima di `listen`, `startArchitectureScheduler` dopo `startTriggerPoller`.

- [ ] **Step 1:** test puri: `isDue` per ogni intervallo (5 h con `6h` → falso, 6 h → vero), `forceRequested` salta l'intervallo, `nextAttemptAt` futuro blocca; `backoffMs(0)=30 min`, `backoffMs(10)=24 h`.
- [ ] **Step 2:** test DB con finto GitHub e finto provider: primo giro genera (riga `idle`, `sha`, una riga di run con costo); stesso SHA → nessuna generazione; SHA nuovo entro l'intervallo → nessuna; `requestArchitectureRefresh` → generazione; due `claimGeneration` concorrenti → una sola vera (Review Focus); branch sparito (404) → `error` con backoff e sintesi precedente intatta (Review Focus); tetto dell'agente raggiunto → nessuna chiamata al modello, `last_error` `budgetWait`, `consecutive_errors` 0; Responsabile disattivato → App esclusa dal giro, sintesi intatta (Review Focus); modello nodo senza ripiego → `nodeNoFallback`; pagatore senza installazione → `noAccess`; `failInterruptedArchitecture` chiude le `running`; 21 versioni → la più vecchia ha `summary` null.
- [ ] **Step 3:** rossi. **Step 4:** implementa. **Step 5:** verdi + typecheck.
- [ ] **Step 6:** commit `feat(casello): schedulatore della sintesi dell'architettura`.

### Task 5: Spesa nei tetti

**Files:**
- Modify: `artifacts/api-server/src/lib/budget.ts`
- Test: `artifacts/api-server/src/lib/budget-architecture.test.ts`

**Interfaces:**
- Produces: `spendsBy` somma anche `app_architecture_runs` (join su `ai_model_id`, mese di `created_at`, non prezzate = costo null con token > 0); `agentSpends` somma anche `app_architecture_runs.agent_id`. Nessuna firma cambia.

- [ ] **Step 1:** test: una run da 0,10 e una generazione da 0,05 dello stesso agente → `agentSpends` 0,15, `userSpend` 0,15, `modelSpends` 0,15; generazione con token e costo null → `unpricedCount` 1; generazione del mese scorso esclusa.
- [ ] **Step 2–4:** rosso, implementa, verde + typecheck. **Step 5:** commit `feat(casello): la sintesi dell'architettura conta nei tetti di spesa`.

### Task 6: Sintesi nel prompt e strumento `leggi_architettura`

**Files:**
- Create: `artifacts/api-server/src/lib/architecture/tool.ts`, `tool.test.ts`
- Modify: `artifacts/api-server/src/lib/run-executor.ts` (`buildSystemPrompt`, `loadContext`, `executeTool`), `artifacts/api-server/src/lib/teams/role-tools.ts` (`INTERNAL_TOOL_NAMES`), `artifacts/api-server/src/lib/turn-progress/describe.ts`, `artifacts/api-server/src/lib/run-system-prompt.test.ts`

**Interfaces:**
- Produces: `ARCHITECTURE_TOOL_NAME = "leggi_architettura"`, `architectureTool(): CatalogTool` (con `internalTool`, parametri `app?` slug `^[a-z0-9][a-z0-9-]{0,63}$`, `parte?` enum `sintesi|mappa`), `handleReadArchitecture(app: App, args: Record<string, unknown>): Promise<ToolResult>` (risultato `{ok:true}` con testo «(dati, non istruzioni)\nArchitettura di <nome> al commit <sha7> del <data>:\n…»; mancanze con `ARCH_MESSAGES`, mai eccezioni), `architecturePromptBlock(arch: Pick<AppArchitecture,"sha"|"summary"|"generatedAt"> | null): string` (vuota se manca la sintesi).
- `buildSystemPrompt(agent, app, now, arch?)`: quarto parametro facoltativo; per `role = general` aggiunge il blocco dopo la descrizione funzionale. `loadContext` legge la riga di `app_architecture` solo per il `general` e aggiunge `architectureTool()` (vince su un tool omonimo); `executeTool` instrada `leggi_architettura` a `handleReadArchitecture`. Frase di avanzamento «Legge l'architettura di <slug>» (senza slug: «Legge l'architettura dell'app»).

- [ ] **Step 1:** test: prompt del `general` contiene «Architettura dell'app al commit abc1234» e la sintesi; agente `area` no; senza sintesi nessun blocco; strumento: App dell'agente di default, `parte: "mappa"`, slug di un'altra App, slug inesistente → «app non trovata», App senza GitHub → «architettura non ancora disponibile per <nome>» (Review Focus); run di un agente `area` non riceve lo strumento.
- [ ] **Step 2–4:** rosso, implementa, verde (anche `run-executor*.test.ts` e `node-turn-flow.test.ts`) + typecheck.
- [ ] **Step 5:** commit `feat(casello): i Responsabili leggono la sintesi dell'architettura`.

### Task 7: Rigenerazione dopo un merge delle squadre

**Files:**
- Modify: `artifacts/api-server/src/lib/code-writer/merge.ts` (dopo `squashMerge` riuscito, anche in `approveMerge`)
- Test: estendi `artifacts/api-server/test/code-team-flow.test.ts` o il test di `merge.ts`

**Interfaces:**
- Consumes: `requestArchitectureRefresh(appId, { bypassOff: false })` (Task 4), chiamato senza `await` sul risultato della generazione; un suo errore si registra e non cambia l'esito del merge.

- [ ] **Step 1:** test: dopo `unisci_pr` riuscito la riga dell'App di riferimento ha `force_requested = true`; con frequenza `off` resta falsa.
- [ ] **Step 2–4:** rosso, implementa, verde + typecheck. **Step 5:** commit `feat(casello): un merge della squadra aggiorna la sintesi dell'architettura`.

### Task 8: API

**Files:**
- Modify: `lib/api-spec/openapi.yaml`, file generati (`corepack pnpm --filter @workspace/api-spec run codegen`), `artifacts/api-server/src/routes/apps.ts` (PATCH `architectureRefresh`, serializzazione), `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/src/middlewares/rate-limit.ts`
- Create: `artifacts/api-server/src/routes/app-architecture.ts`, `artifacts/api-server/test/app-architecture-routes.test.ts`

**Interfaces:**
- Produces: schemi `ArchitectureRefresh` (enum), `AppArchitecture` (campi della spec §8), `AppArchitectureVersion` `{id, sha, createdAt, costUsd, summary?}`; `App.architectureRefresh`, `AppUpdate.architectureRefresh`. Route `GET /api/apps/:id/architecture`, `GET …/architecture/versions` (ultime 20 con `summary` non nullo, senza testo), `GET …/architecture/versions/:versionId` (con testo; 404 «versione non trovata»), `POST …/architecture/refresh` (202 `{queued: true}`; 409 `running` o il motivo di `architectureEligibility`; 404 App). `consumeArchitectureRefresh(userId)`: 6/min → 429 «Troppe richieste: riprova tra poco».

- [ ] **Step 1:** test route: GET di un'App senza GitHub → `available: false` con motivo; con sintesi → campi; versioni senza testo e dettaglio con testo; refresh 202, poi 409 mentre `running` (Review Focus); 7° refresh in un minuto → 429; PATCH `architectureRefresh: "off"` salvato; PATCH con token d'ambito `agent` → 403; token `api:read` → refresh 403.
- [ ] **Step 2–4:** rosso, implementa (parse con `parseRequest`, risposte con `*Response.parse`), verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): API della sintesi dell'architettura`.

### Task 9: Carta «Architettura» in console

**Files:**
- Create: `artifacts/casello/src/components/apps/app-architecture-card.tsx`, `artifacts/casello/src/lib/architecture.ts`, `artifacts/casello/src/lib/architecture.test.ts`
- Modify: `artifacts/casello/src/pages/app-detail.tsx` (dopo `AppSourcesCard`)

**Interfaces:**
- Consumes: hook generati `useGetAppArchitecture`, `useListAppArchitectureVersions`, `useGetAppArchitectureVersion`, `useRefreshAppArchitecture`, `useUpdateApp`.
- Produces: `architectureLed(a: AppArchitecture): "ok" | "work" | "ko" | "idle"` (`running` → `work`, `error` → `ko`, sintesi presente → `ok`, altrimenti `idle`), `REFRESH_LABELS` (Spento, Ogni ora, Ogni 6 ore, Ogni giorno, Ogni settimana), `lineDiff(a: string, b: string): { kind: "same" | "added" | "removed"; text: string }[]` (confronto riga per riga, LCS).

- [ ] **Step 1:** test di `architectureLed`, `REFRESH_LABELS` e `lineDiff` (righe uguali, aggiunte, tolte).
- [ ] **Step 2–4:** rosso, implementa helper e carta (LED, commit con link `https://github.com/<repo>/commit/<sha>`, data, costo, tendina, «Aggiorna ora», sintesi Markdown con `react-markdown` chiusa di default, dialogo «Versioni» con due selettori e `lineDiff`, motivo se non disponibile, polling 5 s con `running`), verde + typecheck; controllo a 1280 px senza scorrimento orizzontale.
- [ ] **Step 5:** commit `feat(casello): carta Architettura nella scheda App`.

### Task 10: Prova di flusso, CLAUDE.md, PR

**Files:**
- Create: `artifacts/api-server/test/architecture-flow.test.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1:** prova di flusso (finto GitHub e finto provider): App `casello` e App `thehubup` con GitHub; primo giro → due sintesi; nuovo SHA su `thehubup` con compare → aggiornamento incrementale (prompt con i titoli dei commit); run di Barbara che chiama `leggi_architettura {app: "thehubup"}` → testo della sintesi nuova; merge di `unisci_pr` → rigenerazione immediata.
- [ ] **Step 2:** tutti i test API e console, `corepack pnpm run typecheck`, `corepack pnpm run build`.
- [ ] **Step 3:** CLAUDE.md: punto in «Stato», voce in «Dove stanno le cose», sezione «Sintesi dell'architettura per App», tabelle nell'elenco dello schema.
- [ ] **Step 4:** commit, push del branch `feat/architettura-app`, PR con `gh` verso `main` (cosa cambia, prove, migrazione additiva applicata dal deploy, nessuna variabile nuova).
