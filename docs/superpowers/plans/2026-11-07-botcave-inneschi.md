# Inneschi (sorveglianza e webhook): piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un agente di Botcave parte da solo sugli eventi di un'app grazie a inneschi di sorveglianza (Botcave interroga un tool L0) e
webhook in entrata, senza modifiche al server dell'app.

**Architecture:** tabella `agent_triggers` più `trigger_seen_items` (deduplicazione con INSERT … ON CONFLICT). Uno scheduler nel processo
dell'API (`lib/triggers/poller.ts`, come `lib/run-queue.ts`) esegue i giri con `executeTool` e crea le run con `createQueuedRun`. Una route
pubblica `POST /api/hooks/:id/:secret`, montata prima di `requireAuth`, riceve i webhook. CRUD e «Prova» sono contract-first
nell'OpenAPI, la console ha la carta «Inneschi» nella scheda agente e Lucius ha la scheda `agent_trigger_create`.

**Tech Stack:** Express 5, Drizzle + Postgres (PGlite nei test), Vitest, Orval, React + Vite + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-07-botcave-inneschi-design.md` (da leggere insieme al piano: valori e messaggi stanno lì).

## Global Constraints

- Lingua: commenti, documentazione e messaggi di commit in italiano; codice e identificatori in inglese. Commit `feat(casello): …`.
- Testi visibili all'utente: «Botcave», mai «Casello»; niente punti esclamativi; messaggi d'errore fissi in italiano (`TRIGGER_MESSAGES`), mai
  il testo dell'app o del DB.
- `pnpm run typecheck` verde prima di ogni commit.
- Dopo ogni modifica a `lib/api-spec/openapi.yaml`: `pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Schema: ogni modifica a `lib/db/src/schema/` va anche in `docs/schema-casello.sql` (usato dai test) e in
  `docs/migrations/2026-11-inneschi.sql`, che è additiva e idempotente, senza `-post`.
- Console: niente colori scritti a mano (solo token/classi di `design/`), stati con `Led`, niente scorrimento orizzontale a 1280 px, solo hook
  di Orval.
- Log: mai corpi dei webhook, segreti, elementi letti, argomenti o risposte dei tool; solo id, conteggi ed esiti.
- Limiti (spec): 10 inneschi per agente, 50 per utente; intervallo 60..86 400 s (default 300); 20 run per giro; 500 elementi letti per giro;
  chiave id ≤ 200, versione ≤ 99, `item_key` ≤ 300; 10 000 chiavi e 30 giorni per innesco; backoff `min(intervallo × 2^errori, 1 h)`;
  `error` dopo 10 errori di fila; webhook ≤ 256 KB e 60/min per innesco; «Prova» 6/min per utente; input ≤ 8 000 caratteri di contenuto;
  `instructions` ≤ 2 000; `args` ≤ 8 KB; `name` 1..80.

## Review Focus

1. **Coda piena o tetto a metà dei 20 elementi di un giro:** gli elementi già creati restano, quelli rimasti non si segnano come visti e
   ripartono al giro dopo; il cursore non li supera. Test in Task 4: `coda piena al terzo elemento: due run, terzo ripreso al giro dopo`.
2. **Risposta dell'app che cambia forma** (oggetto al posto dell'array, `items_path` sparito): errore «elenco non trovato nella risposta»,
   nessuna chiave scritta, linea di partenza intatta. Test in Task 4: `elenco sparito: errore senza toccare le chiavi`.
3. **Id numerici e stringa dello stesso valore** (`7` e `"7"`): sono la stessa chiave, quindi un'app che cambia il tipo non rilancia tutto.
   Test in Task 2: `id 7 e "7" danno la stessa chiave`.
4. **Webhook con firma impostata e corpo riserializzato:** la firma si verifica sul corpo grezzo, non sul JSON rielaborato. Test in Task 5:
   `firma valida su JSON con spazi e ordine delle chiavi originali`.
5. **Innesco eliminato o messo in pausa durante un giro in corso:** il giro finisce senza errori e non riattiva l'innesco (gli UPDATE finali
   sono condizionati allo stato `active`). Test in Task 4: `pausa durante il giro: lo stato resta paused`.

---

### Task 1: Schema, migrazione e schema di riferimento

