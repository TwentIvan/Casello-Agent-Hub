# Catalogo universale dei modelli e registro dei provider — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casello cataloga tutte le voci delle fonti (≈4 300 voci, 143 provider, ogni tipo di modello) come
modelli con offerte per provider, tiene i provider come dati (registro nel codice + tabella), segnala i provider
non gestiti e permette di configurare un account su qualsiasi provider compatibile OpenAI, con ricerca adatta a
liste lunghe.

**Architecture:** `providers` (registro allineato all'avvio + provider scoperti) sostituisce l'enum
`ai_provider`; `models` + `model_offers` sostituiscono `model_catalog`. Funzioni pure in `lib/catalog/`
(registro, chiave canonica, fusione, riepilogo) e un orchestratore che scrive le tre tabelle e ricollega
`ai_models.offer_id`. La console usa API paginate con filtri.

**Tech Stack:** Express 5, Drizzle/Postgres, Zod/Orval, Vitest + PGlite, React + React Query + shadcn/ui
(`components/ui/command.tsx`, `popover.tsx`, `pagination.tsx`, `tabs.tsx` già presenti).

**Spec:** `docs/superpowers/specs/2026-10-26-casello-catalogo-universale-design.md` (base:
`docs/superpowers/specs/2026-10-26-casello-catalogo-modelli-design.md`)

## Global Constraints

- Italiano per commenti, messaggi, UI e commit; identificatori in inglese.
- Contract-first: OpenAPI + codegen (file generati committati); `parseRequest` / `*Response.parse`.
- Schema DB: Drizzle + `docs/schema-casello.sql` + **un solo** script `docs/migrations/2026-10-catalogo-universale.sql`
  (idempotente, una transazione), arricchito task dopo task; il testo completo va scritto a Ivan in chat prima
  del push.
- Nessuna nuova dipendenza npm.
- Ogni commit con `pnpm run typecheck` e `pnpm --filter @workspace/api-server run test` verdi (e build della
  console quando la si tocca): nessun task lascia il repository rotto.
- Aggiornamento a costo zero (nessuna chiamata ai modelli); fonti, timeout 30 s, niente redirect, 20 MB come oggi.
- Prezzi `manual` mai sovrascritti; aggiornamento parziale che conserva i campi della fonte caduta; una sola
  esecuzione alla volta.
- Stati dei provider: `managed` (esecutore disponibile: solo `openai_compatible`), `coming` (`anthropic`,
  `bedrock`, `vertex`, `azure`), `unmanaged` (`protocol = unknown`, scoperto dalle fonti).
- Messaggi fissi: "esecutore non ancora disponibile per questo provider", "provider non gestito: inserisci
  l'indirizzo compatibile OpenAI", "provider sconosciuto"; restano quelli esistenti.
- Indirizzi inseriti dall'utente: stesse regole di `custom` (`validateBaseUrl`: https, niente redirect, reti
  private solo con consenso e mai loopback/link-local/metadata).

## Review Focus

1. Provider scoperto con un nome che collide con uno slug del registro dopo la normalizzazione (es.
   `together_ai` → `together-ai` contro `together`): deve finire sul provider del registro tramite
   `source_keys`, mai creare un doppione → test in Task 3.
2. Riavvio dopo che il registro ha riconosciuto un provider prima `discovered`: la riga diventa `registry` con
   protocollo e indirizzo nuovi, gli account esistenti su quel provider continuano a funzionare → test in Task 1.
3. Ricerca con testo che contiene `%`, `_` o apici: trattati come caratteri letterali, nessun errore SQL →
   test in Task 6.
4. Account esistente (DeepSeek, Gemini, custom, sistema) dopo la migrazione: stesso provider, modelli
   ricollegati alle offerte al primo aggiornamento, agenti che girano come prima → test in Task 1 e Task 5.
5. Modello offerto da decine di provider (es. Llama su Fireworks, DeepInfra, Together, Bedrock…): una sola riga
   nella vista per modello con prezzo più basso corretto e numero di offerte → test in Task 4 e Task 6.

