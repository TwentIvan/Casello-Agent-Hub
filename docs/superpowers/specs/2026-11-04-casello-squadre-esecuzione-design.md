# Casello: squadre di agenti — esecuzione (design)

Data: 2026-11-04. Sottoprogetto 3b della specifica «squadre di agenti in Casello» (bozza v0.2). Parte dalla definizione
(3a: skill, modelli, istanze; `docs/superpowers/specs/2026-11-03-casello-squadre-definizione-design.md`) e dalla coda
delle conferme (`docs/superpowers/specs/2026-11-03-casello-strumenti-mcp-design.md`).

## 1. Scopo e decisioni prese

Una squadra attiva lavora su un lavoro di riferimento (es. The Hub Up · WI 1174). Il capo tiene il PLAN, assegna i
compiti ai ruoli, riceve gli esiti e decide il passo successivo; gli eventi alimentano un bollettino; l'utente decide da
console, a voce o dal portale.

Decisioni:

- **Capo a turni guidati dagli eventi.** Non resta acceso: riceve un turno quando arriva una richiesta, finisce o si
  blocca un compito, si decide una voce in coda. Tra un turno e l'altro non costa nulla.
- **PLAN in Casello, strutturato** (obiettivo, vincoli, compiti, azioni manuali, punti aperti), versionato; il capo lo
  aggiorna con strumenti dedicati, l'utente lo vede e lo corregge in console, il portale lo leggerà via API.
- **Centralino = il Claude dell'utente** con gli strumenti di Casello su `/mcp`. In più ogni utente configura in
  Casello un **modello del centralino**, usato quando Casello scrive da sé testi per l'utente e, più avanti, per la chat
  del portale.
- **Autonomia dentro un PLAN approvato.** Il capo propone il PLAN; approvato, lancia da solo i compiti previsti. Un
  compito fuori PLAN o un cambio di obiettivo/vincoli è una modifica da approvare. Le azioni L2 passano sempre dalla coda.
- **Una sola coda «Da confermare»** con voci di tipo `action` (L2, come oggi), `plan` e `plan_change`, numerate per
  utente: «approva la N» vale per tutte. Approva / Rifiuta con nota; la nota è il modo di chiedere modifiche.
- **Costi:** valgono i tetti esistenti (modello, account, utente); un tetto facoltativo della squadra, se impostato, si
  controlla per primo e la ferma. I limiti tecnici per turno e per compito restano sempre.

Fuori ambito: esecuzione dei ruoli `node` e scambio di file con la cartella della CR (sottoprogetto 4); organizzazioni e
policy dei dati (2); interfaccia in The Hub Up (5).

## 2. Dati

- `team_plans` (una riga per istanza, `instance_id` unico): `version` (≥ 1, +1 a ogni modifica), `status`
  (`draft` | `proposed` | `approved`), `objective` (max 2 000), `constraints` (jsonb, elenco di stringhe, max 30 da
  500), `open_points` (come `constraints`), `tasks` (jsonb, max 50, vedi sotto), `manual_actions` (jsonb, max 30:
  `{ id, text (max 500), done: boolean, doneAt }`), `approved_version` (ultima versione approvata, null),
  `updated_at`. Ogni versione è conservata in `team_plan_versions` (`instance_id`, `version`, `plan` jsonb, `created_at`).
- Compito del PLAN: `{ id ("t1", "t2", … stabile), title (max 200), roleKey, instructions (max 4 000), status
  (planned | running | waiting_node | done | blocked | failed), outcome (max 300, una frase) | null, updatedAt }`.
- `team_tasks` (esecuzioni): `id`, `instance_id`, `plan_task_id`, `role_key`, `instructions`, `status` (`queued` |
  `running` | `waiting_node` | `done` | `blocked` | `failed`), `outcome` (max 300), `detail` (max 20 000), `error`,
  `ai_model_id`, token, `cost_usd`, `created_at`, `started_at`, `finished_at`; passi in `team_task_steps` (stessa forma
  di `run_steps`).
