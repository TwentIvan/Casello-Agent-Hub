# Botcave Nodo senza terminale — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** installare, collegare, aggiornare, diagnosticare e disinstallare il nodo locale senza terminale, con «Botcave Nodo.app» e Account → Nodi.

**Architecture:** l'eseguibile unico (Node 24 SEA con `casello-nodo` dentro) fa da app al doppio clic (abbinamento dal browser,
menu con `osascript`) e da servizio sotto launchd; l'API aggiunge l'abbinamento in stile «device flow», un heartbeat esteso
(aggiornamento, impostazioni, richieste di diagnosi e disinstallazione, stato di Claude) e il manifest dei file pubblicati;
la CI costruisce l'app su macOS e la mette nell'immagine web.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), OpenAPI + Orval/Zod, React + Vite (console), Node 24 SEA,
`postject`, `lipo`/`codesign`, GitHub Actions `macos-latest`, nginx.

**Spec:** `docs/superpowers/specs/2026-11-10-botcave-nodo-senza-terminale-design.md` (vince sul piano).

## Global Constraints

- Italiano in commenti, documentazione, messaggi d'errore e commit (`feat(casello): …`, `feat(casello-nodo): …`); identificatori in inglese.
- Contract-first: ogni route o campo nuovo prima in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen`, file generati committati.
- Body/parametri con `parseRequest` (400), risposte con `*Response.parse`. Errori `{error}` con messaggi fissi, mai testo del DB.
- Console: solo hook di Orval, solo token di colore (niente esadecimali né classi di palette), stati con `Led`, niente scorrimento orizzontale a 1280 px.
- Migrazione additiva e idempotente `docs/migrations/2026-11-nodo-senza-terminale.sql` (niente `-post`), riportata in `docs/schema-casello.sql`.
- Mai token, codici di abbinamento, `pollSecret` o hash nei log.
- `pnpm run typecheck` verde prima di ogni commit; test dei pacchetti toccati verdi.
- Valori fissi della spec: codice 8 caratteri dall'alfabeto `ABCDEFGHJKMNPQRSTVWXYZ23456789`, mostrato `XXXX-XXXX`; scadenza 10 min;
  `pollSecret` 32 byte base64url; poll ogni 3 s; limiti `start` 10/min per IP, `poll` 30/min per richiesta, route d'account 20/min
  per utente; 5 tentativi falliti per codice; pulizia oltre 1 ora; aggiornamento: download ≤ 300 MB, 10 min, al più un tentativo
  all'ora, attesa del lavoro ≤ 30 min, ritorno indietro a 3 avvii entro 2 min; verifica di Claude ogni 10 min, comandi 10 s;
  installatore `https://claude.ai/install.sh`, 10 min; login verificato ogni 5 s per 10 min; diagnosi ≤ 256 KB, 500 righe, 7 giorni,
  richieste 6/ora per nodo; impostazioni `maxConcurrent 1..3`, `maxConcurrentTurns 1..4`, `taskTimeoutMinutes 5..240`;
  avviso del nuovo collegamento in Dashboard per 24 ore; login di Claude in scadenza entro 3 giorni.
- Bundle id `cloud.fantamister.botcave-nodo`; LaunchAgent invariato `cloud.fantamister.casello-nodo`; programma installato in
  `~/.casello-nodo/bin/casello-nodo` (e `casello-nodo.prev`); indirizzo predefinito `https://casello.fantamister.cloud`, variabile di sviluppo `BOTCAVE_NODO_URL`.

## Review Focus

1. Un nodo di versione precedente (CLI 0.2.0, heartbeat senza i campi nuovi) deve continuare a funzionare: tutti i campi nuovi sono facoltativi in richiesta e risposta (Task 3).
2. Doppia consegna del token: due `poll` concorrenti su una richiesta approvata → un solo 200 con token, l'altro 410 (Task 2).
3. Aggiornamento interrotto a metà (download troncato, sha256 diverso, processo ucciso durante il rename) non lascia mai un programma rotto: il file installato è sempre intero (Task 5).
4. Un nodo occupato con un turno lungo non perde lavoro per un aggiornamento non obbligatorio (Task 5).
5. `osascript` annullato dall'utente (codice d'uscita 1, «User canceled») non è un errore fatale: selettore annullato → `~/Botcave`, menu annullato → uscita silenziosa (Task 4).

---

### Task 1: Schema e migrazione

