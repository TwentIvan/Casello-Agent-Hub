# Account AI — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni utente aggiunge i propri account AI dalla console; i modelli di quegli account (con prezzi) sono
selezionabili da agenti e analisi; ogni chiamata registra token e costo; nessuna configurazione manuale del
gateway.

**Architecture:** Casello parla direttamente con i provider compatibili OpenAI tramite un esecutore unico
(`lib/ai/executor.ts`) che risolve `aiModelId → account → baseURL + chiave decifrata + prezzi`. Le variabili
`AI_GATEWAY_*` di oggi diventano un account di sistema creato all'avvio, così nulla si rompe al rilascio.
L'interfaccia dell'esecutore prevede già un secondo tipo (agente locale via MCP) senza implementarlo.

**Tech Stack:** Express 5, Drizzle/Postgres, SDK `openai` (già usato), Zod/Orval, Vitest + PGlite, React +
React Query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-26-casello-account-ai-design.md`

## Global Constraints

- Italiano per commenti, messaggi d'errore, UI e commit; identificatori in inglese.
- Contract-first: ogni route nuova/cambiata in `lib/api-spec/openapi.yaml` + codegen, file generati committati;
  `parseRequest` / `*Response.parse` come le route esistenti.
- Schema DB: Drizzle + `docs/schema-casello.sql` + `docs/migrations/2026-10-account-ai.sql` (idempotente, una
  transazione), da applicare prima del merge.
- Nessuna nuova dipendenza npm.
- Chiavi dei provider cifrate con `encryptSecret`/`decryptSecret` (`lib/secrets.ts`), decifrate solo al momento
  della chiamata; mai in log, risposte, errori, DB in chiaro.
- Ogni utente vede e usa solo i propri account più l'account di sistema; "chi configura paga": le run usano
  l'account del modello scelto nell'agente, chiunque le avvii.
- Base URL: solo `https`, tranne `custom` con `allow_private_network = true`; nessun redirect seguito.
- Messaggi fissati dalla spec §7: "chiave non valida o senza permessi", "credito del provider esaurito:
  ricarica il conto o scegli un altro modello", "limite di richieste del provider: riprova più tardi",
  "provider non raggiungibile", "il provider non fornisce l'elenco dei modelli: aggiungili a mano",
  "indirizzo non consentito", "account usato da: …".
- Costo = `prompt × price_input/1e6 + completion × price_output/1e6` (USD); null se un prezzo manca.
- `pnpm run typecheck` e `pnpm --filter @workspace/api-server run test` verdi prima di ogni commit.

## Review Focus

1. Utente B che modifica un agente configurato da A con l'account di A: il salvataggio senza cambiare il modello
   non deve fallire né spostare l'account; scegliere un account di A deve essere impossibile → test in Task 6.
2. Provider che restituisce `/models` enorme o con prezzi assenti/strani (stringhe, negativi): verifica che non
   esploda, tronchi a 2 000 e lasci i prezzi null → test in Task 2.
3. Account eliminato o chiave cambiata mentre una run/analisi è in corso: la run in corso usa la chiave già
   letta; le successive vedono la nuova; eliminazione di un account in uso rifiutata → test in Task 5.
4. Rilascio con agenti esistenti e variabili `AI_GATEWAY_*` presenti: dopo l'avvio ogni agente ha
   `ai_model_id` dell'account di sistema e le run funzionano come prima → test in Task 4.
5. Risposta del provider senza `usage`: costo null ("costo parziale"), nessun crash → test in Task 3.

---

### Task 1: Schema e migrazione

**Files:**
- Create: `lib/db/src/schema/ai-accounts.ts`, `lib/db/src/schema/ai-models.ts`,
  `docs/migrations/2026-10-account-ai.sql`, `artifacts/api-server/test/migration-account-ai.test.ts`,
  `artifacts/api-server/test/fixtures/schema-pre-account-ai.sql` (copia dell'attuale `docs/schema-casello.sql`)
- Modify: `lib/db/src/schema/{agents,analyses,runs,index}.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces: `aiProviderEnum` (`ai_provider`: deepseek, openrouter, huggingface, mistral, groq, together,
  custom, system_gateway), `aiAccountsTable` (spec §2; indice unico parziale `ai_accounts_one_default_per_user`
  su `user_id` where `is_default`; `status` enum `ai_account_status`: unverified, ok, error),
  `aiModelsTable` (spec §2; unico `ai_models_account_model_unique`; prezzi `numeric(12,6)` letti come
  stringa da Drizzle, convertiti in number nel codice), `agents.aiModelId`, `analyses.aiModelId`,
  `analyses.costUsd`, `runs.costUsd` (`numeric(12,6)`); tipi `AiAccount`, `AiModel`.

