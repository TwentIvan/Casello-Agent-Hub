# Botcave · Proposte multiple e discussione con l'agente (5c, tappa 4)

Data: 8 novembre 2026. Repository: Botcave (4a, 4b) e configurazione di The Hub Up in Botcave più due endpoint in AbapCrm (4c).

## 1. Obiettivo

Da una mail nuova Botcave deve saper proporre, oltre al collegamento a ciò che esiste, la **creazione e la modifica di più oggetti
collegati tra loro** (partner → progetto → task, modifiche a task esistenti), come faceva l'agente di progetto interno di The Hub Up
(agente 2 dell'inventario in `2026-11-07-botcave-the-hub-up-5b-design.md` §3). Tutto passa da «Da confermare» di Botcave, generico per
ogni app: nessuna pagina di proposte nell'app ospite. L'utente approva tutto o in parte, rifiuta, oppure discute con l'agente che ha
proposto, che prepara una versione nuova. Alfred legge, discute e decide a voce.

Decisioni di Ivan (8 novembre 2026):
- le proposte vivono in Botcave («Da confermare»), non nell'app ospite;
- le fa il **Responsabile di prodotto** (agente `general`, conosce tutti i tool dell'app);
- la mail arriva prima allo **Smistatore** (innesco), che collega e, se serve creare o modificare, **segnala al Responsabile**;
- una proposta è **multipla**: passi ordinati, un passo può usare l'id creato da un passo precedente;
- si può **approvare in parte**, **rifiutare** e **discutere** con l'agente che ha proposto.

Criteri di fine:
- una mail che richiede un progetto e due task nuovi produce in «Da confermare» **una** voce «Proposta» con i passi; approvandola nascono
  in The Hub Up progetto e task, con i task legati al progetto appena creato;
- escludendo un passo, il passo e quelli che ne dipendono non vengono eseguiti; gli altri sì;
- un messaggio nella discussione produce, se l'agente lo ritiene, una versione nuova della stessa voce;
- da Alfred si sente la proposta passo per passo e la si approva (anche in parte) con il doppio passo.

## 2. Divisione

| Parte | Cosa | Dove |
|---|---|---|
| **4a** | Voce «Proposta» (passi, riferimenti, controlli, approvazione intera o parziale, rifiuto, esecuzione), strumento interno `proponi`, console, pannello incorporato, Alfred | Botcave |
| **4b** | Discussione con l'agente che ha proposto e versioni della proposta | Botcave |
| **4c** | The Hub Up: tool mancanti, istruzioni di Smistatore e Responsabile, prova reale | AbapCrm (2 endpoint) e configurazione in Botcave |

Ogni parte ha il suo piano e la sua PR; 4b dipende da 4a, 4c da 4a (4b non serve per partire).

## 3. Flusso

1. L'innesco «Nuove email» (id 1) avvia lo Smistatore (agente 12) con il riepilogo della mail.
2. Lo Smistatore legge la mail, collega ciò che riconosce (`classify_message`, `link_message`, L1 in coda come oggi) e, se dalla mail
   nascono oggetti nuovi o modifiche, chiama `segnala_al_responsabile` (già esistente: run figlia del Responsabile con `parent_run_id`)
   con l'id della mail e cosa ha capito.
3. Il Responsabile (agente 4) legge mail e stato dell'app con i tool L0 e chiama **`proponi`** con i passi.
4. In «Da confermare» compare una voce di tipo **`proposal`**; l'utente approva (tutto o in parte), rifiuta o discute.

Le singole azioni L2 chiamate direttamente da un agente restano voci `action` come oggi: `proponi` serve quando ci sono più passi o
dipendenze. Le istruzioni del Responsabile (4c) gli chiedono di usare `proponi` per ogni creazione o modifica che nasce da una mail.

## 4. Parte 4a: la voce «Proposta»

### 4.1 Dati

- `pending_action_kind` riceve il valore `proposal` (migrazione additiva, `ALTER TYPE … ADD VALUE IF NOT EXISTS`, fuori da una
  transazione esplicita). Per `proposal`: `app_id` obbligatorio (l'app dell'agente), `tool_id` null, `run_id` e `agent_id` della run che
  ha proposto. Il CHECK esistente (obbligatori solo con `kind = action`) resta valido.
- `args_enc` contiene la proposta cifrata `{title, steps}`; `args_public` la stessa con i valori `x-sensitive` oscurati; `summary` = titolo
  (≤ 300); `recipient` = nome dell'app.
- Tabella nuova `pending_action_steps` (una riga per passo, per l'esito): `id`, `pending_action_id` (FK, `ON DELETE CASCADE`), `key`
  (`p1`…), `position`, `tool_id` (FK `app_tools`, `RESTRICT` come `pending_actions.tool_id`), `summary` (≤ 300), `status`
  `pending|excluded|skipped|done|failed|not_run`, `result` (testo oscurato, ≤ 20 000), `error_message`, `finished_at`. Gli argomenti
  restano solo in `args_enc` (cifrati).
- La numerazione per utente, il limite di 50 voci `pending` e l'ordine dei lock restano quelli di `pending_actions`.

### 4.2 Strumento interno `proponi`

Offerto agli agenti di un'app (run senza squadra), come `segnala_al_responsabile`: interno, vince su un tool omonimo, non passa dalla coda.

```
proponi {
  titolo: string (1..200),
  motivo?: string (≤ 1 000),
  passi: [{ id: "p1".."p20", strumento: string (nome di un tool dell'app), argomenti: object, sintesi: string (1..300) }] (1..20)
}
```

Controlli (risultato `ok: false` con messaggio fisso, mai eccezioni; la run prosegue):
- id dei passi `p1`, `p2`… unici, nell'ordine;
- ogni `strumento` è un tool dell'app dell'agente, `active`, `http` o `mcp`, livello effettivo ≠ L3, **identità `service`** (i tool `user`
  richiederebbero il token dell'utente all'approvazione: esclusi in 4a); per un agente di area, solo i suoi tool collegati;
- **riferimenti**: una stringa che è esattamente `{{pN.campo}}` o `{{pN.campo.sottocampo}}` (1..5 segmenti `^[A-Za-z0-9_-]{1,64}$`) vale il
  campo del risultato JSON del passo `pN`, che deve precedere il passo corrente; riferimenti dentro stringhe più lunghe non sono ammessi
  (niente interpolazione); un riferimento a un passo successivo o inesistente → «riferimento non valido nel passo pK»;
- gli argomenti senza riferimenti si validano con lo schema del tool già alla proposta; quelli con riferimenti dopo la sostituzione;
- controllo del testo della coda (`checkQueuedText`) su titolo, sintesi e argomenti, come per le azioni L2;
- al più una proposta `pending` nata da una stessa run (una seconda chiamata → «hai già proposto in questa run: usa la discussione»).

Esito: `{ok: true, numero}`; la proposta entra in coda per il proprietario dell'account AI del modello della run (stessa regola delle L2).

### 4.3 Decisione

- `POST /api/pending-actions/:number/approve` accetta per `proposal` `{ escludi?: string[] }` (id di passi; ripetuti o sconosciuti → 400
  «passi da escludere non validi»). I passi esclusi diventano `excluded`; quelli che usano (direttamente o a catena) un passo escluso
  `skipped`. Se non resta nessun passo da eseguire → 400 «nessun passo da eseguire: rifiuta la proposta».
- Esecuzione esattamente una volta (UPDATE condizionato `pending` → `executing`, come oggi), poi i passi **in ordine**: sostituzione dei
  riferimenti dal risultato JSON dei passi precedenti (valore mancante o risultato non JSON → passo `failed` «riferimento non risolto»),
  validazione degli argomenti, `executeTool` con la connessione dell'app. Il tool si ricontrolla a ogni passo (non più usabile → `failed`
  «strumento non più utilizzabile»). **Al primo errore ci si ferma**: i passi rimasti diventano `not_run`. Nessun annullamento
  automatico.
- Esito della voce: `done` se tutti i passi da eseguire sono `done`, altrimenti `failed` con `error_message` «eseguiti n passi su m: si è
  fermata al passo pK» e il risultato per passo. All'avvio una voce `proposal` rimasta `executing` diventa `failed` «esito incerto: verifica
  sul servizio» e i passi non chiusi `not_run` (estende `failInterruptedActions`).
- `POST …/reject` resta uguale (nota ≤ 500).
- Limiti invariati: 20 decisioni al minuto per utente; ambito `api:write` per i token.

### 4.4 Console e pannello incorporato

- «Da confermare»: tipo «Proposta» nella colonna tipo; la voce si apre in un dettaglio con titolo, motivo, passi (numero, sintesi, tool,
  argomenti pubblici, riferimenti mostrati come «id creato al passo p2»), caselle per escludere i passi (che segnano anche i passi che ne
  dipendono), «Approva» / «Approva i passi scelti», «Rifiuta» con nota. Dopo l'esecuzione: stato ed esito per passo con LED.
- Pannello incorporato (`/embed`, scheda «Da confermare»): stessa voce, stesso dettaglio compatto; niente «Apri in Botcave» per le proposte
  (si approvano anche dal pannello, sono tool di servizio).
- `GET /api/pending-actions/:number` restituisce anche `proposal {title, reason, steps:[{key, position, toolName, summary, argsPublic,
  refs, status, result?, errorMessage?}]}`.

### 4.5 Alfred

- `coda_da_confermare`: per le proposte riporta titolo e numero di passi.
- Nuovo strumento `leggi_proposta {numero}`: titolo, motivo e per ogni passo numero e sintesi (testo da leggere).
- `prepara_decisione` accetta `escludi` (es. «approva la 5 senza il passo 3») e la sintesi da ripetere elenca i passi esclusi;
  `conferma_decisione` invariato (doppio passo, codice di 6 cifre).
- Chat di Alfred (pannello): `proponi_decisione` accetta `escludi`; la scheda mostra i passi esclusi.

## 5. Parte 4b: discussione con l'agente che ha proposto

- Tabella `proposal_messages`: `pending_action_id` (FK `CASCADE`), `role` `user|agent`, `content` (≤ 8 000), `run_id` (run dell'agente
  che ha risposto, `SET NULL`), `created_at`; colonne su `pending_actions`: `proposal_version` (int, da 1) e `revision_run_id` (run in corso
  o null).
- `POST /api/pending-actions/:number/messages` `{text}` (solo `proposal` `pending`; vuoto → 400 «messaggio vuoto»; revisione già in corso →
  409 «l'agente sta già rispondendo»; 10 al minuto per utente): salva il messaggio e accoda (con `createQueuedRun`) una run dello **stesso
  agente** che ha proposto, con input: proposta attuale (versione, passi, sintesi; argomenti pubblici) e conversazione come dati tra
  delimitatori, più l'istruzione «rispondi; se serve una versione nuova usa proponi». `revision_run_id` = quella run.
- In quella run `proponi` **sostituisce** la proposta della stessa voce invece di crearne una nuova: nuovi passi, `proposal_version + 1`,
  stesso numero; i passi precedenti si cancellano (la voce è ancora `pending`, nessun esito da conservare); la versione precedente resta nei
  messaggi come riepilogo dell'agente. La risposta testuale dell'agente (output della run) diventa un messaggio `agent`.
- Mentre `revision_run_id` è valorizzato (run `pending` o `running`) approvare → 409 «l'agente sta aggiornando la proposta: aspetta la
  nuova versione»; a fine run (qualsiasi esito) si azzera. Rifiutare resta possibile e ferma la discussione (la run in corso finisce senza
  poter sostituire: la voce non è più `pending`).
- Al più 10 revisioni per voce (oltre → 409 «troppe revisioni: rifiuta e chiedi una proposta nuova»).
- Console e pannello: nel dettaglio della proposta, «Discuti» apre la conversazione sotto i passi (polling come le run); la versione corrente
  è indicata («versione 3»).
- Alfred: strumento `scrivi_al_proponente {numero, testo}` (stesso limite); la chat di Alfred può farlo per l'utente.

## 6. Parte 4c: The Hub Up

- **Tool mancanti** (endpoint e tool L2 di servizio): `update_partner` (`PUT /api/partners/:id`) e `create_contact` (`POST /api/contacts`), da
  verificare nel codice di AbapCrm e aggiungere al catalogo di Botcave (Aggiorna o a mano); gli esistenti usati: `create_partner`,
  `create_project`, `update_project`, `create_task`, `update_task`, `add_comment`, `create_calendar_event`.
- **Lista dei task con il work item**: `GET /api/tasks` restituisce anche `externalWorkItemId` e `externalSystem`; `list_tasks` in Botcave li
  aggiunge ai `responseFields`. Così Smistatore e Responsabile riconoscono il task di un work item DevOps.
- **Istruzioni** (prompt in Botcave): Smistatore — collega ciò che esiste; se servono oggetti nuovi o modifiche, `segnala_al_responsabile`
  con id della mail e cosa propone di fare, senza crearli. Responsabile — per una segnalazione da mail: leggi mail e oggetti, una sola
  `proponi` con tutti i passi nell'ordine (partner, progetto, task, modifiche), riferimenti per gli id nuovi, sintesi in italiano chiare
  da leggere a voce.
- **Prova reale**: la notifica della User Story 1174 (o una nuova) → proposta con i passi → approvazione parziale → discussione → nuova
  versione → approvazione; dal pannello incorporato in The Hub Up e a voce con Alfred.
- L'agente di progetto interno di The Hub Up (pulsante «Analizza con AI», `analyze-project`) si spegne nella tappa 6 (smontaggio), non qui.

## 7. Fuori ambito

- Tool con identità `user` nei passi di una proposta.
- Annullamento automatico dei passi già eseguiti quando uno fallisce.
- Proposte delle squadre (il capo continua con il PLAN).
- Allegati della mail (Excel/CSV) letti dal Responsabile: dipendono da un tool di lettura allegati in The Hub Up, da valutare dopo 4c.

## 8. Rischi

- **Esecuzione a metà**: senza annullamento, un errore al passo 3 lascia creati i passi 1–2. L'esito per passo lo dice chiaramente e la
  discussione può proporre il completamento.
- **Token**: il Responsabile ha tutti i tool dell'app nel contesto. Le letture devono restare ridotte (`responseFields` sugli elenchi, già
  impostati l'8 novembre 2026) e il limite di 60 000 token per run vale anche qui.
- **Argomenti con riferimenti non validabili alla proposta**: si validano all'esecuzione; un errore ferma la proposta al passo, senza
  effetti sui successivi.
- **Prompt injection dalla mail**: i passi li vede e approva l'utente; argomenti e sintesi passano dal controllo del testo della coda.
