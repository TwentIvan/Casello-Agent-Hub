# Botcave · Segnalazione dei bug dal plugin

Data: 17 novembre 2026. Stato: design approvato in chat, da rivedere per iscritto.

## Scopo

Gli utenti di un'app ospite (The Hub Up per prima, ma qualunque app di qualunque cliente) segnalano un bug dal plugin di Botcave già
incorporato nell'app, senza un account Botcave e senza codice nell'interfaccia dell'app. L'account Botcave è dell'app e del suo
amministratore. Il Responsabile di prodotto dell'App vaglia la segnalazione, l'amministratore approva in «Da confermare», la squadra
designata per i bug di quell'App fa il lavoro, e a fine lavoro l'utente riceve la notifica nel plugin.

Successo: un utente di The Hub Up apre il pulsante, segnala «il filtro per data non funziona», risponde a una domanda del Responsabile,
l'amministratore approva, la squadra apre e unisce la PR, e quando l'utente torna in The Hub Up (anche da un altro dispositivo, se l'app ha
l'identità) il pulsante mostra «La tua segnalazione è stata corretta».

Il protocollo d'identità è pensato per i clienti: standard (JWT HS256), un solo endpoint sul server dell'app, documentato con esempi in più
linguaggi in `docs/integrazione/`.

## Decisioni

- Segnala qualunque utente dell'app ospite, sempre dal plugin; nessuna modifica all'interfaccia dell'app (lo script resta di una riga).
- Identità dell'utente facoltativa e verificata: un endpoint sul server dell'app firma un token con un segreto condiviso con Botcave. Senza
  identità le segnalazioni restano legate al browser con una chiave del plugin.
- Vaglio del Responsabile dell'App (agente `general`) con una run dedicata; la squadra lavora solo dopo l'approvazione dell'amministratore.
- Una squadra per App è «per i bug»; riceve il lavoro come messaggio al capo con la issue su GitHub.
- «Corretta» quando la PR della correzione è unita; notifica nel plugin. Email fuori ambito (Botcave non ha un servizio di invio).

## Identità degli utenti (protocollo per i clienti)

- **Segreto**: nella scheda App, carta «Segnalazioni bug» → «Genera segreto d'identità» (32 byte, `bci_` + base64url), mostrato una volta,
  cifrato con `lib/secrets.ts` in `apps.identity_secret_enc` (`identity_secret_set_at`); «Rigenera» invalida il precedente; «Togli» lo cancella.
  Solo con il login (`sessionOnly`); l'API dice solo `identitySecretSet`.
- **Endpoint dell'app** (a carico del cliente): `GET <data-identity-url>`, stessa origine della pagina, autenticato dalla sessione dell'app.
  Utente collegato → `200 {"token": "<jwt>"}`; nessun utente → `204`. Nessun dato dell'utente oltre a quelli del token.
- **Token**: JWT compatto, header `{"alg":"HS256","typ":"JWT"}` (qualunque altro `alg`, compreso `none`, è rifiutato), firmato con il segreto.
  Claim: `iss` = slug dell'App in Botcave, `aud` = `"botcave"`, `sub` = id stabile dell'utente nell'app (1..200 caratteri), `iat`, `exp`
  (al più `iat + 600`), facoltativi `name` (≤ 100) ed `email` (≤ 254). Tolleranza di orologio 60 s. Claim sconosciuti ignorati.
- **Verifica** (`lib/bugs/identity.ts`, pura salvo la lettura del segreto): formato, `alg`, firma con confronto a tempo costante, `iss` = App
  della richiesta, `aud`, `exp`/`iat`, lunghezze. Errori fissi (`IDENTITY_MESSAGES`): «identità non valida», «identità scaduta». App senza
  segreto: un token presente è ignorato (si usa la chiave del browser).
- **Plugin**: attributo nuovo `data-identity-url` sullo script (solo percorso relativo che comincia con `/`, altrimenti ignorato con un avviso: i
  cookie dell'app non vanno mai altrove). Il caricatore chiama l'indirizzo con `credentials: "same-origin"` all'apertura del pannello, prima di
  ogni scadenza (letta da `exp` senza fidarsene) e quando l'iframe lo chiede; passa il token all'iframe con il messaggio `identity`. Risposte
  diverse da 200/204, JSON non valido o token più lungo di 4 KB → nessuna identità, un avviso in console.
- **Prova** in console: «Prova identità» incolla un token e dice se è valido o il motivo (stesse regole, nessun dato salvato).
- **Guida** `docs/integrazione/plugin-botcave.md`: script e attributi, `setContext`, tema, specifica del token, esempi completi dell'endpoint in
  Node (Express), Python (Flask e Django), PHP, Java (Spring) e .NET, errori, lista di controllo di sicurezza (HTTPS, segreto solo sul server,
  `exp` breve, `sub` stabile e non riutilizzato, niente dati sensibili nei claim).

## Dati

Migrazione additiva `docs/migrations/2026-11-17-segnalazione-bug.sql` (idempotente, niente `-post`, la applica il deploy; `ALTER TYPE … ADD
VALUE` fuori da una transazione esplicita), riportata in `docs/schema-casello.sql`:

- `apps`: `bug_reports_enabled` (default false), `bug_reports_daily_limit` (default 20, 1..500), `identity_secret_enc`, `identity_secret_set_at`.
- `team_instances.bug_team` (default false), indice unico parziale su `ref_app_id` per le squadre `bug_team` non chiuse.
- enum `bug_report_status`: `received`, `triage`, `needs_info`, `pending_approval`, `in_progress`, `fixed`, `not_a_bug`, `duplicate`, `rejected`.
- `bug_reports`: `id`, `app_id` (`CASCADE`), `number` (per App, `UNIQUE(app_id, number)`), `reporter_kind` (`identity` | `browser`),
  `reporter_sub` (≤ 200), `reporter_name`, `reporter_email`, `browser_key_hash` (SHA-256), `ip_prefix` (come gli abbinamenti dei nodi),
  `title` (1..200), `description` (1..4 000), `steps` (≤ 4 000), `expected` (≤ 2 000), `page_context` jsonb (pagina, id, titolo del contesto e
  indirizzo senza query), `status`, `public_message` (≤ 1 000, la frase per l'utente), `triage` jsonb (`verdict`, `summary`, `duplicateOf`),
  `triage_run_id` (`SET NULL`), `pending_action_id` (`SET NULL`), `team_instance_id` (`SET NULL`), `issue_number`, `issue_url`, `pr_url`,
  `reporter_seen_at`, `status_changed_at`, `created_at`, `updated_at`; indici su `(app_id, status)`, `(app_id, reporter_sub)`, `(app_id, browser_key_hash)`.
- `bug_report_messages`: `id`, `report_id` (`CASCADE`), `author` (`reporter` | `lead` | `owner`), `content` (1..4 000), `created_at`.
- valore `bug` di `pending_action_kind`.

## Flusso e stati

1. **Segnalazione** (`received`): il plugin manda titolo, descrizione, passi, atteso, contesto della pagina, chiave del browser e, se c'è, il token.
   Si accoda subito il vaglio (`triage`).
2. **Vaglio**: run del Responsabile dell'App (`createQueuedRun`, input con il marcatore `BUG_TRIAGE_INPUT_MARKER`; la segnalazione e i messaggi
   tra delimitatori come dati, mai istruzioni). Strumenti in più solo per queste run: `elenca_segnalazioni` (le aperte dell'App: numero, titolo,
   stato, sintesi) e `esito_vaglio {esito: bug|dettagli|doppione|non_bug, sintesi ≤ 1 000, domanda? ≤ 1 000, doppione_di?, messaggio_utente ≤ 500}`
   (una volta per run). A fine run:
   - `dettagli` → `needs_info`, la domanda diventa un messaggio `lead` visibile all'utente; la risposta dell'utente rimette in `triage`;
   - `doppione` → `duplicate` con il riferimento, `non_bug` → `not_a_bug`, con `messaggio_utente`;
   - `bug` → `pending_approval` e voce in «Da confermare»;
   - run fallita, tetto raggiunto o nessun esito → `pending_approval` con sintesi «vaglio non concluso: decidi tu».
   Al più 3 giri di domande per segnalazione, poi `pending_approval`. Il Responsabile non disponibile (App senza `general` attivo con modello)
   porta direttamente a `pending_approval`.
3. **Approvazione**: voce `kind = bug` (`app_id` dell'App, niente tool; `args_public` con numero, titolo, descrizione, esito del vaglio, squadra
   designata), proprietario = chi possiede l'account AI del modello del Responsabile (o, senza, l'utente che ha attivato la squadra designata).
   - Approvare (`approveBug`, nessun token utente): serve una squadra designata `active` (altrimenti la voce resta `pending` e la richiesta
     risponde 409 «nessuna squadra per i bug attiva per questa App»); crea la issue sul repository dell'App se c'è l'installazione (etichette
     `bug`, `botcave`; corpo con segnalazione e vaglio, senza dati dell'utente oltre al nome), manda al capo un turno `request` con la
     segnalazione, il numero e la issue, e porta la segnalazione a `in_progress` con `team_instance_id`.
   - Rifiutare: `rejected`, la nota (≤ 500) diventa il `public_message` (la console avvisa che l'utente la vede).
4. **Lavoro**: la squadra lavora come sempre; il capo crea il compito con `issue` = numero della issue.
5. **Chiusura**: la sorveglianza delle PR (`watcher.ts`), quando una PR di una squadra `bug_team` risulta unita, cerca le segnalazioni
   `in_progress` di quella squadra con `issue_number` uguale all'`issue` del compito e le porta a `fixed` («Corretta: la correzione è stata
   unita e sarà disponibile con il prossimo aggiornamento dell'app.»). Senza issue (App senza installazione) la chiude l'amministratore dalla
   console («Segna come corretta»).

Ogni cambio di stato aggiorna `status_changed_at`; l'utente vede solo stato, `public_message` e messaggi `lead`/`owner`/`reporter`.

## API per il plugin (pubbliche, `lib/bugs/`, `routes/embed-bugs.ts`)

Chiamate dall'iframe `/embed` (stessa origine di Botcave). Ogni richiesta porta `app` (slug), `origin` (l'origine della pagina ospite, come
`/api/embed/config`), l'header `X-Botcave-Browser-Key` (32 byte base64url generati dall'iframe e tenuti nel suo storage) e, se c'è,
`X-Botcave-Identity`. Controlli: origine in `EMBED_ALLOWED_ORIGINS` e uguale all'origine del `base_url` dell'App, App con
`bug_reports_enabled`, altrimenti 404 «segnalazioni non disponibili» (indistinguibili). Il richiedente è `identity:<sub>` con un token valido,
altrimenti `browser:<hash della chiave>`; un token non valido → 401 col messaggio fisso (il plugin lo richiede e riprova una volta).