- [ ] **Step 1: Test** come `migration-github.test.ts`: tabelle e colonne create, seconda esecuzione senza
  errori, un secondo account `is_default` per lo stesso utente rifiutato, `ai_models` duplicato rifiutato,
  eliminazione di un modello referenziato da un agente rifiutata (restrict), cascata account → modelli.
- [ ] **Step 2:** FAIL. **Step 3:** schema, migrazione, `schema-casello.sql`. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(db): account AI e modelli per account`

### Task 2: Provider, prezzi seed e scoperta dei modelli

**Files:**
- Create: `artifacts/api-server/src/lib/ai/providers.ts`, `artifacts/api-server/src/lib/ai/price-seed.ts`,
  `artifacts/api-server/src/lib/ai/discovery.ts`, `artifacts/api-server/src/lib/ai/discovery.test.ts`,
  `artifacts/api-server/test/fake-provider.ts`

**Interfaces:**
- Produces:
  - `PROVIDERS: Record<AiProvider, { label: string; defaultBaseUrl: string | null; editableBaseUrl: boolean }>`
    con i base URL della spec §3.
  - `validateBaseUrl(url: string, allowPrivate: boolean): string | null` (errore "indirizzo non consentito"):
    `https` obbligatorio salvo `allowPrivate`; con `allowPrivate=false` rifiuta host IP privati/loopback e
    `localhost`.
  - `PRICE_SEED: { provider: AiProvider; modelId: string; input: number; output: number; updated: string }[]`
    con almeno `deepseek-chat` e `deepseek-reasoner` (prezzi USD per milione, valori dal sito DeepSeek alla data).
  - `class ProviderError extends Error { kind: "auth" | "credit" | "rate" | "unreachable" | "no_models" | "bad_url"; status: number | null }`
    con i messaggi fissi della spec.
  - `discoverModels(account: { provider; baseUrl; apiKey: string | null }, fetchImpl?): Promise<DiscoveredModel[]>`
    dove `DiscoveredModel = { modelId; displayName; contextTokens: number | null; priceInput: number | null; priceOutput: number | null; priceSource: "provider" | "seed" | null }`:
    `GET {baseUrl}/models` (Bearer), timeout 15 s, risposta ≤ 2 MB, `redirect: "manual"`; mappa
    `data[].id`, `name`, `context_length`, `pricing.prompt`/`pricing.completion` (OpenRouter: USD per token
    → ×1e6); valori non numerici o negativi → null; prezzi mancanti → seed se presente; massimo 2 000 voci;
    404 su `/models` → `ProviderError("no_models")`; 401/403/402/429/rete → kind corrispondente.
- Produces (`test/fake-provider.ts`): `startFakeProvider(opts)` con `/models` configurabile (con/senza prezzi,
  lista enorme, 404), `/chat/completions` con `usage` configurabile (anche assente), tool calls, stati d'errore,
  ritardo; registro delle richieste con header `authorization`.

- [ ] **Step 1: Test** `discovery.test.ts`: OpenRouter con prezzi (0.00000027 → 0.27 per milione); DeepSeek
  senza prezzi → seed; prezzo `"abc"`/negativo → null; 5 000 modelli → 2 000; 404 → `no_models` con il messaggio
  della spec; 401 → "chiave non valida o senza permessi"; 402 → messaggio credito; redirect non seguito;
  `validateBaseUrl`: `http://x` rifiutato, `https://10.0.0.1` rifiutato senza consenso e accettato con consenso;
  nessun messaggio contiene la chiave o l'URL.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS. **Step 5: Commit**
  `feat(api-server): provider compatibili OpenAI e scoperta dei modelli`