**Files:**
- Create: `lib/db/src/schema/node-pairings.ts`, `docs/migrations/2026-11-nodo-senza-terminale.sql`, `artifacts/api-server/test/migration-nodo-senza-terminale.test.ts`
- Modify: `lib/db/src/schema/nodes.ts`, `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces — Produces:** `nodePairingsTable`, `nodePairingStatusEnum`, `nodeDiagnosticsTable` (export da `@workspace/db`); colonne
`nodes.kind`, `pairedAt`, `pairedIp`, `claudeStatus` (jsonb), `claudeCheckedAt`, `settings` (jsonb), `diagnosticsRequestedAt`,
`uninstallRequestedAt`, `updateFailedVersion`.

- [ ] **Step 1: test della migrazione** sul modello di `migration-nodo-cartelle.test.ts`: applicata due volte su uno schema
  precedente (senza le tabelle) non fallisce; dopo, `node_pairings` ha `user_code_hash` unico, `node_diagnostics.node_id` è PK
  con `ON DELETE CASCADE`, `nodes` ha le nove colonne nuove, tutte nullable.
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/api-server exec vitest run test/migration-nodo-senza-terminale.test.ts` → FAIL (file assente).
- [ ] **Step 3: scrivere** schema Drizzle e SQL come da spec §10: enum `node_pairing_status` (`pending`, `approved`, `denied`,
  `consumed`, `expired`) in `DO $$ … EXCEPTION WHEN duplicate_object`; `node_pairings` (`id` uuid default `gen_random_uuid()`,
  `user_code_hash` text unique not null, `poll_secret_hash` text not null, `device_name` text not null, `version` text not null,
  `status` default `pending`, `user_id` → users `CASCADE`, `node_id` → nodes `CASCADE`, `failed_attempts` int default 0,
  `request_ip` text, `expires_at` not null, `created_at` default now, `decided_at`), indice su `expires_at`;
  `node_diagnostics` (`node_id` PK → nodes `CASCADE`, `content` text not null, `created_at` default now); colonne su `nodes`
  con `ADD COLUMN IF NOT EXISTS`. Stesso SQL in `docs/schema-casello.sql`.
- [ ] **Step 4: eseguire** il test e la suite intera dell'API → PASS.
- [ ] **Step 5: commit** `feat(casello): schema dell'abbinamento, diagnosi e stato dei nodi`.

### Task 2: Abbinamento (API)

**Files:**
- Create: `artifacts/api-server/src/lib/nodes/pairing.ts`, `artifacts/api-server/src/routes/node-pairing.ts`, `artifacts/api-server/src/routes/node-pairing.test.ts`
- Modify: `lib/api-spec/openapi.yaml` (+ codegen), `artifacts/api-server/src/app.ts` (montaggio delle route pubbliche prima di `requireAuth`), `artifacts/api-server/src/middlewares/rate-limit.ts`, `artifacts/api-server/src/lib/nodes/lease-sweeper.ts` (pulizia oraria), `artifacts/api-server/src/lib/nodes/nodes.ts` (riuso di creazione nodo e revoca dei token)

**Interfaces — Consumes:** `createNode` e la logica di `regenerateNodeToken` di `lib/nodes/nodes.ts` (separare una funzione
`revokeNodeTokens(tx, node)` e una `createNodeToken` che oggi stanno dentro). **Produces:**
- `startPairing({deviceName, version, ip}): Promise<{pairingId: string, userCode: string, pollSecret: string, expiresAt: Date}>`
- `pollPairing(pairingId, pollSecret): Promise<{status: "pending"} | {status: "approved", token: string, nodeId: number, nodeName: string}>` (lancia `PairingError(410)`)
- `getPairing(userId, userCode)`, `approvePairing(userId, userCode, {name, replaceNodeId?})`, `denyPairing(userId, userCode)`
- `PAIRING_MESSAGES = { notFound: "richiesta di collegamento non trovata o scaduta", gone: "collegamento non più valido" }`
- Route: `POST /api/node-pairing/start`, `POST /api/node-pairing/poll` (pubbliche); `GET /api/account/node-pairings/:code`,
  `POST …/:code/approve`, `POST …/:code/deny` (`sessionOnly`). Operation id OpenAPI: `startNodePairing`, `pollNodePairing`,
  `getNodePairing`, `approveNodePairing`, `denyNodePairing`.