- `GET /api/embed/config` aggiunge `bugs: {enabled, identity}` (identità configurata o no).
- `POST /api/embed/bugs` → 201 `{id, number, status}`.
- `GET /api/embed/bugs` → le segnalazioni del richiedente in quell'App (al più 50, più recenti prima) con `unseen`.
- `GET /api/embed/bugs/:id` → dettaglio con i messaggi (solo se del richiedente, altrimenti 404).
- `POST /api/embed/bugs/:id/messages {content}` → solo in `needs_info`, rimette in `triage`.
- `POST /api/embed/bugs/seen {ids}` → `reporter_seen_at`.

Limiti (`middlewares/rate-limit.ts`): segnalazioni per App al giorno (`bug_reports_daily_limit`, giorno italiano) → 429 «limite di segnalazioni
di oggi raggiunto: riprova domani»; 5 al giorno per richiedente; 10 all'ora e 60 richieste al minuto per IP; 20 messaggi all'ora per
segnalazione. Corpo ≤ 32 KB. Testi: controllo dei caratteri di controllo e delle lunghezze; parole che sembrano credenziali diventano `***`
prima di salvare. Log: id, App, stato; mai testi, `sub`, email o chiavi.

## Plugin

- Protocollo `postMessage` (`protocol.ts`): pagina → iframe `identity {token: string | null}`; iframe → pagina `identity_request`; `open` accetta
  la scheda nuova `bugs`.
