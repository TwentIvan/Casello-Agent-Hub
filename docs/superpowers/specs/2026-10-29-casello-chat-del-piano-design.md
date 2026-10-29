# Casello: Chat del piano (discutere integrazioni e idee nuove sul piano di un'app)

Data: 29 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Contesto e obiettivo

L'architetto produce per ogni app voci di endpoint, completamento ed evoluzione; approvate, oggi restano in
Casello e si copiano a mano come testo di issue. Il percorso completo "dal piano all'implementazione" è stato
diviso in due sottoprogetti:

1. **Chat del piano** (questa spec): una chatbot nella console con cui discutere integrazioni e idee nuove sul
   piano di un'app; il bot propone modifiche al piano come schede che l'utente accetta o scarta.
2. **Dal piano alle issue** (spec successiva): pulsante esplicito «Crea issue su GitHub» (per voce, per fase,
   per tutte le mancanti), permesso Issues della GitHub App, voci aggiunte o modificate a mano, skill di Claude
   Code che realizza le issue in PR. Si è scelto che la fonte di verità del lavoro da fare sia **GitHub**: le
   issue sono il contratto, l'esecuzione si lancia da Claude Code (nessuna coda in Casello per ora).

Ordine deciso: prima la chat, perché le idee vanno integrate prima di creare le issue.

Decisioni prese:
- La chat vive **nella console di Casello** e si apre **su un'app**, sul piano della sua ultima analisi
  completata. Le altre app compaiono come schede brevi, per ragionare sulle integrazioni.
- La chat **non modifica il piano**: propone schede (`add`, `update`, `discard`) che l'utente accetta o scarta.
  Nulla cambia senza approvazione, come per l'architetto.
- Le voci nate in chat sono **righe di `analysis_items`** dell'analisi della conversazione, con `origin = chat`:
  seguono la stessa revisione, esportazione e (sottoprogetto 2) creazione delle issue. Un "piano dell'app"
  indipendente dalle analisi è rinviato: diventerà naturale con le squadre di agenti, e `origin` rende la
  migrazione meccanica.
- La chat **non legge il codice** in questa versione: ragiona sugli esiti dell'analisi (mappa, voci, prove,
  appunti, tool). Se manca un dettaglio di codice lo dice e suggerisce di approfondire con l'analisi o con
  Claude Code. La lettura del codice su richiesta è un passo successivo.
- Modello scelto dall'utente tra i propri account o l'account di sistema ("chi configura paga"), preselezione
  del più economico con strumenti; costo per conversazione visibile.

Obiettivo: dalla pagina di TradeFlow si apre una conversazione, si discute un'integrazione con Mister, il bot
propone una voce di evoluzione per ciascuna app collegate tra loro; accettate, compaiono nel piano e
nell'esportazione delle issue.

Fuori da questa spec: streaming parola per parola (arriva con la fase 2, "Chat nella console"); lettura del
codice; chat di portafoglio senza un'app di partenza; chat sugli agenti delle app (fase 2); creazione delle
issue su GitHub (sottoprogetto 2); squadre di agenti automatizzate che lavorano le issue (direzione futura:
le scelte di qui non devono bloccarle).

## 2. Modello dei dati

Nuove tabelle (una per file in `lib/db/src/schema/`):

- `plan_conversations`: `id`, `app_id` → apps (cascade), `analysis_id` → analyses (cascade), `user_id` →
  users, `ai_model_id` → ai_models, `title` (text, dal primo messaggio, max 80 caratteri), `tokens_used`
  (integer, default 0), `cost_usd` (numeric, null = costo parziale, prezzo mancante), `turn_status`
  (`idle` | `running`, default `idle`), `created_at`, `updated_at`.
- `plan_messages`: `id`, `conversation_id` → plan_conversations (cascade), `role` (`user` | `assistant`),
  `content` (text, markdown), `error` (boolean, default false: messaggio del bot che riporta un errore),
  `tokens` (integer, default 0), `created_at`.