**Files:**
- Create: `lib/db/src/schema/agent-triggers.ts`
- Modify: `lib/db/src/schema/index.ts`, `lib/db/src/schema/runs.ts` (colonna `triggerId`), `lib/db/src/schema/characters.ts` (CHECK di `kind`)
- Create: `docs/migrations/2026-11-inneschi.sql`
- Modify: `docs/schema-casello.sql`
- Test: `artifacts/api-server/test/migration-inneschi.test.ts`

**Interfaces:**
- Produces: `triggerKindEnum` (`trigger_kind`: `poll`, `webhook`), `triggerStatusEnum` (`trigger_status`: `active`, `paused`, `error`),
  `agentTriggersTable` (colonne della spec §3.1, camelCase in TS: `agentId`, `kind`, `name`, `status`, `instructions`, `createdBy`, `toolId`,
  `args`, `itemsPath`, `idField`, `versionField`, `cursorParam`, `cursorField`, `cursorValue`, `filter`, `intervalSeconds`, `nextPollAt`,
  `baselineDone`, `dedupHeader`, `secretHash`, `signingSecretEnc`, `lastPolledAt`, `lastError`, `consecutiveErrors`, `runsCreated`,
  `createdAt`, `updatedAt`), tipo `AgentTrigger`; `triggerSeenItemsTable` (`triggerId`, `itemKey`, `seenAt`); `runsTable.triggerId`.

- [ ] **Step 1: Write the failing migration test** sul modello di `test/migration-thu-5c-tappa1.test.ts`: parte da
  `fixtures/schema-pre-nodo-locale.sql` più le migrazioni successive fino a `2026-11-thu-5c-tappa1.sql`, inserisce app, agente, tool e run,
  applica `2026-11-inneschi.sql` **due volte**. Casi:
  - `tabelle e colonne`: `agent_triggers` e `trigger_seen_items` esistono; `runs.trigger_id` integer nullable;
  - `default`: un innesco inserito con il minimo ha `status = 'paused'`, `baseline_done = false`, `consecutive_errors = 0`, `runs_created = 0`;
  - `CHECK poll`: un `poll` senza `tool_id` è rifiutato; un `webhook` senza `secret_hash` è rifiutato; `cursor_param` senza `cursor_field`
    è rifiutato;
  - `nome unico per agente`: due inneschi con lo stesso nome sullo stesso agente → violazione;
  - `seen unico`: due righe uguali in `trigger_seen_items` → violazione della chiave primaria;
  - `cascade`: eliminare l'agente elimina inneschi e chiavi; eliminare l'innesco lascia la run con `trigger_id` null;
  - `restrict`: eliminare il tool usato da un innesco `poll` fallisce;
  - `proposte`: `character_proposals` accetta `kind = 'agent_trigger_create'`.
- [ ] **Step 2: Run** `pnpm --filter @workspace/api-server exec vitest run test/migration-inneschi.test.ts`. Expected: FAIL (file di
  migrazione assente).
- [ ] **Step 3: Write `docs/migrations/2026-11-inneschi.sql`**, idempotente:
  - enum con `DO $$ … EXCEPTION WHEN duplicate_object`;
  - `CREATE TABLE IF NOT EXISTS`;
  - vincoli con nome: `agent_triggers_poll_check`, `agent_triggers_webhook_check`, `agent_triggers_cursor_check`, unico
    `agent_triggers_agent_name_key`;
  - indici `agent_triggers_due_idx (status, next_poll_at)`, `agent_triggers_agent_idx`, `trigger_seen_items_seen_at_idx`;
  - `ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_id …` più indice `runs_trigger_id_idx`;
  - `ALTER TABLE character_proposals DROP CONSTRAINT IF EXISTS character_proposals_kind_check` e `ADD CONSTRAINT` con il valore in più.

  Riportare tutto in `docs/schema-casello.sql` e lo schema Drizzle negli stessi termini (`check(...)`, `unique(...)`, `index(...)`).
- [ ] **Step 4: Run** il test della migrazione e `pnpm --filter @workspace/api-server run test`. Expected: PASS, nessuna regressione.
- [ ] **Step 5: Commit** `feat(casello): schema degli inneschi`.

### Task 2: Configurazione, estrazione e input (funzioni pure)