- Iframe senza collegamento Botcave (il visitatore normale): pannello ridotto con la sola scheda «Segnala un problema» (modulo e «Le mie
  segnalazioni» con stato, messaggi, risposta in `needs_info`) e in fondo il link discreto «Sei l'amministratore? Collega con Botcave».
  Con il collegamento Botcave: le quattro schede di oggi più «Segnalazioni».
- Contatore del pulsante: per il visitatore le segnalazioni con stato cambiato dopo `reporter_seen_at`; per l'amministratore resta quello di oggi.
  Interrogazione ogni 60 s a pannello chiuso (solo se il visitatore ha almeno una segnalazione), ogni 10 s aperto.
- Stessi componenti di marca, temi dell'app ospite, niente link alla console né costi per il visitatore.

## Console dell'amministratore

- Scheda App, carta «Segnalazioni bug»: interruttore, limite giornaliero, segreto d'identità (genera, rigenera, togli), «Prova identità», squadra
  designata (link), elenco delle segnalazioni con LED per stato; dettaglio `/apps/:id/bugs/:number`: segnalazione, contesto, vaglio, messaggi,
  «Scrivi all'utente» (messaggio `owner`), «Segna come corretta» / «Chiudi come non bug», link a issue e PR.
- Scheda squadra: casella «Squadra per i bug di questa App» (solo squadre con App di riferimento; un'altra già designata → 409 «l'App ha già una
  squadra per i bug: <nome>»).