---

### Task 1: Registro dei provider come dati

**Files:**
- Create: `artifacts/api-server/src/lib/catalog/provider-registry.ts` (+ `.test.ts`),
  `lib/db/src/schema/providers.ts`, `docs/migrations/2026-10-catalogo-universale.sql`,
  `artifacts/api-server/test/migration-catalogo-universale.test.ts`,
  `artifacts/api-server/test/fixtures/schema-pre-catalogo-universale.sql` (copia dell'attuale `docs/schema-casello.sql`)
- Modify: `lib/db/src/schema/{ai-accounts,model-catalog,index}.ts`, `docs/schema-casello.sql`,
  `artifacts/api-server/src/lib/ai/providers.ts`, `artifacts/api-server/src/index.ts`, ogni uso di `AiProvider`/`PROVIDERS`
  (`lib/ai/{executor,discovery,price-seed}.ts`, `routes/ai.ts`, `lib/catalog/{normalize,merge,summary}.ts`)

**Interfaces:**
- Produces:
  - `providersTable` (`providers`): `slug` text PK, `name` text, `protocol` enum `provider_protocol`
    (`openai_compatible`, `anthropic`, `bedrock`, `vertex`, `azure`, `unknown`), `default_base_url` text null,
    `source_keys` jsonb `{ litellm: string[], openrouterAuthor: string | null }`, `status` enum `provider_status`
    (`managed`, `coming`, `unmanaged`), `origin` enum `provider_origin` (`registry`, `discovered`),
    `first_seen_at`, `updated_at`. Tipo `ProviderRow`.
  - `ai_accounts.provider` e `model_catalog.provider`: `text` con FK su `providers.slug` (on update cascade).
  - `type AiProvider = string`; `PROVIDER_REGISTRY: RegistryProvider[]` con
    `RegistryProvider = { slug; name; protocol; defaultBaseUrl: string | null; litellm: string[]; openrouterAuthor: string | null }`
    e `statusForProtocol(protocol): "managed" | "coming" | "unmanaged"`.
  - `ensureProviderRegistry(): Promise<void>` — upsert di ogni voce del registro (`origin = registry`, stato
    da `statusForProtocol`), idempotente; una riga `discovered` con lo stesso slug diventa `registry`.
  - `PROVIDERS`/`validateBaseUrl` restano per le funzioni pure; `PROVIDERS` diventa una `Map` derivata dal registro.

- [ ] **Step 1: Test** `provider-registry.test.ts`: slug unici e `[a-z0-9-]`; ogni `litellm` compare in un solo
  provider; Bedrock ha `bedrock`, `bedrock_converse`, `bedrock_mantle`; Vertex ha ogni `vertex_ai*` presente
  nel listino (lista esplicita); Azure `azure`, `azure_ai`, `azure_text`; `together` ha `together_ai`;
  `openai_compatible` → `managed`, `bedrock` → `coming`. `migration-catalogo-universale.test.ts`: dalla fixture
  con account `deepseek`, `custom`, `system_gateway`, `gemini` gli account restano con lo stesso provider e la
  FK è valida; un account con provider inesistente è rifiutato; seconda esecuzione senza errori.
  Un test DB: `ensureProviderRegistry` due volte → stesso contenuto; riga `discovered` `xai-like` poi
  riconosciuta dal registro → `origin = registry`, protocollo aggiornato (Review Focus 2).
- [ ] **Step 2:** FAIL. **Step 3:** registro con almeno i provider della spec §4 (indirizzi verificati sulla
  documentazione ufficiale di ciascuno; se incerto, `defaultBaseUrl: null`), schema, migrazione (crea i tre
  enum, `providers` con le righe di oggi, `ALTER COLUMN provider TYPE text USING provider::text` su
  `ai_accounts` e `model_catalog`, FK), `ensureProviderRegistry` all'avvio in `index.ts` prima di
  `ensureSystemAccount`. **Step 4:** PASS + typecheck + suite completa.
- [ ] **Step 5: Commit** `feat(api-server): registro dei provider come dati`

### Task 2: Account su qualsiasi provider

**Files:**
- Modify: `artifacts/api-server/src/routes/ai.ts` (+ `ai.test.ts`), `artifacts/api-server/src/lib/ai/executor.ts`,
  `lib/api-spec/openapi.yaml` + codegen, `artifacts/casello/src/components/account/ai-account-dialog.tsx` (solo
  compilazione: legge `GET /ai/providers`; la UI con ricerca è in Task 8)

**Interfaces:**
- Consumes: Task 1 `providersTable`, `statusForProtocol`.
- Produces:
  - `GET /ai/providers` (`listAiProviders`) → `AiProviderInfo[] = { slug, name, protocol, status, defaultBaseUrl, editableBaseUrl }`
    ordinati: `managed` per nome, poi `coming`, poi `unmanaged`; `system_gateway` escluso.
  - `POST /ai/accounts`: provider sconosciuto → 400 "provider sconosciuto"; `coming` → 400 "esecutore non
    ancora disponibile per questo provider"; `unmanaged` o `custom` → `baseUrl` obbligatorio (altrimenti
    "provider non gestito: inserisci l'indirizzo compatibile OpenAI" per `unmanaged`), validato come oggi per
    `custom`; `managed` con indirizzo predefinito → come oggi.
  - `executorKindFor(protocol)`: `openai_compatible` e `unknown` → `openai_compatible`; altri → errore fisso.
  - OpenAPI: `AiProvider` diventa `string` (pattern `^[a-z0-9-]{1,64}$`).