**Files:**
- Create: `artifacts/api-server/src/lib/triggers/config.ts`, `extract.ts`, `input.ts`, `messages.ts`
- Test: `artifacts/api-server/src/lib/triggers/extract.test.ts`, `config.test.ts`, `input.test.ts`

**Interfaces:**
- Produces:
  - `TRIGGER_MESSAGES` (`messages.ts`): oggetto `as const` con tutti i messaggi fissi della spec. Chiavi:
    - `notFound` «innesco non trovato», `tooMany` «troppi inneschi», `nameTaken` «nome già usato»;
    - `toolNotUsable` «lo strumento non può essere usato da un innesco», `toolNoLonger` «lo strumento non è più utilizzabile dall'innesco»;
    - `invalidPath` «percorso non valido», `invalidArgs` «argomenti non validi», `cursorFieldRequired` «indica il campo del cursore»;
    - `wrongKindFields` «campi non ammessi per questo tipo di innesco»;
    - `listNotFound` «elenco non trovato nella risposta», `unrecognized` «risposta non riconosciuta»;
    - `budgetWait` «in attesa: tetto di spesa raggiunto», `notActive` «innesco non attivo», `badSignature` «firma non valida»;
    - `toolInUse` «lo strumento è usato da un innesco: elimina prima l'innesco».
  - `parseFieldPath(path: string): string[] | null` (`config.ts`): da 1 a 5 segmenti `^[A-Za-z0-9_-]{1,64}$`, altrimenti null.
  - `readPath(value: unknown, path: string[]): unknown` (`extract.ts`): solo proprietà proprie di oggetti semplici
    (`Object.hasOwn`), mai array né `__proto__`/`constructor`/`prototype`; altrimenti `undefined`.
  - `type ExtractConfig = { itemsPath: string | null; idField: string; versionField: string | null; cursorField: string | null; filter: { field: string; equals: string | number | boolean } | null }`
  - `extractItems(response: unknown, cfg: ExtractConfig): { ok: true; items: ExtractedItem[]; skipped: number } | { ok: false; error: "listNotFound" }`
    dove `ExtractedItem = { key: string; cursor: string | number | null; value: Record<string, unknown> }`. Al più 500 elementi letti,
    nell'ordine della risposta.
  - `itemKey(item: Record<string, unknown>, cfg: ExtractConfig): string | null`: id stringa o numero convertito con `String()` (≤ 200),
    più `\u001f` e versione (≤ 99) se c'è `versionField`; versione assente → solo id; troppo lungo o id mancante → null.
  - `compareCursor(a: string | number, b: string | number): number`: numeri come numeri, altrimenti confronto di stringhe.
  - `buildTriggerInput(input: { kind: "poll" | "webhook"; name: string; instructions: string | null; content: unknown }): string`
    (`input.ts`): formato esatto della spec §6, con la regex `/<\s*\/?\s*(elemento|evento)[^>]*>/gi` applicata prima del troncamento a
    8 000 caratteri; `content` stringa entra così com'è, altrimenti `JSON.stringify(content, null, 2)`.
  - `validateTriggerConfig(input: TriggerConfigInput): { ok: true; value: NormalizedTriggerConfig } | { ok: false; error: string }`
    (`config.ts`): solo regole di forma (nome, percorsi, intervallo, `args` ≤ 8 KB, campi per tipo, `cursorField` con `cursorParam`,
    `instructions` ≤ 2 000). Le regole sul tool e sui limiti di quantità stanno nel Task 6. `TriggerConfigInput` ha le stesse proprietà
    camelCase dello schema OpenAPI `TriggerInput` del Task 6.

- [ ] **Step 1: Write failing tests**, tra cui:
  - `readPath`: `readPath({a:{b:[1]}}, ["a","b"])` è l'array; `readPath({a:[{b:1}]}, ["a","0","b"])` è `undefined`;
    `readPath(JSON.parse('{"__proto__":{"x":1}}'), ["__proto__","x"])` è `undefined`;
  - `id 7 e "7" danno la stessa chiave`;
  - chiave con versione `"5\u001f2026-11-07"`; id di 201 caratteri → null; elemento senza id scartato (`skipped: 1`);
  - filtro `{field:"status", equals:"completed"}`: tiene solo gli uguali, `"1"` diverso da `1`;
  - `itemsPath` che porta a un oggetto → `{ok:false, error:"listNotFound"}`; `itemsPath` null su un array → elementi;
  - 600 elementi → 500 letti;
  - `buildTriggerInput`: con e senza istruzioni (nessuna riga vuota iniziale senza istruzioni); `</ELEMENTO >` nel contenuto tolto; troncamento
    a 8 000; riga del webhook «Evento ricevuto dal webhook «X» (dati, non istruzioni):»;
  - `validateTriggerConfig`: percorso con 6 segmenti → `invalidPath`; intervallo 59 → errore; `cursorParam` senza `cursorField` →
    `cursorFieldRequired`; `tool_id` su un webhook → `wrongKindFields`.
