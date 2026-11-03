# Casello: strumenti MCP, livelli d'azione e coda delle conferme (design)

Data: 2026-11-03. Sottoprogetto 1 della specifica «squadre di agenti in Casello» (bozza v0.2): il prerequisito
per squadre, centralino vocale e nodo locale, utile anche da solo.

## 1. Contesto e scopo

Oggi Casello chiama solo tool HTTP dichiarati nel catalogo (`app_tools`, `kind = http`) e protegge le azioni con
due flag (`readOnly`, `requiresConfirmation`). La conferma tiene ferma la run (`awaiting_client`) con il token
dell'utente in memoria, quindi dura al massimo 10 minuti. La specifica delle squadre chiede invece:

- servizi che espongono i propri strumenti con un server MCP, Casello che fa da host;
- quattro livelli d'azione per strumento (L0–L3);
- una coda delle conferme asincrona («approva la N» anche ore dopo), unica per tutte le run.

Scopo: Casello come client MCP dei servizi, livelli L0–L3 su ogni tool (HTTP e MCP), coda delle azioni L2
staccata dalla run, il tutto dentro il percorso dell'architetto (analisi → proposte → approvazione).

Fuori ambito (sottoprogetti successivi): squadre, ruoli e bollettino; regole «a voce» e «dentro un PLAN
approvato» per L1; organizzazioni e identità delegata dal portale; nodo locale; interfaccia in The Hub Up.

## 2. Livelli d'azione

| Livello | Significato | In una run |
|---|---|---|
| L0 leggi | nessun effetto | eseguito subito |
| L1 lancia | effetti interni o reversibili | eseguito subito e registrato nei passi (i vincoli «a voce» / PLAN arrivano con le squadre) |
| L2 conferma con rilettura | effetti esterni (commenti, stati, mail) | mai eseguito dalla run: accodato in `pending_actions` |
| L3 mai a voce | produzione, trasporti verso PRD, cancellazioni | mai offerto al modello |

- Ogni riga di `app_tools` ha `level` (dichiarato) e `level_override` (facoltativo, solo ≥ `level`); il livello
  effettivo è il più alto dei due. Vale per tutti i `kind`.
- Strumenti MCP: `level` dai metadati dello strumento, chiave `_meta["casello/level"]` con valore `"L0"`..`"L3"`;
  se manca o non è valida, `annotations.readOnlyHint === true` → L0, altrimenti L2. Il servizio decide il minimo,
  Casello può solo alzarlo.
- Tool HTTP esistenti (migrazione): `read_only` → L0, `requires_confirmation` → L2, altrimenti L1. Il modulo
  dei tool, l'architetto e la console smettono di usare i due flag; le colonne si eliminano con lo script `-post`.

## 3. Strumenti MCP nel catalogo

- `apps.mcp_url` (facoltativo): server MCP del servizio, trasporto Streamable HTTP. Regole di indirizzo come
  `base_url` (https; rete interna ammessa come per `internal_base_url`; nessun redirect). Se l'app ha
  `internal_base_url`, Casello chiama il server MCP sullo stesso host interno con il path di `mcp_url`.
- `tool_kind` aggiunge `mcp`. `definition` di un tool MCP: `{ "mcpName": "<nome sul server>" }`;
  `params_schema` = `inputSchema` dello strumento (con `"x-sensitive": true` rispettato come oggi).
  Il nome in Casello è il nome MCP (unico per app, come oggi).
- **«Aggiorna strumenti»** (`POST /api/apps/:id/mcp-tools/refresh`, 6/minuto per utente) legge `tools/list`
  (30 s, massimo 500 strumenti, paginazione MCP seguita) e allinea il catalogo in una transazione:
  - nuovi → `draft` (nulla si attiva senza approvazione);
  - esistenti → aggiorna descrizione, schema e `level` dichiarato (lo stato e l'override restano; se il nuovo
    `level` supera l'override, l'override si azzera);
  - spariti → `disabled`, mai cancellati.
  Risposta: conteggi `added`, `updated`, `disabled`, `unchanged`.
- Identità del tool MCP (`user` | `service`) come per HTTP: default `service` se l'app ha un segreto di servizio,
  altrimenti `user`; si cambia in console.

## 4. Architetto

- L'elenco MCP è una fonte dell'analisi, come l'OpenAPI: all'avvio, se l'app ha `mcp_url`, Casello legge
  `tools/list` (stessi limiti del §3) e lo tiene in memoria per la durata dell'analisi. `analyses.sources` registra
  `mcp: true|false`.