- [ ] **Step 1: test** in `node-pairing.test.ts` (stile di `nodes.test.ts`, PGlite e app in memoria):
  - `start` risponde 201 con `userCode` che corrisponde a `/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/`, `pollSecret` di 43 caratteri; nel DB nessuno dei due in chiaro.
  - `poll` prima dell'approvazione → 202 `{status: "pending"}`; segreto sbagliato → 410.
  - `GET /account/node-pairings/:code` con login → 200 con `deviceName`, `version`, `createdAt`; codice accettato con o senza trattino e in minuscolo; con un token personale `api:write` → 403.
  - `approve` `{name: "MacBook di prova"}` → 200; poi `poll` → 200 con `token` che inizia con `cas_`, `nodeId`, `nodeName`; il token funziona su `POST /api/node/heartbeat`; secondo `poll` → 410.
  - due `poll` concorrenti dopo l'approvazione (`Promise.all`) → esattamente un 200.
  - `approve` con `replaceNodeId` di un nodo dell'utente: stesso `nodeId`, il vecchio token del nodo → 401 sull'heartbeat; `replaceNodeId` di un altro utente → 404 «nodo non trovato».
  - `approve` con nome già usato → 409 «nome già usato»; `deny` → `poll` 410.
  - richiesta scaduta (orologio iniettato +11 min) → `GET` 404 col messaggio fisso, `poll` 410.
  - 5 `approve` falliti (nome non valido) → la richiesta passa a `expired`.
  - limite: l'11ª `start` dallo stesso IP in un minuto → 429.
  - la pulizia cancella le richieste create da oltre 1 ora, in qualunque stato (quelle consumate non servono più: il collegamento resta in `nodes.paired_at`).
- [ ] **Step 2: eseguire** → FAIL.
- [ ] **Step 3: OpenAPI e codegen**, poi `pairing.ts`: codici generati con `randomInt` sull'alfabeto fisso; hash SHA-256 del
  codice normalizzato (maiuscolo, senza trattino); `poll` consuma con `UPDATE … SET status='consumed' WHERE id=$1 AND status='approved' RETURNING`
  e crea il token nella stessa transazione; `approve` in transazione con la riga del nodo bloccata per `replaceNodeId`
  (revoca come «Rigenera token», compiti e turni in carico chiusi come oggi); `request_ip` abbreviato (IPv4 /24, IPv6 /48);
  alla consumazione scrive `nodes.paired_at = now()` e `paired_ip`. Limiti in `rate-limit.ts` (`nodePairingStartLimit`,
  `nodePairingPollLimit`, `nodePairingAccountLimit`).
- [ ] **Step 4: eseguire** test e typecheck → PASS.
- [ ] **Step 5: commit** `feat(casello): abbinamento dei nodi dal browser`.

### Task 3: Heartbeat esteso, manifest, impostazioni, diagnosi, disinstallazione (API)

**Files:**
- Create: `artifacts/api-server/src/lib/nodes/manifest.ts`, `artifacts/api-server/src/lib/nodes/node-admin.ts`, `artifacts/api-server/src/lib/nodes/manifest.test.ts`
- Modify: `lib/api-spec/openapi.yaml` (+ codegen), `artifacts/api-server/src/lib/nodes/protocol.ts`, `artifacts/api-server/src/lib/nodes/nodes.ts` (`toNodeView`), `artifacts/api-server/src/routes/node.ts`, `artifacts/api-server/src/routes/nodes.ts`, `artifacts/api-server/src/routes/dashboard.ts`, `artifacts/api-server/src/lib/node-turns/protocol.ts` (claim dei turni), `artifacts/api-server/src/routes/node.test.ts`, `artifacts/api-server/src/routes/nodes.test.ts`

