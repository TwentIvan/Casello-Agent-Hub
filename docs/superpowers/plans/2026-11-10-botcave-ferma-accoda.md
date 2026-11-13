# Ferma, Invia subito, Accoda: piano di implementazione (PR 1 di 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nelle tre chat (personaggi, piano, squadra) l'utente può fermare il turno in corso, mandare subito una correzione o accodare un messaggio
che parte a fine turno.

**Architecture:** il registro dei turni in corso (`lib/stale-turns.ts`) diventa anche il registro degli `AbortController`; il segnale scende da
`runChatTurn` a `runPlanTurn`/`modelChat` e a `delegateTurn`. Un modulo nuovo `lib/chat-turns/` contiene la logica comune alle tre chat (stop,
coda, partenza del messaggio in coda) parametrizzata da un descrittore per tipo di chat; i tre `run-turn.ts` forniscono il descrittore e usano
una scrittura finale condizionata. Il messaggio in coda è una riga dei messaggi con `queued_at` non nullo.

**Tech Stack:** Express 5, Drizzle, PGlite nei test, Vitest, OpenAPI + Orval, React + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-11-10-botcave-personaggi-ferma-skill-esegui-design.md` §1 (le §2 e §3 avranno piani propri, PR 2 e 3).

## Global Constraints

- Testi visibili in italiano, «Botcave» mai «Casello»; pulsanti che dicono cosa fanno, niente punti esclamativi.
- Messaggio di un turno fermato: esattamente `Risposta interrotta.` con `error: false`.
- Un solo messaggio in coda per conversazione; uno nuovo ne sostituisce testo e pagina, `queued_at` resta del primo.
- `mode=now` con turno in corso = accoda (sostituendo) + ferma; il turno nuovo parte dalla coda.
- Stop: 30/min per utente (`consumeTurnStop`); non consuma il limite dei messaggi. Attesa massima della chiusura nella route: 10 s.
- Il limite dei messaggi (10/min) si consuma all'invio, anche in coda; tetti e modello si ricontrollano alla partenza (nel turno, come oggi).
- Migrazione additiva e idempotente `docs/migrations/2026-11-ferma-accoda.sql`, riportata in `docs/schema-casello.sql`; nessuna variabile nuova.
- Console senza colori scritti a mano (solo token), niente scorrimento orizzontale a 1280 px; `Button` da `ui/button.tsx`.
- Nei log solo id e conteggi, mai contenuti dei messaggi.
- `pnpm run typecheck` verde prima di ogni commit; commit in italiano `feat(casello): …` con la riga `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Stop mentre lo strumento di una scheda sta scrivendo: la scheda salvata resta `pending` e accettabile, il messaggio dice «Risposta interrotta.»
   (test in Task 4).
2. Due «Invia subito» rapidi: niente 409 e un solo turno in corso; l'ultimo testo vince (test in Task 5).
3. Stop di un turno che gira in un altro processo (deploy): il processo vecchio, finendo, non sovrascrive il messaggio né somma due volte i totali
   (test in Task 4 con `executeXTurn` chiamato dopo la chiusura da DB).
4. Messaggio in coda su una conversazione archiviata / squadra chiusa / argomento eliminato nel frattempo: resta in coda, nessun errore 500, la
   console lo mostra con «Annulla» (test in Task 5).
5. Riavvio dell'API con un messaggio in coda: la pulizia dell'avvio chiude il turno e fa partire il messaggio in coda (test in Task 5).

---

### Task 1: Migrazione `queued_at` e schema Drizzle

**Files:**
- Create: `docs/migrations/2026-11-ferma-accoda.sql`
- Modify: `docs/schema-casello.sql`, `lib/db/src/schema/characters.ts` (`characterMessagesTable`), `lib/db/src/schema/plan-messages.ts`,
  `lib/db/src/schema/team-chat.ts` (`teamChatMessagesTable`)
- Test: `artifacts/api-server/test/migration-ferma-accoda.test.ts`

**Interfaces:**
- Produces: colonna `queuedAt: timestamp("queued_at")` (nullable) sui tre `*MessagesTable`; indici unici parziali
  `character_messages_queued_uidx`, `plan_messages_queued_uidx`, `team_chat_messages_queued_uidx` su `(conversation_id) WHERE queued_at IS NOT NULL`.

