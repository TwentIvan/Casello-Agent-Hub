# casello-nodo

Servizio per Mac che esegue con Claude Code i compiti «nodo» delle squadre di Botcave: prende un compito in coda,
prepara lo spazio di lavoro, lancia `claude` e riferisce l'esito a Botcave.

## Requisiti

- macOS con Node 24.
- Claude Code installato (`claude` nel PATH) e con il login già fatto.
- Un nodo creato nella console di Botcave (Account → Nodi): al momento della creazione viene mostrato una sola volta
  il token del nodo (`cas_…`).

## Comandi

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

## Dove stanno le cose

- Programma: `~/.casello-nodo/bin/casello-nodo.mjs` (copia scritta da `install`).
- Config: `~/.casello-nodo/config.json` (permessi 600; il nodo non parte se sono diversi).
- Log: `~/.casello-nodo/logs/` (`casello-nodo.log` con rotazione, `launchd.out.log`, `launchd.err.log`).
  Non contengono token, allegati né istruzioni dei compiti.
- Stato: `~/.casello-nodo/state.json` (letto da `status`, senza segreti).
- Turni: `~/.casello-nodo/turns/` (cartelle temporanee, vuote a riposo).

## Spazio di lavoro della squadra

Ogni squadra indica una cartella relativa (`node_workspace`) dentro la radice scelta con `--workspace-root`. Il nodo
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
