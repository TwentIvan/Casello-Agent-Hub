# Agente locale — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** analisi dell'architetto e run degli agenti eseguibili da Claude Code sul computer dell'utente
(abbonamento, nessuna chiave API), in automatico con `casello-runner` o dalla chat, con modello di riserva a
richiesta.

**Architecture:** Casello resta il regista: per ogni lavoro crea "compiti" (una fase dell'analisi, un turno
della run, una ripresa dopo conferma) e li consegna a un esecutore locale; il runner avvia `claude -p` collegato
al server MCP di Casello (`/api/mcp`), dove vivono tutti gli strumenti (sorgenti, tool delle app, consegna).
L'orchestrazione esistente (`run-analysis.ts`, `run-executor.ts`) cambia solo nel punto in cui oggi chiama il
modello: con una macchina locale attende il compito invece di chiamare `modelChat`.

**Tech Stack:** Express 5, Drizzle/Postgres, `@modelcontextprotocol/sdk` (nuovo), Zod/Orval, Vitest + PGlite,
React + shadcn/ui, Node 24 per `casello-runner`, CLI `claude` (Claude Code).

**Spec:** `docs/superpowers/specs/2026-10-27-casello-agente-locale-design.md`

## Global Constraints

- Italiano per commenti, messaggi, UI e commit; identificatori in inglese.
- Contract-first per le route della console (OpenAPI + codegen); `/api/mcp` e `/api/runner/*` fuori da
  OpenAPI, autenticate con token (mai con la sessione della console).
- Schema DB: Drizzle + `docs/schema-casello.sql` + `docs/migrations/2026-10-agente-locale.sql` (idempotente,
  solo aggiunte; `ALTER TYPE provider_protocol ADD VALUE IF NOT EXISTS 'local_agent'` prima del `BEGIN`).
- Unica nuova dipendenza: `@modelcontextprotocol/sdk` (API e runner).
- Token: 32 byte casuali, prefissi `csl_m_` (macchina), `csl_p_` (personale), `csl_j_` (lavoro), mostrati una
  sola volta, salvati come SHA-256, confronto a tempo costante, revocabili; ognuno vede solo i lavori del proprio
  utente.
- Tempi della spec: runner "collegato" = segnale di vita negli ultimi 30 s; presa entro 10 s; attesa lunga del
  runner 25 s; senza segnale di vita 60 s durante l'esecuzione → "agente locale disconnesso"; "attendi" = 30 min
  per un'analisi, 2 min per una run; "posticipa" = fino a 24 h, poi `cancelled`.
- Regole delle run avviate dalle app: `fallback` (default) | `wait_then_fallback` (`local_offline_wait_s`) |
  `postpone`; `local_for_third_parties` default false (run di un utente diverso dal proprietario dell'agente →
  subito riserva).
- Messaggi fissi: "agente locale non collegato", "agente locale disconnesso", "lavoro scaduto", "token non
  valido o revocato", "lavoro non trovato", "modello di riserva obbligatorio con l'agente locale".
- Nessun segreto delle app (segreti di servizio, `X-App-User-Token`) esce da Casello; argomenti `x-sensitive`
  oscurati come oggi; Claude Code avviato in una cartella temporanea vuota con solo gli strumenti MCP di Casello.
- Costo per Casello zero sui lavori locali (`cost_usd` null o 0 come "abbonamento"); `pnpm run typecheck`, suite
  API e build console verdi a ogni commit.

## Review Focus

1. Runner che si riconnette a metà di un compito (rete instabile, sleep del Mac): se il segnale di vita torna
   entro 60 s il lavoro prosegue, oltre fallisce una volta sola e la run mostra "Riprova con il modello di
   riserva" → test in Task 3.
2. Due runner della stessa macchina (o runner + chat) che provano a prendere lo stesso lavoro: uno solo vince,
   l'altro riceve "lavoro non trovato" → test in Task 3.
3. Claude che termina senza chiamare lo strumento di consegna (o con consegna non valida): la fase riceve le
   correzioni previste (max 2) e poi fallisce con messaggio chiaro, mai un'attesa infinita → test in Task 5.
4. Token di lavoro usato dopo la fine del lavoro, o per un lavoro di un altro utente: 401 / "lavoro non
   trovato", nessun dato esposto → test in Task 4.
