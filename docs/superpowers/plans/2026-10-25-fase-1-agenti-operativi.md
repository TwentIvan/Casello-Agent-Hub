# Fase 1 – Agenti che agiscono: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gli agenti di Casello chiamano davvero le API delle app attraverso un catalogo di tool per app, con identità utente o di servizio, conferma per le azioni importanti e traccia dei passi visibile nella console.

**Architecture:** catalogo dichiarativo `app_tools` per app; un esecutore HTTP unico che costruisce le richieste solo dal catalogo; un ciclo dell'agente puro (dipendenze iniettate) che alterna modello e tool e si mette in pausa per le conferme; un orchestratore che persiste stato, passi e pause nel DB. La console gestisce catalogo, collegamento all'app e mostra timeline e conferme.

**Tech Stack:** Express 5, Drizzle (Postgres/Neon), OpenAPI + Orval, LiteLLM via SDK `openai`, React + React Query + shadcn/ui, Vitest, Ajv, PGlite (solo test).

**Spec:** `docs/superpowers/specs/2026-10-25-casello-agenti-operativi-design.md` (§4, §5, §8, §9 fase 1, §10)

## Global Constraints

- Lingua: commenti, documentazione e messaggi di commit in italiano; codice e identificatori in inglese.
- `pnpm run typecheck` verde prima di ogni commit; dopo ogni modifica a `openapi.yaml` eseguire `pnpm --filter @workspace/api-spec run codegen` e committare i file generati.
- Frontend: solo hook generati da Orval, mai `fetch` a mano.
- Ogni modifica a `lib/db/src/schema/` va riportata in `docs/schema-casello.sql` e nello SQL di produzione `docs/migrations/2026-10-fase-1.sql`.
- Nuove dipendenze: versioni pubblicate da più di un giorno (`minimumReleaseAge`).
- Limiti (spec §5): 8 giri di tool, 120 s di tempo attivo per turno, 60 000 token per turno (default), 15 s per chiamata HTTP, risposta massima 1 048 576 byte, pausa massima 10 minuti.
- Token dell'utente: mai nel DB né nei log. Segreti: AES-256-GCM con `CASELLO_SECRET_KEY` (64 caratteri esadecimali), obbligatoria con `NODE_ENV=production`.
- L'esecutore raggiunge solo `internalBaseUrl` (o `baseUrl`) + `path` del tool; nessun host, schema o percorso arriva dagli argomenti del modello.
- Tutti i task stanno su un unico branch `feat/agenti-operativi-fase-1` e una sola PR. Dal Task 2 al Task 11 la vecchia tabella `tools` sparisce prima che API e console siano migrate: in quei commit devono essere verdi `pnpm run typecheck:libs` e i test dell'API, mentre il typecheck completo torna obbligatorio dal Task 9 (API) e dal Task 11 (console). **Non fare push prima della fine del Task 11**: il push su `feat/**` avvia la build Docker in CI.
- Nella fase 1 l'App riceve solo i campi di esecuzione (`slug`, `internalBaseUrl`, `userAuth`, `serviceAuth`, segreto di servizio); i campi delle sorgenti dell'architetto arrivano nella fase 3.

## Review Focus

1. Parametro di percorso con `/`, `..`, `?`, `#` o un URL completo (`http://altro`): la richiesta resta sull'host dell'app e il valore è codificato → test in Task 5.
2. `internalBaseUrl` con slash finale o prefisso (`http://mister:3000/api/`) e `path` del tool con slash iniziale: URL unito senza doppio slash né perdita del prefisso → test in Task 5.
3. Il modello chiede un tool inesistente o con argomenti JSON non validi: errore restituito al modello come risultato del tool, il turno continua → test in Task 7.
4. `resume` chiamato due volte, su una run non in pausa o dopo la scadenza: 409, nessuna doppia esecuzione del tool → test in Task 9.
5. Tool con identità `user` senza token utente: risultato di errore "token utente mancante" al modello, non un 500 → test in Task 5 (esecutore) e Task 8 (orchestratore).

---

## File Structure

API (`artifacts/api-server/`):
- `vitest.config.ts`, `test/global-setup.ts` — Vitest con Postgres PGlite e schema caricato.
- `src/lib/secrets.ts` — cifratura dei segreti.
- `src/lib/tools/types.ts` — tipi del catalogo e dei risultati.
- `src/lib/tools/definition.ts` — validazione di definizioni, schemi e argomenti (zod + Ajv).
- `src/lib/tools/executor.ts` — costruzione ed esecuzione delle richieste HTTP.
- `src/lib/tools/catalog.ts` — tool attivi di un agente, conversione in *function calling*, oscuramento dei parametri sensibili.
- `src/lib/ai-gateway.ts` — nuovo metodo `chat` con tool.
- `src/lib/agent-loop.ts` — ciclo modello ↔ tool, puro.
- `src/lib/user-tokens.ts` — token utente in memoria con scadenza.
- `src/lib/run-executor.ts` — orchestrazione: avvio, ripresa, passi, scadenza delle pause.
- `src/routes/apps.ts`, `src/routes/app-tools.ts` (nuovo), `src/routes/agents.ts`, `src/routes/runs.ts`.

