# Botcave: Ferma e Accoda, skill dei personaggi, «Esegui il piano» da Lucius

Data: 2026-11-10. Stato: design approvato in chat da Ivan, spec da rivedere.

Tre migliorie alle chat dei personaggi (Alfred e Lucius) nel pannello unico, nella chat del piano e nella chat di squadra.
Una spec, **tre PR in sequenza**, ognuna con il suo sì al merge:

1. **Ferma, Invia subito, Accoda** (§1)
2. **Skill visibili e selezionabili** (§2)
3. **«Esegui il piano» da Lucius** (§3)

Primo caso reale: eseguire il piano approvato di The Hub Up (App 3) con una squadra ibrida (ruoli `node` con «Claude Code (nodo)», ruoli `cloud` con
altri modelli).

Chat interessate in tutto il documento: conversazioni dei personaggi (`lib/characters/run-turn.ts`, tabelle `character_*`), chat del piano
(`lib/plan-chat/run-turn.ts`, `plan_*`) e chat di squadra (`lib/team-chat/run-turn.ts`, `team_chat_*`). Tutte e tre passano da `runChatTurn`
(`lib/node-turns/chat-turn.ts`), che usa `runPlanTurn` (cloud) o `delegateTurn` (nodo). La console usa per tutte `CharacterChat`
(`components/characters/character-chat.tsx`), in console ed embed.

---

## 1. Ferma, Invia subito, Accoda

### 1.1 Comportamento

Mentre un personaggio risponde (`turn_status = running`) la casella di scrittura resta attiva:

