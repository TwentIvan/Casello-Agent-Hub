# Lucius e le best practice — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** prima di proporre o analizzare un'App, Lucius conosce l'App dalla sintesi dell'architettura, cerca le best practice con Gemini
(ricerca Google) e legge le fonti curate, e cita le fonti; attivo per default o con un interruttore.

**Architecture:** modulo nuovo `artifacts/api-server/src/lib/best-practice/` (chiamata a Gemini, cache e spesa, strumento per turno,
istruzioni); impostazioni sulle colonne di `users`; flag `best_practice` su conversazioni e analisi; cablaggio nei tre turni di Lucius
e un passo interno dell'analisi cloud; console in Account, barra della chat, avvio e pagina dell'analisi.

**Tech Stack:** Node 24, Express 5, Drizzle + Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-16-botcave-lucius-best-practice-design.md`

## Global Constraints

- Italiano per commenti, messaggi, commit; identificatori in inglese. Testi visibili: «Botcave», niente punti esclamativi.
- Migrazione unica `docs/migrations/2026-11-16-lucius-best-practice.sql`, additiva e idempotente (la applica il deploy), riportata in `docs/schema-casello.sql`.
- Dopo ogni modifica a `lib/api-spec/openapi.yaml`: `corepack pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Nessun colore esadecimale né classi di palette nella console; niente scorrimento orizzontale a 1280 px.
- Mai domanda, risposta, fonti o chiavi nei log; messaggi d'errore fissi, mai il testo di Gemini.
- Valori: 2 ricerche per turno, 10/min per utente, cache 7 giorni, 0,014 $ a query Google (`GROUNDING_QUERY_USD`), sintesi ≤ 4 000 caratteri,
  ≤ 8 fonti, domanda 3..300, timeout 30 s, `maxOutputTokens` 1500, temperatura 0.2; fonti curate ≤ 30 (etichetta 1..80); note dell'analisi ≤ 8 000,
  ≤ 3 domande; pulizia delle ricerche dopo 90 giorni.
- `corepack pnpm run typecheck` verde prima di ogni commit.

## Review Focus

- Interruttore spento: Lucius non riceve né `cerca_best_practice` né le istruzioni né la sintesi nel contesto (test nel Task 6).
- Alfred: `bestPractice` mai vero, PATCH con `bestPractice` → 400 (Task 5).
- Ricerca dalla cache: nessuna riga nuova, nessun consumo del limite al minuto, nessun costo (Task 3).
- Ricerche delle analisi (`analysis_id` non null) fuori dalla spesa di Lucius e dell'utente (Task 2), ma dentro il costo dell'analisi (Task 7).
- Gemini senza `groundingMetadata` o con testo vuoto: messaggio fisso, nessuna eccezione (Task 2).

---

### Task 1: Migrazione e schema

**Files:**
- Create: `docs/migrations/2026-11-16-lucius-best-practice.sql`, `lib/db/src/schema/best-practice.ts`, `artifacts/api-server/test/migration-lucius-best-practice.test.ts`
- Modify: `lib/db/src/schema/users.ts`, `plan-conversations.ts`, `characters.ts`, `team-chat.ts`, `analyses.ts`, `index.ts`; `docs/schema-casello.sql`

**Interfaces:**
- Produces: enum `bestPracticeModeEnum` (`best_practice_mode`: `always|on_request`); `usersTable.luciusBestPractice` (default `on_request`),
  `luciusSearchAiModelId` (FK `ai_models`, set null), `luciusSources` (jsonb `{url:string,label:string}[]`, default `[]`); `bestPractice` boolean
  not null default false su `planConversationsTable`, `characterConversationsTable`, `teamChatConversationsTable`, `analysesTable`;
  `analysesTable.bestPracticeNotes` text; `bestPracticeSearchesTable` con i campi della spec §3 e indice `best_practice_searches_lookup_idx (user_id, query_hash, created_at)`.