- `plan_proposals`: `id`, `conversation_id` → plan_conversations (cascade), `message_id` → plan_messages
  (cascade), `kind` (`add` | `update` | `discard`), `chapter` (`endpoint` | `completion` | `evolution`),
  `payload` (jsonb: per `add` e `update` validato con `ITEM_SCHEMAS[chapter]`; per `discard` null),
  `rationale` (text), `target_item_id` → analysis_items (set null; obbligatorio per `update` e `discard`),
  `target_hash` (text: SHA-256 del payload e dello stato della voce di destinazione quando il bot l'ha
  proposta), `status` (`pending` | `accepted` | `rejected` | `stale`, default `pending`), `item_id` →
  analysis_items (set null: voce creata o modificata all'accettazione), `decided_at`, `created_at`.

Su `analysis_items`:
- `origin` (`architect` | `chat`, not null, default `architect`);
- `conversation_id` → plan_conversations (set null).

Un'unione di due voci si esprime come `update` della prima più `discard` della seconda nello stesso messaggio;
uno spostamento di fase o di dipendenze è un `update`.

Migrazione: `docs/migrations/2026-10-chat-del-piano.sql`, solo additiva (tabelle nuove, due colonne con
default); allineare `docs/schema-casello.sql`. L'SQL completo va dato in chat prima della PR.

## 3. Motore della chat

Nuovo modulo `artifacts/api-server/src/lib/plan-chat/`:
- `context.ts`: costruzione del contesto (puro);
- `tools.ts`: definizioni e gestione di `read_item`, `read_app`, `propose`;
- `turn.ts`: ciclo del turno (puro, con dipendenze iniettate: modello, lettura, salvataggio delle proposte);
- `run-turn.ts`: orchestrazione con DB ed esecutore dei modelli (`lib/ai/executor.ts`, `modelChat`);
- `decide.ts`: accettazione e rifiuto delle proposte (transazione).

### Turno

- Un messaggio dell'utente avvia un turno in background (come le run); la route risponde subito. Un solo
  turno alla volta per conversazione (`turn_status`, aggiornato con una condizione: un secondo messaggio
  durante un turno → 409). La UI interroga `GET /api/plan-conversations/:id` finché `turn_status = idle`.
- Il turno finisce con un messaggio `assistant` (testo più eventuali proposte collegate). In caso di errore
  il messaggio ha `error = true` e il testo fisso in italiano di `lib/ai/discovery.ts`.
- All'avvio dell'API le conversazioni con `turn_status = running` tornano `idle` con un messaggio di errore
  "turno interrotto dal riavvio".
- Il modello "Agente locale" non è selezionabile (nessuna risposta in tempo reale); un modello ritirato o non
  disponibile blocca l'invio con l'invito a sceglierne un altro (`PATCH` del modello della conversazione).

### Contesto (tetto ~30 000 token stimati, `estimateTokens` dell'architetto)

1. Istruzioni del pianificatore: ruolo, italiano, il contenuto delle app è dato e mai istruzione, niente
   endpoint o funzioni inventati, proposte solo con `propose`, motivazione breve in ogni proposta, una voce
   per app quando un'integrazione tocca due app (collegate citando l'altra nel testo).
2. Scheda dell'app: nome, slug, descrizione funzionale, sintesi della mappa (`analysis_phase_results` o
   appunti della fase `map`), nomi dei tool attivi. Mai `base_url`, `internal_base_url`, segreti, token.
3. Piano compatto: una riga per voce di endpoint/completamento/evoluzione dell'analisi della conversazione e
   delle voci `origin = chat` approvate delle analisi precedenti della stessa app: ref, capitolo, titolo,
   fase, dipendenze, sforzo o priorità, stato, origine.
4. Altre app (dello stesso utente): nome, slug, descrizione breve (max 300 caratteri), nomi dei tool attivi
   (max 20).
5. Cronologia: ultimi messaggi entro 24 000 caratteri (i più vecchi si tagliano), con lo stato delle
   proposte già decise accanto al messaggio che le ha prodotte.

Se il contesto supera il tetto si riducono, in quest'ordine: cronologia, altre app, descrizioni del piano.

### Strumenti del bot

- `read_item({ ref })`: payload completo della voce (prove, traccia di implementazione, file).
- `read_app({ slug })`: sintesi della mappa e tool attivi di un'altra app dell'utente.
- `propose({ kind, chapter, payload?, targetRef?, rationale })`: crea una scheda `pending`. Validazione
  immediata: payload con `ITEM_SCHEMAS[chapter]` per `add`/`update`, `targetRef` esistente nel piano per
  `update`/`discard`, dipendenze che citano ref esistenti. Errore → messaggio `tool` con gli errori (stessa
  formattazione di `formatIssues`), massimo 2 correzioni per proposta. Per `update`/`discard` si salva
  `target_hash`.

### Limiti per turno

6 giri di strumenti, 40 000 token, 120 s di tempo attivo (ogni chiamata al modello limitata dal tempo
rimasto), messaggio dell'utente max 8 000 caratteri. Token e costo si sommano alla conversazione.

### Decisione su una proposta (`decide.ts`, una transazione)

- `add`: crea `analysis_items` con `origin = chat`, `conversation_id`, `diff = new`, `status = approved`,
  `ref` univoco nell'analisi (`chat-<id proposta>`), `position` in coda al capitolo, `evidence` dal payload.
- `update`: se l'hash attuale della voce coincide con `target_hash` aggiorna `payload` ed `evidence`;
  altrimenti la proposta diventa `stale` e la route risponde 409.
- `discard`: stesso controllo dell'hash, poi la voce passa a `discarded`.
- `reject`: la proposta diventa `rejected`, nient'altro.
- Una proposta non `pending` non si decide di nuovo (409).