### Task 3: Esecutore unico dei modelli

**Files:**
- Create: `artifacts/api-server/src/lib/ai/executor.ts`, `artifacts/api-server/src/lib/ai/executor.test.ts`
- Modify: `artifacts/api-server/src/lib/ai-gateway.ts` (estrarre i tipi `GatewayMessage`, `ChatResult`,
  `ChatToolCall`, le opzioni `timeoutMs/maxRetries/signal` e la conversione dei tool calls in funzioni
  riusabili; nessun cambiamento di comportamento per chi lo usa ancora)

**Interfaces:**
- Consumes: Task 1 tabelle, Task 2 `PROVIDERS`, `ProviderError`.
- Produces:
  - `type ExecutorKind = "openai_compatible" | "local_agent"` (solo il primo implementato; il secondo lancia
    "esecutore non ancora disponibile").
  - `interface ResolvedModel { aiModelId: number; accountId: number; provider: AiProvider; kind: ExecutorKind; baseUrl: string; apiKey: string | null; modelId: string; priceInput: number | null; priceOutput: number | null; ownerUserId: number | null }`
  - `resolveModel(aiModelId: number, opts: { userId: number | null; mustOwn: boolean }): Promise<ResolvedModel>`:
    carica modello + account; con `mustOwn` l'account deve essere dell'utente o di sistema, altrimenti
    `ProviderError`-like `ModelAccessError` "modello non disponibile"; `system_gateway` usa
    `AI_GATEWAY_BASE_URL`/`AI_GATEWAY_API_KEY` dall'ambiente; decifra la chiave solo qui.
  - `modelChat(resolved: ResolvedModel, opts: ChatOptions): Promise<ChatResult & { costUsd: number | null }>`
    con `ChatOptions = { messages; tools?; maxTokens?; temperature?; signal?; timeoutMs?; maxRetries?; caller: string }`;
    client `openai` con `baseURL` e chiave dell'account (cache dei client per `accountId` + hash della chiave);
    errori HTTP mappati in `ProviderError` (401/403 auth, 402 credit, 429 rate, rete/timeout unreachable o
    timeout invariato: i chiamanti che distinguono il timeout — l'architetto — ricevono l'errore originale del
    SDK per `APIConnectionTimeoutError`).
  - `computeCost(promptTokens: number, completionTokens: number, priceIn: number | null, priceOut: number | null): number | null`.

- [ ] **Step 1: Test** contro il finto provider: `resolveModel` di un account altrui con `mustOwn` → errore;
  account di sistema risolto dalle env; chiave inviata nell'header `Authorization` corretta e mai presente in
  errori; `modelChat` con tool calls restituisce `toolCalls`; costo calcolato (1000 prompt, 500 completion,
  prezzi 0.27/1.10 → 0.00082); `usage` assente → token 0 e costo null (Review Focus 5); 402 → messaggio credito;
  cambio di chiave dell'account → il client successivo usa la nuova chiave.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS + suite completa invariata.
- [ ] **Step 5: Commit** `feat(api-server): esecutore unico dei modelli con costo per chiamata`

### Task 4: Account di sistema e collegamento dei riferimenti esistenti

**Files:**
- Create: `artifacts/api-server/src/lib/ai/system-account.ts`, `artifacts/api-server/src/lib/ai/system-account.test.ts`
- Modify: `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/lib/models.ts` (resta solo come elenco
  dei modelli dell'account di sistema, con commento)

**Interfaces:**
- Consumes: Task 1–3.
- Produces: `ensureSystemAccount(): Promise<{ accountId: number } | null>` — se `AI_GATEWAY_BASE_URL` e
  `AI_GATEWAY_API_KEY` ci sono, crea/aggiorna l'account `system_gateway` "Gateway Casello" (`user_id` null,
  `api_key_enc` null, `status` ok) e un `ai_models` per ogni voce di `AVAILABLE_MODELS` (prezzi dal seed se
  noti); poi imposta `agents.ai_model_id` e `analyses.ai_model_id` dove null e `model` corrisponde; idempotente;
  senza variabili restituisce null e non tocca nulla. Chiamata in `index.ts` all'avvio dopo
  `failInterruptedAnalyses`, errori solo loggati (nome).

