# Strumenti MCP, livelli d'azione e coda delle conferme — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casello diventa client MCP dei servizi, ogni tool ha un livello L0–L3 e le azioni L2 finiscono in una coda
delle conferme staccata dalla run, decisa con «approva/rifiuta la N»; l'architetto usa l'elenco MCP come fonte.

**Architecture:** gli strumenti MCP sono righe di `app_tools` con `kind = mcp`, sincronizzate da `tools/list`; un
modulo puro calcola i livelli; il ciclo dell'agente non si mette più in pausa ma passa le chiamate L2 a una
dipendenza che le accoda in `pending_actions`; l'approvazione esegue la chiamata fissata con lo stesso esecutore
dei tool, senza modello.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, `@modelcontextprotocol/sdk` 1.32.2 (già
dipendenza), OpenAPI + Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-03-casello-strumenti-mcp-design.md`

## Global Constraints

- Lingua: commenti, messaggi, commit in italiano; identificatori in inglese. Commit `feat(casello): …`.
- `pnpm run typecheck` verde prima di ogni commit; dopo ogni modifica a `openapi.yaml`:
  `pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Ogni modifica a `lib/db/src/schema/` va anche in `docs/schema-casello.sql` e in `docs/migrations/`.
- Livelli: `"L0" | "L1" | "L2" | "L3"`; effettivo = max(`level`, `level_override`); override solo ≥ `level`.
- Chiave dei metadati MCP: `_meta["casello/level"]`; ripiego: `annotations.readOnlyHint === true` → L0, altrimenti L2.
- Migrazione dei tool HTTP: `read_only` → L0, `requires_confirmation` → L2, altrimenti L1 (se entrambi veri → L2).
- `tools/list`: 30 s, massimo 500 strumenti, paginazione seguita. `tools/call`: 15 s, risposta massima 1 048 576 byte.
- Nessun redirect; credenziali rimandate dal servizio sostituite con `***`; mai il testo del servizio nei log.
- Messaggi fissi MCP: «server MCP non raggiungibile», «autenticazione rifiutata dal server MCP», «strumento non
  trovato sul server MCP», «risposta MCP non valida».
