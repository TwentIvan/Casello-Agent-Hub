# Botcave Nodo senza terminale — design

Data: 10 novembre 2026. Stato: da approvare.

## 1. Obiettivo

Oggi il nodo locale (`casello-nodo`) si installa e si aggiorna solo dal terminale: Node 24, clone del repository, build con
pnpm, `casello-nodo install` con il token incollato, Claude Code installato e con il login fatto. Ad un utente normale non
si può chiedere di aprire un terminale. Obiettivo: installare, collegare, aggiornare, diagnosticare e disinstallare il nodo
senza mai aprire il terminale, con la console di Botcave come unica interfaccia di gestione.

Utenti: prima i colleghi Derga (Mac aziendali), poi utenti esterni. Il design deve reggere gli esterni, ma la prima
versione è **senza firma Apple** (vedi §9: la firma e la notarizzazione sono il passo successivo, previsto dalla struttura).

Decisioni prese con Ivan:

- Approccio: app senza finestre («Botcave Nodo.app») con Node incluso; tutto il resto in console (Account → Nodi).
- Nessuna firma Apple per ora: primo avvio con «Apri comunque» in Impostazioni di Sistema → Privacy e sicurezza.
- Claude Code: l'app lo verifica e, a richiesta dell'utente, lo installa con l'installatore ufficiale di Anthropic
  («Installa Claude Code») e avvia il login (`claude auth login`). Non include una copia propria di Claude Code.

## 2. Mappa delle azioni manuali

| # | Azione | Oggi | Frequenza | Dopo |
|---|---|---|---|---|
| 1 | Installare Node 24 | Homebrew/nvm da terminale | una volta | incluso nell'app (§4) |
| 2 | Clone, `pnpm install`, build | terminale e git | una volta e a ogni versione | app scaricata dalla console (§5) |
| 3 | Creare il nodo e copiare il token | console → incollato nel terminale | una volta | abbinamento dal browser, token mai visto (§3) |
| 4 | `casello-nodo install` (indirizzo, token, radice) | prompt nel terminale | una volta | primo avvio dell'app: indirizzo fisso, radice col selettore di cartelle (§3) |
| 5 | LaunchAgent | scritto da `install` | una volta | scritto dall'app (§4) |
| 6 | Installare Claude Code e fare il login | `curl … \| bash`, `claude` | una volta / a scadenza | «Installa Claude Code» e «Accedi a Claude» nel menu dell'app; verifica in console (§6) |
| 7 | Aggiornare dopo un deploy | build e `install` | a ogni versione | aggiornamento automatico (§5) |
| 8 | «Rigenera token» | console + `install` | raro | «Ricollega» dal menu dell'app (§3) |
| 9 | Stato | `casello-nodo status` | quando serve | Account → Nodi (§6) |
| 10 | Log e diagnosi | file in `~/.casello-nodo/logs/` | quando serve | «Richiedi diagnosi» in console, «Apri i log» nell'app (§7) |
| 11 | Disinstallare | `casello-nodo uninstall` | raro | menu dell'app o console (§8) |
| 12 | `maxConcurrent`, `maxConcurrentTurns`, timeout | modifica di `config.json` | raro | impostazioni del nodo in console (§7) |
| 13 | Permessi di `config.json` | `install` | una volta | l'app (come oggi: 600) |

La CLI resta (sviluppo, test, chi la preferisce): l'app è un'altra entrata dello stesso programma.

## 3. Abbinamento (collegamento di un Mac)

Schema del «device flow» (RFC 8628), adattato.

1. Primo avvio dell'app (nessuna config): il nodo chiama `POST /api/node-pairing/start` (pubblica)
   `{deviceName (≤ 100, nome del Mac), version}` → `{pairingId, userCode, pollSecret, expiresAt}`.
   - `userCode`: 8 caratteri da un alfabeto senza caratteri ambigui (`ABCDEFGHJKMNPQRSTVWXYZ23456789`), mostrato come
     `XXXX-XXXX`; `pollSecret` 32 byte base64url. Nel DB solo gli hash SHA-256. Scadenza 10 minuti.
   - Limite: 10/min per IP.
