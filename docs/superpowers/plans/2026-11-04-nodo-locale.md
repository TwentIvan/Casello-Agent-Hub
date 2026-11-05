# Nodo locale per i ruoli `node` — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** i compiti dei ruoli `node` delle squadre vengono presi in lease da un nodo registrato (oggi `casello-nodo` sul
Mac con Claude Code), eseguiti nello spazio di lavoro della squadra con gli allegati e riferiti a Casello.

**Architecture:** in Casello un modulo `lib/nodes/` (nodi, token d'ambito `node`, protocollo heartbeat/claim/ping/report,
scadenze) riusa la chiusura dei compiti di `lib/teams/task-runner.ts`; gli allegati stanno in `team_attachments`. Fuori
dall'API, un pacchetto `artifacts/casello-nodo` (Node 24, TypeScript) fa il ciclo sul Mac e lancia `claude -p`.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React + shadcn/ui; Node 24
(`node:child_process`, `node:fs`, `fetch`) per `casello-nodo`, launchd.

**Spec:** `docs/superpowers/specs/2026-11-04-casello-nodo-locale-design.md`

## Global Constraints

- Italiano per commenti, messaggi, UI, log e commit (`feat(casello): …`); identificatori in inglese.
- `pnpm run typecheck` verde prima di ogni commit; codegen dopo ogni modifica a `openapi.yaml`.
- Schema: ogni modifica anche in `docs/schema-casello.sql` e in `docs/migrations/2026-11-nodo-locale.sql` (additiva,
  idempotente, PRIMA del merge).
- Token d'ambito `node`: valgono SOLO su `/api/node/…`; su ogni altra route di `/api` e su `/mcp` → 403; le route
  `/api/node/…` rifiutano sessione e token senza `node` (403).
- Lease 15 minuti; heartbeat ogni 30 s; ping ogni 5 minuti; «nessun nodo» dopo 10 minuti, nodo vivo se
  `last_seen_at` negli ultimi 2 minuti; controllo delle scadenze ogni minuto.
- Limiti: heartbeat e claim 6/min per nodo; ping 4/min per compito; allegati 10 MB l'uno, 50 MB per squadra;
  `max_concurrent` 1..3; `node_workspace` max 300, relativo, senza `..`, caratteri `[A-Za-z0-9._ -]` e `/`.
- Messaggi fissi: «nodo non più raggiungibile», «nessun nodo disponibile con le skill: …», «spazio di lavoro non
  valido», «allegato non valido», «tempo massimo superato», «lease non valida o scaduta».
- Il costo riferito dal nodo va in `team_tasks.cost_usd` con `ai_model_id` null (conta solo nel tetto della squadra).
- Ordine dei lock: istanza → PLAN → pending_actions; per il claim: istanza (per il conteggio) poi riga del compito;
  `patchPlan` dopo il commit. Mai letture dal pool dentro una transazione di scrittura.
- `casello-nodo`: mai token, contenuti degli allegati o del pacchetto nei log; config con permessi 600.
- Console senza scorrimento orizzontale a 1280 px; solo hook Orval.

## Review Focus

- Un nodo che riferisce dopo che la lease è scaduta e il compito è già stato chiuso come fallito: 409, nessuna
  sovrascrittura, nessun secondo turno del capo (test nel Task 3).
- Uno spazio di lavoro che esce dalla radice con un link simbolico: il nodo lo rifiuta anche se il percorso testuale è
  dentro la radice (test nel Task 5).
- Due nodi dello stesso utente che chiedono un claim insieme: un compito va a uno solo (test nel Task 3).
- Un compito `node` assegnato quando la squadra ha `node_workspace` vuoto: il nodo riferisce «spazio di lavoro non
  valido» come `blocked`, non resta appeso (test nel Task 5).
- Un allegato eliminato dopo l'assegnazione del compito: il nodo lo scarica comunque (test nel Task 4).

---

### Task 1: Dati e migrazione

**Files:** `lib/db/src/schema/nodes.ts` (nodes), `lib/db/src/schema/team-attachments.ts`, modifiche a `api-tokens`,
`team-instances`, `team-work` (team_tasks), indice schemi; `docs/schema-casello.sql` (stato finale delle tabelle, non
la migrazione accodata); `docs/migrations/2026-11-nodo-locale.sql`;
`artifacts/api-server/test/migration-nodo-locale.test.ts` (+ fixture `schema-pre-nodo-locale.sql`).

