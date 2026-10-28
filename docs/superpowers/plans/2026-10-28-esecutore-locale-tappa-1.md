# Esecutore locale, tappa 1 — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dalla console si avvia un'analisi dell'architetto con esecutore "Agente locale"; in Claude Code (CLI o
scheda Code dell'app desktop, con l'abbonamento Claude dell'utente) l'agente prende l'analisi in coda dal server
MCP di Casello, esegue le sei fasi sul clone locale e le consegna; in console compaiono gli elementi da approvare
come per un'analisi cloud.

**Architecture:** l'analisi locale è una riga di `analyses` con `executor = 'local'` che nessun processo del
server esegue: un modulo `architect/local-executor.ts` gestisce coda, lease, istruzioni e consegne, e salva gli
esiti in `analysis_phase_results`; la registrazione degli elementi (`phaseItems` + diff + INSERT) viene estratta
da `run-analysis.ts` e condivisa. Un server MCP Streamable HTTP montato su `/mcp` espone il modulo come
strumenti, autenticato con token personali (`api_tokens`) creati dalla pagina Account.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), `@modelcontextprotocol/sdk` (unica dipendenza
nuova), Zod, Vitest, React + React Query + shadcn/ui, nginx.

**Spec:** `docs/superpowers/specs/2026-10-28-casello-esecutore-locale-design.md` (con le note §13). Questo piano
copre l'ordine di consegna 1 e 2 della spec §12; l'OAuth (tappa 2 della spec §6, passo 3) è fuori.

Percorsi abbreviati: `A/` = `artifacts/api-server/src/`, `C/` = `artifacts/casello/src/`.

## Decisioni del piano rispetto alla spec (da confermare in revisione)

1. **Niente provider/account/modello `local_agent`** (spec §2, primo e secondo punto). Nel codice attuale un
   account con `user_id` nullo deve essere `system_gateway` (`resolveModel`, `visibleTo`, `isSystemAccount`),
   `provider_protocol` è un enum Postgres, e un modello "local-agent" comparirebbe anche nella scelta del
   modello degli agenti operativi, che non possono usarlo. Al suo posto: `analyses.executor` (`cloud` | `local`)
   scelto all'avvio con un campo `executor` nella richiesta, `ai_model_id` nullo e `model = 'agente-locale'`.
   La console mostra un'opzione "Agente locale" accanto alla scelta del modello.
2. **`get_phase_instructions` senza `schema` JSON** (spec §4). Generarlo dagli schemi Zod richiederebbe una
   seconda dipendenza (`zod-to-json-schema`); l'esempio esatto della fase è già nel prompt e una consegna non
   valida torna con le stesse `issues` Zod che riceve il modello cloud.
3. **`list_analyses` elenca tutte le analisi locali aperte**, non solo "dell'utente": `analyses` non registra chi
   l'ha avviata e le app sono visibili a tutti gli utenti ammessi (come in console).
4. **Mappa del repository vuota** per l'esecutore locale: Casello non scarica il codice (lo legge l'agente sul
   proprio clone), quindi `repoMap` è `""`; gli appunti (`notes`) delle fasi precedenti arrivano invece come nel
   percorso cloud.

## Global Constraints

- Italiano per commenti, messaggi, UI, documentazione e commit; identificatori in inglese; nomi degli strumenti
  MCP in inglese con descrizioni in italiano.
- Branch `feat/esecutore-locale`; un commit per task; `pnpm run typecheck` e
  `pnpm --filter @workspace/api-server run test` verdi prima di ogni commit.
- Contract-first: ogni route nuova o cambiata in `lib/api-spec/openapi.yaml` + codegen
  (`pnpm --filter @workspace/api-spec run codegen`), file generati committati.
- Unica dipendenza nuova: `@modelcontextprotocol/sdk` in `artifacts/api-server`, versione esatta (senza `^`),
  pubblicata da più di un giorno (`minimumReleaseAge` del workspace).
