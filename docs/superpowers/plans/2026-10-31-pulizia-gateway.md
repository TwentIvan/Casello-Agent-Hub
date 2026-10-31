# Pulizia del gateway e modelli degli agenti per app — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** l'utente sceglie il modello di ogni agente (con il proprio predefinito come proposta) e Casello perde tutto il codice del gateway LiteLLM e dell'account di sistema.

**Architecture:** `users.default_ai_model_id` + funzione unica `resolveAgentModel` (scelto → predefinito → nessuno) usata da creazione app, approvazione dell'architetto e `POST /agents`; route di mappa per app; poi rimozione di `ai-gateway.ts`, `system-account.ts`, `models.ts`, `/api/models` e dei rami `system_gateway`; migrazione additiva prima del merge e `-post` distruttiva dopo il deploy.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React.

**Spec:** `docs/superpowers/specs/2026-10-31-casello-pulizia-gateway-design.md`

## Global Constraints

- Italiano per commenti, messaggi d'errore e commit (`feat(casello): …` / `chore(casello): …`); identificatori in inglese. Contract-first: OpenAPI poi codegen (generati committati); `parseRequest` / `*Response.parse`.
- Messaggi fissi: 400 «modello non disponibile» (modello non dell'utente, già `MODEL_UNAVAILABLE`); 409 «scegli un modello per l'agente»; 400 «scegli un modello» (analisi cloud senza `aiModelId`).
- Ripiego unico per gli agenti creati: modello scelto → predefinito dell'utente (solo se ancora suo) → nessuno.
- Migrazioni: `docs/migrations/2026-10-pulizia-gateway.sql` (additiva, idempotente, prima del merge) e `docs/migrations/2026-10-pulizia-gateway-post.sql` (distruttiva, idempotente, in transazione, dopo il deploy); `docs/schema-casello.sql` aggiornato; fixture `test/fixtures/schema-pre-pulizia-gateway.sql`; test di entrambe.
- Console: niente scorrimento orizzontale (pagine `max-w-screen-2xl`), solo hook generati.
- Nuove route di impostazioni dell'account: `sessionOnly`.
- `pnpm run typecheck` verde prima di ogni commit.

## Review Focus

1. Predefinito che punta a un modello poi eliminato o a un modello non più dell'utente: si ignora (agente senza modello), mai un modello altrui → test in Task 1.
2. Mappa con un agente di un'altra app o un modello altrui in mezzo a voci valide: 400 e nessuna modifica parziale → test in Task 2.
3. Ripresa di una run in pausa di un agente rimasto senza modello: fallisce con «scegli un modello per l'agente», non con un errore generico → test in Task 3.
4. Script `-post` lanciato con un agente ancora su un modello di sistema: fallisce senza eliminare nulla → test in Task 5.
5. Avvio dell'API su un DB che ha ancora il provider `system_gateway` e l'account di sistema (prima del `-post`): niente errori, la console non li mostra → test in Task 4.

---

### Task 1: Modello predefinito e ripiego per gli agenti creati

**Files:**
- Create: `docs/migrations/2026-10-pulizia-gateway.sql`, `artifacts/api-server/test/fixtures/schema-pre-pulizia-gateway.sql`, `artifacts/api-server/test/migration-pulizia-gateway.test.ts`, `artifacts/api-server/src/lib/ai/default-model.ts`, `artifacts/api-server/src/routes/default-model.test.ts`
- Modify: `docs/schema-casello.sql`, `lib/db/src/schema/users.ts`, `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/routes/apps.ts` (creazione), `artifacts/api-server/src/lib/architect/apply.ts` (agente nuovo), `artifacts/api-server/src/routes/analyses.ts` (`PATCH /analysis-items/:id`), `artifacts/api-server/src/routes/agents.ts` (`POST /agents`), una route per `/account/default-model` (in `routes/ai.ts` o file nuovo `routes/account-model.ts`)

**Interfaces:**
- Produces in `lib/ai/default-model.ts`:
  - `export async function resolveAgentModel(userId: number, chosen: number | null | undefined, executor?: Tx | typeof db): Promise<{ aiModelId: number | null; model: string }>` — `chosen` definito → `chooseOwnModel` (lancia `ModelChoiceError` se non suo); altrimenti predefinito dell'utente se ancora suo; altrimenti `{ aiModelId: null, model: "" }` (il testo storico `agents.model` resta vuoto per gli agenti senza modello). Il `model` restituito è il `modelId` del modello.
  - `export async function getDefaultModel(userId): Promise<number | null>`; `export async function setDefaultModel(userId, aiModelId: number | null): Promise<void>` (lancia `ModelChoiceError` se non suo).
- Produces (OpenAPI): `GET|PUT /account/default-model` (`DefaultModel { aiModelId: integer | null }`), `AppInput.generalAgentAiModelId?: integer | null`, `AnalysisItemUpdate.aiModelId?: integer | null` (usato solo con `status: approved` su un elemento `agent` nuovo).
- Produces (Drizzle): `users.defaultAiModelId: integer("default_ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" })`.
- `applyItem` riceve l'`aiModelId` già risolto per gli agenti nuovi; gli agenti esistenti aggiornati non cambiano modello.

- [ ] **Step 1:** fixture = copia di `docs/schema-casello.sql`. **Step 2: test**: migrazione (colonna nulla, FK set null, idempotente); `default-model.test.ts`: `"imposta e legge il predefinito; modello altrui → 400; null lo toglie"`, `"PUT con un token → 403 solo login"`, `"predefinito eliminato → null"`, `"creazione app: scelto, poi predefinito, poi nessuno"`, `"approvazione di un agente nuovo con aiModelId scelto o predefinito; agente esistente mantiene il modello"`, `"POST /agents senza aiModelId usa il predefinito; con un modello altrui 400"`, `"predefinito non più dell'utente (account di un altro) → agente senza modello"`. **Step 3:** FAIL. **Step 4:** implementa (OpenAPI + codegen). **Step 5:** PASS + typecheck. **Step 6:** commit `feat(casello): modello predefinito e scelta del modello per gli agenti creati`.

### Task 2: Mappa dei modelli per app (API)

**Files:**
- Modify: `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/routes/agents.ts` (o `routes/apps.ts`)
- Test: `artifacts/api-server/src/routes/agent-models.test.ts`

**Interfaces:**
- Produces: `PUT /apps/{id}/agent-models` body `AgentModelAssignments { assignments: [{ agentId: integer, aiModelId: integer | null }] (1..200, agentId unici) }` → 200 `Agent[]` (gli agenti aggiornati); 404 app; 400 agente non dell'app o modello non dell'utente (nessuna modifica: verifica tutto prima, poi una transazione).

- [ ] **Step 1: test**: `"aggiorna più agenti e azzera con null"`, `"agente di un'altra app → 400 senza modifiche"`, `"modello altrui → 400 senza modifiche"`, `"agentId ripetuti → 400"`. **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS. **Step 5:** commit `feat(casello): mappa dei modelli degli agenti di un'app`.

### Task 3: Agenti e analisi senza modello

**Files:**
- Modify: `artifacts/api-server/src/routes/agents.ts` (`POST /agents/:id/runs`), `artifacts/api-server/src/lib/run-executor.ts`, `artifacts/api-server/src/routes/analyses.ts`, `lib/api-spec/openapi.yaml` (`AnalysisStart.model`, query zip `model`, `AgentInput.model`, `AgentUpdate.model` rimossi)
- Test: estendere `src/routes/routes.test.ts` / `agents-ai-models.test.ts` / `analyses.test.ts`

**Interfaces:**
- `export const AGENT_WITHOUT_MODEL = "scegli un modello per l'agente"` in `lib/run-executor.ts`; run di un agente con `ai_model_id` null (e run con `ai_model_id` null) → al trigger 409 senza run; alla ripresa o all'esecuzione la run fallisce con questo messaggio, senza chiamare alcun gateway.
- Analisi cloud: `aiModelId` obbligatorio (400 «scegli un modello»).

- [ ] **Step 1: test**: `"run di un agente senza modello → 409, nessuna run"`, `"ripresa di una run senza modello → failed con il messaggio"`, `"analisi cloud senza aiModelId → 400"`, `"il campo model non è più accettato (ignorato o 400 secondo lo schema)"`. **Step 2:** FAIL. **Step 3:** implementa (togliere `chooseByName` e i rami `aiGateway.chat`). **Step 4:** PASS. **Step 5:** commit `chore(casello): niente più percorso del gateway per run e analisi`.

### Task 4: Rimozione del gateway e dell'account di sistema dal codice

**Files:**
- Delete: `artifacts/api-server/src/lib/ai-gateway.ts` (+ test), `artifacts/api-server/src/lib/ai/system-account.ts` (+ test), `artifacts/api-server/src/lib/models.ts`, `artifacts/api-server/src/routes/models.ts`
- Create: `artifacts/api-server/src/lib/ai/chat-types.ts` (tipi e funzioni condivise spostate senza modifiche: `ChatToolCall`, `ChatResult`, `GatewayMessage`→`ChatMessage`, `GatewayMessageContent`→`ChatMessageContent`, `readUsage`, `applyTools`, `extractToolCalls`, `assistantToolCalls`, `CHAT_REQUEST_TIMEOUT_MS`, `CHAT_MAX_RETRIES`)
- Modify: tutti gli import (`agent-loop.ts`, `providers/*.ts`, `plan-chat/*.ts`, `architect/*.ts`, `ai/executor.ts`, `run-executor.ts`), `src/index.ts` (niente `ensureSystemAccount`), `routes/index.ts`, `routes/ai.ts`, `routes/catalog.ts`, `lib/ai/accounts.ts`, `lib/ai/providers.ts`, `lib/ai/executor.ts` (niente ramo `system_gateway`, `buildProxyParams`, `SYSTEM_UNAVAILABLE`), `lib/catalog/provider-registry-data.ts` (via `system_gateway`), `lib/api-spec/openapi.yaml` (via `/models` e `Model`, `system_gateway` dagli enum se presente), console (`components/account/ai-account-dialog.tsx` e ogni riferimento a `system_gateway`/`useListModels`), CLAUDE.md (sezioni «Modelli AI», «Catalogo», «Deploy»: variabili `AI_GATEWAY_*` tolte; `gateway/` indicato come storico o rimosso dall'elenco)

**Interfaces:**
- Gli account `system_gateway` eventualmente ancora nel DB (prima del `-post`) sono ignorati: esclusi da elenchi, scelte e catalogo con un filtro `provider <> 'system_gateway'` dove oggi c'era `systemConfigured()`, e `resolveModel` li tratta come modello non disponibile.

- [ ] **Step 1: test**: `"GET /api/models → 404"`; `"con account e modelli di sistema nel DB: GET /ai/accounts e /ai/models non li mostrano, resolveModel → modello non disponibile, l'avvio non li ricrea"`; adeguare i test esistenti che usavano l'account di sistema (sostituirli con account dell'utente o rimuoverli se testavano solo il gateway). **Step 2:** FAIL. **Step 3:** rimozione + spostamento tipi + codegen. **Step 4:** suite completa e typecheck verdi; `grep -rn "ai-gateway\|system_gateway\|AI_GATEWAY\|AVAILABLE_MODELS" artifacts lib` restituisce solo migrazioni/fixture storiche e la riga del filtro. **Step 5:** commit `chore(casello): via il gateway LiteLLM e l'account di sistema`.

### Task 5: Migrazione di fine pulizia

**Files:**
- Create: `docs/migrations/2026-10-pulizia-gateway-post.sql`, `artifacts/api-server/test/migration-pulizia-gateway-post.test.ts`
- Modify: `docs/schema-casello.sql` (via la riga `system_gateway` dagli INSERT dei provider)

**Interfaces:**
- Script in transazione: blocco `DO` che solleva un'eccezione se un agente punta a un modello di un account `system_gateway`; poi `DELETE FROM ai_models` dell'account di sistema, `DELETE FROM ai_accounts WHERE provider = 'system_gateway' AND user_id IS NULL`, `DELETE FROM providers WHERE slug = 'system_gateway'`, `DROP TYPE IF EXISTS "public"."ai_provider"`.

- [ ] **Step 1: test** (PGlite proprio, schema attuale + dati): `"elimina account e modelli di sistema; analisi e run tengono nome e costo con ai_model_id nullo"`, `"fallisce senza modifiche se un agente usa un modello di sistema"`, `"è idempotente"`. **Step 2:** FAIL. **Step 3:** script. **Step 4:** PASS. **Step 5:** commit `chore(casello): migrazione di fine pulizia del gateway`.

### Task 6: Console

**Files:**
- Modify: `artifacts/casello/src/pages/account.tsx` (+ componente «Modello predefinito»), `artifacts/casello/src/components/apps/app-form-dialog.tsx` (modello dell'agente generale, solo in creazione), `artifacts/casello/src/components/analysis/item-card.tsx` (scelta del modello sulla scheda di un agente nuovo in attesa; inviata con l'approvazione), `artifacts/casello/src/pages/app-detail.tsx` + nuovo `components/apps/agent-models-card.tsx` (mappa con «Applica a tutti» e «Salva»), segnalazione «nessun modello» nella scheda agente

**Interfaces:**
- Consumes: hook generati di Task 1-2; `ModelPicker` (`components/ai/model-picker.tsx`, `value`/`onChange`), badge di dismissione (`components/ai/model-deprecation-badge.tsx`).

- [ ] **Step 1:** implementa. **Step 2:** typecheck e `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/casello exec vite build` verdi. **Step 3:** prova nel browser (controller). **Step 4:** commit `feat(casello): modelli degli agenti nella console`.
