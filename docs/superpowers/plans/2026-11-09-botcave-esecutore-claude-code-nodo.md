# Esecutore «Claude Code (nodo)» — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** scegliere un account AI «Claude Code (nodo)» come modello di personaggi, chat e agenti, e far eseguire i loro turni a `casello-nodo` con `claude -p`, che chiama gli strumenti del turno su `/mcp/turn`.

**Architecture:** il turno si accoda in `node_turns`; il nodo lo prende con un long-poll, lancia `claude -p` senza strumenti propri e con un solo server MCP (`/mcp/turn`, token `cat_…` del turno); le tool call arrivano all'API e passano dallo stesso dispatcher dei modelli cloud (registro in memoria); l'esito torna al chiamante come `PlanTurnOutcome` o come esito della run.

**Tech Stack:** Express 5, Drizzle + Postgres (PGlite nei test), Vitest, SDK MCP (`@modelcontextprotocol/sdk`, `Server` di basso livello), OpenAPI + Orval, React (console), Node 24 (`casello-nodo`).

**Spec:** `docs/superpowers/specs/2026-11-09-botcave-esecutore-claude-code-nodo-design.md`

## Global Constraints

- Lingua: commenti, messaggi d'errore, documentazione e commit in italiano; identificatori in inglese. Testi visibili: «Botcave».
- Contract-first: ogni route nuova o cambiata passa da `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Schema DB: ogni modifica in `lib/db/src/schema/`, in `docs/schema-casello.sql` e in `docs/migrations/2026-11-esecutore-nodo.sql` (additiva, idempotente, `ALTER TYPE … ADD VALUE IF NOT EXISTS` fuori da BEGIN/COMMIT).
- Mai nei log: token (`cat_`, `cas_`), hash, prompt, contenuti dei messaggi, argomenti degli strumenti, testo grezzo di `claude`.
- Messaggi d'errore verso l'utente: solo quelli fissi di `NODE_TURN_MESSAGES` (spec §6).
- Valori: long-poll 25 s; prontezza 60 s; presa entro 20 s; lease 2 min; ping ogni 30 s; claim 40/min per nodo; ping 6/min per turno; `/mcp/turn` 60 chiamate/min per turno e al massimo 4 × `maxTurns`; `content` ≤ 20 000; `timeoutMs` 300 000 (Responsabile 600 000); `maxTurns` = giri di oggi + 1 (chat 7, run 9, Responsabile 13); `maxConcurrentTurns` 1..4 default 2; pulizia righe chiuse > 30 giorni; controllo scadenze ogni 5 s.
- Console: solo token di design (niente esadecimali né classi di palette), stati con `Led`, niente scorrimento orizzontale a 1280 px, solo hook Orval.
- `pnpm run typecheck` verde prima di ogni commit.

## Review Focus

- Report del nodo che arriva dopo la scadenza della lease o dopo `cancelRun`: deve rispondere 409 e non riscrivere né la run né il messaggio (test in Task 4 e Task 8).
- Tool call su `/mcp/turn` mentre il turno si sta chiudendo (report appena arrivato): 401, nessuna esecuzione dopo la chiusura (test in Task 5).
- Ripiego dopo che Claude ha già chiamato strumenti (timeout a metà turno): non deve ripartire col modello cloud, per non duplicare le azioni L2 (test in Task 6).
- Nodo vecchio (heartbeat vivo ma nessun long-poll): turno subito al ripiego o con «offline», senza aspettare 20 s (test in Task 6).
- Riavvio dell'API con un turno `running`: turno `failed restart`, token morto, il report del nodo riceve 409 (test in Task 4).

---

### Task 1: Schema e migrazione

**Files:**
- Create: `lib/db/src/schema/node-turns.ts`, `docs/migrations/2026-11-esecutore-nodo.sql`, `artifacts/api-server/test/migration-esecutore-nodo.test.ts`
- Modify: `lib/db/src/schema/ai-accounts.ts`, `lib/db/src/schema/nodes.ts`, `lib/db/src/schema/providers.ts` (enum `provider_protocol`), `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces: `nodeTurnsTable`, `NodeTurn`, `nodeTurnStatusEnum` (`queued|running|done|failed|cancelled|expired`), `nodeTurnConsumerEnum` (`character|plan_chat|team_chat|run`); `aiAccountsTable.nodeId`, `aiAccountsTable.fallbackAiModelId`; `nodesTable.lastTurnPollAt`; valore `claude_code_node` di `provider_protocol`.