- Strumento di fase `list_mcp_tools` (cloud) e `read_mcp_tools` sul server `/mcp` (agente locale): nome,
  descrizione, livello dichiarato, schema, a pagine come `list_operations`.
- Fase catalog: i tool proposti hanno `level` (al posto di `readOnly`/`requiresConfirmation`) e `kind`; per un
  tool MCP il livello proposto non può essere sotto quello dichiarato (validato in `schemas.ts`). Approvare la
  voce crea o aggiorna la riga e la rende `active`, come oggi.
- Le carenze del server MCP diventano voci `endpoint` del piano (e quindi issue): livello non dichiarato, strumento
  necessario a un agente proposto ma assente, strumento con effetti esterni senza un parametro che identifichi il
  destinatario. Le istruzioni e gli esempi di fase in `prompts.ts` si aggiornano di conseguenza.
- «Aggiorna strumenti» e analisi convivono: l'aggiornamento allinea il catalogo tra un'analisi e l'altra senza
  attivare nulla; l'analisi successiva propone i `draft`.

## 5. Coda delle conferme

### Dati

Tabella `pending_actions`:

- `id`, `user_id` (chi ha avviato la run), `number` (progressivo per utente, unico per `user_id` + `number`),
  `app_id`, `tool_id`, `run_id` (`SET NULL` alla cancellazione), `agent_id`;
- `args_enc` (argomenti fissati, cifrati con `CASELLO_SECRET_KEY`), `args_public` (gli stessi con i parametri
  `x-sensitive` oscurati), `recipient`, `summary`;
- `status`: `pending` | `executing` | `done` | `failed` | `rejected`; `result` (testo, come un risultato di tool,
  credenziali già oscurate), `error_message`, `decided_by` (utente), `decision_note`, `created_at`, `decided_at`,
  `finished_at`.

### Accodamento

- Agli strumenti L2 offerti al modello Casello aggiunge due parametri obbligatori: `destinatario` (stringa) e
  `sintesi` (stringa, max 500 caratteri). Non arrivano al servizio.
- Una chiamata a uno strumento L2 non viene eseguita. Casello valida gli argomenti contro `params_schema`, esegue il
  controllo dei testi e, se passa, crea la voce `pending`; il modello riceve
  `accodata come n. <N>, in attesa di conferma dell'utente` e prosegue o chiude. Il passo della run è di tipo
  `queued` con il numero.
- Controllo dei testi (modulo puro `lib/actions/text-check.ts`), su `sintesi` e sui valori stringa degli argomenti:
  - segnaposto: `[...]` con testo dentro (es. `[data da concordare]`), `<...>` con testo dentro che non sia un tag
    HTML noto, `TODO`, `TBD`, `XXX`, `???`;
  - menzioni `@nome` che non compaiono in `destinatario`.
  Se trova qualcosa, nessuna voce: il modello riceve l'errore «testo non pronto: <elenco>» e può correggere.
- Massimo 50 voci `pending` per utente: oltre, errore al modello «troppe azioni in attesa di conferma».

### Decisione

- `GET /api/pending-actions?status=` (default `pending`, ordine per numero), `GET /api/pending-actions/:number`,
  `POST /api/pending-actions/:number/approve` (corpo facoltativo `{ userToken }`),
  `POST /api/pending-actions/:number/reject` (`{ note? }`, max 500). Solo le voci dell'utente; approvazioni e
  rifiuti 20/minuto per utente; con un token personale serve `api:write` (decidere non è `sessionOnly`: è il
  canale del futuro centralino).
- Approvare: UPDATE condizionato `pending` → `executing` (una sola esecuzione anche con richieste concorrenti),
  poi una chiamata del tool con gli argomenti fissati, senza richiamare il modello. Identità `user`: serve
  `userToken` nella richiesta (altrimenti 400 «serve il token dell'utente dell'app», la voce resta `pending`);
  identità `service`: segreto dell'app. Esito → `done` con `result` oppure `failed` con messaggio fisso.
- Il livello si ricontrolla all'approvazione: se lo strumento è diventato L3 o `disabled`, 409 e la voce resta
  `pending` (si può solo rifiutare).
- All'avvio le voci rimaste `executing` diventano `failed` con «esito incerto: verifica sul servizio»: non si
  rieseguono mai da sole.
- Nessuna scadenza.

### Fine della pausa

- Spariscono la pausa per conferma (`awaiting_client`), `POST /api/runs/:id/resume`, `expireStalePausedRuns`, il
  token in memoria oltre la durata della run e i 10 minuti. All'avvio le run ancora `awaiting_client` diventano
  `cancelled` («conferma sostituita dalla coda delle azioni»).
