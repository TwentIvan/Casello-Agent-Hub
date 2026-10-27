# Casello: agente locale (Claude Code con l'abbonamento dell'utente)

Data: 27 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Obiettivo

Far eseguire analisi dell'architetto e run degli agenti a un **agente locale** — Claude Code sul computer
dell'utente, con il suo abbonamento — invece che a un modello via chiave API: niente chiavi, niente quote del
piano gratuito, costo zero per Casello. È il secondo esecutore già previsto dall'esecutore unico
(`ExecutorKind = "local_agent"`, dichiarato e non implementato).

Due modalità che condividono lo stesso server MCP di Casello:
- **A, automatica**: un piccolo programma ponte, `casello-runner`, gira sul computer dell'utente, prende i
  lavori da Casello e li fa eseguire a Claude Code in modalità non interattiva (`claude -p`).
- **C, interattiva**: l'utente collega Claude Code o Claude Desktop al server MCP di Casello con un token
  personale e, dalla chat, elenca e prende i lavori in coda.

Pronto quando: con il runner acceso sul Mac di Ivan, un'analisi di Mister con il modello "Agente locale ·
MacBook di Ivan" si completa e le proposte compaiono come con un modello API; una run di prova di un agente
con agente locale esegue i tool dell'app (con conferma e ripresa); a runner spento Casello chiede se usare la
riserva, attendere o posticipare.

Fuori da questa spec: esecutore Anthropic nativo e hyperscaler (sottoprogetti del catalogo); runner condiviso
tra più utenti; esecuzione di comandi o lettura di file del computer dell'utente da parte dell'agente.

## 2. Architettura

- **Server MCP di Casello**: `POST|GET /api/mcp`, trasporto HTTP standard MCP (SDK ufficiale
  `@modelcontextprotocol/sdk`, nuova dipendenza), autenticazione `Authorization: Bearer <token>`; fuori dalla
  sessione della console (non usa cookie).