- `team_turns`: `id`, `instance_id`, `reasons` (jsonb: elenco dei motivi accumulati: `request` con testo, `task_finished`
  con id, `decision` con numero della voce ed esito e nota, `activation`, `restart`), `status` (`queued` | `running` |
  `done` | `failed`), passi in `team_turn_steps`, token, `cost_usd`, timestamp. Al più un turno `queued` e uno `running`
  per istanza: un nuovo motivo si aggiunge al turno `queued` se esiste.
- `team_events`: `id`, `instance_id`, `type` (`piano_proposto` | `compito_finito` | `bloccato` |
  `decisione_richiesta` | `azione_manuale_richiesta` | `lavoro_finito` | `interrotto`), `task_id` | null,
  `bulletin` (max 300, due frasi al massimo), `detail` (max 4 000), `read_at`, `created_at`.
- `team_instances`: `activated_by` (FK `users`, `SET NULL`), `monthly_budget_usd` (numeric, null), `last_turn_at`.
- `pending_actions`: `kind` (`action` | `plan` | `plan_change`, default `action`), `team_instance_id` (FK, `SET NULL`),
  `plan_version` (per `plan`/`plan_change`). Per i tipi `plan` e `plan_change` `tool_id`/`app_id` sono null e
  `args_enc`/`args_public` contengono la proposta (versione del PLAN e sintesi); `tool_id` e `app_id` diventano
  nullable con un CHECK: obbligatori se `kind = action`.
- `users.centralino_ai_model_id` (FK `ai_models`, `SET NULL`).

## 3. Ciclo di vita

1. `POST /api/team-instances/:id/activate` (squadra `draft` → `active`, `activated_by` = utente): crea il PLAN
   `draft` se manca e un turno con motivo `activation`.
2. Il capo propone il PLAN (`proponi_piano`): stato `proposed`, voce `plan` in coda all'utente `activated_by`, evento
   `piano_proposto`.
3. Decisione: approvato → `approved_version` = versione, turno con motivo `decision`; rifiutato con nota → turno con
   la nota, il capo ripropone.
4. Turni successivi: il capo assegna compiti del PLAN approvato, legge gli esiti, segnala eventi, aggiorna il PLAN.
5. `chiudi_lavoro` → evento `lavoro_finito`; la squadra resta `active` finché l'utente non la chiude. Chiudere la
   squadra annulla i compiti `queued`, attende quelli `running` (nessun nuovo turno) e rifiuta le voci di coda
   `plan`/`plan_change` aperte.

## 4. Capo

- Turno: prompt del ruolo capo, il PLAN corrente, i motivi del turno (con gli esiti brevi dei compiti finiti), le
  istruzioni d'uso degli strumenti del capo; limiti 6 giri, 90 s di tempo attivo, 40 000 token. Il capo usa anche i suoi
  strumenti di app (livelli di sempre; L2 in coda con `team_instance_id`).
- Strumenti del capo:
  - `leggi_piano` → PLAN corrente;
  - `proponi_piano` (`objective`, `constraints`, `openPoints`, `tasks`) → nuova versione `proposed` + voce `plan`; se
    esiste già una versione approvata, è una modifica: voce `plan_change` con le differenze;
  - `aggiorna_piano` (`openPoints`, `manualActions`, `outcome`/`status` dei compiti): modifiche non rilevanti, nessuna
    approvazione; nuova versione, stato invariato;
  - `assegna_compito` (`taskId`) → solo per un compito del PLAN approvato in stato `planned`/`blocked`/`failed`:
    crea un `team_tasks`; ruolo `node` → `waiting_node`; altrimenti errore al modello «il compito non è nel piano
    approvato: proponi una modifica»;
  - `leggi_esito` (`taskId`) → dettaglio dell'ultima esecuzione;
  - `segnala` (`type`: `bloccato` | `decisione_richiesta` | `azione_manuale_richiesta`, `bulletin`, `detail`) → evento;
    `azione_manuale_richiesta` aggiunge anche la voce in `manual_actions`;
  - `chiudi_lavoro` (`bulletin`) → evento `lavoro_finito`.