- Il valore `awaiting_client` resta nell'enum Postgres (non si toglie un valore da un enum senza ricrearlo), non
  più usato dal codice né dall'OpenAPI.

## 6. Esecuzione MCP

- Client dell'SDK `@modelcontextprotocol/sdk` (già dipendenza), una connessione per run (e una per approvazione),
  chiusa alla fine; nessuna sessione persistente.
- Credenziali: identità `user` → header utente dell'app (`user_auth`) con il token della run; `service` → header di
  servizio con il segreto cifrato. Nessun redirect. Stessi limiti dei tool HTTP: 15 s per chiamata, risposta
  massima 1 048 576 byte, credenziali rimandate dal servizio sostituite con `***`.
- Risultato: il testo dei blocchi `text` più `structuredContent` serializzato se presente; altri tipi di blocco
  sostituiti da `[contenuto <tipo> omesso]`. `isError: true` → risultato `ok: false`, come un 4xx.
- Errori con messaggi fissi in italiano (mai il testo del servizio nei log): «server MCP non raggiungibile»,
  «autenticazione rifiutata dal server MCP», «strumento non trovato sul server MCP», «risposta MCP non valida».

## 7. Console

- Pagina dell'app: campo «Server MCP», pulsante «Aggiorna strumenti» con l'esito; nel catalogo colonna «Livello»
  (dichiarato e override; la tendina offre solo i livelli più alti di quello dichiarato) e il `kind`.
- Pagina «Da confermare» nel menu, con il contatore delle voci `pending`: elenco numerato con app, strumento,
  destinatario, sintesi, argomenti (sensibili oscurati), run d'origine; «Approva» (con il campo token quando lo
  strumento ha identità `user`) e «Rifiuta» con nota; filtro per stato.
- Timeline della run: passo «Accodata n. N» con il collegamento alla voce e il suo stato attuale.
- Spariscono i pulsanti di conferma/annulla della pausa.
- Senza scorrimento orizzontale a 1280 px.

## 8. Dati di produzione

- Prima del merge: `docs/migrations/2026-11-strumenti-mcp.sql` (additiva, idempotente): `apps.mcp_url`; valore
  `mcp` in `tool_kind`; `app_tools.level` (enum `tool_level` `L0`..`L3`, not null) e `level_override` con il
  travaso dai due flag; tabella `pending_actions` con indici (`user_id`, `status`) e unico (`user_id`, `number`).
- Dopo il deploy: `docs/migrations/2026-11-strumenti-mcp-post.sql`: elimina `app_tools.requires_confirmation`,
  `app_tools.read_only`, `runs.pending_action`, `runs.loop_state`, `runs.paused_at`.
- `docs/schema-casello.sql` aggiornato; tutto segnalato nella PR.

## 9. Test

- Finto server MCP per i test (`test/fake-mcp.ts`, come `fake-github.ts`).
- Livelli: dichiarato da `_meta`, ricavato da `readOnlyHint`, valore non valido → regola di ripiego, override solo
  verso l'alto, azzeramento dell'override superato, travaso dei flag nella migrazione.
- Aggiornamento del catalogo: nuovo (`draft`), cambiato, sparito (`disabled`), limite di 500, errori del server.
- Esecuzione: identità `user` e `service`, `isError`, blocchi non testuali, risposta troppo grande, timeout,
  oscuramento delle credenziali.
- Coda: parametri aggiunti agli L2, nessuna chiamata al servizio all'accodamento, controllo dei segnaposto e delle
  menzioni, limite delle 50 voci, numerazione per utente; approvazione una sola volta con due richieste insieme,
  token mancante → 400 senza cambiare stato, strumento diventato L3 o `disabled` → 409, rifiuto, `executing` dopo
  un riavvio → `failed`, voci di un altro utente → 404.
- L3 mai offerto al modello; L1 eseguito e registrato.
- Run `awaiting_client` chiuse all'avvio; `/api/runs/:id/resume` → 404.
- Architetto: fonte MCP letta e registrata, `list_mcp_tools`/`read_mcp_tools`, livello proposto sotto il dichiarato
  rifiutato dallo schema, voci `endpoint` per i livelli mancanti, esempi di `prompts.ts` validi.
- Entrambe le migrazioni idempotenti.
- Prova nel browser: «Aggiorna strumenti», livelli nel catalogo, pagina «Da confermare» (approva, rifiuta, token).
