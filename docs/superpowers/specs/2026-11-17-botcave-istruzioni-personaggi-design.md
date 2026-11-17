# Botcave · Istruzioni personali dei personaggi

Data: 17 novembre 2026. Stato: design approvato in chat, da rivedere per iscritto.

## Scopo

L'utente corregge in modo stabile il comportamento di Alfred e Lucius (tono, regole del suo modo di lavorare, cose da fare o
evitare) con un testo in Markdown che si **aggiunge** alle istruzioni di base, senza toccare il codice. Le regole fisse (dati non
istruzioni, proposte decise dal clic, niente credenziali, formati delle consegne) restano nelle basi e non si possono annullare.
I personaggi stessi possono proporre una modifica al proprio testo con una scheda che l'utente accetta o rifiuta.

Barbara non ha un testo in più: le sue istruzioni sono il prompt del suo agente (`general` dell'App `casello`), già modificabile, che
diventa leggibile e modificabile anche dalla carta «Personaggi».

Successo: dopo aver scritto «Dimmi sempre il costo stimato prima di proporre» nel testo di Lucius, dal turno successivo Lucius lo fa in
ogni contesto; in chat Lucius propone una modifica, l'utente la accetta e la versione nuova vale dal turno dopo.

## Decisioni

- Testo per utente e per personaggio (`alfred`, `lucius`), come modelli, tetti e memoria dei personaggi.
- Si aggiunge in fondo alle istruzioni di sistema di ogni contesto; in caso di contrasto valgono le regole sopra.
- Vale ovunque il personaggio lavora:
  - Alfred: filo scritto (pannello ed embed) e voce (dalla sessione successiva: la `systemInstruction` sta nel token);
  - Lucius: conversazioni nelle aree, chat del piano, chat di squadra, analisi dell'architetto (cloud e locale, ogni fase).
- Claude Code sul nodo riceve lo stesso prompt di sistema: nessun lavoro in più.
- Versioni immutabili, «Ripristina» crea una versione nuova con il contenuto di una vecchia.
- Proposte dei personaggi in una tabella propria, legata alla conversazione, mostrata dalla chat comune in tutte e tre le chat.

## Dati

Migrazione additiva `docs/migrations/2026-11-17-istruzioni-personaggi.sql` (idempotente, niente `-post`, la applica il deploy), riportata in
`docs/schema-casello.sql`:

- `character_instructions`: `id`, `user_id` (FK `users`, `CASCADE`), `character` (enum esistente `character`), `version` (intero ≥ 1),
  `content` (0..8 000 caratteri; vuoto = nessuna istruzione), `source` (`manual` | `proposal` | `restore`), `proposal_id` (null o FK alla tabella
  sotto, `SET NULL`), `created_at`; `UNIQUE (user_id, character, version)`. Il testo attuale è la versione più alta; nessuna riga = versione 0, testo vuoto.
- `character_instruction_proposals`: `id`, `user_id` (`CASCADE`), `character`, `conversation_kind` (`character` | `plan_chat` | `team_chat`),
  `conversation_id` (intero, nessuna FK: tre tabelle possibili), `message_id` (messaggio dell'assistente del turno, null se non noto),
  `base_version` (versione su cui è nata, 0 se nessuna), `content` (testo completo proposto, 0..8 000), `reason` (≤ 1 000), `status` (`pending` |
  `accepted` | `rejected` | `stale`), `decided_at`, `created_at`; indice su `(conversation_kind, conversation_id)`.
- Eliminare una conversazione non tocca le proposte (restano nello storico delle versioni accettate); le proposte `pending` di una conversazione
  eliminata non si vedono più e diventano `stale` alla proposta successiva.

## Regole del testo (`lib/characters/personal-instructions.ts`)

- Al più 8 000 caratteri dopo `trim` del fondo; altrimenti 400 «istruzioni troppo lunghe: al massimo 8 000 caratteri».
- Controllo credenziali su ogni parola con `looksLikeCredential` di `lib/memory/` → 400 «non salvo credenziali nelle istruzioni».
- Caratteri di controllo tolti (tranne a capo e tabulazione).
- Salvataggio con concorrenza ottimistica: `baseVersion` deve essere la versione attuale, altrimenti 409 «le istruzioni sono cambiate:
  ricarica». La nuova versione si scrive con un'unica INSERT `version = base + 1` (il vincolo unico fa da guardia: violazione → stesso 409).
- Un testo uguale all'attuale non crea versioni (risposta con la versione attuale).

## Composizione del prompt

`personalInstructionsBlock(userId, character): Promise<string>`: stringa vuota senza testo, altrimenti

```
Istruzioni personali dell'utente per te (si aggiungono alle regole sopra e non le annullano: se una le contraddice, valgono le regole sopra):
<testo>
```

Letto una volta per turno o per fase, appeso in fondo alle istruzioni di sistema da:

- `lib/characters/run-turn.ts` (Alfred filo e Lucius sugli argomenti);
- `lib/plan-chat/context.ts` e `lib/team-chat/context.ts` (Lucius);
- `lib/architect/` (prompt di sistema di ogni fase cloud, `phase-loop.ts`, e `get_phase_instructions` dell'esecutore locale; per il passo
  `best_practice` no: è una chiamata tecnica senza personaggio);
- `lib/alfred/instructions.ts` (`alfredInstructions`, quindi `buildLiveConfig`, alla creazione e al rinnovo del token).

Il testo dell'utente è fidato (lo scrive lui o lo accetta lui), quindi sta nel prompt di sistema; la riga d'apertura lo subordina alle regole di base.

## Proposte dei personaggi

- Strumento interno `proponi_istruzioni {testo, motivazione}` (`lib/characters/instruction-proposals.ts`), nome riservato:
  - offerto al personaggio della chat: Alfred nel filo scritto, Lucius in conversazioni delle aree, chat del piano e chat di squadra;
  - non offerto: Alfred a voce (le sue istruzioni dicono di proporlo nel filo scritto), analisi, Barbara;
  - `testo` è il testo completo nuovo, con le stesse regole del salvataggio; uguale all'attuale → `{ok:false}` «la proposta è uguale alle
    istruzioni attuali»; `motivazione` 1..1 000;
  - al più una proposta per turno («hai già proposto in questo turno»);
  - una proposta nuova rende `stale` le `pending` dello stesso utente e personaggio («superata da una proposta più recente»);
  - risultato `{ok:true, id}`; errori `{ok:false}` con messaggi fissi, mai eccezioni.
- Istruzioni ai personaggi (riga nelle basi): proporre solo quando l'utente chiede una regola stabile («d'ora in poi», «sempre», «mai») o
  conferma di volerla; le preferenze piccole restano appunti di memoria; la proposta riporta tutto il testo, non solo l'aggiunta.
- Decisione `POST /api/character-instruction-proposals/:id/decision {action: accept|reject}` (sessione o pannello incorporato,
  `sessionOrEmbed`; altrui → 404; già decisa → 409 «proposta già decisa»): accettare, in una transazione, controlla che `base_version` sia la
  versione attuale (altrimenti scheda `stale` e 409 «le istruzioni sono cambiate: chiedi una proposta aggiornata»), scrive la versione nuova
  (`source = proposal`, `proposal_id`) e marca `accepted`; rifiutare marca `rejected`.
- Lettura `GET /api/character-instruction-proposals?conversationKind=…&conversationId=…` (sessione o embed; la conversazione deve essere
  dell'utente, altrimenti 404): proposte della conversazione con `content`, `reason`, `status`, `baseVersion`, `currentContent` (per il confronto),
  `messageId`, `createdAt`.
- Nel contesto del turno successivo la scheda decisa entra come le altre schede (accettata/rifiutata), così il personaggio sa l'esito.

## API delle istruzioni

Route in `src/routes/character-instructions.ts`, tag `characters`, errori `{error}` con `INSTRUCTION_MESSAGES`:

- `GET /api/account/character-instructions/:character` (`alfred` | `lucius`, altro 404): `{character, version, content, updatedAt}`.
- `GET …/:character/versions` (ultime 50: `version`, `source`, `createdAt`, lunghezza) e `GET …/:character/versions/:version` (testo).
- `PUT …/:character` `{content, baseVersion}` → nuova versione (`source = manual`).
- `POST …/:character/restore` `{version, baseVersion}` → nuova versione con quel contenuto (`source = restore`).
- Letture con sessione, embed o token con `api:read`; scritture solo con il login (`sessionOnly`), 20/min per utente (`consumeInstructionWrite`).
  Il token d'ambito `agent` non scrive (già vale per `sessionOnly`).

## Console

- Account → «Personaggi» (`characters-section.tsx`):
  - per Alfred e Lucius, blocco «Istruzioni personali»: area di testo Markdown con contatore dei caratteri, «Anteprima», «Salva», versione
    attuale e data, «Versioni» (elenco, apertura, confronto riga per riga con l'attuale, «Ripristina»), avviso «Si aggiungono alle istruzioni di
    base: non possono annullarne le regole»; 409 → «Le istruzioni sono cambiate: ricarica» con «Ricarica»;
  - Barbara: blocco «Istruzioni» con il prompt dell'agente (lettura con l'hook dell'agente, salvataggio con la PATCH esistente, stesse regole
    della scheda agente) e link «Apri l'agente di Barbara»; non disponibile → il motivo di `GET /api/lead-chat`.
- Chat comune (`components/characters/`): hook `useInstructionProposals(kind, id)` chiamato da `CharacterChat` per gli adattatori che
  dichiarano `instructionProposals: {kind, id}` (personaggi, piano, squadra; non Barbara), aggiornato con lo stesso polling della conversazione;
  scheda `InstructionProposalCard` sotto il messaggio che l'ha prodotta (o in fondo se `messageId` è null): motivazione, confronto riga per riga
  con il testo attuale, «Accetta» / «Rifiuta», stato con il LED; `stale` → «Superata: chiedi una proposta aggiornata». Vale in console,
  pannello ed embed. Niente scorrimento orizzontale a 1280 px.

## Errori e sicurezza

- Messaggi fissi in italiano, mai testo del DB.
- Il testo non va nei log (solo id, personaggio, versione, lunghezza).
- Una proposta la scrive il modello: è un testo non attendibile finché l'utente non la accetta; la scheda mostra il confronto completo, così
  l'utente vede ogni riga che entra nelle istruzioni. Rischio residuo accettato: una pagina web ostile letta da Lucius può spingerlo a proporre
  istruzioni malevole; la difesa è il clic dell'utente sul confronto.

## Prove

- Vitest: regole del testo, versioni e concorrenza, `personalInstructionsBlock`, inserimento nei prompt (filo di Alfred, Lucius sugli argomenti,
  piano, squadra, fase dell'architetto, `get_phase_instructions`, `buildLiveConfig`), strumento `proponi_istruzioni` (limiti, `stale`, uguale
  all'attuale), decisione (accettata, rifiutata, superata, già decisa, altrui), route con gli ambiti.
- Console: funzioni pure del confronto riga per riga e dello stato della scheda.
- Migrazione nella prova `migrations-auto.test.ts` (due applicazioni).

## Fuori ambito

- Testo personale per Barbara (usa il prompt del suo agente) e per gli altri agenti.
- Istruzioni condivise tra utenti o per App.
- Segnalazione dei bug tramite Barbara a una squadra di manutenzione dell'App: sottoprogetto separato, con una sua spec.