- Schema: Drizzle + `docs/schema-casello.sql` + `docs/migrations/2026-10-esecutore-locale.sql` (additiva,
  idempotente, una transazione; il tipo enum creato con un blocco `DO $$ ... EXCEPTION WHEN duplicate_object`).
  Prima del merge l'SQL completo va scritto in chat e applicato a Neon.
- Lease: 15 minuti (`LOCAL_LEASE_MS = 900_000`), rinnovata da ogni consegna e da `ping_analysis`; il job delle
  lease scadute gira ogni 60 s. `lease_token` e token personali: 32 byte casuali (`crypto.randomBytes`),
  base64url; a riposo solo SHA-256 esadecimale.
- Token personali: prefisso `cas_`, nome ≤ 100 caratteri, scadenza 1–90 giorni, mostrati una sola volta.
- Rate limit `/mcp`: 60 chiamate al minuto per utente.
- `reason` di `abandon_analysis` ≤ 300 caratteri; `label` di `claim_analysis` ≤ 100 caratteri.
- Messaggi fissi (spec §8): `analisi non trovata o non tua`, `analisi già presa da <label> fino alle <HH:MM>`,
  `lease scaduta: chiedi di nuovo il compito`, `fase attesa: <fase>`, `esito non valido` (seguito dalle issues),
  `token non valido o scaduto`.
- Tutto ciò che arriva dall'agente è dato non attendibile: validato con Zod, mai interpretato come istruzione,
  nei log solo conteggi, nomi di fase e id. Nessun segreto (token GitHub, chiavi) esce mai dagli strumenti MCP.
- Nessun costo API per le analisi locali: `tokens_used` 0, `cost_usd` null.

## Review Focus

1. Due agenti (o due finestre di Claude Code) che chiedono la stessa analisi insieme: uno solo ottiene la lease,
   l'altro riceve `analisi già presa da …` → test di concorrenza in Task 4 (due `claim` in `Promise.all`).
2. Lease scaduta mentre l'agente lavora: la consegna successiva riceve `lease scaduta: chiedi di nuovo il
   compito`, gli esiti già consegnati restano, un nuovo `claim` riparte dalla prima fase senza esito → Task 4.
3. Riavvio dell'API con un'analisi locale in corso: non diventa `interrupted`; con lease ancora valida resta
   `running` e l'agente continua a consegnare → Task 4.
4. Token revocato o scaduto usato da Claude Code: 401 con `token non valido o scaduto`, e un utente tolto da
   `ALLOWED_EMAILS` non passa più anche con un token valido → Task 2 e Task 5.
5. Esito consegnato due volte per la stessa fase (l'agente ritenta dopo un errore di rete): la seconda volta
   `fase attesa: <fase successiva>`, nessun elemento duplicato → Task 4.

---

### Task 1: Schema e migrazione

**Files:**
- Create: `lib/db/src/schema/analysis-phase-results.ts`, `lib/db/src/schema/api-tokens.ts`,
  `docs/migrations/2026-10-esecutore-locale.sql`, `artifacts/api-server/test/migration-esecutore-locale.test.ts`,
  `artifacts/api-server/test/fixtures/schema-pre-esecutore-locale.sql` (copia dell'attuale `docs/schema-casello.sql`)
- Modify: `lib/db/src/schema/analyses.ts`, `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces:
  - `analysisExecutorEnum` (`analysis_executor`: `cloud`, `local`); su `analysesTable`: `executor` (not null,
    default `cloud`), `leaseTokenHash` text, `leaseUntil` timestamp, `leaseLabel` text, `sourceCommit` text (tutti
    nullabili).
  - `analysisPhaseResultsTable` (`analysis_phase_results`): `id` serial, `analysisId` → analyses (cascade),
    `phase` text not null, `result` jsonb not null, `submittedAt` timestamp not null default now; indice unico
    `analysis_phase_results_unique` su (`analysis_id`, `phase`). Tipo `AnalysisPhaseResult`.
  - `apiTokensTable` (`api_tokens`): `id` serial, `userId` → users (cascade) not null, `tokenHash` text not null
    unique, `name` text not null, `expiresAt` timestamp not null, `lastUsedAt`, `revokedAt` timestamp nullabili,
    `createdAt` default now. Tipo `ApiToken`.