- [ ] **Step 1: Test**: con env presenti crea account e modelli; seconda chiamata non duplica; agenti esistenti con
  `model = "openrouter/deepseek-chat"` ottengono il relativo `ai_model_id` (Review Focus 4); agente con modello
  sconosciuto resta null; senza env nessuna riga.
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS. **Step 5: Commit**
  `feat(api-server): account di sistema per la transizione dal gateway`

### Task 5: API degli account e dei modelli

**Files:**
- Create: `artifacts/api-server/src/routes/ai.ts`, `artifacts/api-server/src/routes/ai.test.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/src/routes/models.ts` (alias:
  stessi dati di `GET /ai/models` nel vecchio formato), `lib/api-spec/openapi.yaml` + codegen

**Interfaces:**
- Consumes: Task 1–4, `currentUserId(req)`.
- Produces: route della spec §5 (`/ai/accounts`, `/ai/accounts/:id`, `/verify`, `/default`,
  `/ai/accounts/:id/models`, `/ai/models/:id`, `/ai/models`, `/ai/estimate`), operationId
  `listAiAccounts`, `createAiAccount`, `updateAiAccount`, `deleteAiAccount`, `verifyAiAccount`,
  `setDefaultAiAccount`, `listAiAccountModels`, `addAiAccountModel`, `updateAiModel`, `listAiModels`,
  `estimateAnalysisCost`. Schemi: `AiAccount { id, name, provider, baseUrl, allowPrivateNetwork, isDefault,
  status, lastError, lastCheckedAt, keySet, isSystem, modelCount }` (mai la chiave), `AiModel { id, accountId,
  modelId, displayName, contextTokens, priceInput, priceOutput, priceSource, hidden }`,
  `AiModelGroup { account: AiAccount; models: AiModel[] }` per `GET /ai/models`, `CostEstimate { maxUsd,
  typicalUsd }` (null se prezzi mancanti; massimo = `maxTokens × (0.95 × in + 0.05 × out)/1e6`, tipico = 60%
  del massimo).
- Regole: create → valida base URL, cifra la chiave, `discoverModels`; se `no_models` l'account si salva con
  `status: ok` e zero modelli (aggiunta manuale); altri errori → 400 con il messaggio, nulla salvato. Il primo
  account dell'utente diventa predefinito. Delete: 409 "account usato da: <nomi agenti/analisi>" se un modello è
  referenziato, altrimenti 204. Account di sistema: 403 su modifica/eliminazione. Route su account altrui: 404.

- [ ] **Step 1: Test** `ai.test.ts` (AUTH_DISABLED con utente di sviluppo + un secondo utente inserito a mano):
  creazione e verifica con modelli; chiave mai nelle risposte; isolamento (account dell'altro utente invisibile e
  404); delete in uso → 409 con i nomi (Review Focus 3); predefinito unico; aggiunta manuale e modifica prezzi;
  `GET /ai/models` include sistema + propri, esclude nascosti; stima con prezzi noti e null senza prezzi.
- [ ] **Step 2:** FAIL. **Step 3:** implementare; codegen. **Step 4:** PASS. **Step 5: Commit**
  `feat(api-server): API degli account AI`

### Task 6: Agenti, run e analisi sull'esecutore

**Files:**
- Modify: `artifacts/api-server/src/routes/agents.ts`, `artifacts/api-server/src/routes/analyses.ts`,
  `artifacts/api-server/src/routes/serializers.ts`, `artifacts/api-server/src/lib/run-executor.ts`,
  `artifacts/api-server/src/lib/architect/run-analysis.ts`, `lib/api-spec/openapi.yaml` + codegen
- Test: `artifacts/api-server/src/routes/routes.test.ts`, `analyses.test.ts`, `run-executor.test.ts`,
  `lib/architect/run-analysis.test.ts`

