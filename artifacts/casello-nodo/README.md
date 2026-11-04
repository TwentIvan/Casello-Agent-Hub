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

- `casello-nodo install --url https://casello.fantamister.cloud --token cas_… --workspace-root ~/Lavoro` installa il
  servizio. Le opzioni mancanti si chiedono a video (il token non viene mostrato mentre lo digiti). Scrive la config
  (permessi 600) e il LaunchAgent `~/Library/LaunchAgents/cloud.fantamister.casello-nodo.plist` (avvio al login,
  riavvio se cade) e lo carica con `launchctl bootstrap`. Rieseguirlo aggiorna config e servizio.
- `casello-nodo uninstall` ferma e rimuove il servizio; config e log restano.
- `casello-nodo status` mostra se launchd ha il servizio, l'ultimo heartbeat riuscito e i compiti in corso.
- `casello-nodo run` avvia il nodo in primo piano (è quello che lancia launchd). `Ctrl+C` o SIGTERM lo fermano:
  i compiti in corso risultano falliti («esecuzione interrotta: nodo fermato»); un secondo segnale forza l'uscita.

## Dove stanno le cose

- Config: `~/.casello-nodo/config.json` (permessi 600; il nodo non parte se sono diversi).
- Log: `~/.casello-nodo/logs/` (`casello-nodo.log` con rotazione, `launchd.out.log`, `launchd.err.log`).
  Non contengono token, allegati né istruzioni dei compiti.
- Stato: `~/.casello-nodo/state.json` (letto da `status`, senza segreti).

## Spazio di lavoro della squadra

Ogni squadra indica una cartella relativa (`node_workspace`) dentro la radice scelta con `--workspace-root`. Il nodo
non esce mai dalla radice (nemmeno con link simbolici). Per ogni compito scrive lì `casello-compito.md` (istruzioni,
piano, skill) e gli allegati in `casello-allegati/`, lancia `claude` con quella cartella come directory di lavoro e
legge l'esito da `casello-esito.json`. A fine compito i file di servizio vengono rimossi.

## Sicurezza

- L'agente gira con `--dangerously-skip-permissions` dentro lo spazio di lavoro: esegue comandi e modifica file senza
  chiedere conferma. Scegli una radice che contenga solo ciò che l'agente può toccare.
- Il token del nodo sta in `~/.casello-nodo/config.json` (600). L'agente gira con lo stesso utente e potrebbe
  leggerlo. Se pensi sia compromesso, revoca il nodo dalla console (Account → Nodi) e creane uno nuovo.