2. Il nodo apre il browser (`open`) su `<caselloUrl>/nodes/pair?code=XXXX-XXXX` e mostra una notifica con il codice.
3. Pagina della console `/nodes/pair` (con il login; senza, la pagina di login e ritorno): «Collega questo Mac?»,
   nome del Mac (modificabile), versione, ora della richiesta, avviso fisso «Conferma solo se hai appena aperto Botcave Nodo
   su questo Mac». Scelta: «Nuovo nodo» (default) oppure «Sostituisci» un nodo esistente dell'utente (tra gli attivi).
   Pulsanti «Collega» e «Annulla».
   - `GET /api/account/node-pairings/:code` (solo login, `sessionOnly`): dati della richiesta; sconosciuta, scaduta o già
     decisa → 404 «richiesta di collegamento non trovata o scaduta».
   - `POST /api/account/node-pairings/:code/approve` `{name, replaceNodeId?}` (solo login): con il nuovo nodo valgono le
     regole di `POST /api/account/nodes` (nome 1..100, doppione 409 «nome già usato»); con `replaceNodeId` il nodo
     dell'utente resta, i suoi token si revocano come con «Rigenera token» (compiti e turni in carico chiusi come oggi) e il
     nome non cambia. Stato `approved`, legato a `user_id` e `node_id`. Il token NON si crea qui.
   - `POST /api/account/node-pairings/:code/deny` (solo login): stato `denied`.
   - Limite: 20/min per utente sulle tre route; al massimo 5 approvazioni o rifiuti falliti per codice, poi `expired`.
4. Il nodo interroga `POST /api/node-pairing/poll` `{pairingId, pollSecret}` ogni 3 s (limite 30/min per richiesta):
   `pending` → 202; `approved` → 200 `{token, nodeId, nodeName}` e nella stessa transazione crea il token di nodo
   (`createNodeToken`, come oggi: ambito `node`, 365 giorni) e passa la richiesta a `consumed`: il token si consegna una volta
   sola; `denied`/`expired`/`consumed` o segreto sbagliato → 410 «collegamento non più valido».
5. Il nodo apre il selettore di cartelle (`osascript` `choose folder`, partendo da `~/Botcave`, creata se manca) per la radice
   degli spazi di lavoro, scrive la config (600, come oggi), installa il programma e il LaunchAgent (§4) e mostra
   «Botcave Nodo è collegato come «<nome>»». Annullare il selettore usa `~/Botcave`.
6. Nella console il nodo nuovo compare in Account → Nodi con «collegato il <data> da <IP abbreviato>» e, per 24 ore, un avviso
   nella Dashboard «Nuovo Mac collegato: <nome>» con il link al nodo (protezione dall'inganno: chi ti fa approvare il *suo*
   codice viene notato). Il bollettino non si usa: i suoi eventi appartengono a una squadra (`team_events.instance_id`).

Pulizia: richieste non consumate oltre 1 ora si cancellano (controllo orario del nodo già esistente).

**Ricollega**: dal menu dell'app (§4) rifà l'abbinamento proponendo «Sostituisci» sul nodo attuale (`replaceNodeId`
preselezionato dalla pagina se il nome coincide). Se il token è revocato (401/403 sull'heartbeat), il nodo si ferma e mostra
una notifica «Botcave Nodo non è più collegato: aprilo e scegli Ricollega»; la console mostra lo stesso testo sul nodo.
Il dialogo «Rigenera token» della console resta solo per i nodi installati con la CLI.

## 4. L'app

- Pacchetto `Botcave Nodo.app`: `Contents/MacOS/botcave-nodo` (eseguibile unico: Node 24 con `casello-nodo` incluso,
  Node «single executable application»), `Contents/Info.plist` (`CFBundleIdentifier` `cloud.fantamister.botcave-nodo`,
  `LSUIElement` true: niente icona nel Dock), `Contents/Resources/AppIcon.icns` (da `design/icons/`). Il bundle per la SEA è
  CommonJS (esbuild `--format=cjs`), accanto al bundle ESM di oggi per la CLI.
- Avvio con doppio clic (nessun argomento, `process.execPath` dentro un `.app`): modalità «app».
  - Non collegato → abbinamento (§3). Se trova una config della CLI (`~/.casello-nodo/config.json` valida), la adotta: tiene
    indirizzo, token e radice, sostituisce programma e LaunchAgent senza nuovo abbinamento.
  - Collegato → menu nativo (`osascript` `choose from list`) con: «Apri Botcave», «Installa Claude Code» (solo se manca),
    «Accedi a Claude», «Cambia cartella di lavoro», «Apri i log», «Ricollega», «Disinstalla».
- Il servizio non gira dall'app: l'installazione copia l'eseguibile in `~/.casello-nodo/bin/casello-nodo` (file temporaneo e
  rename, come oggi) e il LaunchAgent (`cloud.fantamister.casello-nodo`, invariato) lancia quella copia con `run`. Gli
  aggiornamenti (§5) toccano solo la copia: l'app in Applicazioni non cambia (regge la firma futura).