- [ ] **Step 1: Test di migrazione** sul modello di `test/migration-nodo-cartelle.test.ts`: applica lo schema prima della modifica, poi il file due volte (idempotenza); verifica colonne `ai_accounts.node_id`, `ai_accounts.fallback_ai_model_id`, `nodes.last_turn_poll_at`, tabella `node_turns` con le colonne della spec §2, indice unico su `turn_token_hash`, indice unico parziale `ai_accounts(node_id) where node_id is not null`, valore enum `claude_code_node`.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server run test -- migration-esecutore-nodo` → FAIL.
- [ ] **Step 3:** scrivere migrazione, schema Drizzle (colonne come nella tabella della spec §2, `cost_usd numeric(12,6)`) e `docs/schema-casello.sql`.
- [ ] **Step 4:** test → PASS; `pnpm run typecheck` verde.
- [ ] **Step 5:** commit `feat(casello): schema dei turni delegati al nodo`.

### Task 2: Provider, `resolveModel` e modelli dell'account nodo

**Files:**
- Modify: `artifacts/api-server/src/lib/catalog/provider-registry-data.ts`, `artifacts/api-server/src/lib/ai/executor.ts`, `artifacts/api-server/src/lib/ai/accounts.ts`
- Create: `artifacts/api-server/src/lib/ai/node-account.ts`, `artifacts/api-server/src/lib/ai/node-account.test.ts`
- Test: `artifacts/api-server/src/lib/ai/executor.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `ExecutorKind = "openai_compatible" | "node"`; `ResolvedModel` aggiunge `nodeId: number | null`, `fallbackAiModelId: number | null` (null per i cloud).
  - `NODE_PROVIDER = "claude_code_node"`, `NODE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const`.
  - `nodeAccountModels(): Promise<DiscoveredModel[]>` — alias (`displayName` `"<alias> (ultimo)"`) + offerte `anthropic` non ritirate di `model_offers` (id e nome del catalogo), prezzi null, `priceSource: null`.
  - `nodeTurnReady(node: { status: string; lastTurnPollAt: Date | null }, now?: Date): boolean` (60 s).
  - `verifyAccount` per il provider nodo: modelli da `nodeAccountModels`, stato `ok` se il nodo è pronto, altrimenti `error` con «nodo offline» / «nodo eliminato»; `supports_tools = true` sui modelli dell'account.

- [ ] **Step 1: Test** `node-account.test.ts`: con un'offerta `anthropic` attiva (`claude-sonnet-5-5`) e una ritirata, `nodeAccountModels()` restituisce i 4 alias più `claude-sonnet-5-5` e non la ritirata; `nodeTurnReady` vero a 59 s, falso a 61 s e con `status: "disabled"`; `verifyAccount` su un account nodo con nodo mai collegato → `status: "error"`, `lastError: "nodo offline"`, modelli comunque scritti. In `executor.test.ts`: `resolveModel` di un modello dell'account nodo → `kind: "node"`, `nodeId`, `fallbackAiModelId`, nessun errore su `base_url` vuoto; `modelChat` con `kind: "node"` lancia.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** voce di registro `{ slug: "claude_code_node", name: "Claude Code (nodo)", protocol: "claude_code_node", defaultBaseUrl: null, litellm: [], openrouterAuthor: null }`; `statusForProtocol("claude_code_node") = "managed"`; `executorKindFor` → `"node"`; `resolveModel` salta validazione indirizzo e chiave per `kind: "node"`; ramo in `verifyAccount`. Il riallineamento a ogni aggiornamento del catalogo viene da sé perché `reverifyAccounts` chiama `verifyAccount`; escludere il provider nodo da ogni elenco di provider proposti per account con chiave (`GET /api/ai/providers` lo espone con `requiresNode: true`).
- [ ] **Step 4:** test → PASS (anche `provider-registry.test.ts`, `catalog` e `ai` esistenti).
- [ ] **Step 5:** commit `feat(casello): account AI di tipo nodo e suoi modelli`.