- [ ] **Step 1: Test** in `ai.test.ts`: elenco provider con `managed` prima e senza `system_gateway`; account
  `bedrock` → 400 col messaggio; account su provider `unmanaged` senza indirizzo → 400 col messaggio, con
  indirizzo del finto provider (consenso rete privata) → 201 e modelli scoperti; provider inesistente → 400.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen. **Step 4:** PASS + typecheck + build console.
- [ ] **Step 5: Commit** `feat(api-server): account AI su qualsiasi provider del registro`

### Task 3: Fonti complete e chiave canonica

**Files:**
- Modify: `artifacts/api-server/src/lib/catalog/sources.ts` (+ test), `artifacts/api-server/test/fake-sources.ts`
- Create: `artifacts/api-server/src/lib/catalog/canonical.ts` (+ `.test.ts`)

**Interfaces:**
- Produces:
  - `SourceEntry` + `mode: ModelMode`, `supportsVision: boolean | null`, `supportsReasoning: boolean | null`;
    `ModelMode = "chat" | "embedding" | "image_generation" | "image_edit" | "audio_transcription" | "audio_speech" | "video_generation" | "rerank" | "moderation" | "ocr" | "search" | "realtime" | "responses" | "completion" | "other"`.
    LiteLLM: `mode` (valori fuori elenco → `other`), `supports_vision`, `supports_reasoning`; OpenRouter:
    `chat`, visione da `architecture.input_modalities` contiene `image`, ragionamento da `supported_parameters`
    contiene `reasoning`.
  - `providerSlugFor(entry, registry: RegistryProvider[]): { slug: string; known: boolean }` — LiteLLM:
    provider del registro il cui `litellm` contiene `litellm_provider`, altrimenti slug normalizzato
    (`[^a-z0-9]+` → `-`, trim dei `-`) con `known: false`; OpenRouter: `openrouter`.
  - `directProviderFor(entry, registry): string | null` — per una voce OpenRouter con id `autore/modello` senza
    `:`, il provider del registro con `openrouterAuthor === autore` (riserva di dati per l'offerta diretta).
  - `providerModelId(entry): string` — id presso il provider: chiave senza prefisso `<litellm_provider>/`,
    poi `normalizeModelId`.
  - `canonicalModelKey(providerModelId: string): string` — ultimo segmento dopo `/`; tolti prefissi d'autore
    in stile Bedrock (`anthropic.`, `meta.`, `amazon.`, `mistral.`, `cohere.`, `ai21.`, `deepseek.`, `qwen.`,
    `us.`/`eu.`/`apac.`/`global.` iniziali), suffissi `-v\d+:\d+`, `@\d{8}`, `:\d+` finali; minuscolo;
    `_` → `-`; `.` invariato.
  - `authorFor(canonicalKey: string, openrouterAuthor: string | null): string` — dal prefisso OpenRouter (mappa
    `anthropic` Anthropic, `openai` OpenAI, `google` Google, `meta-llama` Meta, `mistralai` Mistral, `qwen`
    Qwen, `deepseek` DeepSeek, `x-ai` xAI, `z-ai` Z.ai, `moonshotai` Moonshot, `minimax` MiniMax, `cohere`
    Cohere, altrimenti il prefisso con iniziale maiuscola), altrimenti dalla famiglia (`claude` Anthropic, `gpt`/
    `o1`/`o3`/`o4` OpenAI, `gemini`/`gemma` Google, `llama` Meta, `mistral…` Mistral, `qwen` Qwen, `deepseek`
    DeepSeek, `grok` xAI, `glm` Z.ai, `kimi` Moonshot), altrimenti "Sconosciuto".

- [ ] **Step 1: Test** `canonical.test.ts`: `canonicalModelKey("anthropic.claude-sonnet-4-5-20250929-v1:0")`
  `=== canonicalModelKey("claude-sonnet-4-5-20250929")`; `"us.meta.llama3-3-70b-instruct-v1:0"` →
  `"llama3-3-70b-instruct"`; `"claude-3-5-sonnet@20240620"` → `"claude-3-5-sonnet"`; `"gemini-2.5-flash"`
  invariato; `providerSlugFor` con `bedrock_converse` → `bedrock`, `together_ai` → `together` (Review Focus 1),
  `nuovo_provider` → `{ slug: "nuovo-provider", known: false }`; `authorFor("claude-…", null) === "Anthropic"`.
  `sources.test.ts`: `mode` letto, valore sconosciuto → `other`, visione e ragionamento da entrambe le fonti.
- [ ] **Step 2:** FAIL. **Step 3:** implementare (fixture con un provider sconosciuto, una voce Bedrock e una
  Anthropic dello stesso Claude, un embedding). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): fonti complete e chiave canonica dei modelli`

### Task 4: Fusione in modelli e offerte

**Files:**
- Modify: `artifacts/api-server/src/lib/catalog/{merge,summary}.ts` (+ test); `normalize.ts` perde
  `catalogKeysFor` (sostituito), tiene `normalizeModelId` e `familyAndVersion`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `OfferRecord = { provider; providerModelId; canonicalKey; priceInput; priceOutput; contextTokens; supportsTools; status; deprecationDate; sources }`
    (stesse regole di precedenza di oggi: per `openrouter` OpenRouter poi LiteLLM, per gli altri LiteLLM poi
    OpenRouter come riserva tramite `directProviderFor`; dismissione solo LiteLLM).
  - `ModelRecord = { canonicalKey; author; family; version; mode; supportsTools; supportsVision; supportsReasoning; releasedAt }`
    — campi dalla voce più informativa (nome e rilascio da OpenRouter se c'è); `supportsTools` del modello =
    vero se almeno un'offerta lo dichiara vero, falso se tutte falso, altrimenti null.
  - `mergeUniversal(entries: SourceEntry[], registry: RegistryProvider[], now: Date): { models: ModelRecord[]; offers: OfferRecord[]; discovered: { slug: string; name: string; count: number }[] }`
    (`name` = nome LiteLLM originale).
  - `keepFailedSourceFields(offers, before, failed, now)` sulle offerte (chiave `provider` + `providerModelId`).
  - `summarizeCatalog(before: OfferRecord[], after: OfferRecord[])` come oggi sulle offerte, `CatalogChange`
    con `provider`, `modelId` (= `providerModelId`), `version`; `CatalogSummary.newProviders: { slug; name; count }[]`.

- [ ] **Step 1: Test** `merge.test.ts`: con le fixture lo stesso Claude da Bedrock e Anthropic → **un**
  `ModelRecord` e **due** offerte (Review Focus 5); provider sconosciuto in `discovered` con il conteggio;
  embedding con `mode: "embedding"`; precedenze e aggiornamento parziale come i test esistenti (adattati);
  `summarizeCatalog` invariato nei casi esistenti.
- [ ] **Step 2:** FAIL. **Step 3:** implementare (i vecchi `CatalogRecord`/`mergeCatalog` restano finché Task 5
  non li sostituisce nell'orchestratore). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): fusione del catalogo in modelli e offerte`

