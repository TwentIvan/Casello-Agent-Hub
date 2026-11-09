# Botcave: esecutore «Claude Code (nodo)»

Data: 2026-11-09. Stato: approvato nel brainstorming con Ivan, da rivedere come testo.

## 1. Scopo

Oggi Alfred scritto, Lucius (aree, chat del piano, chat di squadra) e gli agenti delle App chiamano solo modelli cloud con
una chiave (account AI). Ivan ha un posto Claude Team aziendale («Derga Dev») già pagato, con le sue policy. Obiettivo:
scegliere «Claude Code (nodo)» come si sceglie un modello, e far eseguire i turni di quelle conversazioni e run a
`casello-nodo` sul Mac con `claude -p`, con le stesse regole di oggi (L2 in «Da confermare», schede da accettare, nessun
segreto sul Mac).

Ambito della prima consegna: conversazioni dei personaggi (Alfred scritto, Lucius nelle aree), chat del piano, chat di
squadra e run degli agenti (inneschi compresi). Fuori ambito: la voce di Alfred (resta Gemini Live), i turni del capo e i
compiti `cloud` delle squadre (restano sui modelli cloud; i ruoli `node` hanno già il loro percorso), le analisi
dell'architetto (hanno l'esecutore locale via `/mcp`).

Decisioni prese con Ivan:

- **Costi**: il costo riferito da `claude -p` (`total_cost_usd`, equivalente a listino API) si registra come quello di
  qualsiasi modello e conta in tutti i tetti (utente, agente, personaggio, account, modello). `lib/budget.ts` non cambia.
- **Nodo non disponibile**: modello cloud di ripiego facoltativo sull'account nodo, uno per account, valido per tutti i
  consumatori; senza ripiego errore chiaro.
- **Modelli**: i quattro alias di Claude Code (`fable`, `opus`, `sonnet`, `haiku`) più tutti i modelli Anthropic del
  catalogo non ritirati.
- **Approccio**: si delega l'intero turno (ciclo nativo di Claude Code, strumenti su un MCP per turno), non la singola
  chiamata al modello.