### Task 3: Route degli account nodo

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (`AiAccount`, `AiAccountCreate`, `AiAccountUpdate`), `artifacts/api-server/src/routes/ai.ts`, generati Orval/Zod
- Test: `artifacts/api-server/src/routes/ai.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: `AiAccountCreate` con `provider: "claude_code_node"` + `nodeId` (obbligatorio per quel provider) + `fallbackAiModelId?`; `AiAccountUpdate.fallbackAiModelId?: number | null`; `AiAccount` aggiunge `nodeId`, `nodeName`, `nodeTurnReady`, `fallbackAiModelId` (null per i cloud). Funzione `validateFallback(userId: number, aiModelId: number | null): Promise<void>` in `node-account.ts` (lancia `HttpError 400`).

- [ ] **Step 1: Test** in `ai.test.ts`: creazione con un proprio nodo attivo → 201, 4+ modelli, nessuna chiave richiesta; nodo altrui o disattivato → 400 «nodo non disponibile»; secondo account sullo stesso nodo → 409 «il nodo ha già un account Claude Code»; `fallbackAiModelId` di un modello dell'account nodo stesso o di un altro utente → 400 «modello di ripiego non valido»; PATCH che toglie il ripiego (`null`) → 200; `GET /api/ai/accounts` riporta `nodeName` e `nodeTurnReady`.
- [ ] **Step 2:** test → FAIL. **Step 3:** contratto, codegen, ramo nelle route POST/PATCH (`baseUrl ""`, `apiKeyEnc null`, nessuna verifica di rete). **Step 4:** test → PASS, typecheck. **Step 5:** commit `feat(casello): creazione e modifica degli account nodo`.

### Task 4: Coda dei turni e protocollo del nodo

**Files:**
- Create: `artifacts/api-server/src/lib/node-turns/` — `messages.ts` (`NODE_TURN_MESSAGES`, `NODE_TURN_ERROR_CODES`), `queue.ts`, `protocol.ts`, `sweeper.ts`, `registry.ts`; test `queue.test.ts`, `protocol.test.ts`
- Modify: `lib/api-spec/openapi.yaml` (`/node/turns/claim`, `/node/turns/{id}/ping`, `/node/turns/{id}/report`), `artifacts/api-server/src/routes/node.ts`, `artifacts/api-server/src/middlewares/rate-limit.ts`, `artifacts/api-server/src/lib/nodes/nodes.ts` (disattiva/elimina/rigenera), `artifacts/api-server/src/index.ts` (avvio e sweeper)
- Test: `artifacts/api-server/src/routes/node.test.ts`

**Interfaces:**
- Consumes: Task 1, `nodeTurnReady` (Task 2).
- Produces:
  - `NODE_TURN_ERROR_CODES = ["model_unavailable", "timeout", "usage_limit", "not_logged_in", "claude_failed", "stopped", "lease_lost", "node_disabled", "restart"] as const`; `type NodeTurnErrorCode`.
  - `registry.ts`: `registerTurn(turnId: number, entry: { tools: ChatCompletionFunctionTool[]; dispatch(call: ChatToolCall): Promise<string>; maxCalls: number }): void`, `turnEntry(turnId): TurnEntry | undefined`, `unregisterTurn(turnId)`.
  - `queue.ts`: `enqueueTurn(input: { nodeId: number; userId: number; aiModelId: number; consumer: NodeTurnConsumer; refId: number; messageId?: number; pkg: TurnPackageBody }): Promise<{ turnId: number; turnToken: string }>` (emette l'avviso); `waitTurn(turnId: number, signal?: AbortSignal): Promise<NodeTurnResult>` dove `NodeTurnResult = { status: "done" | "failed" | "cancelled" | "expired"; content: string | null; errorCode: NodeTurnErrorCode | null; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: string | null }`; `cancelTurn(turnId: number): Promise<void>`; `turnByToken(token: string): Promise<{ id: number; userId: number } | null>` (solo `running` con lease valida).
  - `protocol.ts`: `claimTurn(nodeId: number, waitMs?: number, signal?: AbortSignal): Promise<TurnPackage | null>`, `pingTurn(nodeId, turnId, leaseToken): Promise<{ leaseExpiresAt: Date }>`, `reportTurn(nodeId, turnId, body: NodeTurnReport): Promise<void>` (lanciano `NodeError 409`).
  - `sweeper.ts`: `sweepNodeTurns(now?: Date)`, `startNodeTurnSweeper()`, `failInterruptedNodeTurns()`, `failNodeTurns(tx, nodeId)`.
  - `TurnPackage` come JSON della spec §3; `TurnPackageBody` = pacchetto senza `id`, `leaseToken`, `turnToken`, `mcpUrl` (li aggiunge il claim; `mcpUrl` = `${PUBLIC_APP_URL}/mcp/turn`).

- [ ] **Step 1: Test** (`protocol.test.ts` con orologio iniettato e `node.test.ts` via HTTP):
  - claim con un turno in coda → pacchetto con `turnToken` che inizia con `cat_`, stato `running`, lease +2 min, `last_turn_poll_at` aggiornato;
  - claim senza turni con `waitMs: 200` → null dopo ~200 ms; turno accodato durante l'attesa → restituito prima della scadenza;
  - turno di un altro nodo non preso;
  - report `done` con lease giusta → `waitTurn` risolve con `content`, token e costo, `package` null; secondo report → 409; report con lease sbagliata → 409; `errorCode` sconosciuto → salvato `claude_failed`; token non intero → 400;
  - ping su turno annullato (`cancelTurn`) → 409;
  - `sweepNodeTurns` a +21 s su `queued` → `expired`; lease scaduta → `failed lease_lost`;
  - `failInterruptedNodeTurns` → `queued`/`running` diventano `failed restart`, poi report → 409, `turnByToken` → null;
  - disattivare il nodo → turni `failed node_disabled`;
  - rate limit: 41ª claim in un minuto → 429;
  - `sweepNodeTurns` cancella le righe chiuse da oltre 30 giorni e non quelle di 29;
  - `GET /api/account/nodes` espone `turnReady` (contratto `Node.turnReady`).
- [ ] **Step 2:** test → FAIL. **Step 3:** implementare; l'avviso è un `EventEmitter` per `nodeId`; la presa usa `FOR UPDATE SKIP LOCKED`; route con `parseRequest` e `NodeError` come i compiti. **Step 4:** test → PASS, typecheck. **Step 5:** commit `feat(casello): coda dei turni e protocollo del nodo`.

### Task 5: Server MCP del turno

**Files:**
- Create: `artifacts/api-server/src/lib/mcp/turn-server.ts`, `artifacts/api-server/src/lib/mcp/turn-server.test.ts`
- Modify: `artifacts/api-server/src/app.ts` (monta `/mcp/turn` prima di `/mcp`), `artifacts/api-server/src/lib/mcp/auth.ts` (un `cat_` su `/mcp` è 401)

**Interfaces:**
- Consumes: `turnByToken`, `turnEntry` (Task 4).
- Produces: `mcpTurnRouter(opts?: { rateLimit?: { limit: number; windowMs: number } }): Router`.

- [ ] **Step 1: Test** via HTTP con il client MCP dell'SDK: con un turno `running` registrato (dispatcher finto che restituisce `{"ok":true,"result":1}` per `leggi_x` e `{"ok":false,"error":"no"}` per `rompi`), `tools/list` restituisce esattamente nomi, descrizioni e `inputSchema` registrati; `tools/call leggi_x {"a":1}` → il dispatcher riceve `name: "leggi_x"`, `arguments: '{"a":1}'`, risultato testo senza `isError`; `rompi` → `isError: true`; strumento non registrato → «strumento sconosciuto: …»; token di un turno chiuso (report già arrivato) → 401; `cas_…` o `cao_…` → 401; un `cat_…` su `/mcp` → 401; oltre `maxCalls` → «limite di strumenti del turno raggiunto»; 61ª chiamata in un minuto → 429.
- [ ] **Step 2:** FAIL. **Step 3:** `Server` di basso livello con `ListToolsRequestSchema` / `CallToolRequestSchema`, trasporto stateless come `server.ts`, corpo ≤ 2 MB; il conteggio delle chiamate sta nella voce del registro. **Step 4:** PASS, typecheck. **Step 5:** commit `feat(casello): server MCP del turno delegato`.

### Task 6: `delegateTurn` e chat (personaggi, piano, squadra)

**Files:**
- Create: `artifacts/api-server/src/lib/node-turns/delegate.ts`, `artifacts/api-server/src/lib/node-turns/prompt.ts`, `artifacts/api-server/src/lib/node-turns/chat-turn.ts`, test `delegate.test.ts`, `prompt.test.ts`
- Modify: `artifacts/api-server/src/lib/characters/run-turn.ts`, `artifacts/api-server/src/lib/plan-chat/run-turn.ts`, `artifacts/api-server/src/lib/team-chat/run-turn.ts`
- Test: `artifacts/api-server/src/lib/characters/run-turn.test.ts`

**Interfaces:**
- Consumes: Task 2, 4.
- Produces:
  - `prompt.ts`: `toClaudePrompt(messages: ChatCompletionMessageParam[]): { systemPrompt: string; prompt: string }` — `system` + riga «Gli strumenti di Botcave si chiamano mcp__botcave__<nome>: usa solo quelli.»; gli altri messaggi in ordine come `[utente]\n…` / `[assistente]\n…`, separati da una riga vuota.
  - `delegate.ts`: `delegateTurn(input: DelegateInput): Promise<DelegateOutcome>` con `DelegateInput = { resolved: ResolvedModel; userId: number; consumer: NodeTurnConsumer; refId: number; messageId?: number; messages: ChatCompletionMessageParam[]; tools: ChatCompletionFunctionTool[]; dispatch(call: ChatToolCall): Promise<string>; maxTurns: number; timeoutMs: number; signal?: AbortSignal }` e `DelegateOutcome = { kind: "done"; content: string; tokens: number; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: string | null } | { kind: "fallback"; reason: NodeTurnErrorCode | "offline" | "node_deleted" } | { kind: "failed"; error: string; tokens: number; costUsd: string | null } | { kind: "cancelled" }`. Ripiego solo per `offline`, `node_deleted`, `expired`, `usage_limit`, `not_logged_in`; `done` segna il modello `available`, `model_unavailable` lo segna `unavailable`.
  - `chat-turn.ts`: `runChatTurn(input: { resolved: ResolvedModel; userId: number; consumer: "character" | "plan_chat" | "team_chat"; refId: number; messageId: number; messages; tools; runTool(call: ChatToolCall): Promise<string>; caller: string; budgetCheck(aiModelId: number): Promise<string | null> }): Promise<PlanTurnOutcome>` — cloud → `runPlanTurn` come oggi; nodo → `delegateTurn` (`maxTurns` 7, `timeoutMs` 300 000); su `fallback` con ripiego configurato, usabile e senza tetto raggiunto → `runPlanTurn` col modello di ripiego e suffisso «\n\n_(Claude Code non disponibile: risposta del modello di ripiego)_»; senza → `{ ok: false, error: <messaggio fisso> }`.

- [ ] **Step 1: Test**:
  - `prompt.test.ts`: tre messaggi (system, user dati con `<dati>`, assistant, user) → `systemPrompt` con la riga sugli strumenti, `prompt` con le etichette nell'ordine e i delimitatori intatti.
  - `delegate.test.ts` (con un «nodo finto» che chiama `claimTurn`/`reportTurn` nel test): nodo pronto → `done` con contenuto e costo; nodo mai collegato → `fallback offline` **senza** creare righe in `node_turns`; nessuna presa → `fallback` dopo la scadenza (sweeper con orologio iniettato); report `usage_limit` → `fallback`; report `timeout` dopo una tool call → `failed` «Claude Code non ha risposto in tempo» (nessun ripiego); `signal` annullato → turno `cancelled` e `kind: "cancelled"`; registro tolto in tutti i casi.
  - `run-turn.test.ts` (personaggi): conversazione con modello nodo e nodo finto che chiama `proponi_*` via dispatcher → messaggio dell'assistente con il contenuto riferito, scheda creata, `tokens_used` e `cost_usd` aggiornati; nodo offline con ripiego (provider finto `test/fake-provider.ts`) → risposta col suffisso; senza ripiego → messaggio d'errore «Il nodo «…» è offline: accendilo o scegli un altro modello».
- [ ] **Step 2:** FAIL. **Step 3:** implementare; nei tre `run-turn.ts` sostituire la chiamata a `runPlanTurn` con `runChatTurn` (stessi strumenti e dispatcher di oggi). **Step 4:** PASS (anche i test esistenti di plan-chat e team-chat), typecheck. **Step 5:** commit `feat(casello): turni delle chat delegati al nodo con ripiego`.

### Task 7: `dispatchAgentCall` estratto dal ciclo dell'agente

**Files:**
- Create: `artifacts/api-server/src/lib/agent-dispatch.ts`, `artifacts/api-server/src/lib/agent-dispatch.test.ts`
- Modify: `artifacts/api-server/src/lib/agent-loop.ts`

**Interfaces:**
- Produces: `dispatchAgentCall(call: ToolCall, deps: Pick<LoopDeps, "tools" | "executeTool" | "queueAction" | "onStep">, now?: () => number): Promise<string>` — prepara (`prepareCall` spostata qui ed esportata), esegue o accoda o restituisce l'errore, scrive il passo, restituisce il testo che il modello riceverebbe (risultato, `queuedMessage(n)` o messaggio d'errore). `runAgentLoop` la usa per le chiamate non raggruppate in parallelo.

- [ ] **Step 1: Test** `agent-dispatch.test.ts`: L0 → `executeTool` chiamato, passo `tool ok`; L2 senza `destinatario` → `QUEUE_FIELDS_MISSING`, nessun accodamento; L2 completa → `queueAction` con argomenti senza `destinatario`/`sintesi`, testo `queuedMessage(n)`, passo `queued`; strumento inesistente → «Errore: lo strumento "x" non esiste»; eccezione di `executeTool` → testo d'errore, passo `ok: false`.
- [ ] **Step 2:** FAIL. **Step 3:** estrarre senza cambiare comportamento. **Step 4:** PASS, e i test esistenti di `agent-loop` e `run-executor` restano verdi senza modifiche. **Step 5:** commit `refactor(casello): smistamento delle tool call dell'agente riusabile`.