### Task 5: Aggiornamento su modelli e offerte, arricchimento degli account

**Files:**
- Create: `lib/db/src/schema/{models,model-offers}.ts`
- Modify: `lib/db/src/schema/{ai-models,index}.ts`, `docs/schema-casello.sql`, migrazione,
  `artifacts/api-server/src/lib/catalog/refresh.ts` (+ test), `artifacts/api-server/src/lib/ai/accounts.ts`,
  `artifacts/api-server/src/routes/ai.ts` (serializzatore `AiModel` su offerta), `lib/ai/model-status.ts` se serve

**Interfaces:**
- Consumes: Task 1 tabella e registro; Task 4 `mergeUniversal`, `keepFailedSourceFields`, `summarizeCatalog`.
- Produces:
  - `modelsTable` (spec §3; `canonical_key` unica, `mode` enum `model_mode`) e `modelOffersTable` (spec §3; unico
    `provider` + `provider_model_id`; `model_id` → models on delete cascade; prezzi `numeric(12,6)`); enum
    `model_catalog_status` riusato per lo stato dell'offerta.
  - `ai_models.offer_id` → model_offers (set null).
  - `startCatalogRefresh` scrive providers scoperti (`origin = discovered`, `status = unmanaged`,
    `protocol = unknown`, `first_seen_at`; mai modificare righe esistenti), modelli e offerte (upsert a blocchi
    di 500; modelli e offerte assenti dalle fonti restano), riepilogo con `newProviders` = provider creati in
    questa esecuzione.
  - `enrichFromCatalog` abbina su `model_offers` (`provider = account.provider`,
    `provider_model_id = lower(regexp_replace(model_id, '^models/', '', 'i'))`), esclusi solo `custom` e
    `system_gateway`; stesse regole su prezzi e strumenti; scrive `offer_id`.
  - `toPublicModel` legge stato, dismissione, rilascio e strumenti dall'offerta (e dal modello per il rilascio).