- Parametri aggiunti agli L2: `destinatario` (stringa, obbligatorio), `sintesi` (stringa, obbligatorio, max 500).
- Messaggio al modello all'accodamento: `accodata come n. <N>, in attesa di conferma dell'utente`.
- Limiti: 50 voci `pending` per utente («troppe azioni in attesa di conferma»); approve/reject 20/minuto per utente;
  refresh MCP 6/minuto per utente; nota di rifiuto max 500.
- Voce `executing` all'avvio → `failed` con «esito incerto: verifica sul servizio». Run `awaiting_client` all'avvio →
  `cancelled` con «conferma sostituita dalla coda delle azioni».
- Console senza scorrimento orizzontale a 1280 px; solo hook generati da Orval.

## Review Focus

- Un server MCP espone uno strumento con lo stesso nome di un tool HTTP dell'app: il refresh non lo tocca e lo
  conta come `conflicts` (test nel Task 5).
- Il modello manda `destinatario`/`sintesi` a uno strumento non L2, o li omette su uno L2: per i non L2 i due campi
  extra vengono tolti prima della validazione; per gli L2 mancanti è un errore restituito al modello, nessuna voce
  (test nel Task 6).
- Due accodamenti contemporanei dello stesso utente: numeri distinti e consecutivi, nessun errore di unicità che
  arrivi al modello (test nel Task 6).
- Approvazione dopo che l'app ha perso `mcp_url` o il server non risponde: voce `failed` col messaggio fisso,
  nessun 500 (test nel Task 7).
- Argomenti `x-sensitive` di una voce: mai in chiaro in `args_public`, nei passi della run o nelle risposte API;
  in chiaro solo cifrati in `args_enc` (test nel Task 6 e nel Task 7).

---

## File

- `lib/db/src/schema/app-tools.ts`, `apps.ts`, `runs.ts`, nuovo `pending-actions.ts`, `index.ts` — dati.
- `docs/migrations/2026-11-strumenti-mcp.sql`, `…-post.sql`; `docs/schema-casello.sql`.
- `artifacts/api-server/src/lib/tools/levels.ts` (nuovo, puro) — livelli.
- `artifacts/api-server/src/lib/tools/mcp-client.ts` (nuovo) — `tools/list` e `tools/call`.
- `artifacts/api-server/src/lib/tools/mcp-sync.ts` (nuovo) — allineamento del catalogo.
- `artifacts/api-server/src/lib/actions/text-check.ts` (nuovo, puro), `queue.ts` (accodamento), `decide.ts`
  (approva/rifiuta, ripristino all'avvio).
- `artifacts/api-server/src/lib/agent-loop.ts`, `run-executor.ts`, `user-tokens.ts`, `tools/catalog.ts`,
  `tools/executor.ts`, `tools/definition.ts`, `tools/types.ts`.
- `artifacts/api-server/src/routes/pending-actions.ts` (nuovo), `apps.ts`, `app-tools.ts`, `runs.ts`, `index.ts`;
  `src/index.ts` (avvio); `middlewares/rate-limit.ts`.
- `artifacts/api-server/src/lib/architect/` — `sources.ts` o nuovo `mcp-source.ts`, `phase-loop.ts`, `schemas.ts`,
  `prompts.ts`, `apply.ts`, `diff.ts`, `run-analysis.ts`, `local-executor.ts`; `lib/mcp/server.ts`.
- `artifacts/api-server/test/fake-mcp.ts` (nuovo) — server MCP finto.
- `lib/api-spec/openapi.yaml` + codegen.
- `artifacts/casello/src/` — `components/apps/` (MCP e catalogo), `pages/pending-actions.tsx` (nuova), menu,
  `pages/run-detail.tsx`, `components/runs/` (via `confirmation-card.tsx`), `components/analysis/item-card.tsx`,
  `components/agents/agent-tools-section.tsx`, `run-status-badge.tsx`.
- `CLAUDE.md`, `docs/skills/casello-architetto-locale/SKILL.md`.

---

### Task 1: Dati e migrazione additiva

**Files:**
- Modify: `lib/db/src/schema/app-tools.ts`, `lib/db/src/schema/apps.ts`, `lib/db/src/index.ts` (o l'indice degli schemi)
- Create: `lib/db/src/schema/pending-actions.ts`, `docs/migrations/2026-11-strumenti-mcp.sql`,
  `artifacts/api-server/test/migration-strumenti-mcp.test.ts`
- Modify: `docs/schema-casello.sql`

**Interfaces:**
- Produces: `toolLevelEnum` (`tool_level`: `L0`..`L3`); `app_tools.level` (not null, default `L2`),
  `app_tools.level_override` (nullable); `tool_kind` con `mcp`; `apps.mcp_url` (text nullable);
  `pendingActionsTable` / tipo `PendingActionRow` con le colonne della spec §5 (`status` enum
  `pending_action_status`: `pending|executing|done|failed|rejected`); unico (`user_id`, `number`), indice
  (`user_id`, `status`). FK: `user_id` → users cascade, `app_id` → apps cascade, `tool_id` → app_tools cascade,
  `agent_id` → agents set null, `run_id` → runs set null, `decided_by` → users set null.
- I due flag restano nello schema Drizzle fino al Task 2 (colonne ancora presenti).

- [ ] **Step 1: test della migrazione** — sul modello di `test/migration-token-api.test.ts`: copia
  `docs/schema-casello.sql` di prima del task in `test/fixtures/schema-pre-strumenti-mcp.sql`, la applica, inserisce tool con (`read_only`, `requires_confirmation`) = (t,f), (f,t), (t,t), (f,f),
  esegue lo script due volte e verifica: livelli `L0`, `L2`, `L2`, `L1`; `level_override` null; `apps.mcp_url`
  esiste; `pending_actions` esiste con l'unico su (`user_id`, `number`); seconda esecuzione senza errori e senza
  ricalcolare livelli già impostati.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server run test -- migration-strumenti-mcp` → FAIL.
- [ ] **Step 3:** scrivere lo script (idempotente: `ADD VALUE IF NOT EXISTS`, `CREATE TYPE` dentro un blocco `DO`
  con controllo su `pg_type`, `ADD COLUMN IF NOT EXISTS`, travaso solo se la colonna `level` è stata appena creata
  — es. aggiunta nullable, `UPDATE … WHERE level IS NULL`, poi `SET NOT NULL` e `SET DEFAULT 'L2'`), lo schema
  Drizzle e `docs/schema-casello.sql`. Nota: `ALTER TYPE … ADD VALUE` non può essere usato nella stessa transazione
  che usa il valore: lo script non usa `mcp` dopo averlo aggiunto.
- [ ] **Step 4:** test della migrazione e suite completa dell'API → PASS; `pnpm run typecheck` verde.
- [ ] **Step 5: Commit** `feat(casello): livelli dei tool, server MCP dell'app e coda delle azioni nello schema`

### Task 2: Livelli nel catalogo e nelle API dei tool