**Interfaces:**
- Produces: tabelle e colonne di spec §2 (`team_tasks.attachment_ids` jsonb default `[]`); enum `node_status`
  (`active|disabled`); unico (`user_id`, `name`) su `nodes`; indice `team_tasks (node_id, status)`.

- [ ] **Step 1:** test della migrazione (fixture, script due volte): tabelle e colonne create; `api_tokens.node_id` con
  cascade (eliminare un nodo elimina il suo token); `team_attachments` con FK cascade sull'istanza; righe esistenti di
  `team_tasks` con `attachment_ids = []` e `no_node_notified = false`.
- [ ] **Step 2:** FAIL → script, Drizzle, `schema-casello.sql` → PASS; suite e typecheck verdi.
- [ ] **Step 3: Commit** `feat(casello): tabelle di nodi e allegati delle squadre`

### Task 2: Nodi e token d'ambito `node`

**Files:** Create `artifacts/api-server/src/lib/nodes/nodes.ts` (+ test), `src/routes/nodes.ts` (+ test); modify
`src/lib/api-tokens.ts` (ambito `node`, token legato a un nodo), `src/lib/auth.ts` (regola d'ambito), `src/lib/mcp/auth.ts`,
`routes/index.ts`, `openapi.yaml` (+ codegen).

**Interfaces:**
- Produces:
  - `TOKEN_SCOPES` include `node` (non selezionabile nella creazione dei token personali: solo `createNode`).
  - `nodes.ts`: `createNode(userId, name): Promise<{ node: NodeView; token: string }>` (token `cas_…` con
    `scopes: ["node"]`, `node_id`); `listNodes(userId)`, `disableNode(userId, id)`, `deleteNode(userId, id)`,
    `regenerateNodeToken(userId, id): Promise<{ token: string }>` (revoca i token precedenti del nodo);
    `NodeView = { id; name; status; executor; version; skills: string[]; workspaceRoot; maxConcurrent; lastSeenAt; online: boolean }`
    (`online` = `last_seen_at` negli ultimi 2 minuti).
  - `requireAuth`: un token con `node` è rifiutato (403 `TOKEN_MESSAGES.scope`) fuori da `/api/node`; il middleware
    nuovo `requireNodeToken` (in `lib/nodes/auth.ts`) per `/api/node/*` accetta solo token `node` di un nodo `active`,
    imposta `req.node = { id, userId }`, altrimenti 403/401 coi messaggi di `TOKEN_MESSAGES`. `/mcp` rifiuta i token
    `node` (401 come un token senza `mcp`).
  - Route (`sessionOnly`): `GET|POST /api/account/nodes`, `POST /api/account/nodes/:id/disable`,
    `POST /api/account/nodes/:id/token`, `DELETE /api/account/nodes/:id`; nome unico per utente → 409 «nome già usato».
    operationId `listNodes`, `createNode`, `disableNode`, `regenerateNodeToken`, `deleteNode`; schemi `Node`,
    `NodeCreated` (`{ node, token }`).

- [ ] **Step 1: test** — creazione con token mostrato una volta (e salvato come hash); token `node` su
  `GET /api/team-instances` → 403, su `/mcp` → 401; token normale e sessione su una route `/api/node/heartbeat` → 403;
  nodo disabilitato → 403 sul protocollo; rigenerazione revoca il token vecchio; `POST /api/account/tokens` con
  `scopes: ["node"]` → 400; nodi di un altro utente → 404.
- [ ] **Step 2:** FAIL → implementare (la route `/api/node/heartbeat` minima che risponde `{ pending: 0 }` per il test,
  completata nel Task 3) → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): nodi registrati con token d'ambito node`

### Task 3: Protocollo del nodo

**Files:** Create `artifacts/api-server/src/lib/nodes/protocol.ts`, `lease-sweeper.ts` (+ test), `src/routes/node.ts`
(+ test); modify `src/lib/teams/task-runner.ts` (esporta la chiusura del compito), `src/middlewares/rate-limit.ts`,
`src/index.ts`, `openapi.yaml` (+ codegen).