- [ ] **Step 1: Test che fallisce** `migration-esecutore-locale.test.ts` (schema del fixture + un'analisi
  esistente): dopo la migrazione l'analisi ha `executor = 'cloud'` e le colonne lease nulle; le tabelle nuove
  accettano una riga; il vincolo unico su (`analysis_id`, `phase`) rifiuta un duplicato; eseguita due volte non
  fallisce.
- [ ] **Step 2: Eseguirlo e vederlo fallire** — `pnpm --filter @workspace/api-server exec vitest run test/migration-esecutore-locale.test.ts` — FAIL (file di migrazione assente).
- [ ] **Step 3: Implementare** schema Drizzle, migrazione, `docs/schema-casello.sql`.
- [ ] **Step 4: Verifica** — test della migrazione e suite completa verdi, typecheck verde.
- [ ] **Step 5: Commit** — `feat(db): esecutore delle analisi, esiti per fase e token personali`.

### Task 2: Token personali per gli agenti locali

**Files:**
- Create: `A/lib/api-tokens.ts`, `A/lib/api-tokens.test.ts`, `A/routes/api-tokens.ts`, `A/routes/api-tokens.test.ts`
- Modify: `A/routes/index.ts`, `lib/api-spec/openapi.yaml` + codegen

**Interfaces:**
- Consumes: `apiTokensTable`, `usersTable`, `isAllowed(emails)` di `A/lib/users.ts`.
- Produces:
  - `createApiToken(userId: number, name: string, expiresInDays: number): Promise<{ token: string; row: ApiToken }>`
    — token `cas_` + base64url di 32 byte; nome ripulito (`trim`, 1–100 caratteri), giorni interi 1–90, altrimenti
    `ApiTokenInputError` (messaggio in italiano per il 400).
  - `listApiTokens(userId: number): Promise<ApiToken[]>` (più recenti prima, revocati inclusi);
    `revokeApiToken(userId: number, id: number): Promise<boolean>` (false se non suo o già revocato).
  - `authenticateApiToken(raw: string, now?: Date): Promise<{ userId: number; tokenId: number } | null>` — null se
    sconosciuto, revocato, scaduto o se l'email dell'utente non passa più `isAllowed`; aggiorna `lastUsedAt` al
    massimo una volta al minuto.
  - Route (dietro `requireAuth`): `GET /account/tokens` → `ApiTokenInfo[]` (`id`, `name`, `createdAt`,
    `expiresAt`, `lastUsedAt`, `revokedAt`; mai l'hash); `POST /account/tokens` body
    `{ name: string, expiresInDays: integer 1–90 }` → 201 `{ token, info: ApiTokenInfo }`;
    `DELETE /account/tokens/{id}` → 204, 404 se non suo.
- [ ] **Step 1: Test che falliscono**
  - `api-tokens.test.ts`: il token creato inizia con `cas_` e autentica l'utente; nel DB c'è solo l'hash (il token
    in chiaro non compare in nessuna colonna); `revokeApiToken` → `authenticateApiToken` null; scaduto (orologio
    `now` dopo `expiresAt`) → null; `expiresInDays` 0 o 91 → `ApiTokenInputError`; utente la cui email non è più
    in `ALLOWED_EMAILS` → null.
  - `routes/api-tokens.test.ts`: crea, elenca (senza hash né token), revoca; un altro utente riceve 404 sulla
    revoca e non vede i token.
- [ ] **Step 2: Vederli fallire.**
- [ ] **Step 3: Implementare** modulo, route, OpenAPI e codegen.
- [ ] **Step 4: Suite e typecheck verdi.**
- [ ] **Step 5: Commit** — `feat(api-server): token personali per gli agenti locali`.

### Task 3: Registrazione condivisa degli esiti di fase

**Files:**
- Create: `A/lib/architect/phase-record.ts`
- Modify: `A/lib/architect/run-analysis.ts` (usa il modulo), `A/lib/architect/phase-loop.ts` (esporta `formatIssues`)
- Test: `A/lib/architect/run-analysis.test.ts` (invariati, devono restare verdi), `A/lib/architect/phase-record.test.ts`

