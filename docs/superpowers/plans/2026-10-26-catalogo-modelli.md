# Agente del catalogo dei modelli — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casello sa quali modelli esistono per ogni provider degli account AI (versioni, prezzi, strumenti,
ritiri), si aggiorna da solo ogni settimana e a richiesta senza chiamare modelli, e la tendina propone solo
modelli disponibili, con strumenti ed economici.

**Architecture:** un modulo `lib/catalog/` scarica due fonti pubbliche (OpenRouter, listino LiteLLM), le
normalizza e le fonde in `model_catalog` con funzioni pure; un orchestratore (`refresh.ts`) gestisce
l'esecuzione unica in `catalog_runs`, rilegge i `/models` degli account e arricchisce `ai_models`
(`catalog_id`, strumenti, prezzi non manuali). La disponibilità reale arriva dai 404 delle chiamate vere e
dal pulsante "Prova"; l'API calcola per ogni modello lo stato effettivo, se è selezionabile e quale
preselezionare, così la console resta sottile.

**Tech Stack:** Express 5, Drizzle/Postgres, `fetch` nativo, Zod/Orval, Vitest + PGlite, React + React Query +
shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-26-casello-catalogo-modelli-design.md`

## Global Constraints

- Italiano per commenti, messaggi d'errore, UI e commit; identificatori in inglese.
- Contract-first: ogni route nuova o cambiata in `lib/api-spec/openapi.yaml` + codegen, file generati
  committati; `parseRequest` / `*Response.parse` come le route esistenti.
- Schema DB: Drizzle + `docs/schema-casello.sql` + `docs/migrations/2026-10-catalogo-modelli.sql`
  (idempotente; `ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'gemini'` prima del `BEGIN`), da applicare prima del merge.
- Nessuna nuova dipendenza npm.
- Fonti con indirizzi fissi nel codice, mai forniti dagli utenti: `https://openrouter.ai/api/v1/models` e
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`; timeout 30 s,
  `redirect: "manual"`, risposta massima 20 MB (20 971 520 byte).
- Valori ripuliti come in `lib/ai/discovery.ts`: prezzi non finiti, negativi o ≥ 1e6 per Mtok → null; id con
  caratteri di controllo scartati; nomi ≤ 256 caratteri.
- Nessuna chiamata ai modelli nell'aggiornamento automatico; le chiavi restano nell'esecutore e nella verifica
  esistenti, mai in log, risposte, errori o `catalog_runs`.
- Messaggi fissi: "fonte OpenRouter non raggiungibile: dati non aggiornati", "fonte LiteLLM non raggiungibile:
  dati non aggiornati", "aggiornamento parziale", "aggiornamento già in corso", "interrotto dal riavvio".
- Prezzi con `price_source = manual` mai sovrascritti; quelli dal catalogo hanno `price_source = catalog`.
- Le novità per account (`summary.accounts`) sono visibili solo al proprietario; il catalogo a tutti gli
  utenti ammessi.
- `pnpm run typecheck` e `pnpm --filter @workspace/api-server run test` verdi prima di ogni commit.

## Review Focus

1. Listino LiteLLM con voci strane (chiave `sample_spec`, numeri come stringhe, campi mancanti, provider che
   Casello non ha): le voci si saltano una per una, la fonte non fallisce → test in Task 2.
2. Fonte che risponde con redirect, HTML, JSON troncato o oltre 20 MB: quella fonte conta come fallita,
   l'esecuzione è `partial` e le righe del catalogo restano quelle di prima → test in Task 2 e Task 4.
3. Id dell'account con prefisso `models/` o maiuscole (Gemini) che devono abbinarsi al catalogo; varianti
   OpenRouter `:free` che non devono sovrascrivere il modello base del provider → test in Task 3.
4. Modello con prezzo manuale dopo un aggiornamento del catalogo e dopo "Aggiorna modelli" dell'account: resta
   manuale; un modello con prezzo dal catalogo non torna a "prezzo sconosciuto" dopo "Aggiorna modelli" →
   test in Task 4.
5. Doppio clic su "Aggiorna catalogo" o riavvio durante l'aggiornamento: il secondo riceve 409 "aggiornamento
   già in corso"; dopo il riavvio la riga è `failed` e un nuovo aggiornamento parte → test in Task 4.

---

### Task 1: Schema, migrazione e provider Gemini

**Files:**
- Create: `lib/db/src/schema/model-catalog.ts`, `lib/db/src/schema/catalog-runs.ts`,
  `docs/migrations/2026-10-catalogo-modelli.sql`, `artifacts/api-server/test/migration-catalogo.test.ts`,
  `artifacts/api-server/test/fixtures/schema-pre-catalogo.sql` (copia dell'attuale `docs/schema-casello.sql`)
- Modify: `lib/db/src/schema/{ai-accounts,ai-models,index}.ts`, `docs/schema-casello.sql`,
  `artifacts/api-server/src/lib/ai/providers.ts`, `lib/api-spec/openapi.yaml` (enum `AiProvider` + `gemini`,
  enum `priceSource` + `catalog`) + codegen,
  `artifacts/casello/src/components/account/ai-account-dialog.tsx` (`PROVIDER_INFO.gemini`)

**Interfaces:**
- Produces:
  - `aiProviderEnum` + `gemini`; `PROVIDERS.gemini = { label: "Google Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", editableBaseUrl: false }`.
  - `modelCatalogStatusEnum` (`model_catalog_status`: available, deprecated, retired) e `modelCatalogTable`
    (`model_catalog`, spec §3): `provider ai_provider`, `model_id text`, `family text not null`, `version text not null`,
    `released_at timestamp`, prezzi `numeric(12,6)`, `context_tokens integer`, `supports_tools boolean`,
    `status not null default available`, `deprecation_date timestamp`, `sources jsonb not null default '{}'`,
    `updated_at`; vincolo unico `model_catalog_provider_model_unique` (provider, model_id). Tipo `CatalogModelRow`.
  - `catalogTriggerEnum` (`catalog_trigger`: scheduled, manual), `catalogRunStatusEnum` (`catalog_run_status`:
    running, completed, partial, failed), `catalogRunsTable` (`catalog_runs`: `trigger`, `user_id` → users
    set null, `status`, `started_at default now()`, `finished_at`, `summary jsonb`, `error text`); indice unico
    parziale `catalog_runs_one_running` su `status` where `status = 'running'`. Tipo `CatalogRun`.
  - `aiModelAvailabilityEnum` (`ai_model_availability`: available, unavailable, unknown); su `ai_models`:
    `availability not null default 'unknown'`, `supports_tools boolean`, `catalog_id` → model_catalog
    (on delete set null), `last_probe_at timestamp`, `last_probe_ok boolean`.

- [ ] **Step 1: Test** `migration-catalogo.test.ts` come `migration-account-ai.test.ts`: dalla fixture con un
  account e un modello già presenti, dopo la migrazione il modello ha `availability = 'unknown'`; un account
  `provider = 'gemini'` si inserisce; una seconda riga `catalog_runs` `running` è rifiutata, una seconda
  `completed` no; `model_catalog` duplicato (provider, model_id) rifiutato; eliminare una riga del catalogo
  lascia `ai_models.catalog_id` null; seconda esecuzione dello script senza errori.
- [ ] **Step 2:** FAIL. **Step 3:** schema, migrazione, `schema-casello.sql`, provider, OpenAPI + codegen,
  `PROVIDER_INFO.gemini` nella console. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(db): catalogo dei modelli, esecuzioni del catalogo e provider Gemini`