- [ ] **Step 1: Test** `refresh.test.ts` adattato: dopo l'aggiornamento esistono il modello Claude con due
  offerte, il provider sconosciuto `unmanaged` e in `summary.newProviders`; al secondo aggiornamento
  `newProviders` è vuoto e il provider non è duplicato; un account `deepseek` esistente riceve `offer_id`,
  strumenti e prezzi dal catalogo; prezzo manuale intatto; parziale con LiteLLM 500 conserva i campi; account
  su provider `unmanaged` (finto provider) si abbina alle offerte di quel provider; `routes/ai.test.ts` verde
  (stato effettivo e preselezione invariati).
- [ ] **Step 2:** FAIL. **Step 3:** implementare; `model_catalog` resta nello schema ma non è più scritto (lo
  legge ancora solo `routes/catalog.ts` fino a Task 6). **Step 4:** PASS + suite completa.
- [ ] **Step 5: Commit** `feat(api-server): catalogo universale in modelli e offerte`

### Task 6: API del catalogo per liste lunghe

**Files:**
- Modify: `artifacts/api-server/src/routes/catalog.ts` (+ test), `lib/api-spec/openapi.yaml` + codegen,
  `artifacts/casello/src/components/catalog/catalog-table.tsx` (solo per compilare; UI in Task 7), schema e
  migrazione (eliminazione di `model_catalog`, `ai_models.catalog_id`, svuotamento di `catalog_runs`)