- Modifiche rilevanti (richiedono approvazione): obiettivo, vincoli, aggiunta o rimozione di compiti, cambio di ruolo o
  istruzioni di un compito. Non rilevanti: punti aperti, azioni manuali, esiti e stati dei compiti.

## 5. Operai

- Compito di un ruolo `cloud`: prompt del ruolo, contenuto delle sue skill di Casello nella versione fissata
  dell'istanza (e delle skill specializzate), il PLAN in sola lettura (obiettivo, vincoli, compiti con stato), le
  istruzioni del compito. Strumenti: quelli del ruolo (`app_tools` di più app, con la connessione di ciascuna app;
  livelli di sempre), più `riferisci` (`outcome` max 300, `detail` max 20 000, `status` `done` | `blocked`). Nessuno
  strumento del capo, nessun lancio di altri compiti.
- Fine: `riferisci` chiude il compito; senza, l'esito è l'ultimo messaggio (troncato a 300) e lo stato `done`; errore o
  limite → `failed` con il motivo. In ogni caso: stato ed esito nel compito del PLAN, evento (`compito_finito` o
  `bloccato`), turno del capo con motivo `task_finished`.
- Limiti come una run: 8 giri, 120 s, 60 000 token. Massimo 3 compiti `running` per squadra; gli altri `queued`.
- Ruolo `node`: il compito resta `waiting_node` (lo prenderà il nodo locale, sottoprogetto 4).

## 6. Motore

- `lib/teams/runner.ts`: orchestrazione di turni e compiti con il ciclo dell'agente esistente (`agent-loop.ts`, dipendenze
  iniettate: chat col modello del ruolo via `modelChat`, strumenti di più app, `queueAction` della coda con
  `team_instance_id`). Non usa `run-executor` né la tabella `agents`.
- Esecuzione in background nel processo dell'API, come run e analisi. Un turno alla volta per istanza (UPDATE
  condizionato `queued` → `running`); finito un turno, se c'è un turno `queued` parte subito.
- Avvio dell'API: turni e compiti `running` → `failed` con evento `interrotto` («interrotto dal riavvio»), e un turno con
  motivo `restart` per le istanze `active` coinvolte.
- Costi: ogni turno e compito registra token e costo col prezzo del modello. Prima di ogni turno o compito: tetto della
  squadra (se impostato: spesa del mese di turni e compiti dell'istanza ≥ tetto → nessun avvio, evento `bloccato`
  «tetto di spesa della squadra raggiunto»), poi tetti del modello, dell'account e dell'utente (`activated_by`) come le run.
- Sicurezza: richieste dell'utente e note di rifiuto arrivano al modello come messaggi utente, mai nel prompt di sistema;
  nel PLAN e negli eventi non entrano segreti né indirizzi delle app; argomenti `x-sensitive` oscurati nei passi.

## 7. Centralino e API