Verifiche fatte sul Mac di Ivan: `claude` 2.1.319, login claude.ai, organizzazione «Derga Dev», piano `team`; nessuna
policy gestita locale (`/Library/Application Support/ClaudeCode/` assente), quindi nessuna lista che limiti i server MCP.
`--bare` non si usa (non legge il login OAuth). Da sapere: i turni consumano i limiti d'uso del posto di Ivan (un innesco
attivo può toglierne al lavoro interattivo); le policy impostate dalla console di amministrazione claude.ai non sono
visibili in locale (se l'amministratore Derga è un altro, va chiesto).

## 2. Dati e account

### Provider

Nel registro (`lib/catalog/provider-registry-data.ts`) entra `claude_code_node`, nome «Claude Code (nodo)», protocollo
nuovo `claude_code_node` (valore dell'enum `provider_protocol`), stato `managed`, senza indirizzo predefinito e senza nomi
nelle fonti del catalogo. In `lib/ai/executor.ts` `ExecutorKind` diventa `"openai_compatible" | "node"` (il `local_agent`
dichiarato e mai usato si toglie); `executorKindFor("claude_code_node") = "node"`.

### Account nodo

Colonne nuove su `ai_accounts`:

- `node_id` integer, FK `nodes(id)` `ON DELETE SET NULL`; indice unico parziale (un account per nodo).
- `fallback_ai_model_id` integer, FK `ai_models(id)` `ON DELETE SET NULL`.

Regole:

- Provider `claude_code_node` ⇔ `node_id` valorizzato alla creazione; `base_url` vuoto, `api_key_enc` null,
  `allow_private_network` false.
- Il nodo deve essere dell'utente e `active` (altrimenti 400 «nodo non disponibile»); nodo già legato a un account → 409
  «il nodo ha già un account Claude Code».
- Ripiego: modello di un account **non nodo** dello stesso utente, altrimenti 400 «modello di ripiego non valido». Si può
  cambiare o togliere con la PATCH dell'account (solo login, come oggi).
- Nodo eliminato (`node_id` diventa null) → l'account resta, i suoi turni vanno al ripiego o falliscono con «nodo
  eliminato».
- `resolveModel` per un account nodo non valida indirizzi né decifra chiavi: restituisce `kind: "node"`, `nodeId`,
  `fallbackAiModelId`, nome del modello (`modelId`) e proprietario. `modelChat` su un `kind: "node"` resta un errore di
  programmazione (non deve mai arrivarci).
- Route: le esistenti `/api/ai/accounts` accettano `provider: "claude_code_node"` con `nodeId` (e `fallbackAiModelId`
  facoltativo); la risposta espone `nodeId`, `nodeName`, `nodeTurnReady`, `fallbackAiModelId`. «Verifica» su un account nodo
  riallinea i modelli e aggiorna lo stato (`ok` se il nodo è pronto per i turni, altrimenti `error` con «nodo offline» o
  «nodo eliminato»; nessuna chiamata di rete).

### Modelli dell'account

Righe `ai_models` dell'account, create alla creazione e riallineate a ogni «Verifica» e a ogni aggiornamento del catalogo
(stesse regole di oggi: un modello sparito diventa `unavailable`, mai cancellato):

- alias `fable`, `opus`, `sonnet`, `haiku`, nome visibile «<alias> (ultimo)»;
- i modelli delle offerte del provider `anthropic` in `model_offers` non ritirati, con l'id del modello come nel catalogo
  (es. `claude-sonnet-5-5`), passato così com'è a `--model`.

Prezzi nulli (il costo non si calcola dai token: lo riferisce il nodo), `supports_tools = true`, `availability = unknown`
finché un turno non riesce (`available`) o il nodo riferisce `model_unavailable` (`unavailable`, come un 404 del provider).

### Coda dei turni

Tabella nuova `node_turns`:

| colonna | tipo | note |
|---|---|---|
| `id` | serial | |
| `node_id` | integer FK `nodes` `ON DELETE SET NULL` | nodo a cui è destinato |
| `user_id` | integer FK `users` `CASCADE` | proprietario dell'account nodo |
| `ai_model_id` | integer FK `ai_models` `SET NULL` | |
| `consumer` | enum `node_turn_consumer`: `character`, `plan_chat`, `team_chat`, `run` | |
| `ref_id` | integer | id della conversazione o della run |
| `message_id` | integer null | messaggio dell'assistente (chat) |
| `status` | enum `node_turn_status`: `queued`, `running`, `done`, `failed`, `cancelled`, `expired` | |
| `package` | jsonb null | pacchetto del turno; svuotato (null) alla chiusura |
| `turn_token_hash` | text | SHA-256 del token `cat_…` |
| `lease_token` | text null | |
| `lease_expires_at` | timestamp null | |
| `content` | text null | risposta (≤ 20 000) |
| `error_code` | text null | codice chiuso, §5 |
| `prompt_tokens`, `completion_tokens`, `cached_tokens` | integer null | |
| `cost_usd` | numeric(12,6) null | |
| `session_id` | text null | sessione di Claude Code |
| `created_at`, `claimed_at`, `finished_at` | timestamp | |

Indici: `(node_id, status, created_at)` per la presa; unico su `turn_token_hash`.

Colonna nuova `nodes.last_turn_poll_at` (timestamp null).

La tabella è la traccia tecnica del turno; il risultato vero sta dove sta oggi (messaggio della conversazione, run).
Pulizia: le righe chiuse da oltre 30 giorni si cancellano nel controllo orario.

## 3. Protocollo del nodo per i turni

Stesso token del nodo (ambito `node`), route sotto `/api/node/turns` (`requireNodeToken`). Logica in
`artifacts/api-server/src/lib/node-turns/`.

- `POST /api/node/turns/claim` (corpo `{}`): aggiorna `last_turn_poll_at`; se c'è un turno `queued` del nodo (dal più
  vecchio) lo prende con UPDATE condizionato (`FOR UPDATE SKIP LOCKED`), imposta `running`, `claimed_at`, `lease_token`,
  lease di 2 minuti e risponde 200 con il pacchetto. Altrimenti attende fino a 25 s (`TURN_POLL_WAIT_MS`) un avviso in
  memoria (`EventEmitter` per nodo, emesso da `delegateTurn`) e ritenta una volta; poi 204. Richiesta chiusa dal client →
  attesa annullata. 40 richieste/min per nodo (contatore separato da heartbeat e claim dei compiti). Nodo disattivato → 403
  come oggi.
- `POST /api/node/turns/:id/ping` `{leaseToken}`: rinnova la lease di 2 minuti; turno chiuso, annullato o lease diversa →
  409 «lease non valida o scaduta» (il nodo termina `claude`). 6/min per turno.
- `POST /api/node/turns/:id/report` `{leaseToken, status: done|failed, content?, errorCode?, promptTokens?,
  completionTokens?, cachedTokens?, costUsd?, sessionId?}`: chiude il turno una volta sola (UPDATE condizionato alla lease
  e a `running`), 204; altrimenti 409. `content` troncato a 20 000; `errorCode` fuori dall'elenco → `claude_failed`;
  numeri interi ≥ 0 (costo ≥ 0) altrimenti 400. Svuota `package`.
- **Pronto per i turni**: nodo `active` con `last_turn_poll_at` negli ultimi 60 s (`TURN_READY_WINDOW_MS`). Un nodo di
  versione precedente (senza ciclo dei turni) non è mai pronto.
- **Scadenze** (controllo ogni 5 s, `startNodeTurnSweeper`): `queued` da oltre 20 s (`TURN_CLAIM_TIMEOUT_MS`) →
  `expired`; `running` con lease scaduta → `failed` `lease_lost`. Ogni chiusura risolve l'attesa di chi ha delegato.
- **Avvio dell'API**: i turni `queued` e `running` diventano `failed` `restart` (il registro in memoria è perso: nessun
  token resta valido senza dispatcher). I chiamanti sono già chiusi dalle loro pulizie (`failInterruptedCharacterTurns`,
  `failInterruptedRuns`…).