- [ ] **Step 1: test della migrazione** come `migration-nodo-senza-terminale.test.ts`: schema `docs/schema-casello.sql` senza la parte nuova non
  esiste come fixture, quindi parti da `fixtures/schema-pre-nodo-locale.sql` + tutte le migrazioni `2026-11-*` in ordine di data fino a
  `2026-11-nodo-senza-terminale.sql`, poi `2026-11-ferma-accoda.sql` due volte. Test:
  - `migration_is_idempotent`: terza applicazione senza errori; le tre colonne esistono (`information_schema.columns`).
  - `one_queued_per_conversation`: due messaggi con `queued_at` non nullo sulla stessa conversazione → violazione di unicità; due con `queued_at`
    nullo → ok.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run test/migration-ferma-accoda.test.ts` → FAIL (file SQL mancante).
- [ ] **Step 3:** scrivi la migrazione (`ALTER TABLE … ADD COLUMN IF NOT EXISTS queued_at timestamptz`, `CREATE UNIQUE INDEX IF NOT EXISTS …`),
  riportala in `docs/schema-casello.sql` e aggiungi colonna e indice ai tre schemi Drizzle.
- [ ] **Step 4:** test → PASS; `pnpm run typecheck` verde.
- [ ] **Step 5: Commit** `feat(casello): colonna queued_at dei messaggi delle chat`.

### Task 2: Segnale nel ciclo di chat

**Files:**
- Modify: `artifacts/api-server/src/lib/stale-turns.ts`, `artifacts/api-server/src/lib/plan-chat/turn.ts`,
  `artifacts/api-server/src/lib/node-turns/chat-turn.ts`
- Test: `artifacts/api-server/src/lib/plan-chat/turn.test.ts`, `artifacts/api-server/src/lib/stale-turns.test.ts` (crealo se manca),
  `artifacts/api-server/src/lib/node-turns/chat-turn.test.ts` (se esiste; altrimenti nel test di `delegate`)

**Interfaces:**
- Produces:
  - `trackTurn<T>(kind: ChatTurnKind, conversationId: number, run: (signal: AbortSignal) => Promise<T>): Promise<T>` (il parametro nuovo è
    l'unica modifica di firma; i tre chiamanti si aggiornano in Task 4).
  - `abortTurn(kind: ChatTurnKind, conversationId: number): boolean` — true se il turno gira in questo processo (e lo annulla).
  - `isLiveTurn(kind, conversationId): boolean`.
  - `PlanTurnDeps.signal?: AbortSignal`; `PlanTurnOutcome` ramo d'errore con `stopped?: true`.
  - `ChatTurnInput.signal?: AbortSignal`, passato a `modelChat({ signal })`, a `delegateTurn({ signal })` e al ripiego.
  - `STOPPED_TURN_MESSAGE = "Risposta interrotta."` esportata da `lib/plan-chat/turn.ts`.

- [ ] **Step 1: test di `runPlanTurn`** (modello finto come negli altri test del file):
  - `signal già annullato → { ok: false, stopped: true, tokens: 0 }` senza chiamare il modello;
  - `annullato tra due strumenti → il secondo strumento non parte; tokens del primo giro conservati`;
  - `annullato durante la chiamata` (il finto `chat` rifiuta con `APIUserAbortError` quando il segnale scatta) `→ stopped: true`.
- [ ] **Step 2: test del registro**: `abortTurn` restituisce true dentro `run` e il `signal` passato a `run` è annullato; false dopo la fine;
  false per una conversazione mai vista.
- [ ] **Step 3: test di `runChatTurn` sul nodo**: con `signal` annullato `delegateTurn` → `cancelled` → esito `{ ok: false, stopped: true }` (oggi
  restituisce `NODE_TURN_MESSAGES.stopped` senza `stopped`: con `signal` annullato vale `stopped: true`; senza segnale annullato resta com'è).
- [ ] **Step 4:** test → FAIL.
- [ ] **Step 5:** implementa. In `runPlanTurn` controlla `deps.signal?.aborted` prima di ogni chiamata al modello e prima di ogni strumento; un
  errore della chiamata con il segnale annullato è `stopped` (non il messaggio del provider). `cloudTurn` passa `signal` a `modelChat`.
- [ ] **Step 6:** test → PASS; typecheck (i chiamanti di `trackTurn` si aggiornano ignorando il segnale finché Task 4 non lo usa).
- [ ] **Step 7: Commit** `feat(casello): segnale di interruzione nei turni di chat`.

### Task 3: Modulo comune `lib/chat-turns/`

**Files:**
- Create: `artifacts/api-server/src/lib/chat-turns/spec.ts`, `artifacts/api-server/src/lib/chat-turns/control.ts`
- Modify: `artifacts/api-server/src/lib/node-turns/queue.ts`, `artifacts/api-server/src/middlewares/rate-limit.ts`
- Test: `artifacts/api-server/src/lib/chat-turns/control.test.ts`

**Interfaces:**
- Consumes: `abortTurn`, `isLiveTurn` (Task 2); `STOPPED_TURN_MESSAGE`.
- Produces:
  - `spec.ts`:
    ```ts
    export interface ChatKindSpec {
      kind: ChatTurnKind;                       // "character" | "plan" | "team"
      consumer: NodeTurnConsumer;               // "character" | "plan_chat" | "team_chat"
      conversationsTable: string;               // nome SQL: "character_conversations" | "plan_conversations" | "team_chat_conversations"
      messagesTable: string;                    // "character_messages" | "plan_messages" | "team_chat_messages"
      hasPageContext: boolean;                  // solo character_messages ha page_context
      start(conversationId: number, content: string, page: PageContext | null): Promise<{ id: number }>;
    }
    ```
    (SQL con `sql.identifier` sui nomi delle tabelle: le colonne usate — `id`, `conversation_id`, `role`, `content`, `error`, `queued_at`,
    `page_context`, `turn_status`, `updated_at` — hanno lo stesso nome nelle tre.)
  - `control.ts`:
    - `closeTurnAsStopped(spec, conversationId): Promise<boolean>` — in una transazione: conversazione `running` → `idle` (`updated_at`), ultimo
      messaggio assistente con `content = ''` → `STOPPED_TURN_MESSAGE`, `error = false`; true se qualcosa è cambiato. Poi
      `cancelOpenTurnsFor(spec.consumer, conversationId)`.
    - `stopChatTurn(spec, conversationId): Promise<boolean>` — `abortTurn`; se true attende (polling 100 ms, max 10 s) che la conversazione sia
      `idle` o che il messaggio del turno fermato non sia più vuoto, e restituisce true; altrimenti `closeTurnAsStopped` e, se ha chiuso,
      `drainQueued`.
    - `queueChatMessage(spec, conversationId, content, page): Promise<{ id: number; content: string; createdAt: Date }>` — upsert del messaggio
      in coda (`role = 'user'`, `queued_at = now()` solo alla prima inserzione; `ON CONFLICT` sull'indice parziale aggiorna testo e pagina).
    - `cancelQueued(spec, conversationId): Promise<void>`.
    - `getQueued(spec, conversationId): Promise<{ id; content; createdAt } | null>`.
    - `drainQueued(spec, conversationId): Promise<void>` — non lancia mai: legge il messaggio in coda; se c'è chiama `spec.start(…)`; riuscito →
      cancella la riga in coda (per id); `TurnBusyError` o errori 4xx (`CharacterError`, `PlanChatError`/equivalenti, `InstanceError`) → la riga
      resta; altri errori → log `warn` con id e nome dell'errore, la riga resta.
  - `queue.ts`: `cancelOpenTurnsFor(consumer: NodeTurnConsumer, refId: number): Promise<number>` (come `cancelTurn`, per tutti i turni aperti
    di quel consumatore e riferimento; notifica i chiusi).
  - `rate-limit.ts`: `consumeTurnStop(userId: number): boolean` (30/min).

- [ ] **Step 1: test** (PGlite, conversazione di personaggio con turno `running` e messaggio assistente vuoto; `spec` di prova con `start` finto):
  - `closeTurnAsStopped chiude una volta sola`: prima chiamata true e messaggio «Risposta interrotta.» con `error=false`, seconda false.
  - `closeTurnAsStopped annulla i turni del nodo aperti della conversazione` (riga `node_turns` `queued` → `cancelled`).
  - `queueChatMessage sostituisce il testo e conserva queued_at`.
  - `drainQueued avvia e toglie la riga`; `drainQueued con start che lancia TurnBusyError lascia la riga`; `drainQueued senza coda non chiama start`.
  - `stopChatTurn con turno vivo in questo processo` (`trackTurn` con un `run` che attende il segnale e poi chiude la conversazione) → true entro
    il tempo; `stopChatTurn su turno non in corso` → false.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(casello): stop e coda comuni alle chat`.