### Task 8: Run degli agenti sul nodo

**Files:**
- Modify: `artifacts/api-server/src/lib/run-executor.ts`
- Create: `artifacts/api-server/src/lib/run-executor-node.test.ts`

**Interfaces:**
- Consumes: `delegateTurn` (Task 6), `dispatchAgentCall` (Task 7).
- Produces: in `driveLoop`, con `resolved.kind === "node"`, il ramo `driveNodeTurn(ctx, state, writeStep, usage, abort)`; `maxTurns` = `runLimitsFor(agent).maxRounds ?? 8` + 1; `timeoutMs` 600 000 per il `general`, altrimenti 300 000.

- [ ] **Step 1: Test** con nodo finto che, preso il turno, chiama `/mcp/turn` (o direttamente il dispatcher del registro) con una L0 e una L2 completa, poi riferisce `done`:
  - run `succeeded`, `output` = contenuto, passi `tool`, `queued` (voce in «Da confermare» con il numero) e un passo `model` con nota «Claude Code sul nodo «<nome>»», totali di token e costo riferiti;
  - agente con conferma delle scritture: una L1 finisce in coda;
  - `cancelRun` durante il turno → run `cancelled`, turno `cancelled`, report successivo 409, nessuna riscrittura;
  - nodo offline con ripiego → run eseguita col ciclo cloud, passo «Claude Code non disponibile: eseguita con <nome>», `runs.ai_model_id` = ripiego;
  - nodo offline senza ripiego → run `failed` con «Il nodo «…» è offline: accendilo o scegli un altro modello».