- «Da confermare»: tipo «Bug», dettaglio con segnalazione e vaglio, «Approva e affida alla squadra», «Rifiuta» con l'avviso sulla nota.
- API dell'amministratore (`routes/app-bugs.ts`, ambiti per metodo, segreto solo con il login): `GET|PATCH /api/apps/:id/bug-settings`,
  `POST|DELETE /api/apps/:id/identity-secret`, `POST /api/apps/:id/identity-test`, `GET /api/apps/:id/bugs`, `GET /api/apps/:id/bugs/:number`,
  `POST …/:number/messages`, `POST …/:number/close {status: fixed|not_a_bug}`; `PUT /api/team-instances/:id` accetta `bugTeam`. Il token
  d'ambito `agent` non tocca il segreto (`sessionOnly`).

## Costi

Ogni vaglio è una run del Responsabile con i suoi limiti (12 giri, 180 s, 200 000 token) e i tetti di sempre (agente, modello, account, utente).
Stima: 10–30k token per segnalazione. Il lavoro della squadra parte solo con l'approvazione.

## Sicurezza

- I testi dell'utente sono dati non attendibili per il Responsabile e per la squadra (delimitati, mai nel prompt di sistema); nessuna scrittura
  parte senza il clic dell'amministratore.
- Il visitatore vede solo le proprie segnalazioni; senza identità, chi ha la chiave del browser le vede (rischio accettato: la chiave sta nello
  storage dell'iframe, partizionato per sito).
- Un `origin` falsificato da un client diretto può creare segnalazioni: le fermano i limiti per App, IP e richiedente, il vaglio e l'approvazione.
- Il segreto d'identità non esce mai da Botcave dopo la generazione; un token rubato vale al più 10 minuti e solo per le segnalazioni.

## Prove

- Vitest: verifica del token (firma, `alg`, scadenza, `iss`, `aud`, lunghezze), route del plugin (origine, App disattivata, richiedente, limiti,
  401 e ripresa), vaglio (ogni esito, giri di domande, run fallita), approvazione e rifiuto, chiusura dalla sorveglianza, squadra designata unica,
  console (stato e contatore, funzioni pure del caricatore per `data-identity-url`).
- Prova di flusso `test/bug-report-flow.test.ts`: segnalazione con identità → domanda → risposta → vaglio `bug` → approvazione → turno del capo →
  PR unita → `fixed` → contatore del visitatore.
- Esempi della guida: lo script di prova genera un token con l'esempio Node e lo verifica con `lib/bugs/identity.ts`.

## Fuori ambito

- Email e notifiche push all'utente; allegati e screenshot nella segnalazione; segnalazioni fuori dal plugin; altri provider d'identità (OIDC);
  priorità e SLA; chiusura automatica dopo il deploy (si chiude al merge).