- Create: `artifacts/api-server/src/lib/catalog/provider-issue.ts` (+ test)

**Interfaces:**
- Consumes: Task 5 tabelle.
- Produces (spec §8):
  - `GET /catalog/models` (`listCatalogModels`) query `q`, `mode` (default `chat`, `all` per tutti), `author`
    (ripetibile), `provider` (ripetibile), `tools`, `vision`, `reasoning` (booleani), `usable` (solo modelli con
    un'offerta su un provider di un proprio account), `maxPrice` (USD/Mtok su input+output dell'offerta più
    economica), `minContext`, `includeRetired` (default false: escluse le offerte `retired`), `sort`
    (`price` | `released` | `context` | `name`, default `name`), `page` (≥1), `pageSize` (1–100, default 50) →
    `{ items: CatalogModelSummary[], total, page, pageSize }`, `CatalogModelSummary = { id, canonicalKey, author, family, version, mode, supportsTools, supportsVision, supportsReasoning, releasedAt, offerCount, cheapestOffer: { provider, priceInput, priceOutput } | null, inMyAccounts }`.
    Testo: `ILIKE` con `%` `_` `\` resi letterali (Review Focus 3).
  - `GET /catalog/models/{id}/offers` (`listCatalogModelOffers`) → `CatalogOffer[] = { id, provider, providerName, providerStatus, providerModelId, priceInput, priceOutput, contextTokens, supportsTools, status, deprecationDate, inMyAccounts }`
    ordinate per prezzo.
  - `GET /catalog/providers` (`listCatalogProviders`) query `q`, `status` → `{ slug, name, protocol, status, origin, firstSeenAt, modelCount, hasMyAccount }[]`.
  - `GET /catalog/providers/{slug}/issue` (`getProviderIssue`) → `{ title, body }` markdown in italiano per un
    provider `unmanaged` (nome, nomi nelle fonti, numero di voci, esempi di 5 id, cosa serve: protocollo,
    indirizzo, `source_keys`); 404 per gli altri.
  - `CatalogSummaryView.newProviders`.

- [ ] **Step 1: Test** `catalog.test.ts`: paginazione (`total` corretto, `pageSize` 101 → 400); `q="claude"`
  trova per id e famiglia; `q="50%_"` nessun errore e nessun risultato spurio; `mode` e `all`; filtro
  `provider=bedrock`; `cheapestOffer` e `offerCount` del modello con più offerte (Review Focus 5); `usable` con
  un account `deepseek`; `includeRetired`; offerte di un modello ordinate per prezzo; provider con
  `modelCount` e `hasMyAccount`; issue di un provider `unmanaged` con nome e id di esempio, 404 per `managed`.
  Migrazione: `model_catalog` e `catalog_id` spariti, `catalog_runs` vuota, seconda esecuzione senza errori.
- [ ] **Step 2:** FAIL. **Step 3:** implementare + codegen; adattamento minimo di `catalog-table.tsx`.
  **Step 4:** PASS + typecheck + build console.
- [ ] **Step 5: Commit** `feat(api-server): API del catalogo universale con ricerca e paginazione`

### Task 7: Console — pagina Modelli universale

**Files:**
- Modify: `artifacts/casello/src/pages/models.tsx`, `artifacts/casello/src/components/catalog/{catalog-news,catalog-table}.tsx`
- Create: `artifacts/casello/src/components/catalog/{catalog-filters,catalog-by-model,catalog-by-provider,unmanaged-providers}.tsx`,
  `artifacts/casello/src/lib/catalog-query.ts`

**Interfaces:**
- Consumes: Task 6 hook generati.
- Produces: `useCatalogQueryState()` in `catalog-query.ts`: legge e scrive vista (`model` | `provider`), testo,
  filtri, ordinamento e pagina nella query string (wouter `useSearch`/`navigate`), con testo applicato dopo
  300 ms di pausa.

- [ ] **Step 1:** filtri (`catalog-filters.tsx`): campo di ricerca, tipo (predefinito Chat, "Tutti i tipi"),
  autore e provider come selezione multipla con ricerca (`Popover` + `Command`), interruttori Strumenti /
  Visione / Ragionamento / "Solo utilizzabili da me" / "Mostra ritirati", prezzo massimo, contesto minimo,
  ordinamento; "Azzera filtri".
- [ ] **Step 2:** vista per modello (`catalog-by-model.tsx`): tabella paginata (componente `pagination`) con
  autore, famiglia e versione, tipo, capacità (badge), rilascio, prezzo più basso con il provider, numero di
  provider, "nei tuoi account"; riga espandibile che carica le offerte (provider con badge di stato *gestito* /
  *in arrivo* / *non gestito*, id, prezzo, contesto, strumenti, stato).
- [ ] **Step 3:** vista per provider (`catalog-by-provider.tsx`): elenco con ricerca e filtro di stato, numero
  di modelli, "hai un account"; aprendo un provider la vista per modello filtrata su quel provider.
- [ ] **Step 4:** `unmanaged-providers.tsx`: riquadro "Da gestire in Casello" (solo se ci sono `unmanaged`) con
  nome, voci, data di comparsa e "Copia testo issue" (`getProviderIssue`, copia negli appunti, toast).
  `catalog-news.tsx`: lista "Nuovi provider non gestiti" da `newProviders`.
- [ ] **Step 5:** typecheck + build console. **Step 6: Commit** `feat(casello): pagina Modelli universale con ricerca e due viste`

### Task 8: Console — scelta del provider e del modello con ricerca

**Files:**
- Modify: `artifacts/casello/src/components/account/ai-account-dialog.tsx`, `artifacts/casello/src/components/ai/model-picker.tsx`

**Interfaces:**
- Consumes: Task 2 `useListAiProviders`; regole della tendina esistenti (`selectable`, `status`, "Altri modelli", `recommended`).

- [ ] **Step 1:** dialog dell'account: campo provider con ricerca (`Popover` + `Command`) su tutto il
  registro, gruppi "Gestiti", "In arrivo" (disabilitati, "esecutore in arrivo"), "Non gestiti" ("compatibile
  OpenAI: inserisci l'indirizzo"); indirizzo precompilato e non modificabile per i gestiti con indirizzo,
  obbligatorio per `custom` e non gestiti; "Consenti rete privata" solo per questi ultimi.
- [ ] **Step 2:** tendina dei modelli come campo con ricerca (`Popover` + `Command`) con gli stessi gruppi
  per account, "?", "Altri modelli" a richiesta, valore corrente ritirato/non disponibile come voce
  disabilitata, preselezione invariata.
- [ ] **Step 3:** typecheck + build console. **Step 4: Commit** `feat(casello): scelta di provider e modelli con ricerca`

### Task 9: Rilascio e collaudo (controller con Ivan)

- [ ] **Step 1:** `CLAUDE.md`: sezione "Catalogo dei modelli" aggiornata (registro, stati dei provider,
  modelli e offerte, ricerca, intervento evolutivo sui non gestiti), tabelle e route.
- [ ] **Step 2:** prova nel browser in locale con le fonti vere (≈4 300 voci, 143 provider): ricerca, filtri,
  due viste, riquadro "Da gestire", nuovo account su un provider compatibile.
- [ ] **Step 3:** testo **completo** di `docs/migrations/2026-10-catalogo-universale.sql` a Ivan in chat;
  applicazione su Neon prima del merge; poi push e link della PR.
- [ ] **Step 4:** collaudo di Ivan: account esistenti funzionanti, catalogo ricostruito dopo 5 minuti,
  "Aggiorna catalogo", un account su un provider nuovo (es. OpenAI o xAI se ha una chiave).