- [ ] **Step 2:** FAIL. **Step 3:** implementare (tetto del ripiego con `runBudgetBlock` prima di usarlo). **Step 4:** PASS, typecheck. **Step 5:** commit `feat(casello): run degli agenti delegate al nodo`.

### Task 9: Ciclo dei turni in `casello-nodo`

**Files:**
- Create: `artifacts/casello-nodo/src/turns.ts`, `artifacts/casello-nodo/src/turn-runner.ts`, test `turns.test.ts`, `turn-runner.test.ts`
- Modify: `artifacts/casello-nodo/src/client.ts` (`claimTurn`, `pingTurn`, `reportTurn`), `config.ts` (`maxConcurrentTurns` 1..4, default 2), `loop.ts` (avvia e ferma il ciclo dei turni), `state.ts`/`cli.ts` (`status` mostra i turni), `capabilities.ts` (`NODE_VERSION`), `README.md`

**Interfaces:**
- Consumes: protocollo di Task 4.
- Produces: `runTurn(pkg: TurnPackage, ctx: { config: Config; spawn?: SpawnFn; client: CaselloClient; logger: Logger; signal: AbortSignal; turnsDir: string }): Promise<void>`; `turnArgs(pkg, configPath): string[]`; `classifyTurnError(text: string, timedOut: boolean, aborted: boolean): NodeTurnErrorCode`.