DB (`lib/db/src/schema/`): `apps.ts`, `agents.ts`, `runs.ts` (modificati), `app-tools.ts`, `agent-tools.ts`, `run-steps.ts` (nuovi), `tools.ts` (rimosso).

Frontend (`artifacts/casello/src/`):
- `components/apps/app-form-dialog.tsx` — sezione "Collegamento".
- `pages/app-detail.tsx`, `components/apps/tool-catalog.tsx`, `components/apps/app-tool-dialog.tsx` — catalogo.
- `components/agents/agent-tools-section.tsx` — sostituisce `tools-section.tsx` e `tool-form-dialog.tsx` (rimossi).
- `components/runs/run-panel.tsx` — token di prova.
- `components/runs/run-steps.tsx`, `components/runs/confirmation-card.tsx`, `pages/run-detail.tsx` — timeline e conferma.

---

### Task 1: Vitest e cifratura dei segreti

**Files:**
- Create: `artifacts/api-server/vitest.config.ts`, `artifacts/api-server/test/global-setup.ts`, `artifacts/api-server/src/lib/secrets.ts`, `artifacts/api-server/src/lib/secrets.test.ts`
- Modify: `artifacts/api-server/package.json` (script `test`: `vitest run`; devDependencies `vitest`, `@electric-sql/pglite`, `@electric-sql/pglite-socket`), `artifacts/api-server/src/index.ts`, `.github/workflows/deploy.yml`, `CLAUDE.md`

**Interfaces:**
- Produces: `encryptSecret(plain: string): string` (formato `v1:<iv b64>:<tag b64>:<ciphertext b64>`), `decryptSecret(enc: string): string`, `assertSecretKey(): void` (lancia se `CASELLO_SECRET_KEY` manca o non è di 64 caratteri esadecimali).
- Produces: `test/global-setup.ts` avvia un `PGLiteSocketServer` su una porta libera, applica `docs/schema-casello.sql`, imposta `process.env.DATABASE_URL` prima dei worker, e lo chiude in teardown. Se i worker non ereditano la variabile, usare `provide`/`inject` di Vitest e impostarla in un `setupFiles`.