**Interfaces:**
- Consumes: `team_tasks` (`waiting_node`, `waiting_since`), `patchPlan`, `enqueueTurnReason`, `emitEvent`,
  `teamBudgetBlock` (solo tetto della squadra: aggiungere `teamCapBlock(instanceId)` se `teamBudgetBlock` richiede un
  modello), `skillTexts` (task-runner), `getPlan`.
- Produces:
  - `task-runner.ts`: `finishTaskExecution(task: TeamTaskRow, result: { status: "done"|"blocked"|"failed"; outcome: string; detail: string | null; error?: string | null }, usage: { promptTokens: number | null; completionTokens: number | null; costUsd: number | null }): Promise<void>`
    (esportata, usata da `runTask` e dal report del nodo: stato ed esito nel compito e nel PLAN, evento, turno del capo).
    Imposta `waiting_since = now()` quando un compito entra in `waiting_node` (in `startTask`).
  - `protocol.ts`: `heartbeat(nodeId, caps: { version; executor; skills: string[]; workspaceRoot; maxConcurrent }): Promise<{ pending: number }>`;
    `claimTask(nodeId): Promise<TaskPackage | null>`; `pingTask(nodeId, taskId, leaseToken): Promise<{ leaseExpiresAt: Date }>`;
    `reportTask(nodeId, taskId, input: NodeReport): Promise<void>`; `NodeError` (409 «lease non valida o scaduta», 403).
    `TaskPackage` come spec §3 (campi in camelCase). Abbinamento skill: il ruolo richiede i nomi delle skill `node`
    (catalogo: `content` della versione fissata; specializzate di tipo `node`: `content`), tutti presenti in `nodes.skills`.
    Claim: transazione con lock della riga dell'istanza candidata e `SELECT … FOR UPDATE SKIP LOCKED` sul compito;
    rispetta `max_concurrent` (conteggio dei `running` con `node_id`); tetto della squadra raggiunto → la squadra viene
    saltata nel claim, senza eventi nuovi (il blocco per tetto è già segnalato dai turni del capo).
  - `lease-sweeper.ts`: `sweepExpiredLeases(now = new Date()): Promise<number>` (`running` con `node_id` e lease
    scaduta → `finishTaskExecution(…, failed, «nodo non più raggiungibile»)`); `notifyNodelessTasks(now = new Date()): Promise<number>`
    (spec §3 «Nessun nodo adatto»); `startNodeSweeper(): () => void` (setInterval 60 s, `unref`), avviato in `src/index.ts`
    insieme a uno sweep all'avvio.
  - Route: `POST /api/node/heartbeat`, `POST /api/node/claim` (200 pacchetto | 204), `POST /api/node/tasks/:id/ping`,
    `POST /api/node/tasks/:id/report`; rate limit come Global Constraints. operationId `nodeHeartbeat`, `nodeClaim`,
    `nodePing`, `nodeReport`; schemi `NodeCapabilities`, `NodeTaskPackage`, `NodeReport`.