**Files:**
- Create: `artifacts/api-server/src/lib/tools/levels.ts`, `levels.test.ts`
- Modify: `lib/db/src/schema/app-tools.ts` (via i due flag dal Drizzle), `src/lib/tools/catalog.ts`,
  `src/lib/tools/types.ts`, `src/lib/tools/definition.ts`, `src/routes/app-tools.ts`, `src/routes/serializers.ts`,
  `src/routes/apps.ts`, `lib/api-spec/openapi.yaml` (+ codegen), test esistenti che usano i flag
  (`catalog.test.ts`, `routes.test.ts`, `agent-loop.test.ts` solo dove costruiscono tool).

**Interfaces:**
- Produces in `levels.ts`:
  - `type ToolLevel = "L0" | "L1" | "L2" | "L3"`; `TOOL_LEVELS: readonly ToolLevel[]`
  - `effectiveLevel(tool: { level: ToolLevel; levelOverride: ToolLevel | null }): ToolLevel`
  - `isValidOverride(declared: ToolLevel, override: ToolLevel | null): boolean` (null ammesso; altrimenti ≥ declared)
  - `declaredLevelFromMcp(tool: { _meta?: unknown; annotations?: { readOnlyHint?: boolean } }): ToolLevel`
- `CatalogTool` espone `level`, `levelOverride` (non più `readOnly`/`requiresConfirmation`).
- `loadAgentTools` offre i tool `active` con `kind in ('http','mcp')` e livello effettivo diverso da `L3`.
- `parseDefinition("mcp", def)` accetta solo `{ mcpName: string non vuota }`.
- OpenAPI: `AppTool` e input dei tool con `level` (sola lettura per i tool MCP: dichiarato dal servizio) e
  `levelOverride`; `kind` include `mcp`; via `readOnly`/`requiresConfirmation`. Un tool HTTP creato a mano ha
  `level` scelto dall'utente (default `L2`); un override sotto il `level` → 400 «il livello può solo essere alzato».
  `App`/`AppInput`/`AppUpdate` con `mcpUrl` (nullable) validato come `baseUrl` (stessa `parseAppBaseUrl`).

- [ ] **Step 1: test puri** in `levels.test.ts`: `effectiveLevel` ({L1,null}→L1, {L1,L3}→L3); `isValidOverride`
  (L2,L1 → false; L2,L2 → true; L2,null → true); `declaredLevelFromMcp` (`_meta {"casello/level":"L3"}`→L3;
  `"L9"` con `readOnlyHint: true` → L0; nessun metadato → L2; `_meta` non oggetto → L2).
- [ ] **Step 2: test del catalogo e delle route** — `loadAgentTools` esclude un tool L0 con override L3 e include
  un tool `mcp` attivo; `PATCH` di un tool con override sotto il livello → 400 col messaggio; `POST /apps` con
  `mcpUrl: "http://example.com/mcp"` → 400 come per `baseUrl`; la risposta dei tool contiene `level` e
  `levelOverride` e non i due flag.
- [ ] **Step 3:** FAIL, poi implementazione; aggiornare i test esistenti che costruiscono tool con i flag.
- [ ] **Step 4:** codegen, suite API e `pnpm run typecheck` → verdi (la console può ancora usare i flag generati:
  se il typecheck del frontend fallisce, sostituire `readOnly`/`requiresConfirmation` con `level` nei componenti
  toccati in modo minimo; la UI vera arriva nel Task 9).
- [ ] **Step 5: Commit** `feat(casello): livelli L0-L3 al posto dei flag dei tool`

### Task 3: Controllo dei testi da accodare

**Files:**
- Create: `artifacts/api-server/src/lib/actions/text-check.ts`, `text-check.test.ts`

**Interfaces:**
- Produces: `checkQueuedText(input: { recipient: string; summary: string; args: Record<string, unknown> }): string[]`
  — elenco dei problemi (vuoto = ok), ognuno nella forma `segnaposto "<testo>"` o `menzione "@nome" non nel
  destinatario`; controlla `summary` e ogni valore stringa annidato in `args` (oggetti e array).

- [ ] **Step 1: test** — trova `[data da concordare]`, `[nome]`, `<da definire>`, `TODO`, `TBD`, `XXX`, `???`;
  non segnala `[]`, `[1]` (dentro le parentesi serve almeno una lettera), `<br>`, `<b>`, `<p>`; `@mario` non segnalato se `recipient` contiene `mario`
  (senza distinzione di maiuscole), segnalato altrimenti; un'email `a@b.it` non è una menzione (la menzione è `@`
  a inizio parola, preceduta da spazio, inizio stringa o punteggiatura); valori annidati controllati.