- [ ] Step 1: test di migrazione sul modello di `test/migration-architettura-app.test.ts`: applica il file due volte su `docs/schema-casello.sql` senza errori; le colonne esistono con i default; l'enum ha i due valori.
- [ ] Step 2: eseguire `corepack pnpm --filter @workspace/api-server exec vitest run test/migration-lucius-best-practice.test.ts` → FAIL (file mancante).
- [ ] Step 3: scrivere SQL (`CREATE TYPE` in un blocco `DO … EXCEPTION WHEN duplicate_object`, `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), schema Drizzle e `docs/schema-casello.sql`.
- [ ] Step 4: test → PASS; `corepack pnpm --filter @workspace/api-server exec vitest run test/migrations-auto.test.ts` → PASS.
- [ ] Step 5: commit `feat(casello): schema delle best practice di Lucius`.

### Task 2: Ricerca con Gemini, cache e spesa

**Files:**
- Create: `artifacts/api-server/src/lib/best-practice/messages.ts`, `search.ts`, `search.test.ts`, `store.ts`, `store.test.ts`
- Modify: `artifacts/api-server/src/lib/budget.ts` (+ test in `src/lib/budget-best-practice.test.ts`), `lib/memory/summaries.ts` (sweeper: pulizia 90 giorni)

**Interfaces:**
- Produces:
  - `BEST_PRACTICE_MESSAGES` (chiavi: `noSearchModel`, `modelUnavailable`, `keyRejected`, `rateLimitedGemini`, `unreachable`, `empty`, `tooManyInTurn`, `rateLimited`, `invalidQuestion`, `internal`), testi della spec §3.
  - `GROUNDING_QUERY_USD = 0.014`, `BEST_PRACTICE_CACHE_MS = 7*24*3600_000`.
  - `class BestPracticeError extends Error { message: string }` (messaggio fisso).
  - `searchGemini(resolved: ResolvedModel, question: string): Promise<GeminiSearchResult>` con `GeminiSearchResult = {answer: string; sources: {title: string; url: string}[]; promptTokens: number; completionTokens: number; searchQueries: number}`; lancia `BestPracticeError`.
  - `normalizeQuestion(q: unknown): string | null` (spazi collassati, 3..300, altrimenti null); `questionHash(q: string): string` (SHA-256 del minuscolo).
  - `findCached(userId: number, hash: string, now?: Date): Promise<StoredSearch | null>`; `recordSearch(row: NewSearch): Promise<StoredSearch>`; `searchCost(resolved, r: GeminiSearchResult): number | null` (token × prezzi, null se manca un prezzo e ci sono token, + `searchQueries × GROUNDING_QUERY_USD`).
  - `StoredSearch = {id, question, answer, sources, costUsd: number|null, createdAt: Date, analysisId: number|null}`.

- [ ] Step 1: `search.test.ts` con un server finto (`GEMINI_NATIVE_BASE` puntato a un `http.createServer` locale come in `lib/alfred/*.test.ts`): verifica corpo (`tools:[{google_search:{}}]`, `maxOutputTokens: 1500`, header `x-goog-api-key`), parsing di testo concatenato, `usageMetadata.promptTokenCount/candidatesTokenCount`, `webSearchQueries.length`, fonti da `groundingChunks[].web` senza ripetizioni e ≤ 8, risposta troncata a 4 000; 400/401/403 → `keyRejected`, 429 → `rateLimitedGemini`, 500 e timeout → `unreachable`, testo vuoto o senza candidati → `empty`, risposta senza `groundingMetadata` → `searchQueries: 0, sources: []`.
- [ ] Step 2: eseguire → FAIL.
- [ ] Step 3: implementare `search.ts` (chiamata come `lib/alfred/gemini.ts`: `geminiNativeBase()`, `bareModelName`, `redirect:"manual"`, `AbortSignal.timeout(30_000)`); istruzione di sistema fissa della spec §3.
- [ ] Step 4: `store.test.ts`: cache entro 7 giorni solo per lo stesso utente e righe con `cached_from` null; scaduta → null; `searchCost` con prezzi e senza prezzi.
- [ ] Step 5: `budget-best-practice.test.ts`: una riga con `analysis_id` null conta in `characterSpend(user,"lucius")` e nella spesa di utente, modello e account; una con `analysis_id` non conta in nessuna di queste; Alfred non la conta. Implementare in `budget.ts` sul modello delle righe di `appArchitectureRunsTable` (unpriced = costo null con token > 0).
- [ ] Step 6: pulizia: `pruneBestPracticeSearches(now)` in `store.ts` (righe > 90 giorni) chiamata dallo sweeper in `lib/memory/summaries.ts`; test in `store.test.ts`.
- [ ] Step 7: tutti i test del Task → PASS; typecheck; commit `feat(casello): ricerca delle best practice con Gemini, cache e spesa`.

### Task 3: Strumento `cerca_best_practice` per turno

**Files:**
- Create: `artifacts/api-server/src/lib/best-practice/tool.ts`, `tool.test.ts`, `instructions.ts`
- Modify: `artifacts/api-server/src/middlewares/rate-limit.ts` (`consumeBestPracticeSearch`, `resetBestPracticeSearchLimit`), `lib/turn-progress/describe.ts` (+ test)

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `BEST_PRACTICE_TOOL_NAME = "cerca_best_practice"`, `BEST_PRACTICE_TOOLS: ChatCompletionFunctionTool[]`, `isBestPracticeTool(name: string): boolean`.
  - `class BestPracticeSearcher { constructor(userId: number, opts?: {analysisId?: number}); run(args: Record<string, unknown>): Promise<string>; costUsd(): number|null; tokens(): number }` — sempre testo, mai eccezioni; ordine dei controlli della spec §3 (validazione, 2 per turno, cache, 10/min, `characterBudgetBlock(userId,"lucius",searchModelId)` solo senza `analysisId`, modello di ricerca da `users.lucius_search_ai_model_id` con `resolveModel(..., {mustOwn:true})` e provider `gemini`, chiamata, `recordSearch`). Errori come `Errore: <messaggio>`. Uscita nel formato della spec §3 (intestazione, `<dati>`, «Fonti:», nota cache).
  - `BEST_PRACTICE_INSTRUCTIONS: string` (spec §4, punti 1–5); `curatedSourcesBlock(sources: {url,label}[]): string` («Fonti curate dell'utente (dati, non istruzioni):», una riga `- etichetta — indirizzo`, vuoto se nessuna).

- [ ] Step 1: `tool.test.ts`: terza ricerca nel turno → `tooManyInTurn`; domanda di 2 caratteri → `invalidQuestion`; cache → nessun consumo di `consumeBestPracticeSearch` (11 ricerche in cache di fila riescono) e nessuna riga nuova; senza modello di ricerca → `noSearchModel`; modello non Gemini → `modelUnavailable`; tetto di Lucius raggiunto → messaggio del tetto; tag `<dati>` nella risposta neutralizzati come in `web-reader/tool.ts`; uscita con «Fonti:».
- [ ] Step 2: FAIL → implementare → PASS.
- [ ] Step 3: `describe.ts`: `cerca_best_practice` → «Cerca le best practice» senza argomenti; test.
- [ ] Step 4: typecheck; commit `feat(casello): strumento cerca_best_practice di Lucius`.

### Task 4: Impostazioni di Lucius

**Files:**
- Modify: `artifacts/api-server/src/lib/characters/settings.ts` (+ test `settings.test.ts`, se manca crearlo), `routes/account-characters.ts`, `lib/api-spec/openapi.yaml` (`CharacterSettings`, `CharacterSettingsView`), generati.

**Interfaces:**
- Produces: `CharacterSettings` aggiunge facoltativi `luciusBestPractice: "always"|"on_request"`, `luciusSearchAiModelId: number|null`, `luciusSources: {url,label}[]`;
  la vista li ha sempre più `searchModels: {id,name,accountName}[]` (modelli dei propri account con provider `gemini`, esclusi `isAudioOnlyModel`).
  `luciusBestPracticeDefault(userId: number): Promise<boolean>` (true se `always`).
- Validazione: fonti con `checkUrl` di `lib/web-reader/fetch-page.ts`, etichetta 1..80 su una riga, ≤ 30, url ripetuti → 400 «fonti curate non valide: <motivo>»; modello non Gemini o non proprio → 400 «modello di ricerca non valido: scegli un modello Gemini dei tuoi account».

- [ ] Step 1: test di route (`test/` sul modello dei test esistenti di `/api/account/characters`): GET con i default (`on_request`, null, `[]`, `searchModels`); PUT con i tre campi salva; PUT senza i tre campi li lascia invariati; fonte `http://` → 400; 31 fonti → 400; modello DeepSeek come ricerca → 400.
- [ ] Step 2: FAIL → openapi + codegen + implementazione → PASS.
- [ ] Step 3: typecheck; commit `feat(casello): impostazioni delle best practice di Lucius`.

### Task 5: Interruttore per conversazione

**Files:**
- Modify: `routes/plan-chat.ts`, `routes/characters.ts`, `lib/characters/conversations.ts`, `routes/team-chat.ts`, `lib/api-spec/openapi.yaml` (create e update delle tre conversazioni, dettagli con `bestPractice`, `PATCH /team-chat-conversations/{id}` con `TeamChatConversationUpdate {bestPractice: boolean}`), generati; test di route esistenti delle tre chat.

**Interfaces:**
- Consumes: `luciusBestPracticeDefault` (Task 4).
- Produces: colonna valorizzata alla creazione (`bestPractice` del POST vince sul default; per Alfred sempre false); `PlanConversationUpdate` con `aiModelId` e `bestPractice` facoltativi (almeno uno, altrimenti 400); `CharacterConversationUpdate.bestPractice` (Alfred → 400 «le best practice valgono solo per Lucius»); `bestPractice` nei tre dettagli.

- [ ] Step 1: test: default `always` → nuova conversazione del piano, di Lucius e di squadra con `bestPractice: true`; Alfred false; POST con `bestPractice:false` vince; PATCH delle tre cambia il valore; PATCH del piano con corpo vuoto → 400; PATCH di Alfred con `bestPractice` → 400; PATCH di squadra su conversazione altrui → 404.
- [ ] Step 2: FAIL → implementare → PASS; typecheck; commit `feat(casello): interruttore delle best practice per conversazione`.

### Task 6: Lucius nei turni (piano, personaggi, squadra)

**Files:**
- Modify: `lib/plan-chat/context.ts`, `lib/plan-chat/run-turn.ts`, `lib/characters/run-turn.ts`, `lib/characters/subjects/*.ts` (funzione per l'App dell'argomento), `lib/team-chat/context.ts`, `lib/team-chat/run-turn.ts`, `lib/architecture/tool.ts` (handler riusabile senza `App` dell'agente); test dei tre `run-turn.test.ts`.

**Interfaces:**
- Consumes: Task 3, `architectureTool()`, `handleReadArchitecture(app, args)`, `architecturePromptBlock(arch)`.
- Produces:
  - `leggi_architettura` offerto a Lucius in tutte e tre le chat (sempre); App di default: piano → l'App; argomento `agent` → App dell'agente; squadra → App di riferimento; altri argomenti → `app` obbligatorio (senza → `ARCH_MESSAGES.appNotFound`). Lettura limitata alle App dell'utente come nel resto della chat.
  - `SubjectHandler.architectureApp?(userId, subjectId): Promise<App | null>` (solo `agent`).
  - Con `best_practice` della conversazione vero: `BEST_PRACTICE_TOOLS` negli strumenti, `BEST_PRACTICE_INSTRUCTIONS` nel prompt di sistema (piano: argomento nuovo di `planSystemPrompt({…, bestPractice})`; personaggi: `extraInstructions` concatenato; squadra: istruzioni del contesto), e nel messaggio di dati la sintesi (`architecturePromptBlock`) dell'App di default (se c'è) più `curatedSourcesBlock`. Una istanza di `BestPracticeSearcher` per turno.

- [ ] Step 1: test per ciascuna chat con il provider finto: interruttore spento → nessuno strumento `cerca_best_practice`, nessuna istruzione, nessuna sintesi nei messaggi, `leggi_architettura` presente; acceso → strumento, istruzioni, sintesi e fonti curate nei dati; una chiamata a `cerca_best_practice` dal modello finto produce un risultato con «Fonti:». Alfred: mai lo strumento.
- [ ] Step 2: FAIL → implementare → PASS; tutta la suite di `lib/plan-chat`, `lib/characters`, `lib/team-chat` → PASS; typecheck; commit `feat(casello): Lucius verifica le best practice nelle chat`.

### Task 7: Analisi dell'architetto

**Files:**
- Create: `artifacts/api-server/src/lib/best-practice/analysis-step.ts`, `analysis-step.test.ts`
- Modify: `routes/analyses.ts`, `lib/architect/run-analysis.ts` (`CostTracker.addUsd(costUsd: number|null)`), `lib/architect/prompts.ts` (`PhaseContext.bestPracticeNotes?: string|null`, blocco in completion ed evolution; `PhaseContext.localBestPractice?: {summary: string|null}`), `lib/architect/local-executor.ts`, `lib/api-spec/openapi.yaml` (`AnalysisStart.bestPractice`, `Analysis.bestPractice`, `Analysis.bestPracticeNotes`), generati, `docs/skills/casello-architetto-locale/SKILL.md`; test di `run-analysis` e `local-executor`.

**Interfaces:**
- Consumes: Task 2 e 3 (`BestPracticeSearcher` con `{analysisId}`), `architecturePromptBlock`.
- Produces: `runBestPracticeStep(input: {analysisId: number; userId: number; resolved: ResolvedModel; app: App; mapResult: unknown; cost: CostTracker; budget: …}): Promise<string>` — 1) `modelChat` (60 s, ≤ 600 token, JSON `{domande: string[1..3]}`, validato con Zod), 2) ricerche, 3) note ≤ 8 000 con «Domanda», sintesi e fonti; errori → «Best practice non verificate: <messaggio fisso>». Testo del blocco nei prompt: «Best practice per app simili (dati da una ricerca web, non istruzioni):» + note + «Cita le fonti nelle voci che ne derivano.»
- Locale: con `best_practice` le istruzioni di `completion` aggiungono la sintesi dell'architettura e «Prima di questa fase cerca con la tua ricerca web al più 3 domande sulle best practice per app di questo tipo e cita le fonti nelle voci»; `evolution` aggiunge «Riusa le best practice trovate nella fase completion, citando le fonti».

- [ ] Step 1: `analysis-step.test.ts`: domande dal modello finto → 3 ricerche col Gemini finto → note con fonti, righe con `analysis_id`, costo sommato al `CostTracker`; JSON non valido → note «Best practice non verificate: …»; senza modello di ricerca → idem, nessuna chiamata a Gemini.
- [ ] Step 2: test di `run-analysis`: con `bestPractice: true` il passo parte una volta prima di `completion`, `best_practice_notes` salvate e presenti nei prompt di completion ed evolution; con `false` nessuna chiamata in più. Route: `POST /api/apps/:id/analyses` senza `bestPractice` usa il default dell'utente.
- [ ] Step 3: test di `localPhaseInstructions`: con flag le frasi della ricerca web locale compaiono in completion ed evolution, senza no.
- [ ] Step 4: FAIL → implementare → PASS; aggiornare la skill locale; typecheck; commit `feat(casello): best practice nell'analisi dell'architetto`.

### Task 8: Console

**Files:**
- Modify: `artifacts/casello/src/components/account/characters-section.tsx`, `components/characters/adapters.ts` (`ChatAdapter.bestPractice?: {get(conv): boolean; set(id, value): Promise<void>}`), `chat-toolbar.tsx`, `plan-team-adapters.tsx`, `character-adapters.ts`, `components/apps/analyses-card.tsx`, `pages/analysis-detail.tsx`.
- Create: `artifacts/casello/src/lib/curated-sources.ts` + `curated-sources.test.ts` (`validateCuratedSources(rows): string | null` con le regole del Task 4 lato client).

- [ ] Step 1: test di `curated-sources.ts` (https obbligatorio, etichetta 1..80, ≤ 30, ripetizioni) → FAIL → implementare → PASS.
- [ ] Step 2: carta Lucius: tendina «Best practice» (Sempre / Su richiesta), «Modello per la ricerca» da `searchModels` con «Nessuno», editor «Fonti curate» (Aggiungi / Togli, errore sotto), testo d'aiuto del costo della spec §1.
- [ ] Step 3: interruttore «Best practice» (`Switch` di shadcn) nella barra della chat solo se l'adattatore dichiara `bestPractice` (piano, Lucius, squadra), tooltip della spec §2.
- [ ] Step 4: casella «Verifica le best practice» nel modulo di avvio dell'analisi, preselezionata da `luciusBestPractice === "always"`; riquadro «Best practice» in `analysis-detail.tsx` quando `bestPracticeNotes` non è null (Markdown con `react-markdown`, link `target="_blank" rel="noopener"`).
- [ ] Step 5: `corepack pnpm --filter @workspace/casello run test` e typecheck → verdi; verificare nel browser a 1280 px (Account, chat del piano, pagina analisi); commit `feat(casello): best practice di Lucius nella console`.

### Task 9: Documentazione, verifica completa, PR

- [ ] Step 1: CLAUDE.md: punto in «Stato», voce in «Dove stanno le cose», sezione «Lucius e le best practice» (riassunto della spec con le differenze dal codice), spec aggiornata con «Differenze dal codice» se servono.
- [ ] Step 2: `corepack pnpm run typecheck`, `corepack pnpm --filter @workspace/api-server run test`, `corepack pnpm --filter @workspace/casello run test` → verdi (riportare eventuali fallimenti non legati).
- [ ] Step 3: commit `docs(casello): Lucius e le best practice in CLAUDE.md`; push; PR verso `main` con `gh` (cosa cambia, costi, migrazione additiva applicata dal deploy, come si è provato, prova dopo il deploy: impostare un modello Gemini per la ricerca, accendere l'interruttore nella chat del piano di The Hub Up e chiedere una proposta).