### Task 4: Le tre chat usano segnale, scrittura condizionata e descrittore

**Files:**
- Modify: `artifacts/api-server/src/lib/characters/run-turn.ts`, `artifacts/api-server/src/lib/plan-chat/run-turn.ts`,
  `artifacts/api-server/src/lib/team-chat/run-turn.ts`, `artifacts/api-server/src/lib/memory/summaries.ts`
- Test: i `run-turn.test.ts` delle tre cartelle

**Interfaces:**
- Consumes: Task 2 e 3.
- Produces: `CHARACTER_CHAT_SPEC`, `PLAN_CHAT_SPEC`, `TEAM_CHAT_SPEC: ChatKindSpec` esportati dai tre `run-turn.ts` (`start` = `startCharacterTurn`
  / `startPlanTurn` / `startTeamChatTurn`, le ultime due ignorano `page`).

Per ognuna delle tre:
- `executeXTurn` passa il segnale di `trackTurn` a `runChatTurn`; esito `stopped` → contenuto `STOPPED_TURN_MESSAGE`, `isError = false`.
- Scrittura finale: UPDATE del messaggio assistente con `AND content = ''` e `returning`; nessuna riga → nessun aggiornamento dei totali né di
  `turn_status` (il turno è stato chiuso altrove). Dopo la scrittura (riuscita o no) `drainQueued(SPEC, conversationId)`.