**Interfaces:**
- Produces:
  - `recordPhaseResult(input: { analysisId: number; appId: number; phase: PhaseName; result: unknown }): Promise<number>`
    — calcola gli elementi con `phaseItems` (spostato qui con `currentTools`/`currentAgents`/`currentSkills`/
    `evidenceOf`), li inserisce con `position` che prosegue da `max(position)` dell'analisi (una sola INSERT),
    restituisce quanti elementi ha inserito. `forceVerification` resta in `run-analysis.ts` (si applica prima).
  - `export function formatIssues(issues: ZodIssue[]): string[]` da `phase-loop.ts` (oggi privata).
- Refactoring a comportamento invariato: `run-analysis.ts` chiama `recordPhaseResult` al posto del blocco attuale
  e non tiene più il contatore `position`.
- [ ] **Step 1: Test** `phase-record.test.ts`: due chiamate per fasi diverse sulla stessa analisi → `position`
  continua (1..n, poi n+1..); esito del catalogo con un tool già esistente → elemento con il diff "modificato"
  come oggi.
- [ ] **Step 2: Vederlo fallire** (modulo assente).
- [ ] **Step 3: Estrarre** il codice; nessun cambiamento ai test di `run-analysis.test.ts`.
- [ ] **Step 4: Suite e typecheck verdi.**
- [ ] **Step 5: Commit** — `refactor(api-server): registrazione degli esiti di fase condivisa tra gli esecutori`.

### Task 4: Ciclo di vita delle analisi locali

**Files:**
- Create: `A/lib/architect/local-executor.ts`, `A/lib/architect/local-executor.test.ts`
- Modify: `A/lib/architect/run-analysis.ts` (`failInterruptedAnalyses` salta le locali), `A/routes/analyses.ts`,
  `A/index.ts` (job delle lease), `lib/api-spec/openapi.yaml` + codegen
- Test: `A/routes/analyses.test.ts`