- [ ] **Step 1: Test che falliscono** in `secrets.test.ts`:
  - `cifra e decifra`: `decryptSecret(encryptSecret("segreto"))` è `"segreto"`; due cifrature dello stesso testo sono diverse.
  - `rifiuta un testo manomesso`: cambiare un carattere del ciphertext → `decryptSecret` lancia.
  - `chiave mancante`: senza `CASELLO_SECRET_KEY` → `assertSecretKey()` lancia con un messaggio che contiene `CASELLO_SECRET_KEY`.
  - `chiave non valida`: `"abc"` → lancia.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server run test` → FAIL (modulo inesistente).
- [ ] **Step 3:** Implementare `secrets.ts` con `node:crypto` (`aes-256-gcm`, IV di 12 byte). In `index.ts` chiamare `assertSecretKey()` all'avvio se `NODE_ENV === "production"`.
- [ ] **Step 4:** test → PASS; `pnpm run typecheck` verde.
- [ ] **Step 5:** In `deploy.yml` aggiungere un job `test` (checkout, pnpm 10, Node 24, `pnpm install --frozen-lockfile`, `pnpm --filter @workspace/api-server run test`) e `needs: test` sul job `build`. In `CLAUDE.md` (Comandi e Variabili dell'API) aggiungere `pnpm --filter @workspace/api-server run test` e `CASELLO_SECRET_KEY` (generabile con `openssl rand -hex 32`).
- [ ] **Step 6: Commit** `feat(api-server): Vitest e cifratura dei segreti`

### Task 2: Schema DB della fase 1 e migrazione

**Files:**
- Create: `lib/db/src/schema/app-tools.ts`, `lib/db/src/schema/agent-tools.ts`, `lib/db/src/schema/run-steps.ts`, `docs/migrations/2026-10-fase-1.sql`, `artifacts/api-server/test/migration.test.ts`
- Modify: `lib/db/src/schema/apps.ts`, `agents.ts`, `runs.ts`, `index.ts`; `docs/schema-casello.sql`
- Delete: `lib/db/src/schema/tools.ts`

**Interfaces:**
- Produces (tabelle e colonne, nomi SQL):
  - `apps`: `slug text not null unique`, `internal_base_url text`, `user_auth jsonb` (`{"header": string, "scheme": string|null}`), `service_auth jsonb` (stessa forma), `service_secret_enc text`.
  - enum `tool_kind` (`http`,`ui`,`composite`), `tool_identity` (`user`,`service`), `tool_status` (`draft`,`active`,`disabled`), `agent_role` (`general`,`area`).
  - `app_tools`: `id`, `app_id` fk cascade, `name`, `description`, `kind`, `identity` default `user`, `requires_confirmation bool default false`, `read_only bool default false`, `status` default `draft`, `params_schema jsonb not null default '{"type":"object","properties":{}}'`, `definition jsonb not null`, `evidence jsonb`, `needs_verification bool default false`, `created_at`, `updated_at`; unico (`app_id`,`name`).
  - `agent_tools`: (`agent_id` fk cascade, `tool_id` fk cascade) chiave primaria composta.
  - `agents`: `role agent_role not null default 'area'`, `area text`, `default_identity tool_identity not null default 'user'`; indice unico parziale su `app_id` where `role = 'general'`.
  - `run_status` + `awaiting_client`, `cancelled`; `runs`: `pending_action jsonb`, `loop_state jsonb`, `paused_at timestamp`, `prompt_tokens int`, `completion_tokens int`.
  - `run_steps`: `id`, `run_id` fk cascade, `position int`, `type text` (`model`/`tool`), `tool_name text`, `args jsonb`, `ok bool`, `http_status int`, `duration_ms int`, `error text`, `created_at`.
  - Tipi Drizzle esportati: `AppTool`, `AgentTool`, `RunStep`.
- Migrazione `2026-10-fase-1.sql` (idempotente dove possibile, in una transazione): nuovi enum e colonne; `slug` riempito da `name` (minuscolo, non alfanumerici → `-`, suffisso `-<id>` sui duplicati); ogni riga di `tools` → `app_tools` (`kind='http'`, `status='draft'`, `definition = {"method": http_method, "path": endpoint, "paramLocations": {}}`, `params_schema` = `parameters_schema::jsonb` se valido, altrimenti lo schema vuoto) più il collegamento in `agent_tools`; un agente `general` per ogni app che non lo ha (`name` = nome dell'app + " – generale", `status='draft'`); `drop table tools`.

- [ ] **Step 1: Test che fallisce** `migration.test.ts`: su un DB con lo schema **precedente** (copiare la versione attuale di `docs/schema-casello.sql` in `test/fixtures/schema-pre-fase-1.sql`) con 2 app di nome uguale, 1 agente, 1 tool con `parameters_schema` valido e 1 non valido, applicare `2026-10-fase-1.sql` e verificare: slug distinti; 2 righe in `app_tools` in `draft` con i collegamenti in `agent_tools`; uno schema copiato e uno vuoto; un agente `general` per app; tabella `tools` assente. (Il test usa un DB PGlite separato da quello del global setup.)
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Scrivere gli schemi Drizzle e la migrazione; aggiornare `docs/schema-casello.sql` allo schema finale.
- [ ] **Step 4:** test → PASS; `pnpm run typecheck:libs` verde (vedi Global Constraints per il typecheck completo).
- [ ] **Step 5: Commit** `feat(db): catalogo dei tool per app, ruoli degli agenti e passi delle run`

### Task 3: Contratto OpenAPI e codegen

**Files:**
- Modify: `lib/api-spec/openapi.yaml`, file generati in `lib/api-client-react/src/generated/` e `lib/api-zod/src/generated/`

**Interfaces:**
- Produces (schemi):
  - `App` + `slug`, `internalBaseUrl` (nullable), `userAuth` e `serviceAuth` (`AuthConfig` nullable: `header` string, `scheme` string nullable), `serviceSecretSet` boolean. `AppInput`/`AppUpdate` + `internalBaseUrl`, `userAuth`, `serviceAuth`, `serviceSecret` (string, solo scrittura; `null` in update lo cancella).
  - `ToolKind`, `ToolIdentity`, `ToolStatus`, `AppTool` (tutti i campi di `app_tools` in camelCase), `AppToolInput`, `AppToolUpdate`.
  - `Agent` + `role` (`AgentRole`), `area` (nullable), `defaultIdentity`, `toolIds` (integer[]). `AgentUpdate` + `area`, `defaultIdentity`. `AgentToolsInput` `{ toolIds: integer[] }`.
  - `RunStatus` + `awaiting_client`, `cancelled`; `Run` + `pendingAction` (`PendingAction` nullable: `kind` `confirmation`|`ui`, `toolName`, `args` object, `summary` string), `promptTokens`, `completionTokens` (nullable).
  - `RunStep` (campi di `run_steps`), `RunResume` `{ decision: "approved" | "rejected" }`.
- Produces (operazioni): `listAppTools` GET e `createAppTool` POST `/apps/{id}/tools`; `updateAppTool` PATCH e `deleteAppTool` DELETE `/apps/{id}/tools/{toolId}`; `setAgentTools` PUT `/agents/{id}/tools` (→ `Agent`); `listRunSteps` GET `/runs/{id}/steps`; `resumeRun` POST `/runs/{id}/resume` (202 → `Run`, 409 `ErrorResponse`); `triggerRun` con header facoltativo `X-App-User-Token`; `deleteAgent` documenta 409 per l'agente generale. Rimossi `listTools`, `createTool`, `deleteTool` e gli schemi `Tool`/`ToolInput`.

- [ ] **Step 1:** Modificare `openapi.yaml`; eseguire il codegen.
- [ ] **Step 2:** Verificare che gli hook `useListAppTools`, `useCreateAppTool`, `useUpdateAppTool`, `useDeleteAppTool`, `useSetAgentTools`, `useListRunSteps`, `useResumeRun` esistano e che `triggerRun` accetti gli header (`grep` nei file generati).
- [ ] **Step 3:** `pnpm run typecheck:libs` verde.
- [ ] **Step 4: Commit** `feat(api-spec): contratto del catalogo tool, passi e ripresa delle run`

### Task 4: Validazione di definizioni, schemi e argomenti

**Files:**
- Create: `artifacts/api-server/src/lib/tools/types.ts`, `src/lib/tools/definition.ts`, `src/lib/tools/definition.test.ts`
- Modify: `artifacts/api-server/package.json` (dipendenza `ajv`)

**Interfaces:**
- Produces in `types.ts`: `ToolKind`, `ToolIdentity`, `HttpDefinition { method; path: string; paramLocations: Record<string, "path" | "query" | "body">; responseFields?: string[] }`, `UiDefinition { action: string; args?: Record<string, unknown> }`, `CompositeDefinition { steps: { tool: string; args: Record<string, string> }[]; output: Record<string, string> }`, `CatalogTool` (riga di `app_tools` con `definition` tipizzata), `ToolResult { ok: boolean; status?: number; content: string }`, `AppConnection { baseUrl: string; internalBaseUrl: string | null; userAuth: AuthConfig | null; serviceAuth: AuthConfig | null; serviceSecretEnc: string | null }`, `AuthConfig { header: string; scheme: string | null }`.
- Produces in `definition.ts`:
  - `parseDefinition(kind: ToolKind, definition: unknown): { ok: true; value: HttpDefinition | UiDefinition | CompositeDefinition } | { ok: false; error: string }` (zod).
  - `checkParamsSchema(schema: unknown): string | null` — `null` se è un JSON Schema di tipo `object` compilabile da Ajv, altrimenti il messaggio.
  - `validateArgs(schema: object, args: unknown): string | null` — Ajv con cache per schema; messaggio in italiano con il primo errore.
  - `checkPathPlaceholders(def: HttpDefinition, schema: object): string | null` — ogni `{nome}` nel `path` è un parametro dello schema con location `path`, e viceversa.

- [ ] **Step 1: Test che falliscono** (`definition.test.ts`):
  - `http valida`: `{method:"GET", path:"/api/teams/{teamId}", paramLocations:{teamId:"path"}}` → ok.
  - `http senza path` / `method` sconosciuto → errore.
  - `composite valida` e `ui valida` → ok.
  - `checkParamsSchema` rifiuta `{"type":"array"}` e uno schema con `"type": 5`.
  - `validateArgs` accetta `{teamId: 3}` e rifiuta `{}` quando `teamId` è `required`.
  - `checkPathPlaceholders` segnala `{teamId}` nel path non presente nello schema.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Implementare.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(api-server): validazione delle definizioni dei tool`