- `loadHistory`, il conteggio dei messaggi per il titolo in `start*Turn` e le letture di `lib/memory/summaries.ts` escludono `queued_at IS NOT NULL`.
- `failInterrupted*` restituiscono già gli id chiusi: dopo la transazione `drainQueued` per ciascuno (anche dallo sweeper).

- [ ] **Step 1: test** (in ognuno dei tre file, con il modello finto lento già usato nei test esistenti o un `chat` che attende il segnale):
  - `stop durante il turno → «Risposta interrotta.», error false, conversazione idle, token del primo giro registrati`.
  - `scheda salvata prima dello stop resta pending e si accetta` (personaggi: `proponi_*`; piano: `propose`; squadra: `proponi_identita`).
  - `turno chiuso altrove`: `closeTurnAsStopped` mentre il turno gira, poi il turno finisce → il messaggio resta «Risposta interrotta.» e
    `tokens_used` non cambia.
  - `a fine turno parte il messaggio in coda` (messaggio accodato durante il turno → nuovo messaggio utente con id maggiore e nuovo turno).
  - `la cronologia non contiene il messaggio in coda`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS (anche tutti i test esistenti dei tre file) + typecheck.
- [ ] **Step 5: Commit** `feat(casello): turni di chat fermabili con coda dei messaggi`.

### Task 5: API (OpenAPI, route, codegen)

**Files:**
- Modify: `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/routes/characters.ts`, `routes/plan-chat.ts`, `routes/team-chat.ts`, i
  serializzatori dei dettagli delle tre conversazioni; rigenera `lib/api-client-react/src/generated/` e gli schemi Zod
- Test: `artifacts/api-server/src/routes/characters.test.ts`, `plan-chat.test.ts`, `team-chat.test.ts`

**Interfaces:**
- Produces (OpenAPI):
  - `ChatSendMode: enum [normal, now, queue]`; campo facoltativo `mode` in `CharacterMessageCreate`, `PlanMessageCreate`, `TeamChatMessageCreate`.
  - `QueuedChatMessage: { id: integer, content: string, createdAt: date-time }`; campo `queuedMessage: QueuedChatMessage | null` (obbligatorio,
    nullable) in `CharacterConversationDetail`, `PlanConversationDetail`, `TeamChatConversationDetail`.
  - `ChatTurnStopResult: { stopped: boolean }`.
  - `POST /character-conversations/{id}/stop`, `POST /plan-conversations/{id}/stop`, `POST /team-chat-conversations/{id}/stop` → 200
    `ChatTurnStopResult` (operationId `stopCharacterTurn`, `stopPlanTurn`, `stopTeamChatTurn`); 404 conversazione altrui; 429 «Troppe richieste:
    riprova tra poco».
  - `DELETE /character-conversations/{id}/queued`, `/plan-conversations/{id}/queued`, `/team-chat-conversations/{id}/queued` → 204
    (`cancelQueuedCharacterMessage`, `cancelQueuedPlanMessage`, `cancelQueuedTeamChatMessage`).

Comportamento delle route `…/messages` (validazioni e limiti di oggi prima di tutto):
- `normal` o assente: come oggi.
- `queue`: conversazione `running` → `queueChatMessage`, 202 con il messaggio in coda; altrimenti `start*Turn` come `normal`. Se nel frattempo
  il turno finisce prima dell'upsert, chiama `drainQueued` subito dopo l'upsert quando la conversazione è già `idle`.
- `now`: conversazione `running` → `queueChatMessage` + `stopChatTurn`, 202 con il messaggio in coda; altrimenti come `normal`.