- Strumenti su `/mcp` (ambito `mcp`; solo dati dell'utente): `squadre_stato` (istanze `active` con una riga di stato),
  `bollettino` (eventi non letti delle squadre attivate dall'utente; li segna letti), `squadra_dettaglio` (`id`: PLAN,
  compiti, ultimi eventi), `invia_al_capo` (`id`, `testo` max 4 000: turno con motivo `request`), `coda_da_confermare`
  (voci `pending` con tipo e sintesi), `approva` (`numero`, `userToken?`), `rifiuta` (`numero`, `nota?`).
- `users.centralino_ai_model_id`: `GET|PUT /api/account/centralino-model` (solo login; modello dei propri account; null
  = modello predefinito). In questa fase serve a `squadre_stato` quando le squadre attive sono più di 5: riassunto in
  massimo 5 righe; senza modello disponibile, elenco senza riassunto.
- API: `POST /api/team-instances/:id/activate`, `POST …/messages` (`{ text }`), `GET|PUT …/plan` (il PUT è una
  correzione manuale dell'utente: nuova versione già approvata — l'approvatore è l'utente stesso — e un turno con
  motivo `request` informa il capo delle modifiche; eventuali voci `plan`/`plan_change` aperte vengono rifiutate con
  nota «superata dalla modifica dell'utente»), `POST …/manual-actions/:actionId/done`, `GET …/tasks`, `GET …/tasks/:taskId`
  (con i passi), `GET …/turns` (con i passi), `GET …/events`, `PUT …/budget`, `GET /api/team-events?unread=true`,
  `POST /api/team-events/read` (`{ ids }`). `approve`/`reject` di `pending_actions` gestiscono anche i tipi `plan` e
  `plan_change` (nessun `userToken`; l'esecuzione è il cambio di stato del PLAN e il turno del capo).
- Limiti: `invia_al_capo` e `POST …/messages` 10/min per utente; testi come sopra.

## 8. Console

- Scheda della squadra: sezioni «Piano» (obiettivo, vincoli, compiti con stato ed esito, azioni manuali con «Fatto»,
  punti aperti; riquadro «Piano da approvare» con Approva / Rifiuta con nota; «Modifica»), «Attività» (timeline di
  turni e compiti con i passi), «Bollettino» (eventi con «Segna come letti»), campo «Scrivi al capo», «Attiva», tetto di
  spesa della squadra.
- «Da confermare»: tipo della voce (azione, piano, modifica del piano) e squadra; il contatore conta tutti i tipi.
- Account: modello del centralino.
- Niente scorrimento orizzontale a 1280 px.

## 9. Dati di produzione

`docs/migrations/2026-11-squadre-esecuzione.sql`, additiva e idempotente, PRIMA del merge: tabelle `team_plans`,
`team_plan_versions`, `team_tasks`, `team_task_steps`, `team_turns`, `team_turn_steps`, `team_events`; colonne su
`team_instances`, `pending_actions` (`kind` default `action`, `team_instance_id`, `plan_version`; `tool_id`/`app_id`
nullable con CHECK) e `users`. Nessuna colonna tolta. Riportata in `docs/schema-casello.sql`.

## 10. Test

Con un modello finto (come nei test delle run):

- attivazione → turno → `proponi_piano` → voce `plan` in coda ed evento `piano_proposto`;
- approvazione → turno → `assegna_compito` → compito cloud che `riferisce` → evento e turno successivo;
- rifiuto con nota → turno con la nota → nuova proposta;
- `assegna_compito` fuori PLAN → errore al modello; `proponi_piano` dopo l'approvazione → voce `plan_change`;
- azione L2 di un operaio → voce `action` con `team_instance_id`;
- motivi durante un turno → accumulati in un solo turno `queued`;
- 4 compiti assegnati insieme → 3 `running`, 1 `queued`;
- ruolo `node` → `waiting_node`;
- tetto della squadra raggiunto → nessun turno né compito, evento `bloccato`;
- riavvio con turni/compiti `running` → `failed`, evento `interrotto`, turno `restart`;
- chiusura della squadra → compiti `queued` annullati, voci `plan`/`plan_change` rifiutate;
- strumenti del centralino su `/mcp` (solo dati dell'utente, bollettino che segna letti, approva/rifiuta tutti i tipi);
- `PUT …/plan` manuale → nuova versione approvata, voci di piano aperte rifiutate, turno che informa il capo;
- migrazione idempotente; coda esistente (`kind` default `action`) invariata;
- prova nel browser della scheda squadra a 1280 px.