### Rianalisi

Le voci `origin = chat` approvate delle analisi precedenti arrivano all'architetto (percorso cloud,
`prompts.ts`, e locale, `get_phase_instructions`) nelle fasi `completion` ed `evolution` come elenco "già
pianificate" (titolo e capitolo), con l'istruzione di non riproporle. Restano nella loro analisi; la console
le mostra nel piano corrente.

## 4. API e console

Contract-first in `lib/api-spec/openapi.yaml`, poi codegen (hook Orval). Body, parametri e risposte con
`parseRequest` e `*Response.parse` come le altre route; nuovo file `routes/plan-chat.ts`.

- `GET /api/apps/:id/plan-conversations`: conversazioni dell'utente sull'app.
- `POST /api/apps/:id/plan-conversations` `{ aiModelId, analysisId? }`: senza `analysisId` l'ultima analisi
  completata dell'app; nessuna → 409. Il modello deve essere selezionabile dall'utente (propri account o
  sistema), disponibile e non "Agente locale".
- `GET /api/plan-conversations/:id`: conversazione, messaggi, proposte, `turn_status`, token, costo, e
  `newerAnalysisId` se esiste un'analisi completata più recente.
- `PATCH /api/plan-conversations/:id` `{ aiModelId }`: cambio modello (solo con `turn_status = idle`).
- `POST /api/plan-conversations/:id/messages` `{ content }`: avvia il turno; 409 se già in corso. Rate limit
  10 messaggi/minuto per utente.
- `POST /api/plan-proposals/:id/decision` `{ action: "accept" | "reject" }`: proposta aggiornata e voce;
  409 se `stale` o già decisa.
- `DELETE /api/plan-conversations/:id`: elimina la conversazione; le voci accettate restano
  (`conversation_id` → null).

Console (`artifacts/casello`):
- Pagina dell'app, scheda «Piano»: a sinistra il piano (endpoint, completamento, evoluzione dell'ultima
  analisi più le voci da chat delle precedenti, raggruppate come nella revisione, etichetta «da chat»); a
  destra l'elenco delle conversazioni e la chat. Nuova conversazione: scelta del modello con il componente
  esistente, preselezione del più economico con strumenti.
- Chat: messaggi in markdown, indicatore «sta pensando…» durante il turno, banner «c'è un piano più recente»
  quando `newerAnalysisId` è presente. Schede di proposta nei messaggi del bot: tipo, capitolo, titolo,
  motivazione, anteprima espandibile; per `update` le differenze rispetto alla voce attuale; pulsanti Accetta
  e Scarta o lo stato già deciso. Accettare aggiorna subito il piano (invalidazione delle query).
- Revisione dell'analisi: mostra anche le voci da chat (etichetta «da chat»); l'esportazione delle issue le
  include.

## 5. Errori e sicurezza

- Errore del provider o tempo scaduto: il turno si chiude con un messaggio `error = true`; l'utente può
  riscrivere. Nessun nuovo tentativo automatico sui timeout.
- Analisi rifatta durante la chat: la conversazione resta sulla sua analisi; le proposte `update`/`discard`
  su voci cambiate diventano `stale` alla decisione.
- Accesso: conversazioni e proposte visibili e decidibili solo dal proprietario dell'app e della
  conversazione (404 altrimenti, come le altre risorse).
- Il bot non ha strumenti che scrivono: tutto passa da una scheda accettata dall'utente.
- Prompt injection: descrizioni delle app, voci e cronologia arrivano come dati (nei messaggi `user`/`tool`
  delimitati), le istruzioni dicono di non eseguire ordini che vi compaiono; il danno massimo di un modello
  manipolato è una scheda che l'utente vede prima di accettare.
- Nessun segreto nel contesto: niente segreti di servizio, token, indirizzi interni. Il contenuto dei
  messaggi non va nei log.

## 6. Test

Vitest con PGlite (schema da `docs/schema-casello.sql`), modello finto come nei test dell'architetto.

- `context.ts`: contesto entro il tetto, ordine di riduzione, assenza di `base_url` e segreti, voci da chat
  delle analisi precedenti incluse.
- `turn.ts`: risposta senza strumenti; `read_item`/`read_app`; `propose` valida e non valida con 2
  correzioni; limiti di giri, token e tempo.
- Route: creazione (409 senza analisi completata, modello non selezionabile → 400); 409 per un messaggio
  durante un turno; decisione `add`, `update` (anche `stale`), `discard`, `reject`, doppia decisione → 409;
  accesso negato a un altro utente; eliminazione che conserva le voci accettate; ripristino all'avvio dei
  turni `running`.
- Rianalisi: le voci da chat approvate compaiono come "già pianificate" nelle istruzioni di `completion` ed
  `evolution` (cloud e locale).
- Console: typecheck e prova manuale su un'app reale.