5. Riavvio di Casello con lavori aperti e runner collegato: lavori chiusi come le run/analisi, il runner non
   riprende un compito orfano e riceve "lavoro scaduto" → test in Task 3.

---

### Task 1: Schema, migrazione e token

**Files:**
- Create: `lib/db/src/schema/{local-machines,local-jobs,mcp-tokens}.ts`, `artifacts/api-server/src/lib/local/tokens.ts`
  (+ test), `docs/migrations/2026-10-agente-locale.sql`, `artifacts/api-server/test/migration-agente-locale.test.ts`,
  `artifacts/api-server/test/fixtures/schema-pre-agente-locale.sql` (copia dell'attuale `docs/schema-casello.sql`)
- Modify: `lib/db/src/schema/{agents,analyses,providers,index}.ts`, `docs/schema-casello.sql`,
  `artifacts/api-server/src/lib/catalog/provider-registry-data.ts` (provider `local_agent`, protocollo `local_agent`,
  `statusForProtocol("local_agent") = "managed"`)

**Interfaces:**
- Produces:
  - `localMachinesTable` (spec §3), `localJobsTable` (spec §3; enum `local_job_status` con i 9 stati, `kind` enum
    `local_job_kind`, `claimed_by` enum `local_claimed_by`; più `origin` (`console` | `app`), `current_item` jsonb
    `{ id: string; prompt: string; resumeSessionId: string | null } | null`, `job_token_hash`,
    `job_token_expires_at`, `heartbeat_at`), `mcpTokensTable` (spec §3).
  - `agents`: `fallback_ai_model_id` (FK ai_models, set null), `local_offline_policy` enum, `local_offline_wait_s`
    integer default 30, `local_for_third_parties` boolean default false; `analyses.fallback_ai_model_id`.
  - `newToken(kind: "machine" | "personal" | "job"): { token: string; hash: string }`,
    `hashToken(token: string): string`, `tokenKind(token: string): "machine" | "personal" | "job" | null`.

- [ ] **Step 1: Test** `tokens.test.ts`: prefissi `csl_m_`/`csl_p_`/`csl_j_`, 43 caratteri base64url dopo il
  prefisso, due token diversi, `hashToken` deterministico (SHA-256 hex), `tokenKind` riconosce il tipo e rifiuta
  stringhe estranee. `migration-agente-locale.test.ts`: dalla fixture, tabelle e colonne create; provider
  `local_agent` presente; seconda esecuzione senza errori; un lavoro con `machine_id` inesistente rifiutato (FK).
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS + typecheck + suite.
- [ ] **Step 5: Commit** `feat(db): macchine locali, lavori e token dell'agente locale`

### Task 2: Macchine, token personali e scelta del modello

**Files:**
- Create: `artifacts/api-server/src/routes/local.ts` (+ test), `artifacts/api-server/src/lib/local/machines.ts`
- Modify: `routes/index.ts`, `routes/agents.ts`, `routes/analyses.ts`, `lib/ai/choice.ts`, `lib/ai/executor.ts`
  (`executorKindFor("local_agent") = "local_agent"`), `lib/api-spec/openapi.yaml` + codegen

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `POST /local/machines` `{ name }` → 201 `{ machine, token }` (token una sola volta): crea la macchina e, se
    manca, l'account AI "Agente locale" dell'utente (`provider: local_agent`, `base_url: "local://"`, nessuna
    chiave, `status: ok`) con un `ai_models` per la macchina (`model_id = "machine-<id>"`, `display_name =
    "Agente locale · <nome>"`, `supports_tools: true`, `availability: available`). `GET /local/machines` →
    `{ id, name, connected, lastSeenAt, revokedAt }[]` (`connected` = segnale di vita < 30 s).
    `DELETE /local/machines/:id` → revoca (e `ai_models.hidden = true`).
  - `GET|POST /local/tokens`, `DELETE /local/tokens/:id` (token personali; il POST restituisce il token una volta).
  - `isLocalModel(aiModelId: number): Promise<{ machineId: number } | null>`.
  - Agenti e analisi: con un modello locale `fallbackAiModelId` è obbligatorio (400 "modello di riserva
    obbligatorio con l'agente locale") e deve essere un modello API proprio (`chooseOwnModel`, non locale);
    agenti accettano anche `localOfflinePolicy`, `localOfflineWaitS` (1–600), `localForThirdParties`.
  - `executorKindFor("local_agent")` → `"local_agent"`; `modelChat` con un modello locale lancia
    `Error("esecutore non ancora disponibile")` come oggi (il percorso locale non passa da `modelChat`).

- [ ] **Step 1: Test** `local.test.ts`: registrazione → token `csl_m_…` restituito una volta e mai più nei GET;
  account e modello "Agente locale · MacBook" visibili in `GET /ai/models` solo al proprietario; revoca → modello
  nascosto; macchine di un altro utente invisibili e non revocabili (404); agente con modello locale senza riserva
  → 400 col messaggio; riserva locale o altrui → 400; token personale creato, elencato senza valore, revocato.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen. **Step 4:** PASS + typecheck + build console.
- [ ] **Step 5: Commit** `feat(api-server): macchine dell'agente locale, token personali e modello di riserva`

### Task 3: Coda dei lavori e protocollo del runner

**Files:**
- Create: `artifacts/api-server/src/lib/local/jobs.ts` (+ test), `artifacts/api-server/src/routes/runner.ts` (+ test)
- Modify: `routes/index.ts` (montare `/runner` **prima** di `requireAuth`, con autenticazione a token),
  `routes/local.ts` (`GET /local/jobs`, `POST /local/jobs/:id/choice`), `src/index.ts` (chiusura dei lavori aperti
  all'avvio e timer dei controlli), OpenAPI + codegen

**Interfaces:**
- Consumes: Task 1, 2.
- Produces (`lib/local/jobs.ts`, stato in memoria: una sola istanza dell'API):
  - `createLocalJob(input: { userId: number; machineId: number; kind: "analysis" | "run"; analysisId?: number; runId?: number; fallbackAiModelId: number; origin: "console" | "app"; policy?: { kind: "fallback" | "wait_then_fallback" | "postpone"; waitS: number } }): Promise<LocalJob>`.
  - `awaitDispatch(jobId: number, signal: AbortSignal): Promise<DispatchOutcome>` con
    `DispatchOutcome = { kind: "local" } | { kind: "fallback"; aiModelId: number } | { kind: "cancelled"; error: string }`:
    `local` alla presa; con runner non collegato o presa non arrivata in 10 s → `origin: console` passa a
    `waiting_choice` (la console sceglie), `origin: app` applica la regola; scade secondo i tempi dei Global
    Constraints.
  - `chooseForJob(jobId: number, userId: number, choice: "fallback" | "wait" | "postpone"): Promise<void>`.
  - `runItem(jobId: number, item: { prompt: string; resumeSessionId: string | null }, signal: AbortSignal): Promise<ItemResult>`
    con `ItemResult = { sessionId: string | null; exit: "done" | "error"; usage: { inputTokens: number; outputTokens: number } | null }`:
    pubblica il compito in `current_item`, attende `POST /runner/items/:id/done` (o la fine dalla chat), rifiuta
    con "agente locale disconnesso" se il segnale di vita manca per 60 s.
  - `jobByToken(token: string): Promise<LocalJob | null>` (token di lavoro valido, non scaduto, lavoro aperto).
  - `failOpenLocalJobs(): Promise<number>` (avvio: aperti → `failed`, "interrotto dal riavvio").
- Produces (route del runner, `Authorization: Bearer csl_m_…`, 60 richieste/minuto per macchina):
  - `GET /runner/next` → attesa fino a 25 s, aggiorna `last_seen_at`; risponde `204` o
    `{ jobId, itemId, jobToken, prompt, resumeSessionId, mcpUrl }` (il `jobToken` viene generato alla presa e
    vale fino alla fine del lavoro; presa atomica: `UPDATE … WHERE status='queued'`).
  - `POST /runner/jobs/:id/heartbeat` → 204; `POST /runner/items/:itemId/done`
    `{ sessionId, exit, usage }` → 204.
  - `POST /local/jobs/:id/choice` (console, sessione) `{ choice }` → 204; `GET /local/jobs` → lavori propri
    aperti con stato.

- [ ] **Step 1: Test** `jobs.test.ts` (orologio e attese iniettabili): runner collegato → presa e
  `awaitDispatch` = `local`; nessun runner + `console` → `waiting_choice`, `chooseForJob(fallback)` →
  `{ fallback, aiModelId }`; `postpone` → presa al collegamento successivo, dopo 24 h `cancelled`; `wait` scade
  dopo 30 min (analisi) / 2 min (run); `app` con le tre regole; segnale di vita assente 60 s → errore
  "agente locale disconnesso", ritorno entro 59 s → prosegue (Review Focus 1); due prese concorrenti → una sola
  (Review Focus 2); `failOpenLocalJobs` e token del lavoro chiuso → "lavoro scaduto" (Review Focus 5).
  `runner.test.ts`: token di macchina errato/revocato → 401 "token non valido o revocato"; 204 dopo 25 s
  senza lavori; flusso next → done.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen. **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(api-server): coda dei lavori locali e protocollo del runner`

### Task 4: Server MCP

**Files:**
- Create: `artifacts/api-server/src/lib/local/mcp-server.ts`, `artifacts/api-server/src/routes/mcp.ts` (+ test)
- Modify: `artifacts/api-server/package.json` (`@modelcontextprotocol/sdk`), `routes/index.ts` (montare `/mcp`
  prima di `requireAuth`, autenticazione a token)

**Interfaces:**
- Consumes: Task 3 `jobByToken`, `runItem`.
- Produces:
  - `POST|GET|DELETE /api/mcp` con `StreamableHTTPServerTransport` in modalità senza stato (un server per
    richiesta), `Authorization: Bearer` personale o di lavoro; 401 "token non valido o revocato" altrimenti;
    limite di 300 richieste/minuto per token (429 oltre).
  - `registerJobTool(name, schema, handler)` / registro per tipo di lavoro, usato dai Task 5 e 6:
    `type JobToolHandler = (ctx: { job: LocalJob; userId: number }, args: unknown) => Promise<{ text: string; isError?: boolean }>`.
  - Strumenti: `get_job` (istruzioni del compito corrente: `prompt`, tipo, limiti); con token personale anche
    `list_jobs` (lavori propri `queued`/`postponed`/`waiting_choice`) e `claim_job { job_id }` (presa dalla chat,
    `claimed_by = chat`; da quel momento gli strumenti del lavoro accettano `job_id` con quel token personale).
- [ ] **Step 1: Test** `mcp.test.ts` con il client MCP dell'SDK su un'app Express vera: senza token / token
  revocato → 401; token di lavoro → `get_job` e solo gli strumenti del suo tipo; token di lavoro di un lavoro
  chiuso → "lavoro scaduto" (Review Focus 4); token personale → `list_jobs` vede solo i propri, `claim_job` di un
  lavoro altrui → "lavoro non trovato".
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(api-server): server MCP di Casello per l'agente locale`

### Task 5: Analisi dell'architetto delegate

**Files:**
- Create: `artifacts/api-server/src/lib/local/architect-tools.ts` (+ test)
- Modify: `artifacts/api-server/src/lib/architect/phase-loop.ts` (estrarre l'esecuzione degli strumenti di lettura
  e la validazione della consegna in funzioni esportate, comportamento invariato), `run-analysis.ts` (+ test)

**Interfaces:**
- Consumes: Task 3 (`createLocalJob`, `awaitDispatch`, `runItem`), Task 4 (registro strumenti).
- Produces:
  - `executeReadTool(name: ReadToolName, args: unknown, ctx: { tree: SourceTree | null; openapi: OpenApiDoc | null }): Promise<string>`
    e `validatePhaseSubmit(phase: PhaseName, raw: unknown): { ok: true; result: unknown } | { ok: false; issues: string }`
    esportate da `phase-loop.ts` (usate da `runPhase` e dagli strumenti MCP).
  - Strumenti MCP dei lavori `analysis`: gli strumenti di lettura di `phaseTools(hasCode, hasOpenApi)` con gli
    stessi nomi e schemi, più `submit_phase_result { result }`.
  - `runPhaseDelegated(input: { jobId; phase; system; user; budget; log }): Promise<PhaseOutcome>`: compito con
    il prompt della fase (sistema + utente + "usa gli strumenti di Casello; termina con submit_phase_result"),
    attende la consegna valida; se Claude termina senza consegna o con consegna non valida, nuovo compito con
    `resumeSessionId` e il messaggio di correzione, al massimo `MAX_CORRECTIONS`, poi
    `{ ok: false, error: "fase non consegnata dall'agente locale" }` (Review Focus 3).
  - `startAnalysis`: se `analysis.aiModelId` è un modello locale crea il lavoro (`origin: console`), attende
    `awaitDispatch`; `fallback` → prosegue col modello di riserva come oggi; `local` → ogni fase con
    `runPhaseDelegated`; `cancelled` → analisi `failed` con l'errore. Diff, applicazione e registro invariati.

- [ ] **Step 1: Test** `architect-tools.test.ts`: `read_file` via MCP restituisce lo stesso testo di `runPhase`;
  `submit_phase_result` non valido → errore con i problemi; `run-analysis.test.ts` con un esecutore finto (che
  risponde ai compiti chiamando gli strumenti MCP): analisi completa via agente locale con gli stessi elementi
  del percorso API; consegna mancante → correzioni poi errore; scelta `fallback` → analisi col modello di riserva.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(api-server): analisi dell'architetto eseguite dall'agente locale`

### Task 6: Run degli agenti delegate

**Files:**
- Create: `artifacts/api-server/src/lib/local/run-tools.ts` (+ test)
- Modify: `artifacts/api-server/src/lib/run-executor.ts` (+ test), `artifacts/api-server/src/lib/agent-loop.ts`
  (esportare `prepareCall` e `needsPause`, comportamento invariato), `routes/agents.ts`, `routes/runs.ts`
  (pulsante "Riprova con il modello di riserva": `POST /runs/:id/retry-fallback`), OpenAPI + codegen

**Interfaces:**
- Consumes: Task 3, 4.
- Produces:
  - Strumenti MCP dei lavori `run`: i tool `http` dell'agente (nome, descrizione e `params_schema` come in
    `toFunctionTools`), più `finish_run { content }`. Ogni chiamata passa da `prepareCall` (validazione,
    oscuramento), registra il passo come oggi, esegue `runTool` (segreti e token restano in Casello); un tool con
    conferma mette la run in `awaiting_client` con l'azione in sospeso e risponde "in attesa di conferma
    dell'utente: termina ora il turno"; limiti dei giri e del tempo attivo applicati come oggi.
  - `startRun` / `resumeRun`: con modello locale → lavoro (`origin` = `console` se avviata dalla console dal
    proprietario, `app` altrimenti; regola e `localForThirdParties` dell'agente), `awaitDispatch`, poi compito con
    l'input della run (o, alla ripresa, `resumeSessionId` + esito dell'azione confermata/annullata), fine con
    `finish_run` → `succeeded` con l'output; `fallback` → percorso API attuale col modello di riserva.
  - `POST /runs/:id/retry-fallback` → nuova run con lo stesso input sul modello di riserva dell'agente.

- [ ] **Step 1: Test** `run-tools.test.ts` + `run-executor.test.ts` con esecutore finto: run completa con un tool
  di lettura e `finish_run`; tool con conferma → `awaiting_client`, conferma → ripresa con lo stesso
  `resumeSessionId` e l'esito; annullamento → messaggio `REJECTED_ACTION_MESSAGE`; argomento `x-sensitive`
  oscurato nei passi e nel risultato MCP; run di un utente terzo con `localForThirdParties = false` → riserva
  subito; disconnessione → `failed` "agente locale disconnesso" e `retry-fallback` crea la nuova run.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen. **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(api-server): run degli agenti eseguite dall'agente locale`

### Task 7: `casello-runner`

**Files:**
- Create: `artifacts/casello-runner/` (`package.json` `@workspace/casello-runner`, `src/index.ts`, `src/claude.ts`,
  `src/runner.ts`, test, `README.md` in italiano), `artifacts/casello-runner/test/fake-claude.mjs`
- Modify: `pnpm-workspace.yaml` se serve, `tsconfig.json` di root (references)

**Interfaces:**
- Consumes: Task 3 protocollo, Task 4 server MCP.
- Produces:
  - Avvio: `CASELLO_URL=https://casello.fantamister.cloud CASELLO_RUNNER_TOKEN=csl_m_… pnpm --filter @workspace/casello-runner start`
    (variabili obbligatorie; opzionale `CASELLO_CLAUDE_BIN`, default `claude`, e `CASELLO_RUNNER_CONCURRENCY`,
    default 1).
  - `runClaude(item: { prompt; resumeSessionId; mcpUrl; jobToken }, opts: { bin: string; signal: AbortSignal }): Promise<ItemResult>`:
    cartella temporanea vuota come `cwd`, file `mcp.json` `{ "mcpServers": { "casello": { "type": "http", "url": mcpUrl, "headers": { "Authorization": "Bearer <jobToken>" } } } }`
    (permessi 0600, cancellato alla fine), argomenti `-p <prompt> --output-format json --mcp-config <file>
    --strict-mcp-config --allowedTools mcp__casello` più l'opzione che disattiva gli strumenti predefiniti
    (verificare con `claude --help` della versione installata: `--tools ""` se esiste, altrimenti
    `--disallowedTools` con Bash, Edit, Write, Read, Glob, Grep, WebFetch, WebSearch, NotebookEdit, Task) e
    `--resume <id>` se c'è; legge `session_id` e `usage` dall'output JSON; il token non compare mai nei log.
  - Ciclo: `GET /runner/next` in attesa lunga; per ogni compito segnale di vita ogni 15 s durante `runClaude`,
    poi `POST /runner/items/:id/done`; ripresa dopo errori di rete con attesa crescente (1 s → 30 s).
- [ ] **Step 1: Test** con `fake-claude.mjs` (script che legge `--mcp-config`, si collega al server MCP con
  l'SDK, chiama `get_job` e gli strumenti di consegna, stampa un JSON con `session_id`): contro un'API di prova
  un'analisi e una run arrivano a fine; argomenti passati a `claude` corretti (snapshot) e senza token in log;
  `mcp.json` rimosso a fine compito; perdita di rete → riprova.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(casello-runner): programma ponte per l'agente locale`

### Task 8: Console

**Files:**
- Create: `artifacts/casello/src/components/account/local-agents-section.tsx`,
  `artifacts/casello/src/components/local/{local-choice-dialog,local-jobs-list}.tsx`
- Modify: `pages/account.tsx`, `components/ai/model-picker.tsx` (badge "agente locale" e stato collegato),
  form degli agenti (riserva, regola, attesa, utenti terzi), avvio analisi (riserva obbligatoria con modello
  locale), dettaglio run ("Riprova con il modello di riserva"), dashboard o pagina Run (lavori in attesa)

**Interfaces:**
- Consumes: hook generati dei Task 2, 3, 6.

- [ ] **Step 1:** sezione "Agenti locali" nella pagina Account: registra macchina (nome → token e comando di avvio
  del runner con `CASELLO_URL` e token, "copia" e avviso "mostrato una sola volta"), elenco con "collegata" /
  "vista …", revoca con conferma; token personali con il comando `claude mcp add --transport http casello
  <origine>/api/mcp --header "Authorization: Bearer <token>"` e il JSON per Claude Desktop.
- [ ] **Step 2:** scelta del modello: macchine con stato; se locale, campo "Modello di riserva" obbligatorio (solo
  modelli API propri) e, negli agenti, "Se l'agente locale non è collegato" (riserva subito / attendi N s poi
  riserva / posticipa) e "Consenti per le run di altri utenti" (spento, con nota sui termini dell'abbonamento).
- [ ] **Step 3:** finestra "L'agente locale non è collegato" quando analisi o run di prova vanno in
  `waiting_choice` (polling dello stato): "Usa il modello di riserva" (con stima del costo), "Attendi",
  "Posticipa"; elenco dei lavori in attesa o posticipati con "Usa la riserva".
- [ ] **Step 4:** typecheck + build console. **Step 5: Commit** `feat(casello): agenti locali nella console`

### Task 9: Rilascio e collaudo (controller con Ivan)

- [ ] **Step 1:** `CLAUDE.md`: sezione "Agente locale" (modalità A e C, token, runner, regole, sicurezza), route e
  tabelle.
- [ ] **Step 2:** prova in locale: API + runner con il `claude` vero sul Mac (analisi breve di un'app di prova,
  run con conferma), modalità chat con `claude mcp add`.
- [ ] **Step 3:** testo completo di `docs/migrations/2026-10-agente-locale.sql` a Ivan in chat **prima** del push;
  applicazione su Neon prima del merge; push e link della PR.
- [ ] **Step 4:** collaudo di Ivan: registra il Mac, avvia il runner, analisi di Mister con l'agente locale, run di
  prova con conferma, comportamento a runner spento (tre scelte).