- [ ] **Step 2:** FAIL → implementare → PASS.
- [ ] **Step 3: Commit** `feat(casello): controllo di segnaposto e menzioni prima di accodare`

### Task 4: Client MCP ed esecuzione dei tool `mcp`

**Files:**
- Create: `artifacts/api-server/src/lib/tools/mcp-client.ts`, `mcp-client.test.ts`, `artifacts/api-server/test/fake-mcp.ts`
- Modify: `artifacts/api-server/src/lib/tools/executor.ts`, `types.ts`, `catalog.ts` (`loadAppConnection` con `mcpUrl`)

**Interfaces:**
- `AppConnection` aggiunge `mcpUrl: string | null`.
- Produces in `mcp-client.ts`:
  - `MCP_LIST_TIMEOUT_MS = 30_000`, `MCP_MAX_TOOLS = 500`, `MCP_MESSAGES` (i quattro messaggi fissi)
  - `resolveMcpEndpoint(conn: AppConnection): URL | null` — `mcpUrl`, oppure, se c'è `internalBaseUrl`, origine
    interna + path di `mcpUrl`; null se l'app non ha `mcpUrl`.
  - `mcpAuthHeaders(conn, identity: "user" | "service", userToken?: string): { headers: Record<string,string>; secrets: string[] }`
    (riusa le regole di `buildHttpRequest` per header e scheme).
  - `listMcpTools(conn: AppConnection, opts?: { fetchImpl?; timeoutMs? }): Promise<McpToolInfo[]>` con
    `McpToolInfo = { name; description: string | null; inputSchema: Record<string, unknown>; level: ToolLevel }`;
    usa sempre l'identità di servizio se l'app ha il segreto, altrimenti nessuna credenziale; lancia `McpError`
    (`message` ∈ `MCP_MESSAGES`) se il server non risponde, rifiuta (401/403), risponde male o supera 500 strumenti.
  - `callMcpTool(input: { conn; tool: CatalogTool; args: Record<string, unknown>; userToken?; fetchImpl?; timeoutMs?; signal? }): Promise<ToolResult>`
- `executeTool` instrada `kind === "mcp"` su `callMcpTool` dopo la stessa validazione degli argomenti.
- Il client usa `Client` + `StreamableHTTPClientTransport` dell'SDK con un `fetch` che impone `redirect: "manual"`
  (un 3xx → «server MCP non raggiungibile»), il timeout e il limite di 1 048 576 byte sulla risposta.
- `fake-mcp.ts`: `startFakeMcp(opts: { tools: FakeTool[]; requireAuth?: { header: string; value: string } }): Promise<{ url: string; calls: { name: string; args: unknown; headers: Record<string,string> }[]; setTools(t: FakeTool[]): void; close(): Promise<void> }>`
  basato su `McpServer` dell'SDK su un server HTTP locale (porta 0); `FakeTool` permette di impostare risposta
  testuale, `structuredContent`, `isError`, ritardo e dimensione della risposta.

- [ ] **Step 1: test** — `listMcpTools` legge nomi, schemi e livelli (uno con `_meta` L1, uno con `readOnlyHint`,
  uno senza); più di 500 → `McpError` «risposta MCP non valida»; credenziale errata → «autenticazione rifiutata dal
  server MCP»; porta chiusa → «server MCP non raggiungibile»; `callMcpTool` con identità `service` manda l'header di
  servizio e con `user` il token dell'utente; testo + `structuredContent` → contenuto concatenato; blocco immagine
  → `[contenuto image omesso]`; `isError` → `ok: false`; risposta di 2 MB → `ok: false` «risposta troppo grande
  (oltre 1048576 byte)»; ritardo oltre il timeout → `ok: false` timeout; il segreto rimandato nel testo diventa
  `***`; `resolveMcpEndpoint` con `internalBaseUrl` `http://svc:5000` e `mcpUrl` `https://x.it/mcp` →
  `http://svc:5000/mcp`.
- [ ] **Step 2:** FAIL → implementare → PASS; `pnpm run typecheck`.
- [ ] **Step 3: Commit** `feat(casello): client MCP per elencare ed eseguire gli strumenti dei servizi`

### Task 5: «Aggiorna strumenti»

**Files:**
- Create: `artifacts/api-server/src/lib/tools/mcp-sync.ts`, `mcp-sync.test.ts`
- Modify: `artifacts/api-server/src/routes/app-tools.ts`, `middlewares/rate-limit.ts`, `lib/api-spec/openapi.yaml` (+ codegen)