- Dialoghi e notifiche con `osascript` (`display dialog`, `display notification`, `choose folder`, `choose from list`):
  nessun framework grafico. Testi fissi in italiano, tono di Botcave.
- L'indirizzo di Botcave è fisso nella build (`https://casello.fantamister.cloud`); in sviluppo si può forzare con la variabile
  `BOTCAVE_NODO_URL` (ignorata se non https, salvo localhost come oggi).
- Configurazione locale: `caselloUrl`, `token`, `workspaceRoot` più i campi di oggi; le impostazioni di §7 arrivano dalla
  console e, se presenti, prevalgono su quelle locali.

## 5. Build, distribuzione e aggiornamenti

**Build** (`.github/workflows/deploy.yml`, job nuovo `build-nodo` su `macos-latest`, prima di `build`):

1. Build di `casello-nodo` (bundle CJS per la SEA).
2. Blob SEA (`node --experimental-sea-config`) iniettato con `postject` nell'eseguibile ufficiale di Node 24 per `darwin-arm64`
   e `darwin-x64` (scaricati da nodejs.org con verifica di `SHASUMS256.txt`), unione con `lipo` in un binario universale,
   firma ad-hoc (`codesign --sign -`).
3. Prova: `botcave-nodo --version` in arm64 e in x64 (Rosetta, `arch -x86_64`).
4. Pacchetto `Botcave-Nodo-<versione>.zip` (app) e `casello-nodo-<versione>` (binario da solo) più
   `nodo-manifest.json` `{version, minVersion, binary: {file, sha256, size}, app: {file, sha256, size}}`. `minVersion` = versione
   minima compatibile con il protocollo (scritta a mano in `artifacts/casello-nodo/min-version.txt`).
5. Artefatti passati ai job delle immagini (`actions/upload-artifact`/`download-artifact`).

**Distribuzione**: `casello-web` serve i file da `/downloads/nodo/` (nginx: `location ^~ /downloads/nodo/`, cache di 1 ora per
manifest, 1 anno per i file con la versione nel nome); `casello-api` ha `nodo-manifest.json` nell'immagine (letto all'avvio;
assente in sviluppo = nessun aggiornamento proposto). API e nodo pubblicati vanno sempre insieme. Console: Account → Nodi →
«Scarica per Mac» (link allo zip del manifest, esposto da `GET /api/account/nodes/download`) con le istruzioni del primo avvio
(trascina in Applicazioni, apri, «Apri comunque» in Privacy e sicurezza, con schermate).