### Task 5: Esecutore HTTP

**Files:**
- Create: `artifacts/api-server/src/lib/tools/executor.ts`, `src/lib/tools/executor.test.ts`

**Interfaces:**
- Consumes: Task 1 `decryptSecret`; Task 4 `validateArgs`, tipi.
- Produces:
  - `buildHttpRequest(conn: AppConnection, tool: CatalogTool, args: Record<string, unknown>, userToken?: string): { url: string; init: RequestInit }` — lancia `ToolError` (classe esportata, `message` in italiano) per argomenti non validi, token utente mancante o segreto di servizio mancante.
  - `executeTool(input: { conn: AppConnection; tool: CatalogTool; args: unknown; userToken?: string; fetchImpl?: typeof fetch }): Promise<ToolResult>` — non lancia mai: ogni errore diventa `{ ok: false, content }`. `kind` `ui` → errore "eseguito dal client"; `composite` → errore "tool composti non ancora supportati".
  - Costanti esportate: `TOOL_TIMEOUT_MS = 15_000`, `MAX_RESPONSE_BYTES = 1_048_576`, `MAX_RESULT_CHARS = 20_000`.
- Regole: base = `internalBaseUrl ?? baseUrl` senza slash finale; `path` con i segnaposto sostituiti da `encodeURIComponent(String(valore))`; URL finale costruito con `new URL` e verificato: stessa `origin` della base e `pathname` che inizia con il percorso della base; parametri `query` in `searchParams` (array ripetuti), `body` come JSON (solo per POST/PUT/PATCH); header `Authorization` (o quello di `AuthConfig.header`) = `scheme ? scheme + " " + token : token`; `redirect: "manual"` (un 3xx è un errore); risposta letta a flusso fino a `MAX_RESPONSE_BYTES`; JSON → proiezione su `responseFields` (campi di primo livello, anche su array di oggetti) → stringa troncata a `MAX_RESULT_CHARS`; risposta non 2xx → `{ ok: false, status, content: "HTTP <status>: <testo breve>" }`.