- **Disattivazione, eliminazione, «Rigenera token» del nodo**: i turni `queued`/`running` del nodo chiudono `failed`
  `node_disabled` nella stessa transazione delle operazioni di oggi.

### Pacchetto

```json
{
  "id": 12,
  "leaseToken": "…",
  "model": "sonnet",
  "systemPrompt": "…",
  "prompt": "…",
  "mcpUrl": "https://casello.fantamister.cloud/mcp/turn",
  "turnToken": "cat_…",
  "maxTurns": 7,
  "timeoutMs": 300000
}
```

- `systemPrompt`: il messaggio `system` del turno più la riga «Gli strumenti di Botcave si chiamano
  mcp__botcave__<nome>: usa solo quelli.».
- `prompt`: tutti gli altri messaggi in ordine, ciascuno preceduto dalla sua etichetta (`[utente]`, `[assistente]`); i
  messaggi di dati restano con i loro delimitatori `<dati>`. Il nodo lo passa su stdin.
- `maxTurns`: giri di strumenti del turno di oggi + 1 (chat 7, run 9, Responsabile 13).
- `timeoutMs`: 300 000; 600 000 per il Responsabile di prodotto. Il limite di token non si può imporre a Claude Code: si
  registra soltanto.

## 4. Server MCP del turno (`/mcp/turn`)

- `POST /mcp/turn`, Streamable HTTP stateless (come `/mcp`), sotto la `location /mcp` di nginx (nessuna modifica a nginx).
  Server di basso livello dell'SDK MCP (`Server` con gestori `tools/list` e `tools/call`), perché gli schemi degli
  strumenti sono JSON Schema già pronti, non Zod.
- Autenticazione: solo `Authorization: Bearer cat_…`; l'hash deve corrispondere a un turno `running` con lease valida,
  altrimenti 401 «token non valido o scaduto». Un `cat_…` su `/mcp` o `/api` è sconosciuto (401); un `cas_…` o `cao_…` su
  `/mcp/turn` è 401.
- Token: 32 byte casuali base64url con prefisso `cat_`, solo l'hash nel DB, mai nei log; vive finché il turno è
  `running`.