### Task 2: Fonti pubbliche (OpenRouter e listino LiteLLM)

**Files:**
- Create: `artifacts/api-server/src/lib/ai/sanitize.ts`, `artifacts/api-server/src/lib/catalog/sources.ts`,
  `artifacts/api-server/src/lib/catalog/sources.test.ts`, `artifacts/api-server/test/fake-sources.ts`
- Modify: `artifacts/api-server/src/lib/ai/discovery.ts` (usa `sanitize.ts`, comportamento invariato)

**Interfaces:**
- Produces:
  - `sanitize.ts`: `perMillion(v: unknown): number | null`, `contextTokens(v: unknown): number | null`,
    `cleanId(v: unknown): string | null` (trim, 1–256 caratteri, niente controllo),
    `cleanName(v: unknown): string | null` (trim, niente controllo, troncato a 256), spostati da `discovery.ts`.
  - `OPENROUTER_MODELS_URL`, `LITELLM_PRICES_URL` (Global Constraints).
  - `interface SourceEntry { source: "openrouter" | "litellm"; key: string; litellmProvider: string | null; name: string | null; releasedAt: Date | null; priceInput: number | null; priceOutput: number | null; contextTokens: number | null; supportsTools: boolean | null; deprecationDate: Date | null }`
    (`key` = id OpenRouter o chiave LiteLLM così come arrivano, già ripuliti).
  - `fetchOpenRouterSource(fetchImpl?: typeof fetch): Promise<SourceEntry[]>`: `data[]`; `created` (secondi
    Unix, intero positivo) → `releasedAt`; `pricing.prompt/completion` per token → per Mtok; `context_length`;
    `supportsTools` = `supported_parameters.includes("tools")` se l'array c'è, altrimenti null.
  - `fetchLiteLlmSource(fetchImpl?: typeof fetch): Promise<SourceEntry[]>`: oggetto chiave → voce; salta
    `sample_spec` e le voci non oggetto; `input_cost_per_token`/`output_cost_per_token` → per Mtok;
    `max_input_tokens`; `supports_function_calling` (solo booleani); `deprecation_date` solo `YYYY-MM-DD` →
    mezzanotte UTC; `litellm_provider` (stringa ripulita o null).
  - `class SourceError extends Error { source: "openrouter" | "litellm" }` con messaggio
    "fonte OpenRouter non raggiungibile: dati non aggiornati" / "fonte LiteLLM non raggiungibile: dati non
    aggiornati" per rete, timeout, stato non 2xx (redirect compresi), corpo oltre 20 MB, JSON non valido o
    forma radice sbagliata. Lettura con `readBytesLimited`.
  - `test/fake-sources.ts`: `OPENROUTER_FIXTURE`, `LITELLM_FIXTURE` (pochi modelli: `deepseek/deepseek-chat`,
    `deepseek/deepseek-v4-pro`, `google/gemini-3.5-flash`, `google/gemini-2.5-flash`,
    `google/gemini-2.0-flash-exp:free`, `mistralai/mistral-small`; LiteLLM `deepseek/deepseek-v4-pro`,
    `gemini/gemini-2.5-flash` con `deprecation_date` passata, `gemini/gemini-3.5-flash`, `groq/llama-3.3-70b`,
    `sample_spec`) e `fakeSourcesFetch(opts?: { openrouter?: unknown | number; litellm?: unknown | number }): typeof fetch`
    (oggetto = corpo JSON 200, numero = stato d'errore; URL diversi dalle fonti → `fetch` vero).

- [ ] **Step 1: Test** `sources.test.ts`: prezzo OpenRouter `"0.00000027"` → 0.27; `created: 1767225600` →
  2026-01-01; `supported_parameters: ["tools"]` → true, assente → null; LiteLLM `sample_spec` saltato, voce con
  `input_cost_per_token: "x"` → prezzo null ma voce presente, `deprecation_date: "2026-10-16"` → Date UTC,
  `"domani"` → null; id con `\u0007` scartato; 302, 500, HTML, `{"data": 3}` e corpo di 21 MB → `SourceError`
  con il messaggio della fonte; nessun messaggio contiene l'URL (Review Focus 1–2). `discovery.test.ts`
  invariato e verde.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): fonti pubbliche del catalogo dei modelli`

### Task 3: Normalizzazione, fusione e riepilogo (funzioni pure)

**Files:**
- Create: `artifacts/api-server/src/lib/catalog/normalize.ts`, `artifacts/api-server/src/lib/catalog/merge.ts`,
  `artifacts/api-server/src/lib/catalog/summary.ts` e i rispettivi `*.test.ts`

**Interfaces:**
- Consumes: Task 2 `SourceEntry`; `AiProvider`.
- Produces:
  - `normalizeModelId(id: string): string` — toglie `models/` iniziale, minuscolo.
  - `catalogKeysFor(entry: SourceEntry): { provider: AiProvider; modelId: string }[]` — OpenRouter: sempre
    `{ openrouter, normalizeModelId(key) }`; inoltre, se il prefisso è `deepseek/` → deepseek, `google/` →
    gemini, `mistralai/` → mistral, e l'id dopo lo slash non contiene `:`, la chiave del provider con l'id
    dopo lo slash. LiteLLM: `litellm_provider` `deepseek` | `gemini` | `mistral` | `groq` | `together_ai` |
    `openrouter` → deepseek | gemini | mistral | groq | together | openrouter, `modelId` = chiave senza il
    prefisso `<litellm_provider>/`; altri provider → nessuna chiave.
  - `familyAndVersion(modelId: string, name: string | null): { family: string; version: string }` — base =
    ultimo segmento dopo `/`; famiglia per prefisso della base: `gemini` Gemini, `gemma` Gemma, `deepseek`
    DeepSeek, `mistral|ministral|codestral|magistral|devstral|pixtral` Mistral, `llama` Llama, `qwen` Qwen,
    `gpt` GPT, `claude` Claude, `grok` Grok, `kimi` Kimi, `glm` GLM; altrimenti il primo token (separato da
    `-`) con iniziale maiuscola. Versione: il nome senza prefisso `"<Provider>: "` e senza la parola della
    famiglia iniziale; senza nome, la base senza il prefisso della famiglia con `-` → spazio.
  - `interface CatalogRecord { provider: AiProvider; modelId: string; family: string; version: string; releasedAt: Date | null; priceInput: number | null; priceOutput: number | null; contextTokens: number | null; supportsTools: boolean | null; status: "available" | "deprecated" | "retired"; deprecationDate: Date | null; sources: Partial<Record<"price" | "contextTokens" | "supportsTools" | "releasedAt" | "deprecationDate", "openrouter" | "litellm">> }`
  - `mergeCatalog(entries: SourceEntry[], now: Date): CatalogRecord[]` — raggruppa per chiave; precedenza
    (spec §4): per provider `openrouter` prezzi/contesto/strumenti da OpenRouter poi LiteLLM, per gli altri da
    LiteLLM poi OpenRouter; i prezzi si prendono in coppia dalla prima fonte che li ha entrambi; contesto e
    strumenti dalla prima non null; `releasedAt` solo OpenRouter; `deprecationDate` solo LiteLLM; `status`
    retired se `deprecationDate ≤ now`, deprecated se futura, altrimenti available.
  - `interface CatalogSummary { firstRun: boolean; added: CatalogChange[]; retired: CatalogChange[]; deprecating: (CatalogChange & { deprecationDate: string })[]; priceChanged: (CatalogChange & { oldInput: number | null; oldOutput: number | null; newInput: number | null; newOutput: number | null })[]; accounts: { accountId: number; userId: number; accountName: string; missing: string[] }[] }`
    con `CatalogChange = { provider: AiProvider; modelId: string; version: string }`.
  - `summarizeCatalog(before: CatalogRecord[], after: CatalogRecord[]): Omit<CatalogSummary, "accounts">` —
    `before` vuoto → `firstRun: true` e liste vuote; `added` = chiavi nuove; `retired` = diventati retired;
    `deprecating` = deprecated ora e prima non deprecated o con data diversa; `priceChanged` = coppia di
    prezzi diversa con entrambe le coppie non null.

- [ ] **Step 1: Test** `normalizeModelId("models/Gemini-2.5-Flash") === "gemini-2.5-flash"`; OpenRouter
  `google/gemini-3.5-flash` → [{openrouter, google/gemini-3.5-flash}, {gemini, gemini-3.5-flash}];
  `google/gemini-2.0-flash-exp:free` → solo openrouter (Review Focus 3); LiteLLM `together_ai/x` → together,
  `bedrock/…` → nessuna; `familyAndVersion("gemini-3.5-flash", "Google: Gemini 3.5 Flash")` →
  {Gemini, "3.5 Flash"}, `("deepseek-v4-pro", null)` → {DeepSeek, "v4 pro"}; con le fixture di Task 2:
  `deepseek-v4-pro` prende i prezzi LiteLLM anche se OpenRouter li ha diversi, `openrouter/deepseek/deepseek-chat`
  prende quelli OpenRouter, `gemini-2.5-flash` è retired, `releasedAt` solo da OpenRouter, `sources` dice da
  dove; `summarizeCatalog([], x).firstRun === true`; nuovo, ritirato, prezzo 0.28→0.30 riconosciuti, prezzo
  da null a noto non è un cambio.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): normalizzazione e fusione del catalogo dei modelli`