- **Ferma**: interrompe il turno in corso.
- **Invia subito** (il pulsante d'invio durante un turno): ferma il turno e manda subito il messaggio.
- **Accoda** (pulsante secondario): il messaggio si salva sul server «in coda» e parte da solo quando il turno finisce (anche se il pannello si
  chiude o si cambia dispositivo).

Un turno fermato:

- chiude il messaggio dell'assistente con «Risposta interrotta.» (`error: false`, non è un errore del sistema);
- lascia valido tutto quello che ha già fatto: schede salvate (personaggi, piano, squadra), appunti di memoria, voci in «Da confermare»;
- registra i token già spesi e il costo (sul nodo quello riferito, se arriva; altrimenti 0 come oggi per `cancelled`);
- resta nella cronologia del turno dopo con il suo testo e le sue schede (`[scheda …: stato]`), così il personaggio sa cosa aveva già proposto.

### 1.2 Interruzione nel server

- **Registro dei turni**: `trackTurn` (`lib/stale-turns.ts`) crea anche un `AbortController` per turno (`kind`, `conversationId`) e lo passa a
  `run`; nuova funzione `abortTurn(kind, conversationId): boolean` (true se il turno gira in questo processo).
- **Segnale nel ciclo**: `ChatTurnInput.signal`; `PlanTurnDeps` riceve `signal?: AbortSignal` e `runPlanTurn`:
  - lo passa a `deps.chat` → `modelChat({ signal })` (già supportato dall'esecutore);
  - controlla `signal.aborted` prima di ogni giro e prima di ogni strumento; abortito → esito `{ ok: false, stopped: true, … }` con i token e il
    costo già accumulati (un abort durante la chiamata al modello: token della chiamata persi, come un timeout).
  - Sul nodo il segnale va a `delegateTurn` (già supportato: chiude il turno `cancelled`; il nodo riceve 409 al ping e termina `claude`).
  - Nel ripiego cloud vale lo stesso segnale.
- **Esito fermato**: `PlanTurnOutcome` aggiunge `stopped?: true`; i tre `execute*Turn` scrivono allora «Risposta interrotta.» con `error: false`.
- **Scrittura finale condizionata**: la chiusura del turno aggiorna il messaggio dell'assistente solo se `content = ''` (UPDATE condizionato); se
  nessuna riga cambia il turno è già stato chiuso altrove (fermato da un altro processo, o dallo sweeper): `idle` e `updated_at` non si toccano due volte.
  Token e costo del turno si sommano sempre alla conversazione (chi ha chiuso il turno altrove non li somma: nessun doppio conteggio); stato e
  `updated_at` cambiano solo se la scrittura del messaggio è riuscita.

### 1.3 API

Per ognuna delle tre chat (stesse route esistenti, prefissi di oggi):

- `POST /api/character-conversations/:id/stop`, `POST /api/plan-conversations/:id/stop`, `POST /api/team-chat-conversations/:id/stop`:
  - turno non in corso → 200 `{ stopped: false }` (idempotente);
  - turno in questo processo → `abortTurn`, attende la chiusura (al più 10 s) e risponde `{ stopped: true }`;
  - turno in un altro processo (durante un deploy) → chiude direttamente con lo stesso UPDATE condizionato del §1.2 (messaggio vuoto →
    «Risposta interrotta.», conversazione `idle`, `updated_at`), `{ stopped: true }`; il processo vecchio trova il messaggio già scritto e non
    sovrascrive. Sul nodo: si chiude anche il turno delegato `queued|running` del messaggio (`cancelTurn` per `consumer` + `message_id`).
  - Limite: il contatore dei messaggi della chat (10/min) non si consuma; 30/min per utente per lo stop (`consumeTurnStop`).
- `POST …/messages` accetta `mode` facoltativo: `normal` (default, come oggi: 409 «il personaggio sta già rispondendo» se il turno è in corso),
  `now`, `queue`.
  - `now`: se il turno è in corso il messaggio diventa il messaggio in coda (come `queue`, sostituendo il testo di un eventuale messaggio già
    in coda, che la console mostra) e il turno si ferma come `…/stop`: a fine turno parte subito; altrimenti come `normal`. Così non c'è una
    corsa tra il turno fermato e il turno nuovo. 202.
  - `queue`: se il turno è in corso salva il messaggio con `queued_at = now()` (un solo messaggio in coda per conversazione: uno nuovo ne
    sostituisce il testo e la pagina, `queued_at` resta del primo); se il turno non è in corso parte subito. 202.
  - La risposta resta il messaggio dell'utente (quello in coda, se accodato); lo stato si legge dal dettaglio (`queuedMessage`).
  - Validazioni (vuoto, lunghezza, contesto della pagina, argomento eliminato, conversazione archiviata, squadra chiusa) come oggi, anche in coda.
- `DELETE …/queued` («Annulla»): toglie il messaggio in coda (204; nessuno → 204).
- I dettagli della conversazione (`CharacterConversationDetail`, `PlanConversationDetail`, `TeamChatConversationDetail`) espongono `queuedMessage`
  `{ id, content, createdAt } | null`; i messaggi in coda non compaiono in `messages`.
- Con un token personale valgono gli ambiti per metodo (stop e coda sono scritture: `api:write`); token `embed` come le altre route della chat.

### 1.4 Partenza del messaggio in coda

- A fine turno (normale, fermato o fallito), dopo la scrittura finale, `drainQueued`: con la conversazione `idle` il messaggio in coda
  diventa l'ultimo messaggio dell'utente
  (si avvia il turno con `startXTurn`, che inserisce il messaggio come riga nuova con l'id più alto, poi si cancella la riga in coda: l'ordine
  della cronologia resta per id). Se `startXTurn` rifiuta (turno già ripartito: la coda si svuoterà alla sua fine; argomento eliminato,
  conversazione archiviata, squadra chiusa) il messaggio resta in coda, visibile con «Annulla».
- Al momento della partenza si controllano tetto del personaggio, modello e tetto di spesa come per un messaggio normale: se bloccato il messaggio
  parte comunque e il turno chiude con il messaggio d'errore dell'assistente (come oggi per un tetto raggiunto nel turno). Il limite di 10/min si
  consuma all'accodamento, non alla partenza.
- Anche lo sweeper dei turni appesi e la pulizia dell'avvio (`failInterrupted*`) chiamano `drainQueued` per le conversazioni che chiudono.

### 1.5 Dati (migrazione additiva)

`docs/migrations/2026-11-ferma-accoda.sql` (idempotente, niente `-post`):

- colonna `queued_at timestamptz` (nulla) su `character_messages`, `plan_messages`, `team_chat_messages`;
- per ognuna un indice unico parziale `(conversation_id) WHERE queued_at IS NOT NULL` (un solo messaggio in coda per conversazione).

Le letture della cronologia (`loadHistory` delle tre chat, serializzatori, riassunti delle memorie, titolo della conversazione al primo messaggio)
escludono le righe con `queued_at` non nullo.

### 1.6 Console

In `CharacterChat` (valida per le tre chat, console ed embed):

- accanto all'avanzamento del turno (`turn-progress-view.tsx`) il pulsante «Ferma» (`secondary`);
- durante il turno il pulsante d'invio diventa «Invia subito» (principale) con accanto «Accoda» (`outline`); Invio da tastiera = «Invia subito»;
- il messaggio in coda si vede sotto l'avanzamento, in grigio, con «In coda» e «Annulla»;
- dopo «Ferma» il polling continua finché la conversazione non è `idle` (il messaggio in coda può far ripartire subito un turno).

### 1.7 Prove

- Unità: `runPlanTurn` con segnale abortito prima di un giro, durante la chiamata, tra due strumenti; `abortTurn` del registro.
- Route (PGlite, modello finto lento): stop di un turno in corso, stop idempotente, `mode=now` (turno fermato con il suo messaggio e il turno nuovo
  con il messaggio nuovo), `mode=queue` (parte a fine turno; sostituzione del testo; `DELETE …/queued`), turno «in un altro processo» chiuso dalla
  route senza sovrascrittura, scheda salvata prima dello stop ancora `pending` e accettabile.
- Nodo: `delegateTurn` con turno `running` e stop → `cancelled` e messaggio «Risposta interrotta.» (estensione di `node-turn-flow.test.ts`).

---

## 2. Skill visibili e selezionabili

Due cose diverse, mostrate insieme nella chat in una barra «Cosa so fare».

### 2.1 Skill di Claude Code (sul nodo, usate da Claude da solo)

Valgono solo nelle conversazioni con un modello «Claude Code (nodo)». Sono le skill del Mac (`~/.claude/skills`) e quelle dei plugin abilitati
(es. superpowers), che il nodo già dichiara nell'heartbeat (`nodes.skills`). Oggi i turni di chat le escludono.

- **Esecuzione** (`artifacts/casello-nodo/src/turn-runner.ts`), solo se il pacchetto del turno ha `skills: true`:
  - nella cartella del turno (`~/.casello-nodo/turns/<id>/`) si crea `.claude/skills/` con un collegamento simbolico per ogni skill di
    `~/.claude/skills` (diventano skill di progetto: `--setting-sources project` resta);
  - per ogni plugin abilitato (`enabledPlugins` di `~/.claude/settings.json`) un `--plugin-dir` sulla versione più recente nella cache dei plugin;
  - `--tools "Skill"` al posto di `--tools ""` e `--allowedTools "mcp__botcave__*" "Skill"`;
  - hook, permessi, server MCP e il resto delle impostazioni personali restano esclusi (`--strict-mcp-config`, nessun `user` nelle fonti).
  - Bash, Write, Edit e Read non ci sono: le istruzioni del turno (nodo) aggiungono «Puoi usare le skill (strumento Skill) come metodo di
    lavoro; le parti che chiedono comandi o file non sono disponibili in questa chat: saltale.»
- **Prova preliminare** sul `claude` vero, prima del resto della PR: verificare che con `--setting-sources project` le skill di progetto della
  cartella del turno e i `--plugin-dir` siano caricate e che lo strumento Skill le usi. **Ripiego** se non funziona: il nodo legge nome e
  descrizione delle skill (frontmatter) e li aggiunge al prompt di sistema, e il server MCP del turno offre `leggi_skill_nodo {nome}` che il nodo
  risolve localmente (il contenuto del SKILL.md non passa da Botcave). La spec si aggiorna con l'esito («Differenze dal codice»).
- **Interruttore**: account AI nodo, campo `nodeSkills` (boolean, default vero) → nel pacchetto del turno `skills`. Colonna
  `ai_accounts.node_skills boolean not null default true`. Console: casella «Skill di Claude Code nelle chat» nel dialogo dell'account nodo.
  I nodi di versione precedente ignorano il campo. Versione di `casello-nodo` alzata.
- **Elenco visibile**: l'heartbeat aggiunge `skillDetails` facoltativo `[{ name, description }]` (descrizione dal frontmatter, ≤ 300 caratteri,
  al più 500 voci; valori non validi scartati senza rifiutare l'heartbeat) → `nodes.skill_details jsonb`. Solo nome e descrizione: mai il contenuto.
- Solo per le chat: le run degli agenti sul nodo restano come oggi (fuori ambito).

### 2.2 Skill del catalogo di Botcave (aggiunte per conversazione)

Valgono con qualunque modello. Sono le skill `casello` di `skills` (istruzioni scritte), oggi usate da agenti e ruoli.

- **Dati**: tabella `chat_conversation_skills` (`id`, `chat_kind` enum `character|plan|team`, `conversation_id`, `skill_id` (FK `skills`,
  `RESTRICT`), `skill_version`, `created_at`; unico su `chat_kind, conversation_id, skill_id`; FK composta `(skill_id, skill_version)` su
  `skill_versions (skill_id, version)`, che ha già il vincolo unico). Niente FK sulla conversazione (tre tabelle diverse): le righe si cancellano
  nella stessa transazione dell'eliminazione della conversazione (e dell'app o della squadra che la porta via a cascata).
- **Regole**: solo skill di tipo `casello` non deprecate al momento dell'aggiunta (400 «skill non disponibile»); al più 5 per conversazione
  (400 «al massimo 5 skill per conversazione»); somma dei contenuti ≤ 20 000 caratteri (400 «skill troppo lunghe per una conversazione»); la
  versione si fissa alla `current_version` dell'aggiunta. Una skill poi deprecata resta (versione fissata). Conversazione archiviata → 409.
- **Turno**: il contenuto delle skill (versione fissata) entra nel messaggio `system`, dopo le istruzioni del personaggio, sotto «Skill aggiunte
  dall'utente:» con `## <nome> (<codice> v<n>)`. È testo dell'utente, fidato come le istruzioni degli inneschi. La riduzione del contesto
  (~30 000 token) lo conta e non lo tronca (il limite di 20 000 caratteri basta).
- **API** (per le tre chat): `GET|PUT …/conversations/:id/skills` (`PUT {codes: string[]}` sostituisce l'insieme; le skill già presenti
  mantengono la versione fissata; `{skills: [{code, name, version, description}]}`). Con un token personale ambiti per metodo.

### 2.3 «Cosa so fare»

- `GET …/conversations/:id/capabilities` (per le tre chat) → `{ tools: [{name, label}], nodeSkills: [{name, description}] | null, catalogSkills }`:
  - `tools`: gli strumenti che il turno offrirebbe ora (argomento, memoria, `passa_a`, codice se disponibile), con un'etichetta fissa in italiano
    da una mappa nuova accanto a `describeStep` (`lib/turn-progress/describe.ts`); strumento senza etichetta → il suo nome;
  - `nodeSkills`: `nodes.skill_details` del nodo dell'account, solo se il modello della conversazione è un modello nodo e l'interruttore è
    attivo; altrimenti null;
  - `catalogSkills`: le skill aggiunte alla conversazione.
- **Console**: in cima a `CharacterChat` una barra richiudibile «Cosa so fare» (chiusa di default, stato ricordato in `localStorage` del browser)
  con tre elenchi: «Strumenti su questa pagina», «Skill di Claude Code» (solo con un modello nodo, nota «Claude le usa quando servono»),
  «Skill di Botcave» (spunte con ricerca tra le skill `casello` del catalogo, link alla scheda della skill che si apre in console). Niente
  scorrimento orizzontale a 1280 px; sul telefono gli elenchi vanno a capo.

### 2.4 Migrazione

`docs/migrations/2026-11-skill-personaggi.sql` (additiva e idempotente): enum `chat_kind`, tabella `chat_conversation_skills`, colonne
`ai_accounts.node_skills` e `nodes.skill_details`.

### 2.5 Prove

- API: aggiunta/rimozione, limiti, versione fissata, skill nel messaggio `system` (le tre chat), `capabilities` con e senza modello nodo.
- Nodo: argomenti di `claude` con e senza `skills` (collegamenti in `.claude/skills`, `--plugin-dir`, `--tools "Skill"`), `skillDetails`
  dall'heartbeat con frontmatter valido, mancante e troppo lungo.
- A mano sul Mac: una chat di Lucius con Claude Code che usa una skill di superpowers.

---

## 3. «Esegui il piano» da Lucius

### 3.1 Comportamento

Nella chat del piano di un'app (pagina `/apps/:id/plan`, pannello Lucius della scheda app, embed) Lucius, quando il piano ha voci approvate e
l'utente lo chiede (o lo suggerisce lui), propone una scheda **«Esegui con la squadra …»**. Accettandola nasce una squadra in bozza legata
all'app, con un PLAN già approvato costruito dalle voci approvate; l'utente la attiva dalla scheda squadra.

### 3.2 Strumenti nuovi di Lucius (chat del piano)

In `lib/plan-chat/tools.ts` (con l'ambiente in `PlanToolEnv`):

- `elenca_modelli_squadra`: modelli non archiviati con versione, ruoli (key, nome, capo, `runsOn`, nome del modello), al più 50.
- `leggi_modello_squadra {id}`: manifesto della versione corrente (identità dei ruoli troncate a 1 000 caratteri, nomi di strumenti e skill).
- `elenca_squadre_app`: squadre non chiuse con `ref_app_id` = l'app, con stato e voci già coperte (dalle schede accettate, §3.4).
- `proponi_esecuzione` (vedi §3.3).

Le istruzioni della chat del piano (`plan-chat/context.ts`) aggiungono: quando proporre l'esecuzione, che ogni voce approvata va coperta o
esclusa con un motivo, preferire un modello esistente adatto, proporne uno nuovo solo se nessuno va bene, squadre ibride ammesse (ruoli `node`
per il lavoro sul codice con Claude Code, ruoli `cloud` per il resto).

### 3.3 La scheda

`proponi_esecuzione`:

```
{
  template: { id: number } | { new: { name, description?, roles } },   // roles con le regole di template_create (validateRoles)
  title?: string (1..200, default «Piano di <app>»),
  plan: {
    objective: string (≤ 2 000),
    constraints?: string[] (≤ 30 da 500),
    tasks: [{ title (1..200), roleKey, instructions (≤ 3 000), itemRefs: string[] (1..20, riferimenti delle voci come nel piano) }] (1..50)
  },
  excluded?: [{ ref, reason (1..300) }],
  rationale: string (≤ 1 000)
}
```

Regole (alla proposta, con errore da correggere come per `propose`: messaggio fisso con il campo, al più 2 correzioni per proposta e 8 proposte
non valide per turno, stessi contatori):

- `roleKey` esistente nei ruoli del modello (esistente: versione corrente; nuovo: i ruoli proposti); il capo può avere compiti;
- `itemRefs` e `excluded[].ref` solo voci `approved` dei capitoli endpoint, completion, evolution dell'app;
- **copertura**: ogni voce approvata di quei capitoli è in almeno un compito o in `excluded`, mai in entrambi; le voci già coperte da una
  squadra non chiusa dell'app possono stare solo in `excluded` (Lucius lo sa da `elenca_squadre_app`);
- modello esistente archiviato o inesistente → errore; modello nuovo: `validateRoles` (un capo, `cloud` con modello dei propri account e mai un
  modello nodo, `node` senza modello, strumenti e skill ammessi), nome non già usato.
- Istruzioni dei compiti: al testo di Lucius il server aggiunge in fondo, all'accettazione, un blocco «Voci del piano:» con, per ogni voce,
  riferimento, capitolo, titolo, «issue #n <url>» se c'è e, per completion, «Fatto quando: …» (troncato perché il totale resti ≤ 4 000;
  per questo il testo di Lucius è limitato a 3 000).
- Impronta (`target_hash`): SHA-256 di id, stato e `updated_at` delle voci approvate dell'app, delle coperture delle altre squadre e, per un
  modello esistente, della sua versione corrente.
- Al più una scheda `pending` di esecuzione per conversazione: una nuova rende `stale` la precedente.

### 3.4 Dati

Tabella `plan_execution_proposals` (migrazione additiva):

`id`, `conversation_id` (FK `plan_conversations`, `CASCADE`), `message_id` (FK `plan_messages`, `CASCADE`), `payload jsonb` (la scheda validata),
`rationale`, `target_hash`, `status` (enum `plan_proposal_status` esistente: `pending|accepted|rejected|stale`), `team_instance_id` (FK, `SET NULL`),
`template_id` (FK, `SET NULL`), `covered_item_ids integer[]` (voci nei compiti, scritte all'accettazione: servono a `elenca_squadre_app` e alla
copertura), `decided_at`, `created_at`. Indice su `conversation_id`.

Non si riusa `plan_proposals`: è legata a un capitolo e a una voce.

### 3.5 Accettazione

`POST /api/plan-execution-proposals/:id/decision` `{ decision: accept | reject }` (dati dell'utente, altrui → 404; già decisa → 409; ambito
`api:write`; vietata al token `agent` come le altre decisioni: si aggiunge ad `AGENT_DENIED_ROUTES`).

Accettare:

1. Dal pool, fuori dalla transazione: rilettura delle voci, ricalcolo dell'impronta (diversa → scheda `stale`, 409 «il piano è cambiato: chiedi
   a Lucius una proposta aggiornata»), rivalidazione di ruoli e modello (`validateRoles`), costruzione del PLAN (compiti `t1`… `planned`, esito
   null, istruzioni con il blocco delle voci; nessuna azione manuale né punto aperto).