- **Account AI "Agente locale"**: provider `local_agent` (protocollo `local_agent` nel registro, stato
  `managed`); i suoi "modelli" sono le macchine registrate dall'utente (es. "MacBook di Ivan"), scelte nella
  tendina come gli altri modelli. Un agente o un'analisi che usa una macchina indica anche un **modello di
  riserva** (un modello API dell'utente).
- **Coda dei lavori** (`local_jobs`): un'analisi o una run assegnata a una macchina diventa un lavoro; lo prende
  il runner di quella macchina oppure l'utente dalla chat (modalità C).
- **`casello-runner`** (`artifacts/casello-runner`, Node 24): si collega in uscita a Casello con un token di
  macchina (richieste HTTPS in attesa lunga, ~25 s), prende un lavoro alla volta (configurabile), avvia
  `claude -p` collegato al server MCP con il token del lavoro, riprende le sessioni sospese con `--resume`.
- Segreti delle app, token degli utenti delle app, regole (conferme, limiti, oscuramento) e registrazione dei
  passi restano in Casello: i tool delle app li esegue Casello; all'agente locale arrivano solo istruzioni e
  risultati.

## 3. Dati

- `local_machines`: `id`, `user_id`, `name`, `token_hash`, `last_seen_at`, `revoked_at`, `created_at`. Una
  macchina corrisponde a un `ai_models` dell'account "Agente locale" dell'utente (`model_id` = id della macchina).
- `local_jobs`: `id`, `user_id`, `machine_id`, `kind` (`analysis` | `run`), `analysis_id` / `run_id`, `status`
  (`queued` | `waiting_choice` | `postponed` | `claimed` | `running` | `paused` | `completed` | `failed` |
  `cancelled`), `fallback_ai_model_id`, `claude_session_id` (per `--resume`), `claimed_by` (`runner` | `chat`),
  `job_token_hash`, `job_token_expires_at`, `heartbeat_at`, `error`, `created_at`, `updated_at`.
- `mcp_tokens` (token personali): `id`, `user_id`, `name`, `token_hash`, `last_used_at`, `revoked_at`.
- `agents`: `fallback_ai_model_id`, `local_offline_policy` (`fallback` | `wait_then_fallback` | `postpone`,
  default `fallback`), `local_offline_wait_s`, `local_for_third_parties` (bool, default false).
- `analyses`: `fallback_ai_model_id`.
- Token: generati casualmente (32 byte), mostrati una sola volta, salvati come SHA-256; confronti a tempo
  costante.

## 4. Ciclo di vita di un lavoro

1. **Nascita**: avviare un'analisi o una run con una macchina crea il lavoro `queued`.
2. **Assegnazione**: se il runner della macchina è collegato (segnale di vita negli ultimi 30 s) gli arriva
   subito e deve prenderlo entro 10 s. Altrimenti:
   - **avviato dall'utente dalla console** (analisi, run di prova): lavoro `waiting_choice` e finestra
     "L'agente locale non è collegato" con tre scelte: **usa il modello di riserva** (con la stima del costo),
     **attendi** (resta in coda fino a 30 min per un'analisi, 2 min per una run, poi fallisce), **posticipa**
     (`postponed`: parte da solo appena un runner si collega, entro 24 h, poi `cancelled`);
   - **run avviata da un'app**: regola dell'agente — `fallback` (riserva subito), `wait_then_fallback` (attende
     `local_offline_wait_s`, poi riserva), `postpone`. Una run di un utente diverso dal proprietario dell'agente
     usa l'agente locale solo se `local_for_third_parties` è attivo; altrimenti va subito sulla riserva.
   - **modalità C**: l'utente elenca i lavori con lo strumento di coda e ne prende uno (`claimed_by = chat`).
3. **Esecuzione**: alla presa Casello genera il token del lavoro (valido per quel lavoro e fino alla sua durata
   massima). Il runner avvia Claude Code con il prompt del lavoro e il server MCP; ogni chiamata a uno strumento
   passa da Casello, che la esegue e la registra (passi della run, registro dell'analisi). Il lavoro termina con
   lo strumento di consegna. Restano i limiti attuali (giri, tempo; per l'architetto fasi e consegne validate
   con Zod). Costo per Casello: zero; i token, se Claude li riporta, si registrano a titolo informativo.
4. **Conferme**: un'azione che richiede conferma mette la run in `awaiting_client` come oggi; lo strumento
   risponde "in attesa di conferma" e il lavoro diventa `paused` con `claude_session_id`. Alla conferma o
   all'annullamento il lavoro torna in coda e il runner riprende la sessione con `--resume`, comunicando l'esito.
5. **Guasti**: senza segnale di vita per 60 s durante l'esecuzione il lavoro e la run/analisi falliscono con
   "agente locale disconnesso" (per le run: pulsante "Riprova con il modello di riserva"); all'avvio di Casello i
   lavori aperti si chiudono come le run e le analisi; il token del lavoro scade alla fine del lavoro.

## 5. Strumenti MCP

- **Token di lavoro**: `get_job` (istruzioni, contesto, limiti); per le analisi gli strumenti dell'architetto
  (lettura dei sorgenti, OpenAPI) e `submit_phase_result`; per le run i tool dell'app dell'agente (con conferme e
  oscuramento) e `finish_run`. Nient'altro.
- **Token personale (modalità C)**: `list_jobs` (solo i propri lavori in attesa o posticipati) e `claim_job`
  (genera un token di lavoro per quella sessione di chat), poi gli stessi strumenti del lavoro.
- **Token di macchina**: non usa MCP: solo `GET /api/runner/next` (attesa lunga, segnale di vita) e
  `POST /api/runner/jobs/:id/claim`.

## 6. Sicurezza

- Token personali, di macchina e di lavoro separati, revocabili, salvati solo come hash; ognuno vede solo i
  lavori del proprio utente; i lavori altrui sono invisibili; token scaduti o revocati rifiutati (401).
- Nessun segreto delle app lascia Casello; gli argomenti `x-sensitive` sono oscurati nei risultati come oggi.
- Il runner avvia Claude Code in una cartella temporanea vuota con **solo** gli strumenti MCP di Casello
  abilitati (`--strict-mcp-config`, `--allowedTools` limitati, nessuno strumento di shell o di file).
- Il codice delle app arriva all'agente locale solo attraverso gli strumenti dell'architetto, come a un modello
  API. I risultati dei tool delle app possono contenere testo ostile: valgono le regole attuali (conferme,
  limiti).
- Limiti di frequenza sulle route del runner e su `/api/mcp`.
- Termini d'uso: l'uso per run di utenti terzi è spento di default (`local_for_third_parties`), da attivare
  solo dopo aver verificato che i termini dell'abbonamento lo consentono.

## 7. Console

- Pagina Account, sezione **Agenti locali**: registra una macchina (nome → token e comando di avvio del runner,
  mostrati una volta), elenco con stato ("collegata", "vista l'ultima volta …"), revoca; **token personale** per
  la chat con il comando pronto (`claude mcp add --transport http casello <url>/api/mcp --header
  "Authorization: Bearer …"`) e la configurazione per Claude Desktop.
- Tendina dei modelli: le macchine compaiono come "Agente locale · <nome>"; se scelte, diventano obbligatori il
  modello di riserva e, negli agenti, la regola per le run delle app e l'interruttore per gli utenti terzi.
- Finestra all'avvio quando l'agente non è collegato (riserva / attendi / posticipa).
- Elenco dei lavori in attesa o posticipati, con lo stato e l'azione "usa la riserva".

## 8. API

Contract-first (OpenAPI + codegen) per le route della console: macchine (`GET|POST /local/machines`,
`DELETE /local/machines/:id`), token personali (`GET|POST /local/tokens`, `DELETE /local/tokens/:id`), lavori
(`GET /local/jobs`, `POST /local/jobs/:id/choice` con `fallback` | `wait` | `postpone`). Le route del runner
(`/runner/*`) e `/mcp` restano fuori dalla console (autenticazione con token, non con sessione).

## 9. Errori

Messaggi fissi in italiano: "agente locale non collegato", "agente locale disconnesso", "lavoro scaduto",
"token non valido o revocato", "lavoro non trovato", "modello di riserva obbligatorio con l'agente locale".

## 10. Migrazione

`docs/migrations/2026-10-agente-locale.sql`, idempotente, solo aggiunte (applicabile prima del merge): tabelle
`local_machines`, `local_jobs`, `mcp_tokens` con i loro enum, colonne nuove di `agents` e `analyses`, provider
`local_agent` nel registro (riga di `providers`). Testo completo in chat prima del push.

## 11. Prove

Server MCP con un client MCP vero (strumenti per tipo di token, isolamento tra utenti, token scaduti); ciclo di
vita (presa entro 10 s, tre scelte, rinvio, regole delle app e utenti terzi, perdita del segnale di vita,
pausa per conferma e ripresa); runner con un finto `claude` (script che chiama gli strumenti MCP come farebbe
Claude); architetto e run completi in modalità delegata. Collaudo con Ivan: runner sul suo Mac, analisi di
Mister con l'agente locale, run di prova con conferma, comportamento a runner spento.
