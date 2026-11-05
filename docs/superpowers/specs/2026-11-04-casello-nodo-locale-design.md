# Casello: nodo locale per i ruoli `node` delle squadre (design)

Data: 2026-11-04. Sottoprogetto 4 della specifica «squadre di agenti in Casello» (bozza v0.2). Parte dall'esecuzione
delle squadre (`docs/superpowers/specs/2026-11-04-casello-squadre-esecuzione-design.md`), dove i compiti dei ruoli
`node` restano `waiting_node`.

## 1. Scopo e decisioni prese

Un compito di un ruolo `node` (es. Backend developer SAP) non gira in Casello ma presso un **nodo**: un esecutore
esterno che prende il compito con una lease, lo esegue e riferisce. Casello conosce solo il protocollo e le capacità
dichiarate; come il nodo esegue è affar suo. Oggi l'unico nodo è `casello-nodo` sul Mac di Ivan con Claude Code;
l'architettura deve restare aperta a nodi remoti o in cloud.

Decisioni:

- **Servizio sempre attivo** sul Mac (`casello-nodo`, avviato da launchd), non legato all'app Claude.
- **Spazio di lavoro dichiarato dalla squadra** (`team_instances.node_workspace`, es. `SAP/AIMAG/CR/DS5100/WI_1174_ART_38`),
  interpretato dal nodo rispetto alla sua radice.
- **Nodi registrati** per utente, con un token dall'ambito `node` e capacità dichiarate (skill disponibili, executor);
  un compito va solo a un nodo dello stesso utente che ha tutte le skill `node` del ruolo.
- **Allegati in ingresso**: caricati in Casello, scaricati dal nodo nello spazio di lavoro prima dell'esecuzione. Niente
  file in uscita in questo giro.
- Lezioni del lanciatore `agenti-sap`: permessi bypass in background, sessione nuova per ogni compito (mai riprendere),
  ID completo della sessione, verifica delle azioni manuali da parte dell'operaio.

Fuori ambito: file prodotti dal nodo verso Casello; esecutori diversi da Claude Code (il protocollo li ammette);
organizzazioni; The Hub Up.

## 2. Dati

- `nodes`: `id`, `user_id` (FK, cascade), `name` (1..80, unico per utente), `status` (`active` | `disabled`),
  `executor` (testo dichiarato, es. `claude-code`), `version`, `skills` (jsonb, elenco di nomi dichiarati, max 500 da
  100 caratteri), `workspace_root` (testo descrittivo, max 300), `max_concurrent` (1..3, dichiarato), `last_seen_at`,
  `created_at`, `updated_at`.
- `api_tokens.node_id` (FK `nodes`, cascade): un token con `node_id` ha l'unico ambito `node`; creato insieme al nodo,
  mostrato una volta, salvato come hash come gli altri.
- `team_instances.node_workspace` (testo nullable, max 300, relativo: niente `/` iniziale, niente segmenti `..`, solo
  `[A-Za-z0-9._ -]` e `/`).
- `team_tasks`: `node_id` (FK `nodes`, `SET NULL`), `lease_token` (testo casuale), `lease_expires_at`, `session_id`,
  `waiting_since` (quando è entrato in `waiting_node`), `no_node_notified` (boolean, default false).
- `team_attachments`: `id`, `instance_id` (FK cascade), `name` (max 200, senza separatori di percorso), `content_type`,
  `size_bytes`, `sha256`, `content` (`bytea`), `uploaded_by` (FK `users`, `SET NULL`), `created_at`, `deleted_at`.
  Limiti: 10 MB per file, 50 MB per squadra (allegati non eliminati). Un allegato eliminato resta disponibile ai
  compiti che lo citavano già (si elimina solo dall'elenco: `deleted_at`).

## 3. Protocollo del nodo

Route `/api/node/…`, accessibili solo con un token d'ambito `node` (un token `node` su qualsiasi altra route di `/api`
o su `/mcp` → 403; un token senza `node` o la sessione su `/api/node` → 403). Il nodo è quello del token.

- `POST /api/node/heartbeat` `{ version, executor, skills, workspaceRoot, maxConcurrent }` → aggiorna il nodo e
  `last_seen_at`; risposta `{ pending: number }` (compiti che potrebbe prendere). Nodo `disabled` → 403.