2. In una transazione: scheda bloccata `FOR UPDATE` e ancora `pending`; se il modello è nuovo `createTemplate` (nome già usato → 409 col messaggio
   di regola, scheda `pending`); `createInstance` dal modello (`ref_app_id` = app, `ref_type` = `piano`, `ref_id` = id dell'app, `ref_title` =
   `title`, stato `draft`, skill fissate come sempre); `writePlanVersion(instance, plan, "approved")` più `approved_version` = quella versione;
   scheda `accepted` con `team_instance_id`, `template_id`, `covered_item_ids`, `decided_at`.
3. Risposta: la scheda con `teamInstanceId`. Nessun turno parte: la squadra è in bozza.

Rifiutare: `rejected`, nessun effetto. Una squadra creata così si chiude o si modifica come ogni altra; chiudendola le sue voci tornano proponibili.

### 3.6 Attivazione

Il turno `activation` già dice al capo «Se il PLAN non è approvato, proponilo»: con il PLAN già approvato il capo legge il piano e assegna i compiti
(nessuna modifica necessaria al codice delle squadre; si aggiunge solo un test che lo verifica con un modello finto).

### 3.7 API e console

- `PlanConversationDetail.executionProposals` (elenco, ciascuna con il suo `messageId`, come le schede di oggi) con la scheda e i dati per la
  vista: nome del modello, ruoli (nome, capo, luogo, modello), compiti raggruppati per ruolo con le voci (titolo, issue), voci escluse con
  motivo, stato, `teamInstanceId`.