**Interfaces:**
- Consumes: `listMcpTools`, `McpError` (Task 4); `effectiveLevel` (Task 2).
- Produces: `syncMcpTools(appId: number, tools: McpToolInfo[]): Promise<McpSyncResult>` con
  `McpSyncResult = { added: number; updated: number; disabled: number; unchanged: number; conflicts: string[] }`,
  in una transazione: nuovi → `kind mcp`, `status draft`, `definition {mcpName}`, `identity` `service` se l'app ha il
  segreto altrimenti `user`; esistenti `mcp` → descrizione, `params_schema`, `level` aggiornati (override azzerato
  se ora < `level`; `status` invariato, tranne un `disabled` per sparizione che ricompare: resta `disabled`);
  `mcp` assenti dall'elenco → `disabled`; nome uguale a un tool non `mcp` → nessuna modifica, nome in `conflicts`.
- Route `POST /api/apps/:id/mcp-tools/refresh` (proprietario dell'app, `mcpRefreshRateLimit` 6/min per utente):
  200 con `McpSyncResult`; app senza `mcpUrl` → 409 «l'app non ha un server MCP»; `McpError` → 502 col messaggio.

- [ ] **Step 1: test** — con `fake-mcp`: prima sincronizzazione (3 `added`, tutti `draft`); secondo giro con uno
  cambiato, uno sparito, uno nuovo → conteggi giusti, lo sparito `disabled`; un override L2 resta se il nuovo
  `level` è L1 o L2 e si azzera se il nuovo `level` è L3; conflitto con un tool HTTP omonimo → `conflicts: ["nome"]` e tool HTTP invariato; route:
  409 senza `mcpUrl`, 502 con server spento, 404 per l'app di un altro utente.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): aggiornamento del catalogo dagli strumenti MCP dell'app`

### Task 6: Accodamento delle azioni L2 e fine della pausa

**Files:**
- Create: `artifacts/api-server/src/lib/actions/queue.ts`, `queue.test.ts`
- Modify: `artifacts/api-server/src/lib/agent-loop.ts` (+ test), `run-executor.ts` (+ test), `user-tokens.ts`,
  `tools/catalog.ts` (`toFunctionTools`), `routes/runs.ts`, `src/index.ts`, `lib/api-spec/openapi.yaml` (+ codegen),
  `lib/db/src/schema/runs.ts` (via `pendingAction`, `loopState`, `pausedAt` dal Drizzle; le colonne restano nel DB)

**Interfaces:**
- Consumes: `checkQueuedText` (Task 3), `effectiveLevel` (Task 2), `pendingActionsTable` (Task 1), `encryptSecret`.
- `toFunctionTools` aggiunge ai tool L2 le proprietà `destinatario` (`string`) e `sintesi` (`string`,
  `maxLength: 500`) in `properties` e in `required`, con descrizioni in italiano.
- `LoopDeps` perde la pausa e aggiunge `queueAction(tool: CatalogTool, args: Record<string, unknown>, recipient: string, summary: string): Promise<{ ok: true; number: number } | { ok: false; message: string }>`.
  Il ciclo: per un tool L2 toglie `destinatario`/`sintesi` dagli argomenti (mancanti o non stringa → errore al
  modello «servono destinatario e sintesi per un'azione da confermare»), valida gli argomenti restanti con lo schema
  del tool, chiama `queueAction` e restituisce al modello il messaggio di accodamento o `message`; per i non L2 toglie
  i due campi se presenti ed esegue. `StepRecord.type` aggiunge `"queued"` con `queuedNumber?: number`.
  Spariscono `PendingAction`, `resolvePending`, `PendingMismatchError`, l'esito `paused`; `isParallelSafe` = livello
  effettivo L0 e `kind` `http` o `mcp`.
- Produces in `queue.ts`: `MAX_PENDING_PER_USER = 50`;
  `enqueueAction(input: { userId: number; appId: number; agentId: number | null; runId: number | null; tool: CatalogTool; args: Record<string, unknown>; recipient: string; summary: string }): Promise<{ ok: true; number: number } | { ok: false; message: string }>`
  — controllo testi (problemi → `testo non pronto: <problemi separati da "; ">`), limite delle 50, numero =
  max(`number`) dell'utente + 1 con nuovo tentativo (fino a 5) su violazione dell'unico, `args_enc` =
  `encryptSecret(JSON.stringify(args))`, `args_public` = argomenti oscurati con `maskArgsWithSchema`.
- `run-executor`: `queueAction` collegato a `enqueueAction` con l'utente proprietario dell'agente; passo `queued`
  scritto con il numero e gli argomenti oscurati; il token dell'utente resta in memoria solo per la durata della run
  (`user-tokens.ts` senza `PAUSE_TTL_MS`: si cancella a fine run). Spariscono `claimResume`, `resumeRun`,
  `expireStalePausedRuns`, `REJECTED_ACTION_MESSAGE`, `PAUSE_EXPIRED_MESSAGE` e la route `POST /runs/:id/resume`
  (OpenAPI: via `resumeRun`, `PendingAction`, `PendingActionKind`, `pendingAction` di `Run`; `awaiting_client` resta
  nell'enum di `RunStatus` solo per le run storiche).
- `failInterruptedRuns` chiude anche le `awaiting_client` come `cancelled` con «conferma sostituita dalla coda delle azioni».
- Passo `queued` in `run_steps`: nessuna colonna nuova; `args` del passo = `{ numero, destinatario, sintesi, argomenti }` con gli argomenti oscurati.

- [ ] **Step 1: test del ciclo** (`agent-loop.test.ts`) — chiamata a un tool L2 con destinatario e sintesi →
  `queueAction` chiamata con gli argomenti senza i due campi, messaggio al modello `accodata come n. 7, in attesa di
  conferma dell'utente`, `executeTool` mai chiamata, passo `queued`; L2 senza `sintesi` → errore al modello e nessuna
  `queueAction`; tool L1 con `destinatario` superfluo → eseguito senza quel campo; `queueAction` che risponde
  `ok: false` → il testo arriva al modello; due chiamate L0 in parallelo, una L1 in sequenza.
- [ ] **Step 2: test della coda** (`queue.test.ts`) — numerazione 1, 2, 3 per utente e indipendente tra utenti;
  `Promise.all` di due `enqueueAction` dello stesso utente → numeri 1 e 2; 51ª voce → «troppe azioni in attesa di
  conferma»; testo con `[data da concordare]` → `testo non pronto: …` e nessuna riga; argomento `x-sensitive` →
  `***` in `args_public` e in chiaro dopo `decryptSecret(args_enc)`.
- [ ] **Step 3: test dell'orchestrazione** (`run-executor.test.ts`, con il modello finto già usato nei test) — run
  con una chiamata L2 → run `succeeded`, una voce `pending` collegata alla run, passo `queued`; la risposta di
  `GET /runs/:id/steps` non contiene valori sensibili; `failInterruptedRuns` porta una run `awaiting_client` a
  `cancelled` col messaggio; `POST /api/runs/1/resume` → 404. Togliere i test della pausa.
- [ ] **Step 4:** FAIL → implementare → PASS; codegen; suite API; typecheck (nel frontend togliere l'uso di
  `resumeRun` e `pendingAction` in modo minimo; la UI vera nel Task 9).
- [ ] **Step 5: Commit** `feat(casello): le azioni L2 vanno in coda, via la pausa delle run`

### Task 7: Approvare e rifiutare

**Files:**
- Create: `artifacts/api-server/src/lib/actions/decide.ts`, `decide.test.ts`, `artifacts/api-server/src/routes/pending-actions.ts`, `pending-actions.test.ts`
- Modify: `routes/index.ts`, `middlewares/rate-limit.ts`, `src/index.ts`, `lib/api-spec/openapi.yaml` (+ codegen)

**Interfaces:**
- Consumes: `executeTool` (con `kind` `mcp` dal Task 4), `loadAppConnection`, `effectiveLevel`, `decryptSecret`.
- Produces in `decide.ts`:
  - `approveAction(userId: number, number: number, opts: { userToken?: string }): Promise<DecideResult>`
  - `rejectAction(userId: number, number: number, note: string | null): Promise<DecideResult>`
  - `DecideResult = { ok: true; action: PendingActionRow } | { ok: false; status: 400 | 404 | 409; message: string }`
  - `failInterruptedActions(): Promise<number>` — `executing` → `failed` «esito incerto: verifica sul servizio».
  - Messaggi: 404 «azione non trovata»; 409 «azione già decisa»; 409 «lo strumento non può più essere eseguito da
    Casello» (tool `disabled`, cancellato o livello effettivo L3); 400 «serve il token dell'utente dell'app».
  - Ordine di `approveAction`: carica la voce dell'utente (404) → `status` `pending` (409 altrimenti) → tool e livello
    (409) → token se identità `user` (400) → UPDATE condizionato `pending`→`executing` con `decided_by`/`decided_at`
    (0 righe → 409 «azione già decisa») → `executeTool` con gli argomenti decifrati → `done` con `result` o `failed`
    con `error_message` = contenuto dell'errore del tool (già oscurato) → `finished_at`. Un'eccezione inattesa porta
    la voce a `failed` «errore interno nell'esecuzione dell'azione».
- Route (tutte `requireAuth`; con un token servono `api:read` per le GET e `api:write` per le POST, non `sessionOnly`):
  `GET /api/pending-actions?status=pending|executing|done|failed|rejected|all` (default `pending`, ordine per
  `number` decrescente, massimo 200), `GET /api/pending-actions/:number`,
  `POST /api/pending-actions/:number/approve` `{ userToken?: string }`,
  `POST /api/pending-actions/:number/reject` `{ note?: string (max 500) }`; le POST con
  `actionDecideRateLimit` 20/min per utente. Schema OpenAPI `QueuedAction`: `number`, `status`, `app {id,name}`,
  `tool {id,name,identity}`, `agentId`, `runId`, `recipient`, `summary`, `args` (pubblici), `result`,
  `errorMessage`, `decisionNote`, `createdAt`, `decidedAt`, `finishedAt`. `GET /api/dashboard/stats` o un campo
  dedicato: `pendingActions` (conteggio `pending`) per il contatore nel menu.
- Avvio (`src/index.ts`): `failInterruptedActions()` accanto a `failInterruptedRuns()`.

- [ ] **Step 1: test** — approvazione di una voce `service` con `fake-mcp` → `done`, una sola chiamata al servizio
  con gli argomenti originali (anche quelli sensibili); due approvazioni con `Promise.all` → una 200 e una 409, una
  sola chiamata; identità `user` senza token → 400 e voce ancora `pending`; con token → header utente arrivato al
  servizio; tool diventato L3 via override → 409; app senza più `mcpUrl` → voce `failed` «server MCP non
  raggiungibile» e risposta 200 con la voce; rifiuto con nota → `rejected`, nota oltre 500 → 400; voce di un altro
  utente → 404; `failInterruptedActions` → `failed` col messaggio; token `api:read` su approve → 403; 21ª
  approvazione nel minuto → 429; le risposte non contengono valori `x-sensitive`.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): approvazione e rifiuto delle azioni in coda`

### Task 8: Architetto con la fonte MCP

**Files:**
- Create: `artifacts/api-server/src/lib/architect/mcp-source.ts`, `mcp-source.test.ts`
- Modify: `architect/run-analysis.ts`, `phase-loop.ts`, `schemas.ts`, `prompts.ts`, `apply.ts`, `diff.ts`,
  `local-executor.ts`, `lib/mcp/server.ts` (+ test esistenti), `lib/api-spec/openapi.yaml` (`AnalysisSources.mcp`,
  campi `level`/`kind` delle voci tool) + codegen, `docs/skills/casello-architetto-locale/SKILL.md`

**Interfaces:**
- Consumes: `listMcpTools`, `McpToolInfo`, `McpError` (Task 4); `ToolLevel`, `TOOL_LEVELS` (Task 2).
- Produces in `mcp-source.ts`: `loadMcpSource(conn: AppConnection): Promise<McpToolInfo[] | null>` (null senza
  `mcpUrl` o su `McpError`, con riga di log dell'analisi «MCP: n strumenti» / «MCP: non raggiungibile»);
  `listMcpToolsPage(tools: McpToolInfo[], args: { prefix?: string; offset?: number }, limits): { content: string; log: string }`
  (stesso formato e paginazione di `listOperations`); `describeMcpTool(tools, name): string` (nome, descrizione,
  livello dichiarato, schema JSON).
- `analyses.sources` aggiunge `mcp: boolean`. `phaseTools` aggiunge `list_mcp_tools` (`prefix`, `offset`) e
  `read_mcp_tool` (`name`) quando la fonte c'è. Server `/mcp`: strumento `read_mcp_tools` (`analysisId`,
  `leaseToken`, `prefix?`, `offset?`, `name?`), con l'elenco letto al claim come per l'OpenAPI.
- `schemas.ts`: la voce tool ha `kind: "http" | "mcp"` e `level: ToolLevel` al posto dei due flag; per `kind mcp`
  la `definition` è `{ mcpName }` e il `level` non può essere sotto quello dichiarato dall'elenco MCP (validazione
  che riceve l'elenco: errore «livello sotto quello dichiarato dal servizio per "<nome>"»).
- `apply.ts`: approvare una voce tool `mcp` crea/aggiorna la riga con `kind mcp`, `level` = dichiarato,
  `level_override` = proposto se più alto; `diff.ts` confronta anche `level` e `kind`.
- `prompts.ts`: istruzioni della fase catalog e della fase completion: usare `list_mcp_tools` se presente,
  proporre i livelli secondo la tabella della spec §2, e proporre voci `endpoint` per livello non dichiarato,
  strumento mancante a un agente proposto, strumento con effetti esterni senza un parametro che identifichi il
  destinatario. Esempi JSON aggiornati (verificati dai test esistenti di `prompts.test.ts`).

- [ ] **Step 1: test** — analisi cloud con `fake-mcp` e modello finto: `sources.mcp = true`, `list_mcp_tools`
  disponibile e funzionante; server spento → `sources.mcp = false` e analisi che prosegue; schema che rifiuta un
  livello L1 per uno strumento dichiarato L2; `apply` di una voce `mcp` proposta L3 su dichiarato L2 → riga con
  `level L2`, `level_override L3`, `active`; `read_mcp_tools` sul server `/mcp` con la lease giusta → elenco, con
  lease sbagliata → errore come `read_openapi`; esempi di `prompts.ts` validi.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): l'architetto legge gli strumenti MCP e propone i livelli`