- [ ] **Step 1: Test che falliscono** (`executor.test.ts`, server HTTP locale con `node:http` su porta 0 che registra le richieste):
  - `sostituisce e codifica i parametri di percorso`: `teamId: "../../admin?x=1#y"` → il server riceve `/api/teams/..%2F..%2Fadmin%3Fx%3D1%23y` sull'host dell'app.
  - `un URL completo nel parametro non cambia host`: `teamId: "http://evil.example/"` → richiesta sempre al server locale.
  - `unisce base con prefisso e slash`: base `http://127.0.0.1:<port>/api/`, path `/teams/{id}` → `/api/teams/7`.
  - `query e body`: parametri `query` in querystring, `body` in JSON con `content-type: application/json`.
  - `identità utente`: header `Authorization: Bearer tok-utente`; senza token → `ok: false` con contenuto che contiene `token utente mancante`, nessuna richiesta inviata.
  - `identità servizio`: segreto cifrato con `encryptSecret` → header `X-Api-Key: <segreto>` con `AuthConfig {header:"X-Api-Key", scheme:null}`.
  - `argomenti non validi`: `ok: false`, nessuna richiesta.
  - `timeout`: server che non risponde, `TOOL_TIMEOUT_MS` ridotto via parametro di test → `ok: false` con `timeout`.
  - `risposta troppo grande` (2 MB) → `ok: false`.
  - `redirect` 302 → `ok: false`.
  - `responseFields`: `[{id:1,nome:"Rossi",extra:"x"}]` con `["nome"]` → contenuto `[{"nome":"Rossi"}]`.
  - `errore HTTP`: 404 `{"error":"Squadra non trovata"}` → `{ok:false, status:404}` e contenuto con `Squadra non trovata`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Implementare (timeout con `AbortSignal.timeout`; per i test accettare un'opzione `timeoutMs`).
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(api-server): esecutore HTTP dei tool`

### Task 6: Chiamata al modello con tool

**Files:**
- Modify: `artifacts/api-server/src/lib/ai-gateway.ts`
- Create: `artifacts/api-server/src/lib/ai-gateway.test.ts`

**Interfaces:**
- Produces: `aiGateway.chat(opts: { modelKey: string; messages: ChatCompletionMessageParam[]; tools?: ChatCompletionTool[]; maxTokens?: number; temperature?: number; agentId?: number; caller?: string; signal?: AbortSignal }): Promise<ChatResult>` con `ChatResult { content: string | null; toolCalls: { id: string; name: string; arguments: string }[]; promptTokens: number; completionTokens: number }` (tipi da `openai/resources/chat/completions`). Solo in modalità proxy (`AI_GATEWAY_BASE_URL`); senza proxy e con `tools` non vuoto lancia `Error` "i tool richiedono il gateway LiteLLM (AI_GATEWAY_BASE_URL)"; senza tool ricade su `complete`. `complete` resta invariato.

- [ ] **Step 1: Test che falliscono** con un finto LiteLLM `node:http`: la richiesta contiene `tools` e `tool_choice: "auto"`; una risposta con `tool_calls` viene restituita in `toolCalls`; una risposta testuale in `content`; senza proxy e con tool → errore con `AI_GATEWAY_BASE_URL`.
- [ ] **Step 2:** test → FAIL. **Step 3:** implementare. **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(api-server): chiamata al modello con tool via LiteLLM`

### Task 7: Ciclo dell'agente

**Files:**
- Create: `artifacts/api-server/src/lib/agent-loop.ts`, `src/lib/agent-loop.test.ts`

**Interfaces:**
- Consumes: Task 4 tipi, Task 6 `ChatResult`.
- Produces:
  - `LoopLimits { maxRounds: number; maxActiveMs: number; maxTokens: number }`, `DEFAULT_LIMITS = { maxRounds: 8, maxActiveMs: 120_000, maxTokens: 60_000 }`.
  - `ToolCall { id: string; name: string; arguments: string }`.
  - `LoopState { messages: ChatCompletionMessageParam[]; queue: ToolCall[]; rounds: number; tokens: number; activeMs: number }` (serializzabile in JSON: è il `loop_state` della run).
  - `PendingAction { kind: "confirmation" | "ui"; toolCallId: string; toolName: string; args: Record<string, unknown>; summary: string }`.
  - `StepRecord { type: "model" | "tool"; toolName?: string; args?: unknown; ok: boolean; httpStatus?: number; durationMs: number; error?: string }`.
  - `LoopDeps { chat(messages: ChatCompletionMessageParam[]): Promise<ChatResult>; tools: CatalogTool[]; executeTool(tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult>; onStep(step: StepRecord): Promise<void>; limits?: Partial<LoopLimits>; now?: () => number }`.
  - `LoopOutcome = { type: "finished"; content: string; state: LoopState } | { type: "paused"; pending: PendingAction; state: LoopState } | { type: "failed"; error: string; state: LoopState }`.
  - `runAgentLoop(state: LoopState, deps: LoopDeps): Promise<LoopOutcome>`.
  - `resolvePending(state: LoopState, pending: PendingAction, result: ToolResult): LoopState` — aggiunge il messaggio `tool` per la chiamata in sospeso e la toglie dalla coda.
- Regole: prima svuota la `queue` (chiamate rimaste del messaggio assistente precedente), poi chiama il modello. Per ogni chiamata, nell'ordine: nome sconosciuto o `arguments` non JSON → messaggio `tool` di errore e si prosegue; tool con `requiresConfirmation` o `kind: "ui"` → `paused` con le chiamate successive ancora in `queue`; altrimenti esecuzione. Le chiamate consecutive `readOnly` vengono eseguite in parallelo con `Promise.all`, preservando l'ordine dei messaggi. `summary` = `"<description del tool>: <argomenti in chiave: valore>"`. Superati i limiti → `failed` con messaggio in italiano che nomina il limite.

- [ ] **Step 1: Test che falliscono** (`agent-loop.test.ts`, con `chat` ed `executeTool` finti):
  - `risposta diretta`: nessun tool → `finished` con il testo, un passo `model`.
  - `un giro di tool`: il modello chiede `leggi_rosa`, poi risponde → `finished`; `executeTool` chiamato una volta; passi `model`, `tool`, `model`.
  - `tool sconosciuto`: errore restituito al modello come messaggio `tool`, il turno finisce `finished`.
  - `argomenti JSON non validi`: come sopra.
  - `conferma`: tool con `requiresConfirmation` → `paused` con `pending.kind === "confirmation"`, `executeTool` mai chiamato; dopo `resolvePending` con esito approvato e un nuovo `runAgentLoop` → `finished`.
  - `coda dopo la pausa`: due chiamate nello stesso messaggio, la prima con conferma → dopo la ripresa la seconda viene eseguita prima della nuova chiamata al modello.
  - `parallelo readOnly`: due chiamate `readOnly` partono insieme (verificato con promesse controllate).
  - `limite di giri`: modello che chiede sempre un tool → `failed` dopo 8 giri.
  - `limite di token`: `promptTokens` alti → `failed` con `token`.
- [ ] **Step 2:** test → FAIL. **Step 3:** implementare. **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(api-server): ciclo dell'agente con tool e pausa per conferma`

### Task 8: Orchestrazione delle run

**Files:**
- Create: `artifacts/api-server/src/lib/user-tokens.ts`, `src/lib/tools/catalog.ts`, `src/lib/run-executor.test.ts`, `src/lib/tools/catalog.test.ts`
- Modify: `artifacts/api-server/src/lib/run-executor.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Task 2 tabelle, Task 5 `executeTool`, Task 6 `aiGateway.chat`, Task 7 `runAgentLoop`/`resolvePending`.
- Produces:
  - `user-tokens.ts`: `PAUSE_TTL_MS = 600_000`; `setUserToken(runId: number, token: string): void`, `getUserToken(runId: number): string | undefined`, `clearUserToken(runId: number): void` (scadenza `PAUSE_TTL_MS`).
  - `catalog.ts`: `loadAgentTools(agentId: number): Promise<CatalogTool[]>` (agente `general` → tutti i tool `active` della sua app; `area` → solo quelli collegati e `active`), `toFunctionTools(tools: CatalogTool[]): ChatCompletionTool[]`, `maskSensitiveArgs(tool: CatalogTool, args: unknown): unknown` (proprietà con `"x-sensitive": true` nello schema → `"***"`), `loadAppConnection(appId: number): Promise<AppConnection>`.
  - `run-executor.ts`: `startRun(runId: number, opts?: { userToken?: string }): Promise<void>`, `resumeRun(runId: number, decision: "approved" | "rejected", opts?: { userToken?: string }): Promise<void>` (lancia `ResumeConflictError` se la run non è `awaiting_client`; la transizione `awaiting_client → running` è un `UPDATE … WHERE status = 'awaiting_client' RETURNING`, così una seconda chiamata non trova righe), `expireStalePausedRuns(now?: Date): Promise<number>`, `failInterruptedRuns()` invariata.
- Regole: il contesto di sistema resta quello attuale (app, istruzioni) senza l'elenco testuale dei tool, che ora passano come *function calling*; ogni `StepRecord` diventa una riga `run_steps` (con `maskSensitiveArgs`); a ogni pausa si salvano `loop_state`, `pending_action`, `paused_at` e lo stato `awaiting_client`; alla fine `output`, `prompt_tokens`, `completion_tokens`, `duration_ms`, `finished_at`, `clearUserToken`. Ripresa approvata → `executeTool` della chiamata in sospeso (con il token utente salvato in memoria o quello nuovo di `opts`) → `resolvePending` → `runAgentLoop`. Rifiutata → risultato `{ ok: false, content: "L'utente ha annullato l'azione." }`. In `index.ts` `setInterval(expireStalePausedRuns, 60_000)` con `unref()`.

- [ ] **Step 1: Test che falliscono** (con il DB del global setup e un finto LiteLLM + una finta app `node:http`):
  - `catalog.test.ts`: `general` vede tutti gli `active` e non i `draft`; `area` solo i collegati `active`; `maskSensitiveArgs` oscura `password` marcato `x-sensitive`.
  - `run-executor.test.ts`:
    - `run con tool`: la run finisce `succeeded`, la finta app ha ricevuto la richiesta, ci sono 3 `run_steps`.
    - `token utente non salvato`: run con `userToken: "segreto-utente"` → nessuna colonna di `runs`/`run_steps` contiene `segreto-utente`.
    - `tool user senza token`: il passo `tool` ha `ok = false` ed `error` con `token utente mancante`; la run finisce `succeeded` (il modello spiega).
    - `pausa e ripresa`: tool con conferma → `awaiting_client` con `pending_action`; `resumeRun(id, "approved")` → `succeeded` e la finta app ha ricevuto una sola richiesta; una seconda `resumeRun` lancia `ResumeConflictError`.
    - `rifiuto`: `resumeRun(id, "rejected")` → la finta app non riceve nulla, run `succeeded`.
    - `scadenza`: `paused_at` di 11 minuti fa → `expireStalePausedRuns()` restituisce 1 e la run è `cancelled`.
- [ ] **Step 2:** test → FAIL. **Step 3:** implementare. **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(api-server): orchestrazione delle run con passi, pausa e ripresa`

### Task 9: Route dell'API

**Files:**
- Create: `artifacts/api-server/src/routes/app-tools.ts`, `src/routes/routes.test.ts`
- Modify: `src/routes/apps.ts`, `src/routes/agents.ts`, `src/routes/runs.ts`, `src/routes/index.ts`, `src/routes/dashboard.ts` (se usa `toolsTable`)

**Interfaces:**
- Consumes: Task 3 schemi Zod generati; Task 1 `encryptSecret`; Task 4 validazioni; Task 8 `startRun`, `resumeRun`, `ResumeConflictError`.
- Regole:
  - App: `slug` generato dal nome alla creazione (stessa regola della migrazione, univoco), non modificabile; `serviceSecret` cifrato in `service_secret_enc` e mai restituito (`serviceSecretSet`); alla creazione viene creato in transazione l'agente `general` (`<nome app> – generale`, `draft`).
  - App tools: create/update validano con `parseDefinition`, `checkParamsSchema`, `checkPathPlaceholders` → 400 `{ error }` in italiano; nome duplicato nell'app → 409.
  - Agenti: `POST /agents` crea sempre `role: "area"`; `DELETE` dell'agente `general` → 409 "L'agente generale non si può eliminare"; `PUT /agents/:id/tools` accetta solo tool della stessa app (altrimenti 400), su un `general` → 400; le risposte `Agent` includono `toolIds`.
  - Run: `POST /agents/:id/runs` legge `X-App-User-Token` e chiama `startRun(run.id, { userToken })` in background (come oggi); `POST /runs/:id/resume` → 202 con la run, 409 se `ResumeConflictError`, 404 se non esiste, stesso rate limit delle run; `GET /runs/:id/steps` ordinati per `position`.
- [ ] **Step 1: Test che falliscono** (`routes.test.ts`, app Express su porta 0 con `AUTH_DISABLED=true`): creazione app → `slug` e agente generale presenti, `serviceSecretSet: true` e nessun segreto nella risposta; tool con `{teamId}` non nello schema → 400; nome duplicato → 409; `DELETE` del generale → 409; `PUT /agents/:id/tools` con tool di un'altra app → 400; `resume` su run non in pausa → 409; `resume` due volte di fila su una run in pausa → 202 poi 409.
- [ ] **Step 2:** test → FAIL. **Step 3:** implementare (rimuovere ogni uso di `toolsTable`). **Step 4:** test → PASS; `pnpm run typecheck` verde.
- [ ] **Step 5: Commit** `feat(api-server): route di catalogo, agenti e ripresa delle run`

### Task 10: Console – collegamento all'app e catalogo dei tool

**Files:**
- Create: `artifacts/casello/src/pages/app-detail.tsx`, `src/components/apps/tool-catalog.tsx`, `src/components/apps/app-tool-dialog.tsx`
- Modify: `src/components/apps/app-form-dialog.tsx`, `src/pages/apps.tsx` (nome dell'app → link a `/apps/:id`), `src/App.tsx` (route `/apps/:id`)

**Interfaces:**
- Consumes: hook del Task 3.
- Comportamento:
  - Form app, sezione "Collegamento": indirizzo interno (URL facoltativo), autenticazione utente (header, default `Authorization`; schema, default `Bearer`; attivabile), autenticazione di servizio (header, schema, segreto: campo password che mostra "impostato" se `serviceSecretSet` e invia il valore solo se modificato).
  - Pagina app: intestazione (nome, slug, base URL, indirizzo interno) e catalogo: tabella con nome, tipo, metodo + path, identità, conferma, sola lettura, stato (attiva/disattiva da menu), modifica, elimina con conferma.
  - Dialog tool (fase 1: solo `kind: http` modificabile; `ui` e `composite` mostrati in sola lettura): nome (`snake_case`), descrizione, metodo, path, schema dei parametri (JSON con la validazione già usata per gli strumenti), posizione di ciascun parametro (`path`/`query`/`body`, una riga per proprietà dello schema), campi della risposta da tenere (elenco separato da virgole), identità, richiede conferma, sola lettura, stato. Gli errori 400/409 dell'API compaiono nel toast.
- [ ] **Step 1:** Implementare; `pnpm --filter @workspace/casello run typecheck` verde.
- [ ] **Step 2:** Verifica nel browser con `AUTH_DISABLED=true pnpm run dev` e Postgres locale: creare un'app con segreto (ricaricando la pagina il segreto risulta "impostato" e non compare), creare un tool con `{teamId}` non nello schema (toast 400), un tool valido, disattivarlo, eliminarlo.
- [ ] **Step 3: Commit** `feat(casello): collegamento all'app e catalogo dei tool`

### Task 11: Console – tool degli agenti, token di prova, timeline e conferma

**Files:**
- Create: `artifacts/casello/src/components/agents/agent-tools-section.tsx`, `src/components/runs/run-steps.tsx`, `src/components/runs/confirmation-card.tsx`
- Modify: `src/pages/agent-detail.tsx` (ruolo, area, sezione tool), `src/pages/agents.tsx` (colonna ruolo), `src/components/runs/run-panel.tsx`, `src/pages/run-detail.tsx`, `src/components/run-status-badge.tsx` (stati `awaiting_client` "In attesa di conferma" e `cancelled` "Annullata"), `src/components/runs/run-queries.ts` (`awaiting_client` è uno stato attivo per il polling)
- Delete: `src/components/agents/tools-section.tsx`, `src/components/agents/tool-form-dialog.tsx`

**Interfaces:**
- Consumes: hook del Task 3; `listRefetchInterval`/`isRunActive` esistenti.
- Comportamento:
  - Scheda agente: badge "Generale" o area; il form permette di modificare l'area (solo agenti `area`) e l'identità predefinita; il pulsante "Elimina agente" non c'è per il generale.
  - Sezione tool: per il generale l'elenco (sola lettura) dei tool attivi del catalogo con link alla pagina dell'app; per un agente di area le caselle dei tool del catalogo (i `draft`/`disabled` visibili ma marcati) e "Salva" con `useSetAgentTools`.
  - Pannello Esegui: sezione richiudibile "Token di prova dell'app" (campo password, solo nello stato della pagina) inviato come `X-App-User-Token`.
  - Pagina run: timeline dei passi (`useListRunSteps`, polling come la run): per ogni passo tipo, tool, esito, codice HTTP, durata, argomenti espandibili; se `awaiting_client` con `pendingAction.kind === "confirmation"`, scheda con `summary`, argomenti e i pulsanti "Conferma" / "Annulla" (`useResumeRun`, poi invalidazione di run e passi; il token di prova non serve se la pausa è ancora entro i 10 minuti).
- [ ] **Step 1:** Implementare; typecheck verde.
- [ ] **Step 2:** Verifica nel browser con il finto LiteLLM e una finta app: agente di area con 2 tool, run con tool di lettura (timeline con 3 passi), run con tool che richiede conferma (scheda, "Conferma" → la finta app riceve la scrittura; "Annulla" → nessuna scrittura), run con tool `user` senza token (passo in errore "token utente mancante") e con token di prova (passo ok).
- [ ] **Step 3: Commit** `feat(casello): tool degli agenti, timeline dei passi e conferma delle azioni`

### Task 12: Rilascio e collaudo su Fantamister

**Files:**
- Modify: `CLAUDE.md` (modello di dominio: catalogo per app, ruoli, stati delle run; variabile `CASELLO_SECRET_KEY`; comando di test)

- [ ] **Step 1:** `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test`, `PORT=5173 BASE_PATH=/ pnpm run build` verdi; aggiornare `CLAUDE.md`.
- [ ] **Step 2:** Preparare il testo della PR (Closes della issue della fase 1) con: SQL `docs/migrations/2026-10-fase-1.sql` da applicare su Neon **prima** del merge, nuova variabile `CASELLO_SECRET_KEY` da impostare su Coolify **prima** del merge (altrimenti l'API non parte), prove eseguite.
- [ ] **Step 3:** Dopo il merge, collaudo con Ivan: leggere le route di `TwentIvan/Mister` per scegliere 2-3 tool di lettura (es. rosa e calendario) e uno di scrittura con conferma; configurare su Casello di produzione il collegamento all'app (indirizzo interno Coolify e autenticazione) e i tool; lanciare "Suggerisci la formazione per domenica" e verificare nella timeline le chiamate reali con esito 2xx e una risposta basata sui dati di Mister.
- [ ] **Step 4: Commit** `docs: CLAUDE.md aggiornato per la fase 1`