- Console (`components/characters/proposal-cards.tsx` + `plan-team-adapters.tsx`): scheda «Esegui con la squadra <titolo>» con modello
  («nuovo» o esistente), ruoli con LED del luogo (cloud/nodo) e modello, compiti per ruolo con badge delle issue (`issue-badge.tsx`), voci escluse,
  motivazione; pulsanti «Crea la squadra» e «Rifiuta»; accettata: link «Apri la squadra».
- Scheda squadra (`team-detail.tsx`): con `ref_type = piano` la riga «Nata dal piano di <app>» con il link alla pagina del piano.
- Niente scorrimento orizzontale a 1280 px (verificato nel browser).

### 3.8 Migrazione

`docs/migrations/2026-11-esegui-piano.sql` (additiva e idempotente): tabella `plan_execution_proposals` con indice.

### 3.9 Prove

- Validazione della scheda: copertura mancante, voce sia in compito sia esclusa, voce non approvata, `roleKey` inesistente, modello archiviato,
  modello nuovo con un modello nodo su un ruolo `cloud`, voce già coperta da un'altra squadra.
- Accettazione: squadra `draft` con ref corretti, PLAN approvato con i compiti e il blocco delle voci (issue comprese), modello nuovo creato,
  impronta cambiata → `stale`, decisione doppia → 409, token `agent` → 403.
- Attivazione con PLAN approvato: il capo (modello finto) chiama `assegna_compito` senza proporre il piano.

### 3.10 Fuori ambito

Risincronizzare la squadra quando il piano cambia dopo l'accettazione; aggiornare le voci del piano o chiudere le issue a compito finito;
strumenti GitHub dei ruoli cloud (sessione «ruoli cloud che modificano il codice via GitHub»: quando esisteranno, i modelli di squadra li
useranno e la scheda li mostrerà senza modifiche); esecuzione dal Responsabile o da Alfred.

---

## 4. Documentazione e consegna

- `CLAUDE.md`: una riga nello «Stato» per ogni PR e le sezioni toccate («Alfred e Lucius nelle aree», «Chat del piano», «Lucius sulla squadra e
  memorie», «Esecutore Claude Code (nodo)», «Squadre (esecuzione)»).
- `openapi.yaml` aggiornato e codegen committato per ogni PR.
- Ogni migrazione va su Neon PRIMA del merge, con l'SQL completo in chat e segnalata nella PR; riportata in `docs/schema-casello.sql`.
- La PR 2 alza la versione di `casello-nodo`; dopo il deploy il nodo si aggiorna da solo (Botcave Nodo) o con `casello-nodo install`.
