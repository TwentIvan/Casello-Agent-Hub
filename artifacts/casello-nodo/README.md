# casello-nodo

Servizio per Mac che esegue con Claude Code i compiti «nodo» delle squadre di Casello: prende un compito in coda,
prepara lo spazio di lavoro, lancia `claude` e riferisce l'esito a Casello.

## Requisiti

- macOS con Node 24.
- Claude Code installato (`claude` nel PATH) e con il login già fatto.
- Un nodo creato nella console di Casello (Account → Nodi): al momento della creazione viene mostrato una sola volta
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
- `casello-nodo status` mostra se launchd ha il servizio, l'ultimo heartbeat riuscito e i compiti in corso.
- `casello-nodo run` avvia il nodo in primo piano (è quello che lancia launchd). `Ctrl+C` o SIGTERM lo fermano:
  i compiti in corso risultano falliti («esecuzione interrotta: nodo fermato»); un secondo segnale forza l'uscita.

## Dove stanno le cose

- Programma: `~/.casello-nodo/bin/casello-nodo.mjs` (copia scritta da `install`).
- Config: `~/.casello-nodo/config.json` (permessi 600; il nodo non parte se sono diversi).
- Log: `~/.casello-nodo/logs/` (`casello-nodo.log` con rotazione, `launchd.out.log`, `launchd.err.log`).
  Non contengono token, allegati né istruzioni dei compiti.
- Stato: `~/.casello-nodo/state.json` (letto da `status`, senza segreti).

## Spazio di lavoro della squadra

Ogni squadra indica una cartella relativa (`node_workspace`) dentro la radice scelta con `--workspace-root`. Il nodo
non esce mai dalla radice (nemmeno con link simbolici). Per ogni compito scrive lì `casello-compito.md` (istruzioni,
piano, skill) e gli allegati in `casello-allegati/`, lancia `claude` con quella cartella come directory di lavoro e
legge l'esito da `casello-esito.json`. A fine compito i file di servizio vengono rimossi.

Per scegliere la cartella dalla console («Sfoglia» nella scheda della squadra) il nodo manda con ogni heartbeat i nomi
delle sottocartelle della radice: solo cartelle (mai file né contenuti), fino a 3 livelli e 2 000 voci, senza cartelle
nascoste, `node_modules` e link simbolici. Una cartella appena creata compare in console entro 30 secondi.

## Sicurezza

- L'agente gira con `--dangerously-skip-permissions` dentro lo spazio di lavoro: esegue comandi e modifica file senza
  chiedere conferma. Scegli una radice che contenga solo ciò che l'agente può toccare.
- Il token del nodo sta in `~/.casello-nodo/config.json` (600). L'agente gira con lo stesso utente e potrebbe
  leggerlo. Se pensi sia compromesso, revoca il nodo dalla console (Account → Nodi) e creane uno nuovo.