- [ ] **Step 1: test** — heartbeat aggiorna capacità e `pending`; claim: solo compiti di squadre `active` del proprio
  utente, solo con le skill presenti, il più vecchio, rispetta `max_concurrent`, 204 se niente; due claim concorrenti
  di due nodi → un compito a uno solo; ping rinnova; report chiude il compito (PLAN, evento, turno) e salva costo con
  `ai_model_id` null e `session_id`; report con lease scaduta o sbagliata → 409 e nessuna modifica; dopo
  `sweepExpiredLeases` il compito è `failed` «nodo non più raggiungibile» e un report successivo → 409 senza secondo
  turno; `notifyNodelessTasks` emette l'evento una volta sola e mai se c'è un nodo vivo adatto; squadra oltre il tetto
  → nessun claim; 7° heartbeat nel minuto → 429.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): protocollo di lease per i compiti dei nodi`

### Task 4: Allegati e spazio di lavoro

**Files:** Create `artifacts/api-server/src/lib/teams/attachments.ts` (+ test); modify `routes/team-instances.ts`,
`routes/node.ts`, `lib/teams/instances.ts` (`nodeWorkspace`), `lib/teams/lead-tools.ts` (`assegna_compito` con
`attachments`, contesto del capo con l'elenco), `lib/nodes/protocol.ts` (allegati nel pacchetto), `openapi.yaml` (+ codegen).

**Interfaces:**
- Produces: `saveAttachment(userId, instanceId, input: { name; contentType; bytes: Buffer }): Promise<AttachmentView>`
  (limiti 10 MB / 50 MB → `AttachmentError` 413 «allegato troppo grande» / «spazio allegati della squadra esaurito»;
  nome senza `/`, `\\`, `..`, max 200 → 400); `listAttachments(instanceId)`, `getAttachment(instanceId, id)`,
  `deleteAttachment(instanceId, id)` (imposta `deleted_at`); `AttachmentView = { id; name; contentType; sizeBytes; sha256; createdAt }`.
  `validateNodeWorkspace(value: string | null): string | null` (messaggio o null).
  Route: `POST /api/team-instances/:id/attachments` (corpo grezzo, `express.raw` con limite 10 MB, header
  `X-Attachment-Name`), `GET …/attachments`, `GET …/attachments/:attachmentId`, `DELETE …/attachments/:attachmentId`;
  `GET /api/node/tasks/:id/attachments/:attachmentId` con `X-Lease-Token` (lease valida e allegato citato dal compito,
  anche se eliminato). operationId `uploadTeamAttachment`, `listTeamAttachments`, `getTeamAttachment`,
  `deleteTeamAttachment`, `nodeGetAttachment`.
  `assegna_compito`: `attachments?: number[]` → solo allegati non eliminati della squadra, altrimenti errore al modello
  «allegato <id> inesistente»; salvati in `team_tasks.attachment_ids`.

- [ ] **Step 1: test** — caricamento e sha256; 11 MB → 413; oltre 50 MB per squadra → 413; nome con `../` → 400;
  `nodeWorkspace` `"../x"`, `"/abs"`, `"a/../b"` → 400, `"SAP/AIMAG/CR/DS5100/WI_1174"` → ok; `assegna_compito` con
  allegati validi li salva, con un id inesistente dà l'errore al modello; il nodo scarica un allegato citato con la lease
  valida, rifiutato senza lease o se non citato; allegato eliminato dopo l'assegnazione ancora scaricabile dal nodo; il
  pacchetto del claim contiene `workspace` e gli allegati citati.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): allegati delle squadre e spazio di lavoro sul nodo`

### Task 5: `casello-nodo` — ciclo ed esecuzione

**Files:** Create `artifacts/casello-nodo/` (`package.json` con `bin`, `tsconfig.json`, `src/config.ts`,
`src/client.ts`, `src/workspace.ts`, `src/capabilities.ts`, `src/runner.ts`, `src/loop.ts`, `src/log.ts`, test in
`src/*.test.ts` con Vitest); registrazione nel workspace pnpm (senza aggiungerlo ai `references` del tsconfig di
root se il pacchetto è foglia, come `artifacts/casello`).

**Interfaces:**
- Produces:
  - `config.ts`: `loadConfig(path = ~/.casello-nodo/config.json): Config` — rifiuta permessi diversi da 600
    («config leggibile da altri: chmod 600»); default di spec §5.
  - `client.ts`: `CaselloClient` con `heartbeat`, `claim`, `ping`, `report`, `downloadAttachment` (fetch, timeout 30 s,
    nuovi tentativi con attesa crescente fino a 5 minuti sugli errori di rete e 5xx; 409 non ritentato).
  - `workspace.ts`: `resolveWorkspace(root: string, rel: string | null): Promise<string>` — normalizza, `realpath` di
    radice e destinazione, rifiuta se fuori dalla radice, inesistente o `rel` null (`WorkspaceError` «spazio di lavoro
    non valido»).
  - `capabilities.ts`: `scanSkills(dirs: string[]): Promise<string[]>` (cartelle con `SKILL.md`; per i plugin
    `<plugin>:<skill>` secondo la struttura di `~/.claude/plugins/cache/<marketplace>/<plugin>/<versione>/skills/<skill>`).
  - `runner.ts`: `runTask(pkg: TaskPackage, ctx: { workspaceDir; config; client; spawn? }): Promise<NodeReport>` —
    scrive `casello-compito.md`, scarica e verifica gli allegati, lancia `claude` (argomenti di spec §5, `--session-id`
    uuid), ping ogni 5 minuti, timeout `taskTimeoutMinutes` (SIGTERM poi SIGKILL dopo 10 s), legge
    `casello-esito.json` (validato con Zod) o il JSON della CLI, rimuove i due file di servizio.
  - `loop.ts`: `startLoop(config, deps?): { stop(): Promise<void> }` — heartbeat ogni 30 s, claim fino a
    `maxConcurrent`, report (ritentato finché la lease è valida).