### Task 4: Aggiornamento del catalogo (esecuzione unica, account, avvio settimanale)

**Files:**
- Create: `artifacts/api-server/src/lib/ai/accounts.ts`, `artifacts/api-server/src/lib/catalog/refresh.ts`,
  `artifacts/api-server/src/lib/catalog/refresh.test.ts`, `artifacts/api-server/src/lib/catalog/scheduler.ts`,
  `artifacts/api-server/src/lib/catalog/scheduler.test.ts`
- Modify: `artifacts/api-server/src/routes/ai.ts` (importa da `accounts.ts`), `artifacts/api-server/src/index.ts`

**Interfaces:**
- Consumes: Task 1 tabelle; Task 2 fetch delle fonti e `fakeSourcesFetch`; Task 3 `mergeCatalog`,
  `summarizeCatalog`, `normalizeModelId`, tipi.
- Produces:
  - `accounts.ts`: `upsertDiscovered(tx, accountId, models)` e `verifyAccount(account): Promise<DiscoveredModel[] | null>`
    spostati da `routes/ai.ts` (null = errore del provider, account in `error`; `no_models` → `[]`).
    `upsertDiscovered` termina con `enrichFromCatalog(tx, { accountId })` (anch'essa in `accounts.ts`): così "Aggiorna modelli" e la
    creazione dell'account non perdono i prezzi del catalogo (Review Focus 4).
  - `enrichFromCatalog(executor: Tx | typeof db, opts: { accountId?: number }): Promise<void>` — per i modelli
    degli account non `custom` né `system_gateway`, abbina (`account.provider`, `normalizeModelId(model_id)`) a
    `model_catalog`; imposta `catalog_id` (null se nessun abbinamento), `supports_tools` dal catalogo e, se
    `price_source` non è `manual` e il catalogo ha entrambi i prezzi, prezzi e `price_source = 'catalog'`.
  - `class CatalogBusyError extends Error` ("aggiornamento già in corso").
  - `startCatalogRefresh(opts: { trigger: "scheduled" | "manual"; userId: number | null; fetchImpl?: typeof fetch }): Promise<{ run: CatalogRun; done: Promise<void> }>`
    — inserisce la riga `running` (violazione dell'indice unico → `CatalogBusyError`) e prosegue in background:
    fonti in parallelo (`Promise.allSettled`); entrambe fallite → `failed` con i due messaggi uniti da "; ";
    altrimenti upsert di `model_catalog` (le righe assenti dalle fonti restano), per ogni account non di
    sistema `verifyAccount` in sequenza (un errore non ferma gli altri; `missing` = id scoperti prima e non
    più elencati, solo se la verifica riesce, e solo se non vuoto), `enrichFromCatalog({})`, riepilogo,
    stato `completed` o `partial` (una fonte fallita: `error` = "aggiornamento parziale: " + messaggio della
    fonte), poi tiene solo le ultime 20 righe. Un'eccezione inattesa → `failed` con "aggiornamento non
    riuscito" (nel log solo il nome dell'errore). `done` non rigetta mai.
  - `failInterruptedCatalogRuns(): Promise<number>` — `running` → `failed`, "interrotto dal riavvio".
  - `scheduler.ts`: `isWeeklyRefreshDue(lastFinishedAt: Date | null, now: Date): boolean` (null o più di 7
    giorni); `checkWeeklyRefresh(now?: Date, start?: typeof startCatalogRefresh): Promise<boolean>` — ultimo
    `completed`/`partial`; se dovuto avvia `scheduled` e ignora `CatalogBusyError`;
    `startCatalogScheduler(): void` — primo controllo dopo 5 minuti, poi ogni 24 h, timer `unref()`.
  - `index.ts`: `failInterruptedCatalogRuns()` all'avvio, poi `startCatalogScheduler()` (errori solo nel log).

- [ ] **Step 1: Test** `refresh.test.ts` (DB PGlite, `fakeSourcesFetch`): dopo l'aggiornamento
  `model_catalog` ha `deepseek/deepseek-v4-pro` con prezzi LiteLLM e `gemini/gemini-2.5-flash` retired; un
  modello `deepseek-v4-pro` di un account deepseek (righe inserite a mano, base URL non raggiungibile)
  riceve `catalog_id`, `supports_tools` e `price_source = 'catalog'`; uno con prezzo `manual` resta invariato,
  anche dopo `upsertDiscovered` (Review Focus 4); un account `custom` sul finto provider a cui sparisce un
  modello compare in `summary.accounts[].missing`; LiteLLM 500 → `partial`, "aggiornamento parziale: fonte
  LiteLLM non raggiungibile: dati non aggiornati", righe OpenRouter aggiornate e righe preesistenti intatte;
  entrambe le fonti 500 → `failed` e catalogo invariato (Review Focus 2); seconda `startCatalogRefresh`
  mentre la prima è `running` → `CatalogBusyError`; `failInterruptedCatalogRuns` chiude la riga e un nuovo
  avvio riesce (Review Focus 5); 22 esecuzioni → ne restano 20; il secondo aggiornamento con un prezzo
  cambiato nel finto LiteLLM lo riporta in `priceChanged`. `scheduler.test.ts`: `isWeeklyRefreshDue` (null →
  true, 6 giorni → false, 8 → true); `checkWeeklyRefresh` con `start` finto: chiamato una volta se l'ultimo
  `completed` ha 8 giorni, mai se ne ha 1, un `failed` recente non conta.
- [ ] **Step 2:** FAIL. **Step 3:** implementare; `routes/ai.test.ts` resta verde senza modifiche.
  **Step 4:** PASS + suite completa.
- [ ] **Step 5: Commit** `feat(api-server): aggiornamento settimanale e a richiesta del catalogo`

### Task 5: Disponibilità, stato effettivo, preselezione e "Prova"

**Files:**
- Create: `artifacts/api-server/src/lib/ai/model-status.ts`, `artifacts/api-server/src/lib/ai/model-status.test.ts`,
  `artifacts/api-server/src/lib/ai/probe.ts`
- Modify: `artifacts/api-server/src/lib/ai/executor.ts` (+ `executor.test.ts`), `artifacts/api-server/src/routes/ai.ts`
  (+ `ai.test.ts`), `lib/api-spec/openapi.yaml` + codegen

**Interfaces:**
- Consumes: Task 1 colonne di `ai_models` e `model_catalog`; `resolveModel`, `modelChat`, `ProviderError` esistenti.
- Produces:
  - `type EffectiveStatus = "available" | "unavailable" | "retired"`;
    `effectiveStatus(m: { availability: "available" | "unavailable" | "unknown"; catalogStatus: "available" | "deprecated" | "retired" | null; deprecationDate: Date | null }, now: Date): EffectiveStatus`
    (spec §3: retired prima di unavailable).
  - `isPreviewModel(modelId: string): boolean` — `/(^|[-_./:])(preview|exp|experimental)([-_./:]|$)/i`.
  - `isSelectable(status: EffectiveStatus, supportsTools: boolean | null): boolean` — available e `supportsTools !== false`.
  - `pickRecommended<M extends { id: number; modelId: string; status: EffectiveStatus; supportsTools: boolean | null; priceInput: number | null; priceOutput: number | null }>(models: M[]): number | null`
    — tra i selezionabili con strumenti `true` e non anteprima, il prezzo noto (input + output) più basso;
    nessun prezzo → il primo di quelli; nessuno con strumenti `true` → lo stesso criterio sui selezionabili non
    anteprima, poi su tutti i selezionabili; altrimenti null.
  - `markModelUnavailable(aiModelId: number): Promise<void>` (UPDATE `availability = 'unavailable'`).
  - `modelChat`: in caso di errore, se lo stato HTTP è 404 o l'`APIError` ha `code === "model_not_found"`,
    `await markModelUnavailable(resolved.aiModelId)` (errori del DB solo nel log), poi rilancia come oggi.
  - `probeModel(aiModelId: number, userId: number): Promise<{ ok: boolean; error: string | null; costUsd: number | null }>`
    — modello di un account dell'utente (non di sistema), altrimenti `ModelAccessError`; `modelChat` con un
    messaggio utente "ping", `maxTokens: 1`, `maxRetries: 0`, `caller: "probe"`; ok → `availability = 'available'`;
    sempre `last_probe_at = now`, `last_probe_ok`; `error` = messaggio fisso del `ProviderError`.
  - OpenAPI `AiModel` + `availability`, `supportsTools`, `status` (`available|unavailable|retired`),
    `deprecationDate`, `releasedAt`, `selectable`, `recommended`, `lastProbeAt`, `lastProbeOk` (da join con
    `model_catalog`); `GET /ai/models` calcola `recommended` per gruppo con `pickRecommended`.
    `POST /ai/models/{id}/probe` (operationId `probeAiModel`) → `ProbeAiModelResponse = { ok, error, costUsd, model: AiModel }`;
    404 "modello non trovato" se non è dell'utente; rate limit 5/minuto iniettabile come `probeRateLimit` in
    `createAiRouter`.

- [ ] **Step 1: Test** `model-status.test.ts`: retired da catalogo e da data passata anche con
  `availability = 'available'`; `isPreviewModel` vero per `antigravity-preview-latest`,
  `gemini-2.0-flash-exp`, falso per `deepseek-expert`; `pickRecommended` sceglie il più economico con
  strumenti tra [anteprima economica, ritirato economico, `supportsTools` null, due con strumenti] e ricade
  sul primo con strumenti senza prezzi. `executor.test.ts`: chat 404 sul finto provider → riga
  `unavailable`; 400 → `availability` invariata. `ai.test.ts`: probe del proprio modello → richiesta con
  `max_tokens: 1`, `last_probe_ok = true`, `availability = 'available'`, costo nel risultato; probe di un
  modello altrui o di sistema → 404; probe con chat 404 → `ok: false`, "richiesta rifiutata dal provider (HTTP 404)",
  `unavailable`; `GET /ai/models` riporta `status`, `selectable` e un solo `recommended` per gruppo.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(api-server): disponibilità dei modelli, preselezione e prova con 1 token`

### Task 6: API del catalogo

**Files:**
- Create: `artifacts/api-server/src/routes/catalog.ts`, `artifacts/api-server/src/routes/catalog.test.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`, `lib/api-spec/openapi.yaml` + codegen

**Interfaces:**
- Consumes: Task 4 `startCatalogRefresh`, `CatalogBusyError`, `CatalogSummary`.
- Produces (OpenAPI, tag `catalog`):
  - `GET /catalog/models?provider=` (`listCatalogModels`) → `CatalogModel[]` = `{ id, provider, modelId, family, version, releasedAt, priceInput, priceOutput, contextTokens, supportsTools, status, deprecationDate, inMyAccounts }`
    ordinati per provider, famiglia, `releasedAt` decrescente; `inMyAccounts` = un modello di un account
    dell'utente ha quel `catalog_id`.
  - `GET /catalog/status` (`getCatalogStatus`) → `{ running: boolean; latest: CatalogRunView | null }` con
    `CatalogRunView = { id, trigger, status, startedAt, finishedAt, error, summary: CatalogSummary | null }`
    dove `summary.accounts` contiene solo gli account dell'utente corrente e senza `userId`.
  - `POST /catalog/refresh` (`refreshCatalog`) → 202 `CatalogRunView`; 409 `{ error: "aggiornamento già in corso" }`;
    rate limit 2/minuto iniettabile (`createCatalogRouter(opts: { refreshRateLimit?: RequestHandler; fetchImpl?: typeof fetch })`).

- [ ] **Step 1: Test** `catalog.test.ts` (app Express vera come `ai.test.ts`, `fakeSourcesFetch`):
  refresh → 202 `running`, dopo `done` lo stato è `completed` con le novità; secondo refresh durante il primo
  → 409 con il messaggio; `summary.accounts` di un altro utente non compare e nessuna risposta contiene
  `userId`; `listCatalogModels?provider=gemini` restituisce solo Gemini con `inMyAccounts` vero per il modello
  di un proprio account e falso per quello di un altro utente.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(api-server): API del catalogo dei modelli`

### Task 7: Console — tendina dei modelli e tabella degli Account AI

**Files:**
- Modify: `artifacts/casello/src/components/ai/{model-picker.tsx,ai-queries.ts}`,
  `artifacts/casello/src/components/account/ai-models-table.tsx`, `artifacts/casello/src/lib/format.ts`

**Interfaces:**
- Consumes: Task 5 campi di `AiModel`, hook `useProbeAiModel`; `invalidateAiQueries`.
- Produces: `useDefaultAiModelId()` usa `recommended` del gruppo predefinito (poi del primo gruppo non in
  errore, poi di qualsiasi gruppo) invece di `cheapestModel`, che sparisce.

- [ ] **Step 1:** tendina: per gruppo solo i modelli `selectable`; `supportsTools === null` con un "?" e
  title "supporto agli strumenti non noto"; i modelli disponibili senza strumenti in un gruppo finale "Altri
  modelli", mostrato solo dopo il pulsante "Mostra altri modelli (N)" sotto la tendina; ritirati e non
  disponibili esclusi; il valore corrente ritirato o non disponibile resta come voce disabilitata con
  "(ritirato)" / "(non disponibile)".
- [ ] **Step 2:** tabella dei modelli dell'account: colonne "Stato" (Disponibile / Non disponibile /
  Ritirato, con "dismesso il <data>" se c'è `deprecationDate`) e "Strumenti" (Sì / No / ?); pulsante
  "Prova" per riga (solo account non di sistema) → toast "Il modello risponde (costo <costo>)" o l'errore,
  poi `invalidateAiQueries`; 429 → "troppe prove: riprova tra un minuto".
- [ ] **Step 3:** typecheck + build della console (`PORT=5173 BASE_PATH=/ pnpm --filter @workspace/casello run build`).
- [ ] **Step 4: Commit** `feat(casello): tendina con soli modelli disponibili e prova dei modelli`

### Task 8: Console — pagina Modelli

**Files:**
- Create: `artifacts/casello/src/pages/models.tsx`, `artifacts/casello/src/components/catalog/catalog-news.tsx`,
  `artifacts/casello/src/components/catalog/catalog-table.tsx`
- Modify: `artifacts/casello/src/App.tsx` (route `/models`), `artifacts/casello/src/components/layout/app-shell.tsx`
  (voce "Modelli", icona `Cpu`, dopo "Run")

**Interfaces:**
- Consumes: Task 6 hook `useGetCatalogStatus`, `useRefreshCatalog`, `useListCatalogModels`.

- [ ] **Step 1:** `catalog-news.tsx`: data ed esito dell'ultimo aggiornamento (badge completato / parziale /
  fallito / in corso, `error` se c'è), pulsante "Aggiorna catalogo" (disabilitato mentre `running`; 409 →
  "aggiornamento già in corso"); durante `running` polling di `getCatalogStatus` ogni 3 s, alla fine
  invalida catalogo e `/api/ai/`; liste "Nuovi", "Ritirati", "In dismissione" (con data), "Prezzi cambiati"
  (vecchio → nuovo), "Spariti dai tuoi account" (per account), ciascuna con al massimo 10 voci e "e altri N";
  `firstRun` → "Primo aggiornamento: catalogo creato"; nessuna esecuzione → "Catalogo non ancora aggiornato".
- [ ] **Step 2:** `catalog-table.tsx`: scelta del provider (preselezionato il primo dei propri account),
  modelli raggruppati per famiglia con versione, `modelId`, rilascio, prezzo (`formatModelPrice`), contesto,
  strumenti, stato; badge "nei tuoi account" per `inMyAccounts`; ritirati nascosti finché non si spunta
  "Mostra ritirati".
- [ ] **Step 3:** typecheck + build della console.
- [ ] **Step 4: Commit** `feat(casello): pagina Modelli con novità e catalogo`

### Task 9: Rilascio e collaudo (controller con Ivan)

- [ ] **Step 1:** `CLAUDE.md`: sezione "Catalogo dei modelli" (fonti, settimanale + `POST /api/catalog/refresh`,
  tabelle, stato effettivo, "Prova", Gemini); elenco route aggiornato.
- [ ] **Step 2:** prova nel browser in locale (`AUTH_DISABLED=true pnpm run dev`): "Aggiorna catalogo"
  (fonti vere), pagina Modelli, tendina, "Prova" con un account di prova se disponibile.
- [ ] **Step 3:** push di `feat/catalogo-modelli` e PR (con Ivan): istruzioni di rilascio = migrazione
  `docs/migrations/2026-10-catalogo-modelli.sql` su Neon prima del merge; nessuna variabile nuova.
- [ ] **Step 4:** collaudo di Ivan: account Gemini (provider nuovo) e DeepSeek, "Aggiorna catalogo", prezzi di
  `deepseek-v4-pro` e dei Gemini noti, `gemini-2.5-flash` ritirato, preselezionato un modello disponibile con
  strumenti, analisi di Mister avviata con quello.