- `POST /api/node/claim` → in una transazione: un compito `waiting_node` di una squadra `active` con
  `activated_by` = utente del nodo, il cui ruolo ha tutte le skill `node` (codici del catalogo e specializzate di tipo
  `node`, confrontate per nome della skill sul nodo) presenti in `nodes.skills`, il più vecchio per `waiting_since`;
  rispetta `max_concurrent` (compiti `running` del nodo); lo porta a `running` con `node_id`, `lease_token`,
  `lease_expires_at = now + 15 min`, `started_at`; aggiorna lo stato del compito nel PLAN (`patchPlan`, dopo il commit).
  Risposta: il **pacchetto** (sotto) oppure 204.
- `POST /api/node/tasks/:id/ping` `{ leaseToken }` → rinnova la lease di 15 min; lease non valida o scaduta → 409.
- `POST /api/node/tasks/:id/report` `{ leaseToken, status: done|blocked|failed, outcome (max 300), detail (max 20 000),
  costUsd?, promptTokens?, completionTokens?, sessionId? }` → chiude il compito come i compiti cloud (stato ed esito nel
  PLAN, evento `compito_finito`/`bloccato`, turno del capo con `task_finished`); lease non valida o scaduta → 409, nulla
  salvato.
- `GET /api/node/tasks/:id/attachments/:attachmentId` (header `X-Lease-Token`) → contenuto dell'allegato, solo se
  citato dal compito e con la lease valida.
- **Pacchetto**: `taskId`, `leaseToken`, `leaseExpiresAt`, squadra (id, nome, lavoro di riferimento),
  `workspace` (`node_workspace`, null se non impostato), ruolo (nome, compito, modello preferito come testo indicativo),
  istruzioni del compito, PLAN (obiettivo, vincoli, compiti con stato ed esito, azioni manuali con stato, punti aperti),
  skill di Casello (codice, versione, testo), skill `node` (nomi), allegati citati (id, nome, dimensione, sha256).
- **Scadenza della lease** (controllo periodico ogni minuto nel processo dell'API e all'avvio): compiti `running` con
  `node_id` e lease scaduta → `failed` («nodo non più raggiungibile»), evento `bloccato`, turno del capo.
- **Nessun nodo adatto**: compiti `waiting_node` da più di 10 minuti senza alcun nodo `active` dell'utente con le skill
  del ruolo e con `last_seen_at` negli ultimi 2 minuti → evento `bloccato` «nessun nodo disponibile con le skill: …»
  (una volta per compito, `no_node_notified`); il compito resta in attesa.
- I compiti `node` non entrano nel limite di 3 compiti cloud contemporanei della squadra; il limite è `max_concurrent`
  del nodo.

## 4. Allegati e spazio di lavoro