- **Registro in memoria** (`lib/node-turns/registry.ts`): `turnId → { tools: ChatCompletionFunctionTool[], dispatch(call:
  ChatToolCall): Promise<string>, calls }`, scritto da `delegateTurn` all'accodamento e tolto alla chiusura.
  - `tools/list` → gli strumenti così come sono (nome, descrizione, `parameters` come `inputSchema`).
  - `tools/call` → `ChatToolCall` (`id` casuale, `name`, `arguments` = JSON degli argomenti) → `dispatch` → testo;
    `isError: true` se il testo è JSON con `ok: false`.
  - Strumento sconosciuto → errore «strumento sconosciuto: <nome>».
- Limiti: 60 chiamate/min per turno; al massimo 4 × `maxTurns` chiamate per turno, poi «limite di strumenti del turno
  raggiunto»; corpo ≤ 2 MB. Log: id del turno, nome dello strumento, esito; mai argomenti né token.

## 5. Aggancio dei consumatori

### Chat (personaggi, piano, squadra)

`lib/node-turns/chat-turn.ts`: `runChatTurn(resolved, messages, deps, limits, tools)` con le stesse firme di
`runPlanTurn` più `runTool` come dispatcher:

- `resolved.kind === "openai_compatible"` → `runPlanTurn` come oggi.
- `resolved.kind === "node"` → `delegateTurn` (sotto), che restituisce lo stesso `PlanTurnOutcome` (`content` o `error`,
  `tokens`, `costUsd`).

`characters/run-turn.ts`, `plan-chat/run-turn.ts` e `team-chat/run-turn.ts` chiamano `runChatTurn` al posto di
`runPlanTurn`. Schede, memoria e `passa_a` funzionano da soli: passano dal dispatcher. Chiusura del turno e scrittura del
messaggio non cambiano.

### Run degli agenti

Da `runAgentLoop` si estrae `dispatchAgentCall(call, deps)` (`lib/agent-dispatch.ts`, puro come il ciclo): prepara la
chiamata (`prepareCall`: strumento esistente, JSON valido, `destinatario`/`sintesi` per le L2, validazione), la esegue,
la accoda o restituisce l'errore, scrive il passo con `onStep` e restituisce il testo per il modello. `runAgentLoop` la
usa per le chiamate non parallele (le L0 in parallelo restano raggruppate come oggi): stesso comportamento, stessi test.

In `run-executor.ts`, `driveLoop` con un modello `kind: "node"`:

- passa a `delegateTurn` i messaggi iniziali di oggi (prompt di sistema con data e descrizione funzionale, input della
  run), gli strumenti per il modello (`roleFunctionTools`, con `proponi` e `segnala_al_responsabile`) e come dispatcher
  `dispatchAgentCall` con gli stessi `executeTool`/`queueAction`/`onStep` di oggi (L1 → L2 con la conferma delle
  scritture compresa, perché gli strumenti passano da `withConfirmedWrites` come oggi);
- i passi `tool` e `queued` compaiono nella timeline mentre Claude lavora; a fine turno un passo `model` con la durata
  totale e la nota «Claude Code sul nodo «<nome>»»;
- esito `done` → run `succeeded` con l'output; `failed` → run `failed` con il messaggio fisso; token e costo riferiti nei
  totali della run;
- annullare la run (`cancelRun`) chiude il turno `cancelled`: il ping successivo del nodo riceve 409 e il nodo termina
  `claude`;
- coda delle run, limiti di concorrenza e inneschi invariati.

### `delegateTurn`

`lib/node-turns/delegate.ts`: `delegateTurn({ resolved, userId, consumer, refId, messageId?, messages, tools, dispatch,
maxTurns, timeoutMs, signal? })`:

