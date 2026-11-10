# casello-nodo

Servizio per Mac che esegue con Claude Code i compiti «nodo» delle squadre di Botcave e i turni delegati a un account
«Claude Code (nodo)»: prende il lavoro in coda, lancia `claude` e riferisce l'esito a Botcave.

Si installa in due modi: con l'app **Botcave Nodo** (consigliato, nessun terminale) oppure con la CLI da terminale.
È lo stesso programma: l'app è un'altra entrata.

## Installazione con l'app (consigliata)

1. In Botcave apri Account → Nodi e premi «Scarica per Mac» (carta «Botcave Nodo per Mac»).
2. Apri lo zip scaricato e trascina «Botcave Nodo» in Applicazioni.
3. Apri l'app. La prima versione non è firmata da Apple: se macOS la blocca, vai in Impostazioni di Sistema → Privacy e
   sicurezza e premi «Apri comunque», poi riaprila.
4. L'app apre il browser su «Collega questo Mac» (`/nodes/pair`) e mostra una notifica con il codice: controlla che sia lo
   stesso, scegli «Nuovo nodo» (o «Sostituisci» un nodo esistente) e premi «Collega». Il token non lo vedi mai: l'app lo
   ritira da sola. Conferma solo se hai appena aperto Botcave Nodo su quel Mac.
5. L'app chiede la cartella in cui il nodo può lavorare (proposta `~/Botcave`; annullare usa quella), scrive la config,
   copia il programma in `~/.casello-nodo/bin/casello-nodo` e carica il LaunchAgent. Il servizio usa la copia: l'app in
   Applicazioni serve solo per il menu.

Se sul Mac c'è già un nodo installato con la CLI, l'app adotta il suo collegamento (indirizzo, token e radice) senza un
nuovo abbinamento.

### Menu dell'app

Riaprendo l'app a nodo collegato compare un menu:

- «Apri Botcave»: apre Account nella console.
- «Installa Claude Code» (solo se `claude` manca): dopo una conferma esegue l'installatore ufficiale
  (`curl -fsSL https://claude.ai/install.sh | bash`, indirizzo fisso nel programma), poi propone «Accedi a Claude».
- «Accedi a Claude»: lancia `claude auth login` (il login si apre nel browser) e controlla l'esito fino a 10 minuti.
- «Cambia cartella di lavoro»: sceglie una nuova radice e riavvia il servizio.
- «Apri i log»: apre `~/.casello-nodo/logs/`.
- «Ricollega»: rifà l'abbinamento (in console proponi «Sostituisci» sul nodo attuale). Serve se il nodo non è più
  collegato (notifica «Botcave Nodo non è più collegato: aprilo e scegli Ricollega»); un nodo disattivato non si
  riattiva, quindi Ricollega crea un nodo nuovo.
- «Disinstalla»: vedi sotto.

### Dalla console (Account → Nodi)

Per ogni nodo: versione e aggiornamenti, stato di Claude Code (installato, accesso fatto, piano, scadenza del login, con
avviso entro 3 giorni), «Impostazioni» (compiti e turni contemporanei, timeout dei compiti: valgono senza riavvio e
prevalgono sulla config locale), «Richiedi diagnosi» / «Scarica diagnosi» (versioni, esito di Claude, config senza token,
stato e ultime 500 righe del log, conservata 7 giorni) e «Disinstalla dal Mac».

### Aggiornamenti automatici

