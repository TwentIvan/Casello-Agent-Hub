# casello-runner

Programma ponte dell'**agente locale** di Casello: gira sul tuo computer, prende da Casello le analisi
dell'architetto e le run degli agenti assegnate a questa macchina e le fa eseguire a Claude Code
(`claude -p`) con il tuo abbonamento. Claude Code vede solo gli strumenti MCP di Casello: niente shell, niente
file, niente rete; i tool delle app li esegue Casello, con le sue conferme e i suoi limiti.

## Requisiti

- Node 24 e pnpm 10 (il monorepo di Casello installato con `pnpm install`).
- Claude Code installato e con l'accesso fatto (`claude` nel `PATH`, oppure `CASELLO_CLAUDE_BIN`). Verifica con
  `claude --version`; il runner è provato con la versione 2.1.311.
- Una macchina registrata in Casello (`POST /api/local/machines`, dalla console): il token `csl_m_…` si vede una
  sola volta.

## Avvio

```sh
CASELLO_URL=https://casello.fantamister.cloud \
CASELLO_RUNNER_TOKEN=csl_m_… \
pnpm --filter @workspace/casello-runner start
```

Variabili:

| Variabile | Obbligatoria | Significato |
| --- | --- | --- |
| `CASELLO_URL` | sì | Indirizzo pubblico di Casello. Solo `https`; `http` è ammesso solo verso `localhost`/`127.0.0.1` (sviluppo). Il server MCP indicato da Casello deve avere la stessa origine, altrimenti il compito è rifiutato. |
| `CASELLO_RUNNER_TOKEN` | sì | Token della macchina (`csl_m_…`). Solo da variabile d'ambiente, mai da argomenti. |
| `CASELLO_CLAUDE_BIN` | no | Programma Claude Code (default `claude`). |
| `CASELLO_RUNNER_CONCURRENCY` | no | Compiti eseguiti insieme, da 1 a 8 (default 1). |

`Ctrl+C` (o SIGTERM) ferma il runner: il compito in corso viene terminato e riportato a Casello come fallito;
un secondo `Ctrl+C` esce subito (codice 130), dopo aver ucciso Claude Code (SIGKILL) e cancellato i file
temporanei con il token del lavoro. Con il token revocato (401) il runner si ferma da solo.

In sviluppo, con l'API in locale (`AUTH_DISABLED=true pnpm run dev`):
`CASELLO_URL=http://localhost:3000 CASELLO_RUNNER_TOKEN=csl_m_… pnpm --filter @workspace/casello-runner start`.

## Come funziona

1. Attesa lunga su `GET /api/runner/next` (circa 25 s): Casello risponde 204 se non c'è nulla, altrimenti con il
   compito (`jobId`, `itemId`, `jobToken`, `prompt`, `resumeSessionId`, `mcpUrl`). L'attesa vale anche come
   segnale di vita della macchina.
2. La consegna si controlla (forma dei campi; `mcpUrl` con la stessa origine di `CASELLO_URL`): se non va, il
   compito si riporta come fallito senza avviare Claude. Cartella di lavoro di Claude Code:
   `~/.casello-runner/jobs/<jobId>` (0700, vuota), **la stessa per tutti i compiti del lavoro**, perché Claude Code
   lega la sessione alla cartella e `--resume` da un'altra cartella non la trova. All'avvio il runner cancella le
   cartelle dei lavori ferme da più di 24 h. Il `mcp.json` (permessi 0600) sta invece in una cartella temporanea
   a parte, una per compito, cancellata sempre a fine compito: punta al server MCP di Casello con il token del
   lavoro **di questa consegna** (Casello lo rigenera a ogni consegna).
3. Avvia Claude Code; ogni 15 s manda `POST /api/runner/jobs/:id/heartbeat`. Se Casello risponde 410 (lavoro
   chiuso o scaduto) il runner termina Claude (SIGTERM, poi SIGKILL dopo 5 s).
4. Riporta la fine con `POST /api/runner/items/:itemId/done` (`sessionId`, `exit`, `usage`) e solo dopo torna in
   attesa: per ogni posto di concorrenza l'ordine è sempre compito → done → nuova attesa.
5. Errori di rete o risposte 5xx/429: nuovo tentativo con attesa crescente da 1 s a 30 s.

### Argomenti di Claude Code

```
claude -p --output-format json --mcp-config <cartella>/mcp.json --strict-mcp-config \
  --tools "" --allowedTools mcp__casello --permission-mode dontAsk --setting-sources user [--resume <sessione>]
```

- `-p --output-format json`: esecuzione non interattiva con un solo esito JSON (`session_id`, `is_error`,
  `usage`); i token riportati (ingresso, compresa la cache del prompt, e uscita) vanno a Casello a titolo
  informativo.
- `--mcp-config` + `--strict-mcp-config`: solo il server `casello` del file, ignorati gli altri server MCP
  configurati sul computer.
- `--tools ""`: disattiva tutti gli strumenti predefiniti (Bash, file, web, sotto-agenti).
- `--allowedTools mcp__casello`: gli strumenti del server `casello` si usano senza richiesta di permesso.
- `--permission-mode dontAsk`: tutto ciò che non è preautorizzato viene negato, mai chiesto (nessuna attesa).
- `--setting-sources user`: carica solo le impostazioni dell'utente (`~/.claude/settings.json`, dove può stare
  anche un `apiKeyHelper`), mai quelle di progetto o locali. L'accesso a Claude (OAuth nel portachiavi) non sta
  nelle impostazioni e resta valido.
- `--resume`: riprende la sessione sospesa (dopo una conferma o una correzione dell'architetto), dalla stessa
  cartella del lavoro.

Il prompt arriva a Claude dallo stdin, non dagli argomenti: non compare in `ps` e le opzioni a più valori
(`--mcp-config`, `--tools`, `--allowedTools`) non possono inglobarlo. Il token di macchina non viene passato a
Claude Code (è tolto dal suo ambiente).

### Log

Su stderr, una riga per evento: id del lavoro e del compito, esito, durata, errori di rete per codice. Mai token,
prompt o risultati.

## Test

`pnpm --filter @workspace/casello-runner run test`: un finto `claude` (`test/fake-claude.mjs`) che legge
`--mcp-config`, parla MCP con Casello e stampa un esito JSON; i test girano contro un finto Casello (ordine delle
richieste, nuovi tentativi, 410, arresto) e contro l'API vera con il Postgres di prova (una run e un'analisi
dell'agente locale arrivano a fine). Nessun test avvia il vero Claude Code.