- [ ] **Step 1: Test**:
  - `turnArgs` = `["-p", "--output-format", "json", "--model", m, "--system-prompt", s, "--tools", "", "--strict-mcp-config", "--mcp-config", path, "--allowedTools", "mcp__botcave__*", "--max-turns", String(n), "--permission-mode", "dontAsk"]`; il prompt arriva su stdin;
  - `mcp.json` scritto con permessi 600 e cancellato a fine turno (anche su errore); il token del turno non compare in nessuna riga di log;
  - JSON `{result: "ciao", total_cost_usd: 0.01, usage: {...}, session_id: "s"}` → report `done` con token e costo; `is_error` con testo di limite d'uso → `usage_limit`; testo «not logged in»/«/login» → `not_logged_in`; modello non trovato → `model_unavailable`; timeout → `timeout` dopo SIGTERM/SIGKILL; stop → `stopped`;
  - 409 su ping → `claude` terminato, nessun report;
  - ciclo: con `maxConcurrentTurns: 2` e tre turni disponibili, al più due `runTurn` insieme; 204 → nuova claim subito; errore di rete → attesa 5 s.
- [ ] **Step 2:** `pnpm --filter @workspace/casello-nodo run test` → FAIL. **Step 3:** implementare riusando gruppo di processi e terminazione di `runner.ts`. **Step 4:** PASS, `run build`. **Step 5:** commit `feat(casello-nodo): esecuzione dei turni delegati con claude -p`.