- Route (login o token `api:write`): `POST /api/team-instances/:id/attachments` (corpo grezzo, nome in
  `X-Attachment-Name`, tipo in `Content-Type`; 413 oltre i limiti), `GET …/attachments` (elenco senza contenuto),
  `GET …/attachments/:attachmentId` (scarica), `DELETE …/attachments/:attachmentId` (elimina dall'elenco).
  `PUT /api/team-instances/:id` accetta `nodeWorkspace`. nginx: il limite del corpo già a 51 MB copre i 10 MB.
- Il capo vede nel suo contesto l'elenco degli allegati (id e nome) e nelle istruzioni di un compito li cita con
  `allegato:<id>`; `assegna_compito` accetta un campo facoltativo `attachments: number[]` (allegati dell'istanza non
  eliminati) che va nel compito (`team_tasks.attachment_ids` jsonb).
- I compiti cloud ignorano gli allegati (non hanno file system); il capo li cita solo per ruoli `node`.

## 5. `casello-nodo`

- Pacchetto `artifacts/casello-nodo` (Node 24, TypeScript, solo dipendenze già nel workspace); eseguibile
  `casello-nodo` con comandi `install` (crea `~/Library/LaunchAgents/cloud.fantamister.casello-nodo.plist`, avvio al
  login, riavvio se cade), `uninstall`, `status`, `run` (in primo piano).
- Configurazione `~/.casello-nodo/config.json` (permessi 600, verificati all'avvio): `caselloUrl`, `token`,
  `workspaceRoot`, `claudeBin`, `permissionMode` (default `bypassPermissions`), `skillsDirs` (default
  `~/.claude/skills` e le cartelle delle skill dei plugin), `maxConcurrent` (1..3, default 1), `taskTimeoutMinutes`
  (default 60).
- Capacità: `skills` = nomi delle cartelle che contengono `SKILL.md` in `skillsDirs` (per i plugin `plugin:skill`),
  `executor = "claude-code"`, `version` del pacchetto.
- Ciclo: heartbeat ogni 30 s; se `pending > 0` e c'è posto, claim; per ogni compito:
  1. spazio di lavoro: `workspaceRoot` + `workspace` normalizzato; se manca, è fuori dalla radice (anche dopo i link
     simbolici: `realpath`) o non esiste → report `blocked` «spazio di lavoro non valido»;
  2. allegati in `<spazio>/casello-allegati/` con verifica sha256 (errore → `failed` «allegato non valido»);
  3. pacchetto scritto in `<spazio>/casello-compito.md` (istruzioni per l'operaio: leggere PLAN e istruzioni, usare le
     skill elencate, verificare prima di proseguire che le azioni manuali segnate come fatte lo siano davvero, alla
     fine scrivere `casello-esito.json` con `{ status, outcome, detail }`);
  4. `claude -p --output-format json --session-id <uuid> [--dangerously-skip-permissions | --permission-mode …]
     "Leggi casello-compito.md in questa cartella ed eseguilo."` con cwd nello spazio di lavoro;
  5. ping ogni 5 minuti; oltre `taskTimeoutMinutes` il processo è terminato e il report è `failed` («tempo massimo
     superato»);
  6. esito da `casello-esito.json` se valido, altrimenti dal risultato JSON della CLI (`status: done`, esito troncato a
     300, dettaglio a 20 000); costo da `total_cost_usd`, token se presenti; `sessionId` = l'uuid;
  7. report; `casello-compito.md` e `casello-esito.json` rimossi dopo il report (restano solo nei log del nodo).
- Errori di rete: nuovi tentativi con attesa crescente (max 5 minuti); un report non consegnato si ritenta finché la
  lease è valida.
- Log in `~/.casello-nodo/logs/` (rotazione a 10 MB, 5 file): mai token, contenuti degli allegati o del pacchetto.

## 6. Costi

Il costo riferito dal nodo va in `team_tasks.cost_usd` con `ai_model_id` null: conta nel tetto della squadra, non nei
tetti di modello/account/utente (un login di Claude Code non è un account AI di Casello). Prima del claim vale il tetto
della squadra (raggiunto → nessun claim, evento `bloccato` come per i compiti cloud).

## 7. Console

- Account → «Nodi»: elenco (nome, stato, ultimo contatto, versione, executor, skill dichiarate), «Nuovo nodo» (crea nodo
  e token, mostrato una volta con le istruzioni: `npx casello-nodo install` o il comando del repo), «Disattiva»,
  «Rigenera token», «Elimina».
- Scheda della squadra: campo «Spazio di lavoro sul nodo»; sezione «Allegati» (carica, elenco con dimensione, elimina);
  nei compiti `node` il nodo, la lease e l'id della sessione.
- Niente scorrimento orizzontale a 1280 px.

## 8. Dati di produzione

`docs/migrations/2026-11-nodo-locale.sql`, additiva e idempotente, PRIMA del merge: `nodes`, `team_attachments`,
`api_tokens.node_id`, `team_instances.node_workspace`, colonne nuove di `team_tasks` (`node_id`, `lease_token`,
`lease_expires_at`, `session_id`, `waiting_since`, `no_node_notified`, `attachment_ids`). Nessuna colonna tolta.

## 9. Test

- API: heartbeat e capacità; claim filtrato per utente, squadra attiva, skill e `max_concurrent`; lease, ping, scadenza
  (`failed`, evento, turno); report con lease scaduta → 409; evento «nessun nodo» una volta sola; token `node` rifiutato
  su `/api` e `/mcp`, token senza `node` rifiutato su `/api/node`; nodo disabilitato; allegati (limiti, sha256, accesso
  solo con lease e se citati, eliminazione che non tocca i compiti già assegnati); `node_workspace` non valido → 400;
  tetto della squadra blocca il claim.
- `casello-nodo` con un Casello finto (server HTTP) e un `claude` finto (script): ciclo completo, spazio di lavoro fuori
  dalla radice o inesistente, allegato con sha sbagliato, esito dal file e dalla CLI, tempo massimo, ping, errori di
  rete con nuovo tentativo, permessi del file di configurazione.
- Prova nel browser di «Nodi», allegati e spazio di lavoro; prova reale sul Mac con un compito semplice in una cartella
  di prova.