**Interfaces:**
- Consumes: `recordPhaseResult`, `formatIssues`, `PHASE_SCHEMAS`, `PHASES`, `phasePrompt`, `SYSTEM_BASE`, `appendLog`.
- Produces (in `local-executor.ts`; ogni errore per l'agente è `LocalAnalysisError` con i messaggi fissi):
  - `export const LOCAL_LEASE_MS = 900_000`, `LOCAL_MODEL = "agente-locale"`.
  - `listOpenLocalAnalyses(): Promise<LocalAnalysisSummary[]>` — `{ analysisId, appId, appName, status, phase, deliveredPhases: PhaseName[], leaseLabel, leaseUntil }` per `executor = 'local'` e stato `queued`/`running`.
  - `claimLocalAnalysis(analysisId: number, label: string, now?: Date): Promise<{ leaseToken: string; phase: PhaseName; app: LocalAppCard }>`
    — atomico (UPDATE condizionato `status = 'queued' OR lease_until < now`): stato `running`, fase = prima di
    `PHASES` senza riga in `analysis_phase_results`, lease nuova; lease valida di altri →
    `analisi già presa da <label> fino alle <HH:MM>` (ora Europe/Rome). `LocalAppCard`: `name`, `functionalDescription`,
    `baseUrl`, `sourceRepo`/`sourceBranch` (solo se GitHub), `hasOpenApi` (impostato da Task 5, qui `false`).
  - `localPhaseInstructions(analysisId, leaseToken, now?): Promise<{ phase: PhaseName; system: string; user: string }>`
    — `system` = `LOCAL_PREFACE + "\n\n" + SYSTEM_BASE`, `user` = `phasePrompt(phase, { …app, hasCode: true, hasOpenApi, previous, repoMap: "" })`
    con `previous` dagli esiti salvati in ordine di fase. `LOCAL_PREFACE` (testo fisso): "Esegui questa fase con i tuoi
    strumenti sul clone locale del repository: gli strumenti di lettura citati sotto (list_dir, read_file,
    read_files, search) corrispondono ai tuoi. Consegna l'esito con lo strumento submit_phase di Casello, non con
    submit_result."
  - `submitLocalPhase(analysisId, leaseToken, phase, result: unknown, sourceCommit?: string, now?)`:
    `Promise<{ ok: true; nextPhase: PhaseName | null; summary?: Record<AnalysisChapter, number> } | { ok: false; issues: string[] }>`
    — lease valida (hash uguale e `leaseUntil > now`, altrimenti `lease scaduta: chiedi di nuovo il compito`); `phase`
    uguale alla corrente (altrimenti `fase attesa: <fase>`); `PHASE_SCHEMAS[phase].safeParse` → `issues` da
    `formatIssues`; valido → in una transazione INSERT in `analysis_phase_results`, `recordPhaseResult`,
    `architecture_map` per `map`, voce di log, fase successiva, lease rinnovata; dopo `evolution` →
    `completed`, `finished_at`, lease azzerata e `summary` = conteggio degli elementi per capitolo. `sourceCommit`
    (solo `/^[0-9a-f]{7,40}$/i`) salvato; se diverso da quello atteso (Task 5) voce di log
    "analizzato il commit X, atteso Y".
  - `pingLocalAnalysis(analysisId, leaseToken, now?)`, `abandonLocalAnalysis(analysisId, leaseToken, reason, now?)`
    (→ `failed`, `error` = `abbandonata dall'agente locale: <reason>`).
  - `releaseLocalAnalysis(analysisId)` (console "Rilascia": lease azzerata, `queued`) e `cancelLocalAnalysis(analysisId)`
    (console "Annulla": `failed`, `error` = `annullata dalla console`).
  - `releaseExpiredLeases(now?: Date): Promise<number>` — le locali `running` con lease scaduta tornano `queued`.
  - `startLocalLeaseJob(): void` — `releaseExpiredLeases` ogni 60 s, timer `unref`, chiamato in `A/index.ts`.
- Route: `StartAnalysisBody` acquista `executor?: "cloud" | "local"` (default `cloud`); con `local`, `aiModelId` e
  `model` vietati, nessun controllo sulle sorgenti GitHub (il codice lo legge l'agente), `startAnalysis` non parte;
  lo zip con `local` → 400 "con l'agente locale lo zip non serve". `POST /analyses/{id}/release` e
  `POST /analyses/{id}/cancel` (solo analisi locali aperte, altrimenti 409). `Analysis` acquista `executor`,
  `leaseLabel`, `leaseUntil`; `GET /analyses/{id}` anche `deliveredPhases: { phase, submittedAt }[]`.
  `failInterruptedAnalyses` chiude solo le analisi `cloud`.
- [ ] **Step 1: Test che falliscono** (`local-executor.test.ts`, orologio passato come `now`):
  claim → `running`, fase `map`, lease di 15 minuti; due claim in `Promise.all` → uno solo riesce, l'altro
  `analisi già presa da`; claim su lease scaduta riesce; submit con esito valido per tutte e sei le fasi (gli esempi
  di `PHASE_EXAMPLES`) → `completed` e `summary` con i conteggi; submit non valido → `{ ok: false, issues }` e la
  fase non avanza; submit della stessa fase due volte → la seconda `fase attesa: capabilities` e nessun elemento
  duplicato; submit con lease scaduta → `lease scaduta: …` e gli esiti precedenti restano; dopo
  `releaseExpiredLeases` → `queued` e un nuovo claim riparte dalla prima fase senza esito; `abandon` → `failed` con
  il motivo; `failInterruptedAnalyses` lascia `running` un'analisi locale con lease valida.
  `routes/analyses.test.ts`: avvio con `executor: "local"` → 202, `aiModelId` null, `model` `agente-locale`, nessuna
  chiamata al modello; `executor: "local"` con `aiModelId` → 400; release e cancel.
- [ ] **Step 2: Vederli fallire.**
- [ ] **Step 3: Implementare**, OpenAPI e codegen.
- [ ] **Step 4: Suite e typecheck verdi.**
- [ ] **Step 5: Commit** — `feat(api-server): analisi dell'architetto eseguite da un agente locale (coda e lease)`.

### Task 5: Server MCP su `/mcp`

**Files:**
- Create: `A/lib/mcp/server.ts`, `A/lib/mcp/auth.ts`, `A/lib/mcp/server.test.ts`
- Modify: `A/app.ts` (monta `/mcp` fuori da `/api`, prima della sessione), `A/middlewares/rate-limit.ts`
  (chiave configurabile), `artifacts/api-server/package.json` + lockfile, `docker/nginx.conf`,
  `A/lib/architect/local-executor.ts` (OpenAPI e commit atteso)

**Interfaces:**
- Consumes: `authenticateApiToken` (Task 2); le funzioni di `local-executor.ts` (Task 4); `fetchOpenApi`,
  `describeOperation`, `loadAppConnection`; `installationToken`, `githubConfig`.
- Produces:
  - `rateLimit({ limit, windowMs, key? })` con `key?: (req) => string` (default `req.ip`, invariato per le run).
  - `mcpRouter(): Router` — `POST /mcp` in modalità stateless (`StreamableHTTPServerTransport` con
    `sessionIdGenerator: undefined`, un server per richiesta), `GET`/`DELETE /mcp` → 405. Middleware: `Bearer`
    obbligatorio → `authenticateApiToken`, altrimenti 401 JSON `{ error: "token non valido o scaduto" }`; poi rate
    limit 60/min con chiave `user:<id>`.
  - Strumenti (descrizioni in italiano, input Zod): `list_analyses` {}; `claim_analysis` { analysisId, label };
    `get_phase_instructions` { analysisId, leaseToken }; `read_openapi` { analysisId, leaseToken, prefix?, offset?,
    method?, path? } (con `method`+`path` descrive un'operazione, altrimenti elenca come `list_operations`);
    `submit_phase` { analysisId, leaseToken, phase, result, sourceCommit? }; `ping_analysis`; `abandon_analysis`
    { …, reason }. Ogni risultato è un unico contenuto testo JSON; gli errori `LocalAnalysisError` tornano come
    risultato con `isError: true` e il messaggio fisso.
  - In `local-executor.ts`: al claim, OpenAPI dell'app (`fetchOpenApi`) in una cache in memoria per analisi (si
    ricarica se manca, es. dopo un riavvio) e `hasOpenApi` nella scheda; `expectedCommit` = sha del branch
    dall'installazione GitHub dell'app (`GET /repos/{repo}/commits/{branch}` con il token di installazione), null se
    l'app non usa l'App GitHub o la chiamata fallisce; mai il token nella risposta né nei log.
  - nginx: `location /mcp` con lo stesso proxy di `/api/` (senza `client_max_body_size` grande: bastano 2m).
  - Dipendenza: `@modelcontextprotocol/sdk` a una versione esatta pubblicata da più di un giorno.
- [ ] **Step 1: Test che falliscono** (`server.test.ts`, app Express in memoria e client MCP dello stesso SDK con
  `StreamableHTTPClientTransport` e header `Authorization`): senza token o con token revocato → 401
  `token non valido o scaduto`; `listTools` elenca i sette strumenti; percorso completo list → claim →
  instructions → submit × 6 con gli esempi di `PHASE_EXAMPLES` → analisi `completed` ed elementi in
  `analysis_items` uguali a quelli di un'analisi cloud con gli stessi esiti (stesso numero per capitolo); submit non
  valido → `isError` assente, `ok: false` con `issues`; 61 chiamate in un minuto con lo stesso token → l'ultima 429;
  nessuna risposta contiene `cas_` né il token GitHub.
- [ ] **Step 2: Vederli fallire.**
- [ ] **Step 3: Implementare** (aggiungere la dipendenza con `pnpm --filter @workspace/api-server add @modelcontextprotocol/sdk@<versione> --save-exact`).
- [ ] **Step 4: Suite e typecheck verdi; `pnpm run build` verde (il bundle dell'API include l'SDK).**
- [ ] **Step 5: Commit** — `feat(api-server): server MCP per gli agenti locali dell'architetto`.

### Task 6: Console

**Files:**
- Modify: `C/components/apps/analyses-card.tsx`, `C/pages/analysis-detail.tsx`, `C/pages/account.tsx`
- Create: `C/components/account/api-tokens-section.tsx`

**Interfaces:**
- Consumes: hook generati di Task 2 e Task 4 (`useListApiTokens`, `useCreateApiToken`, `useRevokeApiToken`,
  `useStartAnalysis` con `executor`, `useReleaseLocalAnalysis`, `useCancelLocalAnalysis`).
- Produces (testi fissi):
  - Avvio analisi: interruttore "Esegui con un agente locale (Claude Code)"; attivo → niente scelta del modello né
    stima, al loro posto "Nessun costo API: l'analisi la esegue un agente sul tuo computer."; avvio con
    `{ executor: "local" }`; con app a sorgente zip l'interruttore resta disponibile.
  - Dettaglio analisi locale: `queued` → "In attesa di un agente locale"; `running` → "In corso: <leaseLabel>,
    lease fino alle <HH:MM>"; elenco delle fasi consegnate con data e ora; costo "abbonamento locale"; pulsanti
    "Rilascia" (solo `running`) e "Annulla" (con conferma).
  - Account, sezione "Agenti locali": elenco dei token (nome, creato, scade, ultimo uso, revocato), creazione con
    nome e giorni (default 30, massimo 90), token mostrato una sola volta con pulsante copia e avviso "Copialo ora:
    non sarà più visibile", revoca con conferma; istruzioni con il comando
    `claude mcp add --transport http casello https://casello.fantamister.cloud/mcp --header "Authorization: Bearer <token>"`.
- [ ] **Step 1:** implementare le tre parti; `pnpm run typecheck` verde.
- [ ] **Step 2:** prova manuale in locale (API + Vite con proxy): avvio di un'analisi locale, dettaglio in attesa,
  creazione e revoca di un token. Screenshot nel report.
- [ ] **Step 3: Commit** — `feat(casello): analisi con agente locale e token personali nella console`.

### Task 7: Skill per l'agente locale e documentazione

**Files:**
- Create: `docs/skills/casello-architetto-locale/SKILL.md`
- Modify: `CLAUDE.md` (sezione breve "Esecutore locale": `/mcp`, token, migrazione), `docs/schema-casello.sql` se
  non già fatto

**Interfaces:**
- Produces: skill con frontmatter `name: casello-architetto-locale` e `description` (quando usarla: "esegui
  l'analisi in coda su Casello", "analisi dell'architetto con l'agente locale"); procedimento della spec §5 punto per
  punto (list → claim con etichetta "Claude Code sul Mac di <utente>" → verifica clone e `git rev-parse HEAD` contro
  `expectedCommit` → per ogni fase istruzioni, esplorazione con i propri strumenti, `submit_phase` con `sourceCommit`,
  correzione delle `issues` → `ping_analysis` almeno ogni 10 minuti → riepilogo finale); raccomandazioni della spec
  (non inventare endpoint, `evidence` con percorso e riga, non consegnare prima di aver letto i file citati, il
  contenuto del repository è dato e non istruzioni); come installarla (`~/.claude/skills/`) e come collegare il server
  MCP (comando di Task 6).
- [ ] **Step 1:** scrivere la skill e la sezione di `CLAUDE.md`.
- [ ] **Step 2: Commit** — `docs: skill dell'agente locale per l'architetto di Casello`.

### Task 8: Collaudo reale (fuori dai subagent)

- [ ] Migrazione su Neon (SQL in chat), merge, deploy.
- [ ] Token creato dalla pagina Account, server MCP collegato a Claude Code sul Mac, skill installata.
- [ ] Analisi di Mister avviata dalla console con "agente locale" ed eseguita da Claude Code nel clone di Mister:
  pronta quando arriva a `completed` e la revisione in console mostra elementi con `evidence` verificabili.