### Task 10: Console

**Files:**
- Modify: `artifacts/casello/src/components/account/ai-account-dialog.tsx`, `ai-accounts-section.tsx`, `nodes-section.tsx`, `artifacts/casello/src/pages/run-detail.tsx` (solo se la nota del passo `model` non compare già dal testo del passo)
- Modify: nessuna modifica al contratto (`Node.turnReady` viene da Task 4)

**Interfaces:**
- Consumes: campi `AiAccount` di Task 3, `Node.turnReady`.

- [ ] **Step 1:** dialogo account: provider «Claude Code (nodo)» mostra la scelta del nodo (solo nodi attivi propri) e del ripiego (modelli dei propri account cloud, «Nessuno»), nasconde chiave e indirizzo. Scheda account: nodo, `Led` `ok`/`idle` da `nodeTurnReady`, ripiego con «Modifica». Nodi: riga «pronto per i turni» con `Led`.
- [ ] **Step 2:** `pnpm --filter @workspace/casello run test` e `pnpm run typecheck` verdi; controllo a 1280 px nel browser locale (nessuna barra orizzontale) in tema chiaro e scuro.
- [ ] **Step 3:** commit `feat(casello): account Claude Code nella console`.

### Task 11: Prova del flusso, documentazione, PR

**Files:**
- Create: `artifacts/api-server/test/node-turn-flow.test.ts`, `artifacts/casello-nodo/test/fake-claude.mjs`
- Modify: `CLAUDE.md` (stato, «Dove stanno le cose», sezione nuova «Esecutore Claude Code (nodo)», schema), `artifacts/casello-nodo/README.md`

- [ ] **Step 1: Test di flusso**: API reale in memoria (PGlite) su una porta locale; il ciclo dei turni di `casello-nodo` con `claudeBin` = `fake-claude.mjs` (legge stdin e `--mcp-config`, chiama davvero `/mcp/turn` con il client MCP: `tools/list`, poi uno strumento, poi stampa il JSON di uscita). Casi: conversazione di Lucius sull'agente → scheda `agent_prompt` creata e risposta salvata; run di un agente → azione L2 in «Da confermare».
- [ ] **Step 2:** test → PASS; tutta la suite: `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello-nodo run test`, `pnpm --filter @workspace/casello run test`, `pnpm run typecheck`.
- [ ] **Step 3: Prova con il `claude` vero**: `AUTH_DISABLED=true pnpm run dev` con un DB di sviluppo, nodo creato in console, `node artifacts/casello-nodo/dist/index.mjs run` in primo piano con la config di prova, account nodo su `haiku`, un messaggio ad Alfred scritto che usa `squadre_stato`; annotare esito, durata e costo per la PR.
- [ ] **Step 4:** aggiornare `CLAUDE.md` e README; commit `docs(casello): esecutore Claude Code sul nodo`.
- [ ] **Step 5:** push del branch, SQL completo della migrazione in chat, link compare precompilato della PR (senza `gh`) con: cosa cambia, come si è provato, migrazione da applicare su Neon PRIMA del merge, nessuna variabile nuova, nodo da aggiornare (`casello-nodo install`) dopo il deploy.