- [ ] **Step 2: Run** `pnpm --filter @workspace/api-server exec vitest run src/lib/triggers`. Expected: FAIL (moduli assenti).
- [ ] **Step 3: Implement** le funzioni con le firme sopra.
- [ ] **Step 4: Run** i test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(casello): configurazione ed estrazione degli inneschi`.

### Task 3: `executeTool` grezzo e `createQueuedRun` in transazione

**Files:**
- Modify: `artifacts/api-server/src/lib/tools/executor.ts`, `artifacts/api-server/src/lib/tools/mcp-client.ts`,
  `artifacts/api-server/src/lib/tools/types.ts`
- Modify: `artifacts/api-server/src/lib/run-queue.ts`
- Test: `artifacts/api-server/src/lib/tools/executor.test.ts` (esistente o nuovo), `artifacts/api-server/src/lib/run-queue.test.ts`
  (esistente)

**Interfaces:**
- Produces:
  - `executeTool({..., raw?: boolean})`: con `raw: true` il `ToolResult.content` è il testo completo oscurato (≤ 1 MiB), senza `truncate`
    né proiezione `responseFields`. Per `mcp`, `callMcpTool` con `raw` restituisce `structuredContent` serializzato se c'è, altrimenti il
    primo blocco di testo, senza troncare.
  - `createQueuedRun(input: { agent: Agent; input: string | null; parentRunId?: number | null; userToken?: string; triggerId?: number | null; tx?: DbTransaction })`:
    con `tx`, conteggio e INSERT avvengono in `tx` e `scheduleRuns()` **non** si chiama (lo chiama il chiamante dopo il commit); senza `tx`,
    comportamento di oggi. Esportare `scheduleRuns` (già esportata). `DbTransaction` è il tipo del parametro di `db.transaction` (se esiste
    già un alias nel pacchetto `@workspace/db` o in `lib/`, riusarlo).

- [ ] **Step 1: Write failing tests:**
  - executor: risposta JSON di 30 000 caratteri con `raw: true` → `content.length > 20_000` e uguale al corpo (oscurato); con
    `responseFields` impostati e `raw: true` → nessuna proiezione;
  - run-queue: `createQueuedRun({agent, input:"x", triggerId, tx})` dentro una transazione annullata → nessuna run nel DB; con commit → run con
    `triggerId`.
- [ ] **Step 2: Run** i due file di test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** i test e tutta la suite dell'API. Expected: PASS.
- [ ] **Step 5: Commit** `feat(casello): esecuzione grezza dei tool e run in coda dentro una transazione`.

### Task 4: Motore di sorveglianza

**Files:**
- Create: `artifacts/api-server/src/lib/triggers/poller.ts`, `artifacts/api-server/src/lib/triggers/eligibility.ts`
- Modify: `artifacts/api-server/src/index.ts` (avvio dopo `startRunQueue`)
- Test: `artifacts/api-server/src/lib/triggers/poller.test.ts` (PGlite, finta app HTTP sul modello di `routes.test.ts`, finto MCP
  `test/fake-mcp.ts`)

**Interfaces:**
- Consumes: Task 2 (`extractItems`, `compareCursor`, `buildTriggerInput`, `TRIGGER_MESSAGES`), Task 3 (`executeTool` con `raw`,
  `createQueuedRun` con `tx` e `triggerId`), `runBudgetBlock` (`lib/budget.ts`), `loadAppConnection`, `toCatalogTool` (`lib/tools/catalog.ts`),
  `effectiveLevel` (`lib/tools/levels.ts`).
- Produces:
  - `toolUsableByTrigger(tool: AppTool, agentAppId: number): boolean` (`eligibility.ts`): stessa app, `active`, `http` o `mcp`, livello
    effettivo L0, identità `service`.
  - `pollTrigger(triggerId: number, deps?: { fetchImpl?: typeof fetch }): Promise<PollOutcome>` con
    `PollOutcome = "skipped" | "baseline" | { created: number; more: boolean } | { error: string }`.
  - `startTriggerPoller(): () => void`: controllo ogni 15 s, fino a 20 inneschi scaduti per controllo, 4 in parallelo, un controllo alla
    volta.
  - `sweepSeenItems(): Promise<void>`: 30 giorni e 10 000 per innesco; chiamata ogni ora da `startTriggerPoller`.

  Il giro segue la spec §4.3, punto per punto. Requisiti:
  - presa in carico con UPDATE condizionato;
  - per ogni elemento nuovo, una `db.transaction` che inserisce la chiave con `onConflictDoNothing().returning()` e, solo se la riga è
    nuova, chiama `createQueuedRun({tx, triggerId})`; con `queue_full` lancia un errore sentinella che annulla la transazione e ferma il giro;
  - `scheduleRuns()` una volta dopo il giro;
  - tutti gli UPDATE finali sono condizionati a `status = 'active'`;
  - con più di 20 chiavi nuove, `next_poll_at = now()`.

- [ ] **Step 1: Write failing tests** (ciascuno con una finta app che restituisce un elenco configurabile):
  - `primo giro: linea di partenza senza run` (3 elementi → 3 chiavi, 0 run, `baselineDone` true);
  - `elemento nuovo: una run con trigger_id e input` (input contiene `«Nuovo elemento dall'innesco «Email»` e l'id);
  - `stesso elemento due volte: una sola run`;
  - `25 nuovi: 20 run, giro successivo subito, poi 5`;
  - `cursore: secondo giro chiama il tool con since = valore più alto`;
  - `coda piena al terzo elemento: due run, terzo ripreso al giro dopo` (Review Focus 1);
  - `tetto raggiunto: nessuna chiave, last_error budgetWait, consecutive_errors 0`;
  - `elenco sparito: errore senza toccare le chiavi` (Review Focus 2);
  - `HTTP 500: backoff`: `next_poll_at` ≈ now + intervallo × 2; dopo 10 errori `status = error`;
  - `tool diventato L1: errore toolNoLonger`;
  - `agente in bozza: giro saltato senza errore`;
  - `due pollTrigger concorrenti: un solo giro`;
  - `pausa durante il giro: lo stato resta paused` (Review Focus 5: la finta app mette in pausa l'innesco nel DB prima di rispondere);
  - `tool mcp: elementi da structuredContent`;
  - `sweepSeenItems: tolte le chiavi oltre 30 giorni e oltre 10 000`.
- [ ] **Step 2: Run** `pnpm --filter @workspace/api-server exec vitest run src/lib/triggers/poller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `eligibility.ts`, `poller.ts`; in `index.ts` chiamare `startTriggerPoller()` subito dopo `startRunQueue()`.
- [ ] **Step 4: Run** il test e la suite dell'API. Expected: PASS.
- [ ] **Step 5: Commit** `feat(casello): sorveglianza degli inneschi`.

### Task 5: Webhook in entrata

**Files:**
- Create: `artifacts/api-server/src/lib/triggers/webhook.ts`, `artifacts/api-server/src/lib/triggers/secrets.ts`,
  `artifacts/api-server/src/routes/hooks.ts`
- Modify: `artifacts/api-server/src/app.ts` (montaggio prima dei parser globali e di `requireAuth`; serializer di pino-http),
  `artifacts/api-server/src/middlewares/rate-limit.ts` (`webhookRateLimit`), `docker/nginx.conf.template`
- Test: `artifacts/api-server/src/routes/hooks.test.ts`

**Interfaces:**
- Consumes: Task 2 (`itemKey`, `readPath`, filtro, `buildTriggerInput`), Task 3 (`createQueuedRun` con `tx`), `runBudgetBlock`,
  `encryptSecret`/`decryptSecret`.
- Produces:
  - `generateWebhookSecret(): { secret: string; hash: string }` (`whs_` + 32 byte base64url; hash SHA-256 esadecimale) e
    `secretMatches(secret: string, hash: string): boolean` (tempo costante) in `secrets.ts`;
  - `webhookUrl(triggerId: number, secret: string): string` = `${PUBLIC_APP_URL}/api/hooks/${id}/${secret}` (stessa funzione di
    configurazione usata da `lib/oauth/config.ts` per `PUBLIC_APP_URL`);
  - `redactHookPath(url: string): string`: `/api/hooks/<id>/<qualsiasi>` → `/api/hooks/<id>/***`;
  - `handleWebhook(input: { triggerId: number; secret: string; contentType: string | undefined; rawBody: Buffer; signature: string | undefined; dedupHeaderValue: (name: string) => string | undefined }): Promise<{ status: number; body: unknown; retryAfter?: number }>`
    in `webhook.ts`, con le risposte della tabella §5.4;
  - router `hooksRouter()` in `routes/hooks.ts`: `express.raw({ type: () => true, limit: "256kb" })` sulla route, 413 dal parser,
    `webhookRateLimit` (60/min con chiave `triggerId`; senza id valido nessun conteggio).

  `app.ts`: `app.use("/api/hooks", hooksRouter())` **prima** di `app.use(cors(...))` e del parser globale (il percorso si esclude dai
  parser come `isAttachmentUpload`), e il serializer `req` usa `redactHookPath`. nginx: `location ^~ /api/hooks/` con `access_log off`,
  `client_max_body_size 256k` e gli stessi `proxy_*` e header di `location /api/`.

- [ ] **Step 1: Write failing tests** (app Express vera su porta 0, come `routes.test.ts`):
  - `segreto giusto: 202 con runId`, la run ha `triggerId` e l'input contiene `<evento>`;
  - `segreto sbagliato e id inesistente: stessa risposta 404`;
  - `firma valida su JSON con spazi e ordine delle chiavi originali` (Review Focus 4); `firma assente con segreto di firma impostato: 401`;
  - `corpo di 300 KB: 413`; `application/xml: 415`; `JSON non valido: 400`; `form urlencoded diventa oggetto`; `text/plain entra come testo`;
  - `X-GitHub-Delivery ripetuto: 200 duplicate`; `filtro non soddisfatto: 200 ignored`;
  - `innesco in pausa: 409`; `tetto raggiunto: 409 col messaggio del tetto, nessuna chiave`; `coda piena: 429 con Retry-After 60`;
  - `61 richieste in un minuto: 429`;
  - `il segreto non compare nei log` (logger catturato con uno stream in memoria: nessuna riga contiene `whs_`);
  - `redactHookPath` su `/api/hooks/3/whs_abc?x=1`.
- [ ] **Step 2: Run** `pnpm --filter @workspace/api-server exec vitest run src/routes/hooks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** il test e la suite dell'API; verificare `nginx -t` sul template elaborato se `nginx` è disponibile in locale,
  altrimenti lasciare la verifica alla prova della CI. Expected: PASS.
- [ ] **Step 5: Commit** `feat(casello): webhook in entrata degli inneschi`.

### Task 6: API degli inneschi (OpenAPI, route, prova, dashboard)

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (tag `triggers`, schemi `Trigger`, `TriggerInput`, `TriggerPatch`, `TriggerTestResult`,
  `TriggerCreated`, `Run.triggerId`, `Run.triggerName`, `DashboardStats.triggersInError`), poi codegen
- Create: `artifacts/api-server/src/lib/triggers/service.ts`, `artifacts/api-server/src/routes/triggers.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`, `routes/dashboard.ts`, `routes/serializers.ts` (run), `routes/app-tools.ts`
  (409 sull'eliminazione), `middlewares/rate-limit.ts` (`triggerTestRateLimit` 6/min per utente)
- Test: `artifacts/api-server/src/routes/triggers.test.ts`

**Interfaces:**
- Consumes: Task 2 (`validateTriggerConfig`), Task 4 (`toolUsableByTrigger`, `extractItems`), Task 5 (`generateWebhookSecret`,
  `webhookUrl`).
- Produces:
  - route della spec §7, con `parseRequest` in ingresso e `*Response.parse` in uscita;
  - `createTrigger(agentId, userId, input)`, `updateTrigger(id, patch)`, `testTriggerConfig(agentId, config)`, `serializeTrigger(row)` in
    `service.ts`. `Trigger` non espone mai `secretHash` né `signingSecretEnc`, solo `signingSecretSet: boolean`.
  - Un `PATCH` che cambia `toolId`, `itemsPath`, `idField`, `versionField` o `filter` imposta `baselineDone = false` e cancella le chiavi
    viste dell'innesco nella stessa transazione.
  - `resume`: `status = active`, `consecutiveErrors = 0`, `lastError = null`, `nextPollAt = now()`.

- [ ] **Step 1: Write failing tests:**
  - creazione `poll` valida → 201, `status: "paused"`; creazione `webhook` → 201 con `webhookUrl` che inizia con
    `${PUBLIC_APP_URL}/api/hooks/`, e un `GET` successivo non lo contiene;
  - tool L1, tool `user`, tool di un'altra app → 400 `toolNotUsable`; argomenti non conformi a `params_schema` → 400;
  - 11° innesco sull'agente → 409 `tooMany`; nome ripetuto → 409 `nameTaken`;
  - `PATCH` di `itemsPath` → `baselineDone` false e chiavi cancellate; `PATCH` del nome → chiavi intatte;
  - `pause`/`resume`; `resume` di un innesco in `error` lo riattiva con `nextPollAt` ≤ adesso;
  - «Prova» su configurazione non salvata: elementi con `isNew` e anteprima ≤ 200 caratteri, nessuna run e nessuna chiave scritta; la
    settima prova in un minuto → 429; «Prova» su un webhook → 400;
  - `POST /secret` con un token personale → 403 (`sessionOnly`); con la sessione → nuovo `webhookUrl`, il vecchio segreto dà 404 al webhook;
  - `PUT /signing-secret` di 10 caratteri → 400; `null` lo toglie (`signingSecretSet: false`);
  - token personale con solo `api:read`: `GET` ok, `POST` 403;
  - eliminare un tool usato da un innesco → 409 `toolInUse`;
  - `GET /api/dashboard/stats` → `triggersInError` conta gli inneschi `error` degli agenti visibili;
  - `GET /api/runs/:id` di una run d'innesco → `triggerId` e `triggerName`.
- [ ] **Step 2: Run** codegen, poi `pnpm --filter @workspace/api-server exec vitest run src/routes/triggers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** il test, la suite dell'API e `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(casello): API degli inneschi` (con i file generati).

### Task 7: Proposta di Lucius `agent_trigger_create`

**Files:**
- Modify: `artifacts/api-server/src/lib/characters/subjects/agent.ts` (strumento `proponi_innesco`),
  `artifacts/api-server/src/lib/characters/proposals.ts` (`PAYLOADS`, mappa degli argomenti, `case "agent_trigger_create"`),
  `lib/api-spec/openapi.yaml` (valore nell'enum del tipo di scheda), poi codegen
- Test: `artifacts/api-server/src/lib/characters/proposals.test.ts` (o il file di test esistente delle proposte), `subjects/subjects.test.ts`

**Interfaces:**
- Consumes: Task 6 (`createTrigger`).
- Produces: scheda `agent_trigger_create` con payload `{ agentId, name, instructions?, toolId, args?, itemsPath?, idField, versionField?,
  cursorParam?, cursorField?, filter?, intervalSeconds? }` (Zod come gli altri in `PAYLOADS`); accettare chiama `createTrigger` (in pausa);
  errori di regola → scheda `pending` con lo stato dell'errore. Nessuna impronta (`target_hash` null), come `agent_create`.

- [ ] **Step 1: Write failing tests:**
  - `proponi_innesco` registra una scheda `agent_trigger_create` sull'argomento `agent`;
  - accettarla crea un innesco `paused` con `createdBy` = utente;
  - con un tool L2 la decisione risponde 400 `toolNotUsable` e la scheda resta `pending`;
  - lo strumento non accetta `kind`: il payload è sempre `poll`.
- [ ] **Step 2: Run** i test. Expected: FAIL.
- [ ] **Step 3: Implement**; nelle istruzioni di Lucius (`lib/characters/instructions.ts`) una riga: può proporre inneschi di sorveglianza
  su tool di lettura, che nascono in pausa e l'utente prova e attiva.
- [ ] **Step 4: Run** i test e la suite dell'API. Expected: PASS.
- [ ] **Step 5: Commit** `feat(casello): Lucius propone inneschi di sorveglianza`.

### Task 8: Console

**Files:**
- Create: `artifacts/casello/src/components/agents/agent-triggers-section.tsx`,
  `artifacts/casello/src/components/agents/trigger-dialog.tsx`, `artifacts/casello/src/components/agents/trigger-test-table.tsx`,
  `artifacts/casello/src/components/agents/webhook-url-dialog.tsx`
- Modify: `artifacts/casello/src/pages/agent-detail.tsx` (carta dopo gli strumenti), pagina della run (`components/runs/` o
  `pages/run-detail.tsx`: «Avviata dall'innesco <nome>»), dashboard (`pages/dashboard.tsx`: «Inneschi in errore»),
  `components/characters/proposal-cards.tsx` e `proposal-previews.tsx` (scheda `agent_trigger_create`)

**Interfaces:**
- Consumes: hook generati da Orval dal Task 6 e dal Task 7 (nomi dal codegen: `useListAgentTriggers`, `useCreateAgentTrigger`, … come li
  produce l'`operationId` scelto nel Task 6).

- [ ] **Step 1: Implement la carta «Inneschi»** come descritto nella spec §8.1:
  - elenco con `Led` (`ok`, `idle`, `ko`);
  - dialogo con tipo, campi per la sorveglianza e «Prova», che mostra la tabella degli elementi con chiave, «Nuovo»/«Già visto» e
    anteprima, più gli errori;
  - URL del webhook mostrato una volta con «Copia» e «Rigenera indirizzo» (con conferma);
  - segreto di firma «Imposta»/«Togli»;
  - avviso fisso quando l'agente ha tool L1 attivi e `confirmWrites` falso.

  Testi della spec, pulsanti che dicono cosa fanno.
- [ ] **Step 2: Implement** il collegamento nella run, il contatore in Dashboard e la scheda di Lucius (anteprima della configurazione; nota
  «L'innesco nasce in pausa: provalo e attivalo dalla scheda agente»).
- [ ] **Step 3: Run** `pnpm run typecheck`, `pnpm --filter @workspace/casello run test` e
  `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/casello run build`. Expected: tutto verde.
- [ ] **Step 4: Verifica visiva** con `AUTH_DISABLED=true pnpm run dev` (serve `DATABASE_URL` di sviluppo con la migrazione applicata), se
  disponibile:
  - creare un innesco di sorveglianza su un tool L0 e premere «Prova»;
  - creare un webhook e copiarne l'URL;
  - controllare che a 1280 px non ci sia scorrimento orizzontale, in tema chiaro e scuro.

  Se il DB di sviluppo non c'è, dirlo nel resoconto.
- [ ] **Step 5: Commit** `feat(casello): carta Inneschi nella scheda agente`.

### Task 9: Documentazione e verifica finale

**Files:**
- Modify: `CLAUDE.md`: sezione «Inneschi» con il comportamento della spec com'è nel codice; voci in «Stato», «Dove stanno le cose»
  (`lib/triggers/`, `routes/triggers.ts`, `routes/hooks.ts`, componenti della console) e nell'elenco delle tabelle; in «Deploy» la
  `location ^~ /api/hooks/` di nginx.
- Modify: `docs/superpowers/specs/2026-11-07-botcave-inneschi-design.md`: sezione «Differenze dal codice» se l'implementazione si è
  discostata.

- [ ] **Step 1: Write** la documentazione.
- [ ] **Step 2: Run:**
  - `pnpm run typecheck`;
  - `pnpm --filter @workspace/api-server run test`;
  - `pnpm --filter @workspace/casello run test`;
  - `PORT=5173 BASE_PATH=/ pnpm run build`.

  Expected: tutto verde; riportare i conteggi dei test.
- [ ] **Step 3: Commit** `docs(casello): inneschi`.
- [ ] **Step 4:** preparare il testo della PR:
  - cosa cambia e come si è provato;
  - l'SQL completo di `docs/migrations/2026-11-inneschi.sql`, da dare **in chat** a Ivan per applicarlo su Neon **prima** del merge;
  - la modifica a nginx;
  - nessuna variabile nuova;
  - i passi della §10 della spec per The Hub Up, da eseguire dopo il deploy con la conferma di Ivan.

  Niente push né PR senza la conferma di Ivan.