- [ ] **Step 1: test** (Casello finto = server HTTP locale; `claude` finto = script Node che scrive
  `casello-esito.json` o stampa il JSON della CLI, eseguito tramite `spawn` iniettato) — ciclo completo con report
  `done` ed esito dal file; esito dalla CLI se il file manca; spazio di lavoro `null`, fuori radice, con link simbolico
  che esce dalla radice, inesistente → report `blocked` «spazio di lavoro non valido»; allegato con sha sbagliato →
  `failed` «allegato non valido»; timeout → `failed` «tempo massimo superato»; ping inviati durante un compito lungo;
  errore di rete al report ritentato; config con permessi 644 rifiutata; `scanSkills` su una cartella di prova; i log
  non contengono il token.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): casello-nodo esegue i compiti del nodo con Claude Code`

### Task 6: `casello-nodo` — comandi e launchd

**Files:** `artifacts/casello-nodo/src/cli.ts`, `src/launchd.ts` (+ test), `README.md` del pacchetto.

**Interfaces:**
- Produces: comandi `install` (chiede o legge `--url`, `--token`, `--workspace-root`; scrive la config 600; scrive
  `~/Library/LaunchAgents/cloud.fantamister.casello-nodo.plist` con `RunAtLoad` e `KeepAlive`, `ProgramArguments`
  = node + percorso assoluto dell'eseguibile + `run`, log su `~/.casello-nodo/logs/`; `launchctl bootstrap gui/<uid>`),
  `uninstall` (`launchctl bootout`, rimuove il plist, lascia config e log), `status` (stato di launchd, ultimo
  heartbeat riuscito e compito in corso letti da `~/.casello-nodo/state.json` scritto dal ciclo), `run`.
  `buildPlist(opts): string` puro.

- [ ] **Step 1: test** — `buildPlist` con i valori attesi (label, argomenti, percorsi dei log, `KeepAlive`); `install`
  con un `launchctl` finto scrive config (600) e plist e chiama bootstrap; `uninstall` chiama bootout e rimuove il plist;
  `status` legge `state.json`.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): installazione di casello-nodo con launchd`

### Task 7: Console

**Files:** `artifacts/casello/src/pages/account.tsx` e `components/account/nodes-section.tsx` (nuovo);
`pages/team-detail.tsx`, `components/teams/` (`team-attachments.tsx`, campo spazio di lavoro, nodo e sessione nei
compiti di «Attività»).

- [ ] **Step 1:** come spec §7: «Nodi» con elenco (online/offline da `online`, ultimo contatto, versione, executor,
  skill in chip troncabili), «Nuovo nodo» (dialogo con il token mostrato una volta, copia, e le istruzioni:
  `pnpm --filter casello-nodo exec casello-nodo install --url https://casello.fantamister.cloud --token <token> --workspace-root <cartella>`),
  «Disattiva», «Rigenera token» (con conferma), «Elimina»; nella squadra: «Spazio di lavoro sul nodo» (salvato con
  `PUT`), «Allegati» (caricamento con l'hook `uploadTeamAttachment` e corpo grezzo, elenco, elimina con conferma), nei
  compiti `node` il nome del nodo, la scadenza della lease e l'id della sessione.
- [ ] **Step 2:** typecheck e build verdi.
- [ ] **Step 3: Commit** `feat(casello): nodi, allegati e spazio di lavoro nella console`
  (la prova nel browser la fa il controller.)

### Task 8: Documentazione

**Files:** `CLAUDE.md`.

- [ ] **Step 1:** sezione «Nodi (esecuzione dei ruoli node)» dopo «Squadre (esecuzione)»: protocollo, token `node`,
  claim e skill, lease e scadenze, allegati, spazio di lavoro, costi, `casello-nodo` (config, comandi, launchd, log),
  route, migrazione (PRIMA del merge); aggiornare «Stato», «Dove stanno le cose» (`lib/nodes/`, `artifacts/casello-nodo`,
  tabelle), «Token personali» (ambito `node`), «Squadre (esecuzione)» (i compiti `node` non restano più solo in
  attesa). Ogni percorso, limite e messaggio verificato sul codice.
- [ ] **Step 2: Commit** `docs(casello): nodo locale nel CLAUDE.md`