**Interfaces — Produces:**
- `loadNodeManifest(path = process.env.NODO_MANIFEST_PATH ?? "/app/nodo/nodo-manifest.json"): NodeManifest | null` con `NodeManifest = {version, minVersion, binary: {file, sha256, size}, app: {file, sha256, size}}` (letto una volta, cache; file assente o non valido → null e una riga di log).
- `updateFor(nodeVersion: string, kind: "app" | "cli" | null, manifest): {version, sha256, size, required} | null` (solo `kind === "app"`; usa `compareVersions` di semver già presente o una funzione nuova in `manifest.ts`).
- `isBelowMinVersion(nodeVersion, manifest): boolean` — vale per ogni `kind`.
- Heartbeat: richiesta + `kind?`, `claude?: {found, version?, loggedIn?, authMethod?, subscriptionType?, loginExpiresAt?}`, `updateFailed?: string`; risposta + `update?`, `settings?: {maxConcurrent, maxConcurrentTurns, taskTimeoutMinutes}` (null per ognuno = default del nodo), `diagnosticsRequested?: boolean`, `uninstallRequested?: boolean`.
- Route: `PUT /api/account/nodes/:id/settings`, `POST /api/account/nodes/:id/diagnostics-request`, `GET /api/account/nodes/:id/diagnostics`, `POST /api/account/nodes/:id/uninstall-request`, `GET /api/account/nodes/download` (`{available, version, url, size}`), `POST /api/node/diagnostics`, `POST /api/node/uninstalled`.
- `NodeView` + `kind`, `pairedAt`, `claude`, `claudeCheckedAt`, `settings`, `updateAvailable` (versione o null), `updateFailedVersion`, `belowMinVersion`, `diagnosticsAt` (data dell'ultima diagnosi o null), `diagnosticsRequestedAt`, `uninstallRequestedAt`.
- `DashboardStats` + `recentlyPairedNodes: [{id, name, pairedAt}]` (ultime 24 h, attivi) e `nodeClaudeWarnings: [{nodeId, nodeName, reason: "not_installed" | "not_logged_in" | "login_expiring"}]` (solo nodi con un account «Claude Code (nodo)» dell'utente).

- [ ] **Step 1: test**:
  - heartbeat di un nodo senza i campi nuovi → 200 `{pending}` e nessun campo nuovo obbligatorio (compatibilità).
  - con manifest finto (`NODO_MANIFEST_PATH` su un file temporaneo `{version: "0.3.0", minVersion: "0.2.0", …}`): nodo `kind: "app"` versione `0.2.5` → `update {version: "0.3.0", required: false}`; versione `0.1.9` → `required: true`; `kind: "cli"` → nessun `update`.
  - nodo sotto `minVersion`: `POST /api/node/claim` e `POST /api/node/turns/claim` → 204 anche con lavoro in coda.
  - `claude` salvato in `nodes.claude_status` e restituito in `GET /api/account/nodes`; campi in più scartati (niente email).
  - `updateFailed: "0.3.0"` → `updateFailedVersion` e niente `update` per `0.3.0`; manifest con `0.3.1` → `update` di nuovo.
  - `PUT …/settings {maxConcurrent: 2, maxConcurrentTurns: null, taskTimeoutMinutes: 90}` → 200 e nell'heartbeat `settings`; `maxConcurrent: 4` → 400 «impostazioni del nodo non valide».
  - `diagnostics-request` → heartbeat `diagnosticsRequested: true`; `POST /api/node/diagnostics {content}` → 204, poi `diagnosticsRequested` false e `GET …/diagnostics` scarica il testo (`attachment`, `nosniff`); corpo > 256 KB → 413; 7ª richiesta in un'ora → 429; diagnosi di oltre 7 giorni rimossa dalla pulizia.
  - `uninstall-request` → heartbeat `uninstallRequested: true`; `POST /api/node/uninstalled` → nodo `disabled`, token 403.
  - route d'account con un nodo altrui → 404 «nodo non trovato»; con token personale → 403 (sono `sessionOnly`).
  - `GET /api/account/nodes/download` senza manifest → `{available: false}`; con manifest → `url: "/downloads/nodo/<app.file>"`.
  - Dashboard: nodo consumato 1 ora fa in `recentlyPairedNodes`, 25 ore fa no; account nodo con `claude.loggedIn: false` → avviso `not_logged_in`.
- [ ] **Step 2: eseguire** → FAIL.
- [ ] **Step 3: implementare** (OpenAPI e codegen prima). `node-admin.ts` per impostazioni, richieste e diagnosi; `heartbeat` di
  `protocol.ts` salva `kind`, `claude` (`claude_checked_at = now()`), `update_failed_version`, legge le richieste e azzera
  `diagnostics_requested_at` solo alla consegna della diagnosi; i claim controllano `isBelowMinVersion` sulla `version` salvata.
  La pulizia delle diagnosi va nel controllo orario esistente.
- [ ] **Step 4: eseguire** test e typecheck → PASS.
- [ ] **Step 5: commit** `feat(casello): heartbeat con aggiornamenti, impostazioni, diagnosi e disinstallazione dei nodi`.

### Task 4: Modalità app del nodo (abbinamento, installazione, menu)

**Files:**
- Create: `artifacts/casello-nodo/src/dialogs.ts`, `artifacts/casello-nodo/src/pairing.ts`, `artifacts/casello-nodo/src/app-mode.ts`, `artifacts/casello-nodo/src/app-mode.test.ts`, `artifacts/casello-nodo/src/pairing.test.ts`
- Modify: `artifacts/casello-nodo/src/index.ts` (scelta della modalità), `artifacts/casello-nodo/src/cli.ts` (estrarre `installFromConfig` riusabile), `artifacts/casello-nodo/src/client.ts` (`startPairing`, `pollPairing`), `artifacts/casello-nodo/src/config.ts` (`DEFAULT_URL`, `BOTCAVE_NODO_URL`)

**Interfaces — Produces:**
- `interface Dialogs { alert(text): Promise<void>; notify(title, text): Promise<void>; chooseFolder(prompt, defaultDir): Promise<string | null>; chooseFromList(prompt, items: string[]): Promise<string | null>; confirm(text, okLabel): Promise<boolean> }` e `osascriptDialogs(run = execFile)`; annullamento (exit 1 con «User canceled» / `-128`) → `null`/`false`.
- `runPairing(deps: {client, dialogs, openUrl, sleep, deviceName, version}): Promise<{token, nodeId, nodeName}>` (poll ogni 3 s fino a `expiresAt`; 410 → dialogo «Collegamento non riuscito o scaduto: riapri Botcave Nodo» ed errore).
- `installFromConfig(cfg: {caselloUrl, token, workspaceRoot}, programSource: string, deps)`: scrive config 600, copia il programma in `~/.casello-nodo/bin/casello-nodo` (temporaneo e rename, 755), LaunchAgent con argomenti `[programPath, "run"]` (senza `node` davanti: il programma è un eseguibile) — la CLI continua a passare `[execPath, program.mjs, "run"]`.
- `runAppMode(deps)`: menu con le voci della spec §4 nell'ordine «Apri Botcave», «Installa Claude Code» (solo se manca), «Accedi a Claude», «Cambia cartella di lavoro», «Apri i log», «Ricollega», «Disinstalla». Le voci di Claude chiamano funzioni del Task 6 iniettate (in questo task dei segnaposto che il Task 6 sostituisce: interfaccia `ClaudeActions { found(): Promise<boolean>; install(): Promise<void>; login(): Promise<void> }`).
- Scelta della modalità in `index.ts`: argomenti presenti → CLI di oggi; nessun argomento e `process.execPath` dentro `*.app/Contents/MacOS/` → `runAppMode`; altrimenti l'uso della CLI.

- [ ] **Step 1: test** con dialoghi, `openUrl`, `launchctl` e server finti:
  - primo avvio senza config: chiama `start`, apre `<url>/nodes/pair?code=ABCD-EFGH`, notifica il codice, dopo due `pending` riceve il token, chiede la cartella (finto: `null`) → config con `workspaceRoot` = `~/Botcave` (creata), permessi 600, programma copiato, LaunchAgent caricato, dialogo «Botcave Nodo è collegato come «<nome>»».
  - config della CLI presente e valida → nessun abbinamento, programma e LaunchAgent sostituiti, config invariata.
  - collegato → menu; «Cambia cartella di lavoro» con una cartella scelta → `workspaceRoot` aggiornato e servizio riavviato (`kickstart -k`); menu annullato → uscita 0 senza effetti.
  - «Ricollega» → nuovo abbinamento e token sostituito nella config.
  - `osascriptDialogs` con `execFile` finto che esce 1 e stderr `execution error: User canceled. (-128)` → `chooseFolder` restituisce `null`; altri errori → eccezione.
  - testo passato a `osascript`: le virgolette e le barre rovesciate dei testi sono escapate (nessuna iniezione AppleScript).
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/casello-nodo run test` → FAIL.
- [ ] **Step 3: implementare**.
- [ ] **Step 4: eseguire** test, typecheck e `run build` → PASS.
- [ ] **Step 5: commit** `feat(casello-nodo): modalità app con abbinamento dal browser`.

### Task 5: Aggiornamento automatico, impostazioni, diagnosi e disinstallazione (nodo)

**Files:**
- Create: `artifacts/casello-nodo/src/updater.ts`, `artifacts/casello-nodo/src/updater.test.ts`, `artifacts/casello-nodo/src/node-admin.ts`, `artifacts/casello-nodo/src/node-admin.test.ts`
- Modify: `artifacts/casello-nodo/src/loop.ts`, `artifacts/casello-nodo/src/turns.ts` (posti dinamici), `artifacts/casello-nodo/src/client.ts`, `artifacts/casello-nodo/src/index.ts` (controllo di `update.json` all'avvio), `artifacts/casello-nodo/src/capabilities.ts` (`NODE_VERSION` letto dalla build), `artifacts/casello-nodo/package.json` (versione `0.3.0`)

**Interfaces — Consumes:** risposta dell'heartbeat del Task 3. **Produces:**
- `checkUpdateOnStart(paths, now): "ok" | "rolled_back"` — gestisce `update.json` e il ripristino di `.prev` (3 avvii entro 2 min).
- `markUpdateHealthy(paths)` dopo il primo heartbeat riuscito.
- `applyUpdate(update, deps: {download, drain, paths, exit}): Promise<void>` — scarica in `casello-nodo.download` (`fetch` su `<caselloUrl>/downloads/nodo/casello-nodo-<version>`, `redirect: "error"`, 10 min, interrotto oltre 300 MB o oltre `size`), verifica sha256, `drain(maxMs)`, rename atomico di `.prev` e del nuovo, scrive `update.json`, `exit(0)`.
- Loop: `drain(maxMs): Promise<boolean>` (smette di prendere lavoro e aspetta i compiti/turni in corso; `false` se scade), `applySettings(settings)` (posti di compiti e turni, timeout), heartbeat con `kind` (`"app"` se il programma in esecuzione è `~/.casello-nodo/bin/casello-nodo`, altrimenti `"cli"`), `updateFailed` letto da `update.json`.
- `sendDiagnostics(deps)`: ultime 500 righe di `casello-nodo.log`, `state.json`, config senza `token`, `sw_vers -productVersion`, versione del nodo, esito della verifica di Claude; taglio a 256 KB.
- `uninstallSelf(deps)`: stop del ciclo, `POST /api/node/uninstalled`, `launchctl bootout`, rimozione di plist, `bin/` e `config.json`; notifica finale (solo in modalità app).

- [ ] **Step 1: test**:
  - `update` non obbligatorio con un compito in corso: nessun download finché il compito non finisce; finito → scarica, verifica, sostituisce, `exit(0)`; `.prev` è il binario vecchio.
  - sha256 diverso → file scaricato rimosso, binario installato intatto, nuovo tentativo non prima di 1 ora.
  - risposta più lunga di `size` → interrotto, binario intatto.
  - redirect dal server → errore, binario intatto.
  - `required` con lavoro oltre 30 minuti (orologio finto) → interruzione come uno stop, poi aggiornamento.
  - `checkUpdateOnStart`: tre avvii entro 2 minuti senza `markUpdateHealthy` → ripristina `.prev`, `update.json` con `failedVersion`; heartbeat successivo con `updateFailed`.
  - `settings {maxConcurrentTurns: 1}` → un solo claim di turno in attesa; `null` → torna alla config locale.
  - `diagnosticsRequested` → una sola chiamata a `POST /api/node/diagnostics` con contenuto senza il token (verificato cercando la stringa del token).
  - `uninstallRequested` → `uninstallSelf` chiamato; config e programma rimossi, log presenti.
  - nodo installato con la CLI (`kind: "cli"`) che riceve `update` (server vecchio o errato) → ignorato.
  - heartbeat 401/403 in modalità app → una sola notifica «Botcave Nodo non è più collegato: aprilo e scegli Ricollega», niente lavoro preso, nuovo tentativo ogni 30 s (il processo non esce: launchd lo riavvierebbe in ciclo).
- [ ] **Step 2: eseguire** → FAIL.
- [ ] **Step 3: implementare**. La versione del nodo entra nel bundle con `--define:__NODE_VERSION__` letto da `package.json` nello script di build.
- [ ] **Step 4: eseguire** test, typecheck e build → PASS.
- [ ] **Step 5: commit** `feat(casello-nodo): aggiornamento automatico, impostazioni, diagnosi e disinstallazione`.

### Task 6: Claude Code — verifica, installazione, login (nodo)

**Files:**
- Create: `artifacts/casello-nodo/src/claude-check.ts`, `artifacts/casello-nodo/src/claude-check.test.ts`
- Modify: `artifacts/casello-nodo/src/loop.ts` (verifica ogni 10 min, campo `claude` nell'heartbeat), `artifacts/casello-nodo/src/app-mode.ts` (sostituire i segnaposto di `ClaudeActions`), `artifacts/casello-nodo/test/` (un `claude` finto con `--version` e `auth status --json`)

**Interfaces — Produces:**
- `checkClaude(deps: {which, run, home}): Promise<ClaudeStatus>` con `ClaudeStatus = {found: boolean, version?: string, loggedIn?: boolean, authMethod?: string, subscriptionType?: string, loginExpiresAt?: string}`; cerca nel PATH e in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; `claude --version` (prima parola) e `claude auth status --json` (solo i campi elencati; JSON non valido → `loggedIn` assente), 10 s ciascuno.
- `installClaude(deps)`: costante `CLAUDE_INSTALL_URL = "https://claude.ai/install.sh"`; `/bin/bash -c "curl -fsSL <URL> | bash"`, 10 min, poi `checkClaude`.
- `loginClaude(deps)`: `claude auth login` staccato, poi `checkClaude` ogni 5 s fino a 10 min; notifica dell'esito.

- [ ] **Step 1: test** con `claude` finto: installato e con login → `{found: true, version: "2.1.321", loggedIn: true, subscriptionType: "team", …}` senza `email`/`orgId`; senza login → `loggedIn: false`; assente → `{found: false}`; `auth status` che non risponde in 10 s → `loggedIn` assente e nessun blocco; `installClaude` esegue esattamente la riga con l'URL costante (verificata sull'argomento passato al finto `run`); `loginClaude` termina quando il finto passa a `loggedIn: true`.
- [ ] **Step 2: eseguire** → FAIL.
- [ ] **Step 3: implementare**.
- [ ] **Step 4: eseguire** test e typecheck → PASS.
- [ ] **Step 5: commit** `feat(casello-nodo): verifica, installazione e accesso di Claude Code`.

### Task 7: Build dell'app, CI e distribuzione

**Files:**
- Create: `artifacts/casello-nodo/app/Info.plist`, `artifacts/casello-nodo/app/sea-config.json`, `artifacts/casello-nodo/min-version.txt` (`0.3.0`), `artifacts/casello-nodo/scripts/build-app.sh`, `docker/nodo-downloads/.gitkeep`
- Modify: `artifacts/casello-nodo/package.json` (script `build:sea`: bundle CJS `dist/sea.cjs`), `.github/workflows/deploy.yml`, `docker/web.Dockerfile`, `docker/api.Dockerfile`, `docker/nginx.conf.template`, `.gitignore` (`docker/nodo-downloads/*` tranne `.gitkeep`)

**Interfaces — Produces:** file in `docker/nodo-downloads/`: `Botcave-Nodo-<v>.zip`, `casello-nodo-<v>`, `nodo-manifest.json`
(`{version, minVersion, binary: {file, sha256, size}, app: {file, sha256, size}}`); nell'immagine web `/usr/share/nginx/html/downloads/nodo/`;
nell'immagine API `/app/nodo/nodo-manifest.json` (letto dal Task 3).

- [ ] **Step 1: `build-app.sh`** (solo macOS, `set -euo pipefail`): build CJS; per `arm64` e `x64` scarica `node-v24.x-darwin-<arch>.tar.gz`
  della versione di `process.version` del runner, verifica con `SHASUMS256.txt`, copia l'eseguibile, `codesign --remove-signature`,
  `node --experimental-sea-config app/sea-config.json`, `npx postject … NODE_SEA_BLOB … --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`;
  `lipo -create` in `botcave-nodo`; `codesign --sign - --force`; prova `./botcave-nodo --version` e `arch -x86_64 ./botcave-nodo --version`
  (devono stampare la versione di `package.json`); `.app` con `Info.plist` (versione sostituita) e `AppIcon.icns` creato con
  `iconutil` da `design/icons/`; `ditto -c -k --keepParent` per lo zip; scrive il manifest con `shasum -a 256` e `stat -f%z`.
- [ ] **Step 2: eseguire** `bash artifacts/casello-nodo/scripts/build-app.sh` sul Mac → zip, binario e manifest in `docker/nodo-downloads/`; aprire l'app con doppio clic deve mostrare l'abbinamento (con `BOTCAVE_NODO_URL` verso il server di sviluppo).
- [ ] **Step 3: CI**: job `build-nodo` su `macos-latest` (dopo `test`, Node 24, pnpm) che esegue lo script e carica `docker/nodo-downloads/` con `actions/upload-artifact`; il job `build` dipende anche da `build-nodo` e scarica l'artefatto in `docker/nodo-downloads/` prima delle build. Nella prova dell'immagine web aggiungere `expect /downloads/nodo/nodo-manifest.json "200 OK"`.
- [ ] **Step 4: immagini e nginx**: web `COPY docker/nodo-downloads/ /usr/share/nginx/html/downloads/nodo/`; API `COPY docker/nodo-downloads/ /app/nodo/`; nginx `location ^~ /downloads/nodo/` con `Cache-Control: public, max-age=3600` per `nodo-manifest.json` e `max-age=31536000, immutable` per gli altri, `X-Content-Type-Options nosniff` e la CSP della console ripetuta. Build locale delle immagini con la cartella vuota → riuscita.
- [ ] **Step 5: commit** `feat(casello-nodo): app per Mac costruita in CI e pubblicata con la console`.

### Task 8: Console

**Files:**
- Create: `artifacts/casello/src/pages/node-pair.tsx`, `artifacts/casello/src/components/account/node-download-card.tsx`, `artifacts/casello/src/components/account/node-status-list.tsx`, `artifacts/casello/src/components/account/node-settings-dialog.tsx`
- Modify: `artifacts/casello/src/App.tsx` (route `/nodes/pair`), `artifacts/casello/src/components/account/nodes-section.tsx`, `artifacts/casello/src/components/account/ai-accounts-section.tsx` (avviso di Claude sull'account nodo), `artifacts/casello/src/pages/dashboard.tsx`

**Interfaces — Consumes:** hook generati dal Task 2 e 3 (`useGetNodePairing`, `useApproveNodePairing`, `useDenyNodePairing`,
`useGetNodeDownload`, `usePutNodeSettings`, `useRequestNodeDiagnostics`, `useRequestNodeUninstall`, campi nuovi di `NodeView` e `DashboardStats`).

- [ ] **Step 1: pagina `/nodes/pair?code=…`**: titolo «Collega questo Mac», nome del Mac modificabile, versione, ora; avviso fisso «Conferma solo se hai appena aperto Botcave Nodo su questo Mac»; scelta «Nuovo nodo» / «Sostituisci <nodo>» (nodi attivi; preselezionato il nodo con lo stesso nome del Mac, caso di «Ricollega»); «Collega» e «Annulla»; esito «Mac collegato: torna a Botcave Nodo» o errore col messaggio del server. Codice mancante o non trovato → «Richiesta di collegamento non trovata o scaduta: riapri Botcave Nodo».
- [ ] **Step 2: Account → Nodi**: carta «Botcave Nodo per Mac» con «Scarica per Mac» (versione e dimensione), passi del primo avvio (trascina in Applicazioni, apri, «Apri comunque» in Impostazioni di Sistema → Privacy e sicurezza) e il dialogo dei comandi della CLI spostato sotto «Installazione da terminale»; per nodo: LED di Claude («installato · versione», «accesso fatto · piano · scade il»), avviso di versione (`updateAvailable`, `updateFailedVersion`, `belowMinVersion`, «installa Botcave Nodo per gli aggiornamenti automatici» per `kind: "cli"`), «Impostazioni» (dialogo con i tre campi e «predefinito»), «Richiedi diagnosi» / «Scarica diagnosi», «Disinstalla dal Mac» con conferma; «Rigenera token» solo per `kind` diverso da `app`; «Ricollega dal Mac: apri Botcave Nodo» per i nodi `app` col token revocato.
- [ ] **Step 3: Dashboard e account AI**: avviso «Nuovo Mac collegato: <nome>» con link ad Account → Nodi per `recentlyPairedNodes`; avvisi di `nodeClaudeWarnings` in Dashboard e sulla carta dell'account «Claude Code (nodo)».
- [ ] **Step 4: verifica**: test della console, typecheck, poi a 1280 px in tema chiaro e scuro (preview `botcave-dev`): pagina di abbinamento, Account → Nodi, Dashboard; nessuno scorrimento orizzontale.
- [ ] **Step 5: commit** `feat(casello): console per Botcave Nodo (abbinamento, scarico, stato di Claude, impostazioni, diagnosi)`.

### Task 9: Prova di flusso e documentazione

**Files:**
- Create: `artifacts/api-server/test/node-app-flow.test.ts`
- Modify: `CLAUDE.md` (sezione nuova «Botcave Nodo (app per Mac)», Stato, Dove stanno le cose, Deploy: `docker/nodo-downloads/` e job `build-nodo`), `artifacts/casello-nodo/README.md`

- [ ] **Step 1: prova di flusso** (API in memoria e codice vero del nodo, dialoghi e `launchctl` finti, cartella home temporanea): `runAppMode` al primo avvio → approvazione con la sessione di prova → config scritta; `startLoop` con la config → heartbeat con `kind: "app"` e `claude`; manifest finto con versione superiore → download servito da un server statico locale, sostituzione e `exit(0)` intercettato; `checkUpdateOnStart` → `ok`; poi `uninstallRequested` → nodo `disabled`.
- [ ] **Step 2: eseguire** la prova e le suite di API, nodo e console, `pnpm run typecheck` → PASS.
- [ ] **Step 3: documentazione** (CLAUDE.md e README) e SQL completo della migrazione pronto per la chat.
- [ ] **Step 4: commit** `docs(casello): Botcave Nodo per Mac` e push del branch; PR con link compare precompilato (senza `gh`), migrazione da applicare su Neon PRIMA del merge, nessuna variabile nuova obbligatoria (`NODO_MANIFEST_PATH` facoltativa).