1. Se il nodo non è pronto (o non c'è) → ripiego subito (§6).
2. Crea il token, la riga `queued`, registra strumenti e dispatcher, emette l'avviso al nodo.
3. Attende la chiusura del turno (report, scadenza, lease persa, annullamento con `signal`).
4. `done` → `{ok: true, content, tokens, costUsd}` e il modello diventa `available`; `expired`, `usage_limit`,
   `not_logged_in` → ripiego; altri errori → `{ok: false, error}` col messaggio fisso.
5. Toglie il registro in ogni caso.

## 6. Errori e ripiego

**Quando si ripiega**: nodo non pronto (nessun claim negli ultimi 60 s), disattivato o eliminato (deciso prima di
accodare, senza attendere); turno `expired` (non preso entro 20 s); `errorCode` `usage_limit` o `not_logged_in`.
**Mai** su `timeout`, `claude_failed`, `stopped`, `lease_lost`, `model_unavailable`: Claude può aver già chiamato
strumenti o accodato azioni, e rifare il turno le duplicherebbe.

**Ripiego**: modello `fallback_ai_model_id` dell'account nodo; prima di usarlo si controllano i tetti come per un modello
normale (`runBudgetBlock` per le run, `characterBudgetBlock` per i personaggi, controllo dell'utente per le chat del
piano e di squadra) e la sua usabilità (`resolveModel`).

- Chat: turno con `runPlanTurn` sul modello di ripiego; in fondo alla risposta «_(Claude Code non disponibile: risposta
  del modello di ripiego)_».
- Run: passo nella timeline «Claude Code non disponibile: eseguita con <nome del modello>»; `runs.ai_model_id` diventa il
  modello di ripiego (la spesa va al suo account).
- Limite noto: nelle chat il costo si cumula sulla conversazione con il suo modello, quindi la spesa di un turno fatto
  col ripiego si attribuisce all'account nodo (separarla richiederebbe un modello per messaggio).

**Senza ripiego**, messaggi fissi (`NODE_TURN_MESSAGES`):

| caso | messaggio |
|---|---|
| nodo non pronto / `expired` | Il nodo «<nome>» è offline: accendilo o scegli un altro modello |
| nodo eliminato | Il nodo di Claude Code è stato eliminato: scegli un altro modello |
| `usage_limit` | Claude Code ha raggiunto il limite d'uso del tuo account: riprova più tardi |
| `not_logged_in` | Claude Code non ha fatto l'accesso sul nodo: esegui claude e accedi |
| `model_unavailable` | Il modello non è disponibile per il tuo account Claude |
| `timeout` | Claude Code non ha risposto in tempo |
| `lease_lost` | Il nodo non è più raggiungibile |
| `stopped`, `node_disabled` | Esecuzione interrotta sul nodo |
| `restart` | Turno interrotto dal riavvio |
| `claude_failed` e altri | Claude Code non è riuscito a completare il turno |

Chat: messaggio d'errore dell'assistente; run: `failed` con lo stesso testo (si rilancia).

## 7. `casello-nodo`

- Ciclo dei turni (`turns.ts`) accanto a quello dei compiti: finché ci sono posti (`maxConcurrentTurns`, config, 1..4,
  default 2) chiama `claim` in continuo; un errore di rete attende 5 s; lo stop interrompe l'attesa.
- Per ogni turno: cartella temporanea vuota (`mkdtemp` in `~/.casello-nodo/turns/`), file `mcp.json` con permessi 600
  `{"mcpServers": {"botcave": {"type": "http", "url": mcpUrl, "headers": {"Authorization": "Bearer <turnToken>"}}}}`, poi:

  ```
  claude -p --output-format json --model <model> --system-prompt <systemPrompt> --tools "" \
    --strict-mcp-config --mcp-config <dir>/mcp.json --allowedTools "mcp__botcave__*" \
    --max-turns <maxTurns> --permission-mode dontAsk
  ```

  con il prompt su stdin, cwd la cartella temporanea, gruppo di processi proprio (come i compiti), ping ogni 30 s,
  timeout `timeoutMs` (SIGTERM, dopo 10 s SIGKILL). A fine turno la cartella si cancella.
- Esito dal JSON (`result`, `is_error`, `usage`, `total_cost_usd`, `session_id`, `subtype`): successo → `done` con
  `result`; `error_max_turns` → `done` se c'è un `result`, altrimenti `claude_failed`. Mappatura degli errori dal testo di
  `result`/stderr (solo per scegliere il codice, mai inoltrato): limite d'uso → `usage_limit`; accesso mancante →
  `not_logged_in`; modello non trovato o non disponibile → `model_unavailable`; timeout → `timeout`; stop → `stopped`;
  altro → `claude_failed`.
- 409/401/403 su ping o report = turno perso: si termina `claude`, nessun report.
- Log: id del turno, modello, durata, esito; mai prompt, risposta né token del turno.
- `status` mostra anche i turni in corso. README aggiornato.

## 8. Console

- Account → Account AI: «Aggiungi Claude Code (nodo)» (scelta del nodo tra i propri attivi, ripiego facoltativo tra i
  modelli dei propri account cloud); la scheda dell'account mostra nodo, LED `ok`/`idle` secondo la prontezza per i
  turni, ripiego («Modifica»). Tetti per account e modello come per gli altri.
- Account → Nodi: «pronto per i turni» (LED) e versione.
- Tendine dei modelli: i modelli dell'account nodo compaiono come gli altri, sotto il nome dell'account.
- Run: la timeline mostra il passo «Claude Code sul nodo «<nome>»» o il passo del ripiego.
- Niente scorrimento orizzontale a 1280 px; nessun colore fuori dai token.

## 9. Sicurezza

- `claude` gira senza strumenti propri (`--tools ""`), senza altri server MCP (`--strict-mcp-config`), in una cartella
  vuota: può solo chiamare gli strumenti di quel turno su Botcave, con le regole di sempre (livelli, coda, schede).
- Il token del turno vale per un turno solo, finché è `running`, e dà accesso solo a quegli strumenti; sul Mac sta nel
  `mcp.json` temporaneo (600), cancellato a fine turno.
- Nessun segreto delle app, nessuna chiave AI e nessun token personale passa al nodo.
- Il contenuto delle conversazioni passa per il Mac (prompt su stdin) e per i server di Anthropic con le policy
  dell'account aziendale: è lo scopo della funzione.

## 10. Migrazione

`docs/migrations/2026-11-esecutore-nodo.sql`, additiva e idempotente, niente `-post`:

- `ALTER TYPE provider_protocol ADD VALUE IF NOT EXISTS 'claude_code_node'` (fuori da una transazione esplicita);
- riga del provider nel registro (la scrive anche `ensureProviderRegistry` all'avvio);
- `ai_accounts.node_id`, `ai_accounts.fallback_ai_model_id`, indice unico parziale;
- `nodes.last_turn_poll_at`;
- enum `node_turn_consumer`, `node_turn_status`, tabella `node_turns` con indici.

Da applicare su Neon PRIMA del merge (SQL completo in chat) e da segnalare nella PR; riportata in
`docs/schema-casello.sql`. Nessuna variabile nuova.

## 11. Prove

- API (Vitest, PGlite): account nodo (creazione, regole, ripiego, modelli da alias e catalogo, riallineamento);
  `resolveModel` `kind: "node"`; long-poll (subito, risveglio, 204), lease, ping, report una volta sola, scadenze,
  riavvio, nodo disattivato; `/mcp/turn` (solo `cat_`, token morto a turno chiuso, `tools/list` esatto, `tools/call` via
  dispatcher, limiti); `dispatchAgentCall` (i test di `runAgentLoop` restano verdi) e run delegata con L2 in coda;
  ripiego e messaggi.
- Nodo: argomenti di lancio, `mcp.json` senza token nei log, lettura del JSON, codici d'errore, ciclo con
  `maxConcurrentTurns`, ping, stop.
- Flusso: script di prova con l'API locale e un nodo con un `claude` finto che chiama davvero `/mcp/turn` (chat di
  Lucius con una scheda, run con un'azione L2 in coda); poi un turno di Alfred scritto con il `claude` vero sul Mac di
  Ivan, in locale con `AUTH_DISABLED`.

## 12. Fuori ambito

Voce di Alfred; turni del capo e compiti `cloud` delle squadre; analisi dell'architetto; streaming della risposta
parziale; ripresa di una sessione di Claude Code tra turni (`--resume`): ogni turno riparte dal contesto che Botcave
ricostruisce, come per i modelli cloud.