Solo per i nodi installati con l'app. Quando Botcave ha una versione più nuova, il nodo scarica
`<indirizzo di Botcave>/downloads/nodo/casello-nodo-<versione>` (l'indirizzo è quello della config, mai uno ricevuto),
ne verifica dimensione e sha256 continuando a lavorare, poi smette di prendere lavoro, aspetta quello in corso (al più 30
minuti; un aggiornamento obbligatorio poi lo interrompe, uno facoltativo si rinvia), sostituisce
`~/.casello-nodo/bin/casello-nodo` tenendo la versione precedente come `casello-nodo.prev` ed esce: launchd lo riavvia.
Se la versione nuova non parte (tre avvii entro 2 minuti senza un heartbeat riuscito), torna da sola alla precedente e la
console segnala «aggiornamento non riuscito». Sotto la versione minima Botcave non consegna lavoro finché il nodo non si
aggiorna. I nodi installati con la CLI non si aggiornano da soli: la console suggerisce di installare l'app.

### Disinstallazione

Dal menu dell'app («Disinstalla», con conferma) o dalla console («Disinstalla dal Mac»): il nodo chiude il lavoro in corso
come uno stop, avvisa Botcave (il nodo risulta disattivato), toglie programma (anche `.prev`), config con il token e
LaunchAgent. Log e cartelle di lavoro restano. Poi puoi spostare l'app nel cestino. Se sposti l'app nel cestino senza
disinstallare, il servizio continua (usa la sua copia): disinstalla dalla console.

## Installazione da terminale (alternativa)

Requisiti: macOS con Node 24; Claude Code installato (`claude` nel PATH) e con il login già fatto; un nodo creato nella
console (Account → Nodi): al momento della creazione viene mostrato una sola volta il token del nodo (`cas_…`).

Costruisci l'eseguibile (`pnpm --filter @workspace/casello-nodo run build`, produce `dist/index.mjs`), poi:

- `casello-nodo install` installa il servizio e chiede a video indirizzo, token (non mostrato mentre lo digiti) e radice
  degli spazi di lavoro. In alternativa le opzioni `--url https://casello.fantamister.cloud`, `--workspace-root ~/Lavoro` e
  `--token-file <file>` (il file contiene il token; viene letto e ripulito dagli spazi). Esiste anche `--token cas_…`,
  ma il token resta nella cronologia della shell: preferisci il prompt o `--token-file`. Scrive la config
  (permessi 600) e il LaunchAgent `~/Library/LaunchAgents/cloud.fantamister.casello-nodo.plist` (avvio al login,
  riavvio se cade) e lo carica con `launchctl bootstrap`. Copia il programma costruito in
  `~/.casello-nodo/bin/casello-nodo.mjs` ed è quella copia che lancia il servizio: dopo l'installazione il repository si
  può spostare o cancellare. Rieseguirlo (dopo una build nuova) aggiorna programma, config e servizio.
- `casello-nodo uninstall` ferma e rimuove il servizio e la copia del programma; config e log restano.
- `casello-nodo status` mostra se launchd ha il servizio, l'ultimo heartbeat riuscito, i compiti e i turni in corso.
- `casello-nodo run` avvia il nodo in primo piano (è quello che lancia launchd). `Ctrl+C` o SIGTERM lo fermano:
  i compiti in corso risultano falliti («esecuzione interrotta: nodo fermato»); un secondo segnale forza l'uscita.
- `casello-nodo --version` stampa la versione.

Con la CLI il token si rigenera da console («Rigenera token») e si reinstalla; nessun aggiornamento automatico.

## Build dell'app

`bash artifacts/casello-nodo/scripts/build-app.sh` (solo macOS, Node 24 nel PATH o in `NODE_BIN`, pnpm e rete verso
nodejs.org e npm) costruisce il bundle CommonJS (`pnpm run build:sea`, `dist/sea.cjs`), lo inietta come «single executable
application» negli eseguibili ufficiali di Node per arm64 e x64 (verificati con `SHASUMS256.txt`), li unisce con `lipo` in
un binario universale con firma ad-hoc, prova `--version` nelle due architetture e scrive in `docker/nodo-downloads/`
`Botcave-Nodo-<versione>.zip` (l'app), `casello-nodo-<versione>` (il binario per gli aggiornamenti) e `nodo-manifest.json`
(versione da `package.json`, versione minima da `min-version.txt`). In CI lo fa il job `build-nodo`; i file entrano nelle
immagini web (`/downloads/nodo/`) e API (solo il manifest). In sviluppo `BOTCAVE_NODO_URL` cambia l'indirizzo di Botcave
dell'app (https, o http solo verso localhost).

## Dove stanno le cose

- Programma: `~/.casello-nodo/bin/casello-nodo` (app; `casello-nodo.prev` dopo un aggiornamento) oppure
  `~/.casello-nodo/bin/casello-nodo.mjs` (CLI, copia scritta da `install`).
- Aggiornamento in corso o annullato: `~/.casello-nodo/update.json`.
- Config: `~/.casello-nodo/config.json` (permessi 600; il nodo non parte se sono diversi).
- Log: `~/.casello-nodo/logs/` (`casello-nodo.log` con rotazione, `launchd.out.log`, `launchd.err.log`).
  Non contengono token, allegati né istruzioni dei compiti.
- Stato: `~/.casello-nodo/state.json` (letto da `status`, senza segreti).
- Turni: `~/.casello-nodo/turns/` (cartelle temporanee, vuote a riposo).

## Spazio di lavoro della squadra

Ogni squadra indica una cartella relativa (`node_workspace`) dentro la radice (scelta all'abbinamento dell'app o con `--workspace-root`). Il nodo
non esce mai dalla radice (nemmeno con link simbolici). Per ogni compito scrive lì `casello-compito.md` (istruzioni,
piano, skill) e gli allegati in `casello-allegati/`, lancia `claude` con quella cartella come directory di lavoro e
legge l'esito da `casello-esito.json`. A fine compito i file di servizio vengono rimossi.

Per scegliere la cartella dalla console («Sfoglia» nella scheda della squadra) il nodo manda con ogni heartbeat i nomi
delle sottocartelle della radice: solo cartelle (mai file né contenuti), fino a 3 livelli e 2 000 voci, senza cartelle
nascoste, `node_modules` e link simbolici. Una cartella appena creata compare in console entro 30 secondi.

## Turni delegati (account «Claude Code (nodo)»)

Oltre ai compiti, il nodo esegue i turni di chat e le run che Botcave delega a un account AI di tipo «Claude Code (nodo)»:
usa l'accesso a Claude del tuo utente sul Mac (il login già fatto con `claude`), quindi i consumi contano sul tuo posto
Claude e valgono i suoi limiti d'uso. Se il posto raggiunge il limite o il login scade, il turno fallisce con un codice
(`usage_limit`, `not_logged_in`) e Botcave ripiega sul modello di riserva dell'account, se c'è e se Claude non ha ancora
chiamato strumenti nel turno (altrimenti il turno fallisce: rifarlo duplicherebbe azioni già in coda).

- Ciclo separato da quello dei compiti: tiene un claim in attesa (long-poll) finché ha un posto libero, fino a
  `maxConcurrentTurns` turni insieme (config, 1..4, default 2). Errore di rete: riprova dopo 5 s; nodo disattivato: ogni 30 s.
- Per ogni turno crea una cartella vuota in `~/.casello-nodo/turns/` (700) con `mcp.json` (600, contiene il token del turno,
  valido solo per quel turno) e `system-prompt.md` (600, le istruzioni del turno) e lancia, con il prompt su stdin, la
  cartella come cwd e in un gruppo di processi proprio:

  ```
  claude -p --output-format json --model <modello> --system-prompt-file <cartella>/system-prompt.md \
    --setting-sources project --tools "" --strict-mcp-config --mcp-config <cartella>/mcp.json \
    --allowedTools "mcp__botcave__*" --max-turns <n> --permission-mode dontAsk
  ```

  `claude` non ha strumenti propri né altri server MCP: può solo chiamare gli strumenti del turno su Botcave. Con
  `--setting-sources project` e la cartella vuota come cwd le tue impostazioni personali di Claude Code (hook, permessi,
  plugin) non entrano nel turno; il login resta quello del Mac. Le istruzioni passano da un file, non dagli argomenti
  (visibili con `ps`). La modalità `dontAsk` è fissa e non dipende da `permissionMode` (che vale solo per i compiti). La
  cartella si cancella a fine turno, anche in caso di errore; all'avvio il nodo toglie tutta `~/.casello-nodo/turns/`
  (resti di un arresto improvviso).
- Ping della lease ogni 30 s (tengono il nodo «pronto per i turni» anche quando tutti i posti sono occupati e non fa
  claim); al timeout del turno `claude` riceve SIGTERM e dopo 10 s SIGKILL. Una lease persa (409, 401,
  403) termina `claude` senza report. Allo stop del nodo i turni in corso riferiscono `stopped`.
- Il testo dell'errore di `claude` serve solo a scegliere il codice e non viene mai inviato; la risposta si invia troncata a
  20 000 caratteri. Nei log: id del turno, modello, durata ed esito; mai prompt, risposta né token del turno.
- Limiti del posto: i turni delegati e i compiti condividono il tuo abbonamento Claude; più turni in parallelo consumano
  il limite d'uso più in fretta. Abbassa `maxConcurrentTurns` se lo raggiungi spesso.

## Sicurezza

- L'agente gira con `--dangerously-skip-permissions` dentro lo spazio di lavoro: esegue comandi e modifica file senza
  chiedere conferma. Scegli una radice che contenga solo ciò che l'agente può toccare.
- Il token del nodo sta in `~/.casello-nodo/config.json` (600). L'agente gira con lo stesso utente e potrebbe
  leggerlo. Se pensi sia compromesso, revoca il nodo dalla console (Account → Nodi) e creane uno nuovo.
- L'app non è ancora firmata né notarizzata da Apple: la fiducia sta nell'HTTPS di Botcave (download dalla console,
  aggiornamenti dall'indirizzo della config con sha256 e dimensione verificati). Firma e notarizzazione arrivano prima
  degli utenti esterni.
- La console può chiedere al nodo solo un elenco chiuso di azioni (impostazioni, diagnosi, disinstallazione): non può
  fargli eseguire comandi.