**Aggiornamento automatico** (solo nodi installati con l'app: heartbeat con `kind: "app"`):

1. La risposta all'heartbeat porta `update: {version, sha256, size, required}` se la versione del nodo è inferiore a quella del
   manifest; `required` se inferiore a `minVersion`.
2. Il nodo scarica `<caselloUrl>/downloads/nodo/casello-nodo-<version>` (indirizzo dalla config, mai dalla risposta; ≤ 300 MB,
   nessun redirect, 10 minuti), verifica dimensione e sha256; errore → ritenta all'heartbeat successivo, al più una volta
   all'ora.
3. Smette di prendere compiti e turni e aspetta che finiscano quelli in corso, al più 30 minuti; con `required` dopo 30 minuti
   interrompe il lavoro come uno stop (compiti `failed` «esecuzione interrotta: nodo fermato», turni `stopped`). Non
   obbligatorio e ancora occupato: riprova all'ora successiva.
4. Sostituisce in modo atomico `~/.casello-nodo/bin/casello-nodo`, tiene la precedente come `casello-nodo.prev`, scrive
   `~/.casello-nodo/update.json` `{from, to, startedAt, starts: 0}` ed esce con 0; launchd (KeepAlive) lo riavvia.
5. Ritorno indietro: a ogni avvio con `update.json` aperto il nodo incrementa `starts`; il primo heartbeat riuscito della nuova
   versione lo chiude. Se `starts` arriva a 3 entro 2 minuti da `startedAt`, il programma ripristina `casello-nodo.prev`, registra
   la versione fallita ed esce; il nodo ripristinato la riferisce con l'heartbeat (`updateFailed`) e non la riprova finché il
   manifest non ne propone una diversa. La console mostra «aggiornamento a <versione> non riuscito».
6. Con `required` e versione vecchia il server non consegna compiti né turni (`claim` 204) finché il nodo non si aggiorna; la
   console lo segnala.

Nodi installati con la CLI (`kind: "cli"`, o heartbeat senza `kind`): nessun aggiornamento automatico; la console mostra
«installa Botcave Nodo per gli aggiornamenti automatici» se la versione è vecchia.

## 6. Claude Code: verifica, installazione, login

- Verifica (all'avvio, ogni 10 minuti e dopo installazione o login): cerca `claude` nel PATH del servizio e in `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`; legge `claude --version` e `claude auth status --json` (10 s ciascuno). Nell'heartbeat:
  `claude: {found, version, loggedIn, authMethod, subscriptionType, loginExpiresAt}` (niente email né id dell'organizzazione);
  salvato in `nodes.claude_status` con `claude_checked_at`.
- Console (Account → Nodi, per nodo, con i LED): «Claude Code installato · <versione>» / «Claude Code non installato: apri
  Botcave Nodo e scegli Installa Claude Code»; «Accesso fatto · piano <tipo> · scade il <data>» / «Accesso mancante: apri Botcave
  Nodo e scegli Accedi a Claude»; avviso se il login scade entro 3 giorni. Se il login manca o scade entro 3 giorni e l'utente
  ha un account «Claude Code (nodo)» su quel nodo, lo stesso avviso compare anche sulla carta dell'account in Account → Account AI
  e nella Dashboard.
- «Installa Claude Code» (menu dell'app, solo se `claude` manca): conferma con un dialogo che dice cosa farà, poi esegue
  `/bin/bash -c "curl -fsSL https://claude.ai/install.sh | bash"` (URL costante nel codice, mai dal server), 10 minuti al
  massimo, notifica di inizio e fine; esito verificato con la verifica sopra; poi propone «Accedi a Claude».
- «Accedi a Claude»: lancia `claude auth login` (apre il login nel browser), poi verifica ogni 5 s per al più 10 minuti e
  notifica l'esito.
- Il PATH del LaunchAgent comprende già `~/.local/bin` (dove l'installatore ufficiale mette `claude`).

## 7. Impostazioni, diagnosi

- **Impostazioni dalla console**: `PUT /api/account/nodes/:id/settings` (solo login) `{maxConcurrent 1..3 | null,
  maxConcurrentTurns 1..4 | null, taskTimeoutMinutes 5..240 | null}` (null = default del nodo) in `nodes.settings`; la risposta
  all'heartbeat porta `settings`; il nodo le applica senza riavvio (i posti si adeguano a fine lavoro). `permissionMode` resta
  locale. Valori fuori intervallo → 400 «impostazioni del nodo non valide».
- **Diagnosi**: `POST /api/account/nodes/:id/diagnostics-request` (solo login, 6/ora per nodo) imposta
  `nodes.diagnostics_requested_at`; l'heartbeat porta `diagnosticsRequested: true`; il nodo invia `POST /api/node/diagnostics`
  (token di nodo, ≤ 256 KB) con le ultime 500 righe di `casello-nodo.log` (già senza segreti), `state.json`, la config senza
  token, versione di macOS e del nodo e l'esito delle verifiche di Claude; salvata in `node_diagnostics` (una per nodo, la
  nuova sostituisce la vecchia, cancellata dopo 7 giorni). `GET /api/account/nodes/:id/diagnostics` (solo login) la scarica
  come file di testo (`attachment`, `nosniff`); 404 se manca.
- «Apri i log» nel menu dell'app: `open ~/.casello-nodo/logs`.

## 8. Disinstallazione

- Dal menu dell'app («Disinstalla», con conferma) o dalla console («Disinstalla dal Mac»: `POST /api/account/nodes/:id/uninstall-request`,
  solo login, imposta `nodes.uninstall_requested_at`; l'heartbeat porta `uninstallRequested: true`).
- Il nodo chiude il lavoro come uno stop, chiama `POST /api/node/uninstalled` (il server disattiva il nodo: stesse regole di
  «Disattiva»), toglie LaunchAgent, programma (anche `.prev`) e config con il token; lascia log e spazi di lavoro. Notifica
  finale «Botcave Nodo è stato rimosso. Puoi spostare l'app nel cestino.».
- App spostata nel cestino senza disinstallare: il servizio continua (usa la sua copia) e si toglie dalla console.

## 9. Sicurezza

- Route pubbliche di abbinamento con i limiti di §3; codici monouso, 10 minuti, solo hash nel DB; token creato solo al
  `poll` dopo l'approvazione con il login; approvazione solo con sessione (`sessionOnly`), mai con token personali, `agent` o
  `embed`. Avviso in Dashboard a ogni nuovo collegamento (§3).
- Aggiornamenti: indirizzo dalla config, sha256 e dimensione dalla risposta all'heartbeat (TLS e token di nodo), file temporaneo
  e rename. Senza firma Apple la fiducia sta nell'HTTPS di Botcave: accettabile per i colleghi Derga, **da chiudere prima degli
  esterni** con firma e notarizzazione (Developer ID; a quel punto l'app potrà verificare anche la firma del binario scaricato).
- L'installatore di Claude Code ha l'URL fisso nel codice; il server non può far eseguire nulla al Mac: le richieste dalla console
  (impostazioni, diagnosi, disinstallazione) sono un elenco chiuso di azioni del nodo.
- Diagnosi senza token, prompt, risposte né contenuti dei compiti (i log già non li contengono); la config si invia senza `token`.

## 10. Dati e API

Migrazione additiva e idempotente `docs/migrations/2026-11-nodo-senza-terminale.sql` (niente `-post`), riportata in
`docs/schema-casello.sql`:

- enum `node_pairing_status` (`pending`, `approved`, `denied`, `consumed`, `expired`); tabella `node_pairings` (`id` uuid,
  `user_code_hash` unico, `poll_secret_hash`, `device_name`, `version`, `status`, `user_id` null `CASCADE`, `node_id` null
  `CASCADE`, `failed_attempts`, `request_ip` (abbreviato all'/24 o /48), `expires_at`, `created_at`, `decided_at`);
- tabella `node_diagnostics` (`node_id` PK `CASCADE`, `content` text, `created_at`);
- colonne su `nodes`: `kind` text null (`app`|`cli`), `paired_at`, `paired_ip`, `claude_status` jsonb, `claude_checked_at`, `settings` jsonb,
  `diagnostics_requested_at`, `uninstall_requested_at`, `update_failed_version` text.

OpenAPI: route di §3, §7, §8; schemi dell'heartbeat estesi (richiesta: `kind`, `claude`, `updateFailed`; risposta: `update`,
`settings`, `diagnosticsRequested`, `uninstallRequested`), tutti facoltativi: un nodo di versione precedente continua a funzionare.

Console: pagina `/nodes/pair`; Account → Nodi: «Scarica per Mac», stato di Claude, versione e aggiornamento, impostazioni,
«Richiedi diagnosi»/«Scarica diagnosi», «Disinstalla dal Mac». Niente scorrimento orizzontale a 1280 px.

## 11. Prove

- API (Vitest, PGlite): abbinamento (codice sbagliato, scaduto, doppia consegna, `replaceNodeId` di un altro utente, limiti),
  heartbeat con `update`/`settings`/richieste, `claim` bloccato sotto `minVersion`, diagnosi (dimensione, sostituzione, 7 giorni),
  disinstallazione.
- `casello-nodo`: abbinamento con server finto, adozione della config della CLI, aggiornamento (sha256 sbagliato, occupato,
  `required`, ritorno indietro dopo 3 avvii), verifica di Claude con `claude` finto (`--version`, `auth status`), impostazioni
  applicate, disinstallazione; `osascript` iniettato e finto nei test.
- Prova di flusso (`artifacts/api-server/test/`): API in memoria e nodo vero: abbinamento → heartbeat → aggiornamento proposto →
  sostituzione e riavvio simulato.
- CI: avvio del binario universale in arm64 e x64.
- A mano sul Mac di Ivan: scaricare lo zip, «Apri comunque», abbinare, un turno di Alfred scritto, un aggiornamento (versione
  fittizia), disinstallare.

## 12. Fuori ambito

Firma e notarizzazione (prossimo passo, prima degli utenti esterni); icona nella barra dei menu; Windows e Linux; distribuzione
gestita dall'IT (MDM); cambio della radice dalla console; Claude Code incluso nell'app.