- [ ] **Step 1: test di route**:
  - `POST …/stop` su turno in corso → `{ stopped: true }` e messaggio «Risposta interrotta.»; ripetuto → `{ stopped: false }`; altrui → 404;
    31ª chiamata in un minuto → 429.
  - `mode=now` con turno in corso → 202; alla fine la cronologia ha il turno fermato e un nuovo messaggio utente con il testo nuovo seguito da una
    risposta; nessun 409.
  - `due mode=now ravvicinati` → entrambi 202, un solo turno in corso, l'ultimo testo è quello che parte (Review Focus 2).
  - `mode=queue` → `queuedMessage` nel dettaglio; un secondo `queue` sostituisce il testo; `DELETE …/queued` → 204 e `queuedMessage` null.
  - `coda su conversazione archiviata nel frattempo` → nessun 500, `queuedMessage` resta (Review Focus 4; per la squadra: squadra chiusa).
  - `riavvio con un messaggio in coda`: `failInterruptedCharacterTurns()` chiude e fa partire il messaggio in coda (Review Focus 5).
  - token personale `api:read` su `…/stop` → 403.
- [ ] **Step 2:** FAIL. **Step 3:** OpenAPI, `pnpm --filter @workspace/api-spec run codegen`, route e serializzatori. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(casello): route per fermare i turni e accodare i messaggi` (con i file generati).

### Task 6: Console

**Files:**
- Modify: `artifacts/casello/src/components/characters/adapters.ts`, `character-adapters.ts`, `plan-team-adapters.tsx`, `character-chat.tsx`,
  `turn-progress-view.tsx`
- Test: `artifacts/casello/src/components/characters/chat-send.test.ts` (logica pura dei pulsanti)

**Interfaces:**
- Consumes: hook Orval di Task 5.
- Produces:
  - `ChatAdapter.send(id: number, content: string, mode?: "normal" | "now" | "queue"): Promise<void>`;
    `ChatAdapter.stop(id: number): Promise<void>`; `ChatAdapter.cancelQueued(id: number): Promise<void>`;
    `ConvDetail.queuedMessage: { id: number; content: string } | null`.
  - `chat-send.ts`: `sendActions(state: { running: boolean; readOnly: boolean; empty: boolean }): Array<"send" | "now" | "queue">` —
    idle: `["send"]`; running: `["now", "queue"]`; readOnly o testo vuoto: `[]`.

UI (`character-chat.tsx`):
- casella sempre attiva tranne in sola lettura;
- durante il turno, accanto all'avanzamento, «Ferma» (`variant="secondary"`); pulsanti d'invio «Invia subito» (`default`) e «Accoda» (`outline`);
  Invio da tastiera = «Invia subito»;
- sotto l'avanzamento il messaggio in coda: etichetta «In coda» (`text-label`, `text-ink-muted`), testo su due righe al più, «Annulla» (`ghost`);
- dopo un'azione il polling continua finché la conversazione è `running` o c'è un messaggio in coda (stessa regola di grazia di oggi).

- [ ] **Step 1: test** di `sendActions` (i quattro casi sopra).
- [ ] **Step 2:** FAIL. **Step 3:** implementa adattatori e UI. **Step 4:** `pnpm --filter @workspace/casello run test` PASS + typecheck.
- [ ] **Step 5: verifica nel browser** (`AUTH_DISABLED=true pnpm run dev`, modello finto lento o reale): nel pannello di Lucius e nella chat del
  piano: «Ferma», «Invia subito», «Accoda» e «Annulla» a 1280 px senza scorrimento orizzontale, tema chiaro e scuro, e a 390 px.
- [ ] **Step 6: Commit** `feat(casello): Ferma, Invia subito e Accoda nelle chat`.

### Task 7: Documentazione e PR

**Files:**
- Modify: `CLAUDE.md` (riga nello «Stato»; sezioni «Alfred e Lucius nelle aree», «Chat del piano», «Lucius sulla squadra e memorie», «Esecutore
  Claude Code (nodo)» per il turno `cancelled` da Ferma), spec (§«Differenze dal codice» se serve)

- [ ] **Step 1:** aggiorna `CLAUDE.md`.
- [ ] **Step 2:** `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test` → tutti verdi.
- [ ] **Step 3: Commit** `docs(casello): Ferma e Accoda nelle chat`.
- [ ] **Step 4:** SQL completo di `2026-11-ferma-accoda.sql` in chat a Ivan; push del branch; PR con `gh` (cosa cambia, come si è provato,
  migrazione da applicare su Neon PRIMA del merge). Merge solo dopo il sì di Ivan.