**Interfaces:**
- Consumes: Task 3 `resolveModel`, `modelChat`; Task 5 schemi.
- Produces:
  - Agent: campo `aiModelId: number | null` in risposta e input; al salvataggio, se cambia, deve risolvere con
    `mustOwn: true` per l'utente corrente (400 "modello non disponibile"); se non cambia nessun controllo
    (Review Focus 1). `model` resta in risposta per compatibilità.
  - Run: `run-executor` usa `resolveModel(agent.aiModelId, { userId: null, mustOwn: false })` (chi configura paga)
    e `modelChat`; se `aiModelId` è null usa il comportamento attuale di `aiGateway` (transizione). Somma
    `costUsd` in `runs.cost_usd` (null se una chiamata ha costo null).
  - Analisi: `POST /apps/:id/analyses` e `/zip` accettano `aiModelId` (obbligatorio se `model` assente);
    controllo `mustOwn` per l'utente che avvia; `analyses.ai_model_id` salvato; `run-analysis` usa `modelChat`
    con lo stesso timeout/retry/messaggi della fase 3 (incluso il suggerimento 402) e somma `analyses.cost_usd`.
  - Risposte `Run` e `Analysis` con `costUsd: number | null`.

- [ ] **Step 1: Test**: agente salvato con un modello proprio → ok, con modello dell'altro utente → 400; utente B
  modifica il nome di un agente con il modello di A → 200 e `aiModelId` invariato (Review Focus 1); run con il
  finto provider usa la chiave dell'account dell'agente e salva `cost_usd`; analisi con `aiModelId` proprio →
  completata con costo; con modello altrui → 400; analisi con provider 402 → messaggio credito; agenti senza
  `aiModelId` funzionano come prima.
- [ ] **Step 2:** FAIL. **Step 3:** implementare; codegen. **Step 4:** PASS. **Step 5: Commit**
  `feat(api-server): agenti, run e analisi sugli account AI con costo`

### Task 7: Console

**Files:**
- Create: `artifacts/casello/src/components/account/ai-accounts-section.tsx`,
  `artifacts/casello/src/components/account/ai-account-dialog.tsx`,
  `artifacts/casello/src/components/account/ai-models-table.tsx`,
  `artifacts/casello/src/components/ai/model-picker.tsx`
- Modify: `artifacts/casello/src/pages/account.tsx`, `artifacts/casello/src/components/agents/model-options.ts`
  (sostituito dal picker), `agent-create-dialog.tsx`, `pages/agent-detail.tsx`,
  `components/apps/analyses-card.tsx`, `pages/analysis-detail.tsx`, `pages/run-detail.tsx`

**Comportamento:** spec §5 Console. Picker unico (`ModelPicker value={aiModelId} onChange`) raggruppato per
account con prezzo input/output per milione e badge "sistema"; preselezione dal predefinito; se il modello
corrente non è tra i propri (agente configurato da altri) mostra "modello di un altro utente" in sola lettura
e lo conserva. Sezione Account AI con elenco, dialog di aggiunta/modifica (tipo → base URL precompilato, campo
chiave password mai riempito, `allowPrivateNetwork` solo per custom), "Salva e verifica", errori dell'API nel
toast, azioni Aggiorna modelli / Predefinito / Modifica / Elimina (conferma; 409 mostra i nomi), tabella modelli
con prezzi modificabili e "nascondi". Analisi: stima ("circa X $, massimo Y $") accanto ad "Avvia analisi";
costo nell'elenco e nel dettaglio ("costo parziale" se null con token > 0). Run: costo nel dettaglio.

- [ ] **Step 1:** implementare; typecheck e build della console verdi.
- [ ] **Step 2: Commit** `feat(casello): account AI, scelta del modello con prezzi e costi`

### Task 8: Rilascio e collaudo (controller con Ivan)

**Files:** Modify `CLAUDE.md` (sezioni "Modelli AI", "Dove stanno le cose", "Deploy": account AI, esecutore,
account di sistema, migrazione).

- [ ] **Step 1:** verifica nel browser con il finto provider: aggiunta account, modelli e prezzi, picker,
  analisi con costo, agente con run e costo.
- [ ] **Step 2:** `CLAUDE.md`; PR con migrazione da applicare su Neon prima del merge, nessuna nuova variabile.
- [ ] **Step 3:** collaudo con Ivan: account DeepSeek dalla console (chiave da `platform.deepseek.com`), analisi di
  Mister completata con il costo mostrato.
- [ ] **Step 4: Commit** `docs: CLAUDE.md aggiornato per gli account AI`