### Task 9: Console

**Files:**
- Create: `artifacts/casello/src/pages/pending-actions.tsx`, `artifacts/casello/src/components/actions/` (lista e
  scheda della voce)
- Modify: componenti in `components/apps/` (campo «Server MCP» nel modulo dell'app, pulsante «Aggiorna strumenti»
  in `tool-catalog.tsx`, colonna «Livello» e tendina dell'override in `tool-catalog.tsx`/`app-tool-dialog.tsx`),
  `components/agents/agent-tools-section.tsx`, `components/analysis/item-card.tsx` (livello e tipo della voce tool),
  `pages/run-detail.tsx` e `components/runs/` (passo «Accodata n. N» con collegamento e stato; via
  `confirmation-card.tsx` e i pulsanti di conferma), `run-status-badge.tsx` (`awaiting_client` mostrato come
  storico), router e menu (voce «Da confermare» con il contatore).

**Interfaces:**
- Consumes: hook generati per `refreshAppMcpTools`, `listPendingActions`, `getPendingAction`,
  `approvePendingAction`, `rejectPendingAction` e il contatore (Task 5 e 7). I nomi esatti sono gli `operationId`
  scelti nei Task 5 e 7: `refreshAppMcpTools`, `listPendingActions`, `getPendingAction`, `approvePendingAction`,
  `rejectPendingAction`.

- [ ] **Step 1:** implementare. Pagina «Da confermare»: filtro per stato (default «in attesa»), riga per voce con
  numero, app, strumento, destinatario, sintesi, data; dettaglio con argomenti (sensibili già oscurati dall'API),
  run d'origine, «Approva» (campo «Token dell'utente dell'app» solo se `tool.identity === "user"`) e «Rifiuta» con
  nota; esito e messaggi d'errore dell'API mostrati così come arrivano. Esito di «Aggiorna strumenti» come
  notifica con i conteggi e i conflitti.
- [ ] **Step 2:** `pnpm run typecheck` e `pnpm run build` verdi.
- [ ] **Step 3: prova nel browser** (`AUTH_DISABLED=true pnpm run dev`, `fake-mcp` avviato a mano o un server MCP
  di prova): impostare il server MCP di un'app, «Aggiorna strumenti», attivare uno strumento, alzare un livello,
  lanciare una run che accoda un'azione, approvarla e rifiutarne un'altra; a 1280 px nessuno scorrimento orizzontale.
- [ ] **Step 4: Commit** `feat(casello): strumenti MCP, livelli e azioni da confermare nella console`

### Task 10: Migrazione `-post` e documentazione

**Files:**
- Create: `docs/migrations/2026-11-strumenti-mcp-post.sql`, `artifacts/api-server/test/migration-strumenti-mcp-post.test.ts`
- Modify: `docs/schema-casello.sql`, `CLAUDE.md`

- [ ] **Step 1: test** — dopo lo script additivo e il `-post` (eseguito due volte): `app_tools.requires_confirmation`,
  `app_tools.read_only`, `runs.pending_action`, `runs.loop_state`, `runs.paused_at` non esistono più; i livelli
  restano; seconda esecuzione senza errori.
- [ ] **Step 2:** FAIL → script con `DROP COLUMN IF EXISTS` in una transazione → PASS; `docs/schema-casello.sql`
  senza quelle colonne; suite completa e typecheck.
- [ ] **Step 3:** `CLAUDE.md`: nuova sezione «Strumenti MCP e coda delle conferme» (route, limiti, messaggi,
  migrazioni e ordine di applicazione), aggiornare «Modello di dominio» (Tool con `level`, `kind mcp`), «Agenti
  operativi» (niente più pausa di 10 minuti), «Architetto» (fonte MCP), «Dove stanno le cose».
- [ ] **Step 4: Commit** `chore(casello): migrazione di fine dei flag dei tool e documentazione`
