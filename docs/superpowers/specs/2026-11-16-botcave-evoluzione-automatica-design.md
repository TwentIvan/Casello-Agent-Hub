# Botcave · Ciclo di evoluzione automatica di un'App (sottoprogetto 3 di 3)

Data: 16 novembre 2026. Stato: approvata in brainstorming con Ivan; 3a implementata. Rivista il 17 novembre 2026 (§15): la versione
di prova e «Porta in produzione» diventano un meccanismo di tutte le squadre con codice (nuova 3b) che il ciclo riusa (nuova 3c).
Dove §15 differisce dalle sezioni precedenti vale §15.

## 1. Perché

Ivan vuole che un'App evolva da sola: a intervalli Botcave la analizza, sceglie le voci da fare, le fa implementare a una
squadra, apre e unisce le PR, senza fermarsi ad aspettare i clic. Il rischio è di chi attiva il ciclo, quindi servono un
consenso esplicito e chiaro, un tetto di spesa dedicato e la possibilità di fermare tutto in ogni momento. Prima di
sovrascrivere la versione in produzione il giro si prova in un ambiente di prova e si porta in produzione solo con
l'approvazione dell'utente (modalità predefinita).

Terzo dei sottoprogetti delle «rifiniture dei personaggi»: usa la sintesi dell'architettura del sottoprogetto 1
(`app_architecture`, `leggi_architettura`, PR #134) e riusa analisi dell'architetto, piano dell'App, squadre con
`code: merge`, «Implementa», coda «Da confermare», tetti di spesa.

## 2. Decisioni prese (brainstorming del 16/11/2026)

- **Orchestratore deterministico sul server**: uno schedulatore con una macchina a stati per giro chiama le funzioni
  esistenti. Scartati: il Responsabile che guida il giro con strumenti (costo per passo, limiti solo nel prompt) e gli
  inneschi (non hanno passi in sequenza; se ne riusa solo il modello di schedulazione e backoff).
- **Fonte del lavoro**: un'analisi nuova a ogni giro, **ridotta** (fasi `completion` ed `evolution` con la sintesi
  dell'architettura al posto della fase `map`).
- **Cosa approva da solo**: le voci del piano (capitoli `endpoint`, `completion`, `evolution`) scelte per il giro e il PLAN
  del capo della squadra del ciclo (voci `plan` e `plan_change`). **Restano sempre all'utente**: tool, agenti e skill (l'analisi
  ridotta non li propone), le voci `merge` con script `-post`, le azioni L2 dei ruoli, la voce `release` (§7).
- **Squadra**: una squadra fissa del ciclo, creata all'attivazione da un modello di squadra scelto dall'utente e riusata a ogni
  giro.
- **Cadenza**: frequenza scelta **e** giro precedente chiuso **e** tetto con margine; mai due giri insieme.
- **Voci per giro**: impostazione 1..10, predefinita 3; le prime N per priorità e dipendenze.
- **Tetto**: mensile, obbligatorio, su tutto il ciclo (analisi + turni e compiti della sua squadra); raggiunto → pausa.
- **Ferma**: ferma subito tutto (vedi §8).
- **Consenso**: dialogo con l'elenco di ciò che Botcave farà da solo, casella «Attivo a mio rischio» e slug dell'App da
  scrivere; salvato con versione del testo e impronta delle impostazioni.
- **Versione di prova**: ambiente di prova per App preparato dall'utente (branch di prova fisso e indirizzo); Botcave unisce
  il giro su un branch del giro, sposta il branch di prova sulla sua testa e chiede «Porta in produzione il giro N». È
  un'opzione del ciclo, predefinita; l'alternativa «unisci direttamente su main» chiede un consenso più forte.

## 3. Scomposizione

Una spec, tre piani e tre PR, in quest'ordine (ognuna utile da sola):

- **3a · Ciclo, consenso, tetto, analisi ridotta, voci approvate** (§4, §5, §6.1–6.3, §8, §9, §10 parti di 3a). Il giro
  finisce con le voci approvate nel piano (`done`); l'utente può già implementarle con «Implementa».
- **3b · Lavoro su branch unico e «Porta in produzione» per tutte le squadre con codice** (§15.1–15.7, rivista il 17/11).
- **3c · Squadra del ciclo e PLAN automatico** (§15.8, che sostituisce §6.4–6.6 e §7): il ciclo crea la sua squadra e riusa la 3b.

Fino a 3c la modalità `staging` del ciclo non si può scegliere (400 «modalità non ancora disponibile»); con la 3c `merge_mode`
non decide più nulla (§15.8). La prima stesura (3b = squadra del ciclo, 3c = versione di prova del ciclo) è superata.

## 4. Dati

Migrazioni additive e idempotenti `docs/migrations/2026-11-<giorno>-evoluzione-automatica*.sql` (una per PR, le applica il
deploy), riportate in `docs/schema-casello.sql`; schema Drizzle in `lib/db/src/schema/evolution.ts`.

- Enum `evolution_cycle_status`: `active | paused`. Enum `evolution_frequency`: `daily | every_3_days | weekly | monthly`.
  Enum `evolution_merge_mode`: `staging | direct`. Enum `evolution_round_status`: `analyzing | approving | implementing |
  awaiting_release | done | blocked | rejected | stopped | failed`.
- Tabella `evolution_cycles` (una riga per App, `app_id` UNIQUE, FK `CASCADE`):
  - `status`, `paused_reason` (messaggio fisso, null se attivo), `frequency`, `items_per_round` (1..10, default 3);
  - `analysis_ai_model_id` (`SET NULL`; solo modelli cloud dei propri account), `team_template_id` (`SET NULL`),
    `team_instance_id` (`SET NULL`, 3b);
  - `merge_mode` (default `staging`), `staging_branch` (testo, null con `direct`), `staging_url` (https, null con `direct`);
  - `monthly_budget_usd` (numeric, NOT NULL, > 0);
  - consenso: `activated_by` (utente, `SET NULL`), `consent_at`, `consent_version` (testo, es. `2026-11-16`), `consent_hash`
    (SHA-256 delle impostazioni che lo richiedono, §9);
  - `next_round_at`, `consecutive_errors`, `last_error`, `next_attempt_at`, `created_at`, `updated_at`.
- Tabella `evolution_rounds` (`id`, `cycle_id` CASCADE, `number` per ciclo, `UNIQUE(cycle_id, number)`; indice unico parziale:
  al più un giro aperto per ciclo, stati `analyzing | approving | implementing | awaiting_release`):
  - `status`, `analysis_id` (`SET NULL`), `item_ids` (jsonb, voci approvate dal ciclo), `branch` (3c), `pending_action_id`
    (voce `release`, 3c), `outcome` (≤ 300), `rejection_note` (≤ 500), `started_at`, `finished_at`.
- `analyses.mode` `full | evolution` (default `full`) e `analyses.evolution_round_id` (`SET NULL`).
- `analysis_items.approved_by_cycle` boolean default false (traccia delle approvazioni automatiche).
- `pending_actions.decided_by_cycle` boolean default false (voci `plan`/`plan_change` decise dal ciclo, 3b).
- Valore `release` dell'enum `pending_action_kind` (3c, `ALTER TYPE … ADD VALUE IF NOT EXISTS`, fuori da una transazione).

## 5. Schedulazione (`lib/evolution/scheduler.ts`)

- `startEvolutionScheduler()` in `index.ts` dopo `startArchitectureScheduler`: all'avvio i giri `analyzing` con l'analisi
  interrotta diventano `failed` («giro interrotto dal riavvio»); poi un giro di controllo ogni 5 minuti, uno alla volta, fino
  a 20 cicli.
- **Avvio di un giro** (ciclo `active`, nessun giro aperto, `next_round_at <= now()`, `next_attempt_at` null o passato): controlli in
  quest'ordine, ognuno con un motivo fisso; un controllo non superato mette il ciclo in `paused` con `paused_reason` (tranne i
  transitori, che usano il backoff):
  1. consenso valido (§9), altrimenti «consenso da rinnovare»;
  2. App con codice da GitHub tramite installazione posseduta da `activated_by`, sintesi dell'architettura disponibile (se manca,
     `requestArchitectureRefresh` e attesa: transitorio);
  3. modello dell'analisi usabile (`resolveModel`, cloud);
  4. tetto del ciclo (§10) con margine;
  5. tetti di modello, account AI e utente (`runBudgetBlock` dell'utente come per le analisi cloud).
  Poi in una transazione con la riga del ciclo bloccata: giro nuovo `analyzing` (numero + 1), analisi `queued` in modalità
  `evolution` con `evolution_round_id`, `next_round_at = now() + frequenza`; dopo il commit `startAnalysis`.
- **Avanzamento** dei giri aperti a ogni controllo e su evento (fine analisi, fine compito, `pr_closed`, decisione della voce
  `release`): funzione unica `advanceRound(roundId)` con UPDATE condizionati sullo stato, idempotente.
- **Errori transitori** (GitHub, modello, analisi fallita): giro `failed` con il messaggio, `consecutive_errors + 1`,
  `next_attempt_at = now() + min(30 min × 2^errori, 24 h)`; dopo 5 errori di fila il ciclo va in `paused` («troppi errori di
  fila: controlla e riprendi»). Un giro riuscito azzera.
- Frequenze: `daily` 24 h, `every_3_days` 72 h, `weekly` 7 giorni, `monthly` 30 giorni, contate dall'inizio del giro precedente.

## 6. Il giro

### 6.1 Analisi ridotta (`lib/architect/`, `analyses.mode = evolution`)

- Fasi eseguite: `completion` ed `evolution` (`PHASES_BY_MODE`). Al posto di `map`, `capabilities` e `catalog` il modello riceve
  come dati: la sintesi dell'architettura (≤ 8 000) e la mappa (`repo_map`) del sottoprogetto 1, l'elenco dei tool esistenti
  (`existingToolsForPrompt`, solo nomi e descrizioni), le voci già pianificate (`chatPlannedItems`), le voci rifiutate dall'utente
  nei giri precedenti del ciclo (titoli, per non riproporle) e la nota di rifiuto dell'ultima `release` (3c).
- Il codice si legge come oggi (`SourceTree` dello SHA corrente) solo a richiesta del modello.
- Tetto: 150 000 token e 15 minuti (`EVOLUTION_ANALYSIS_LIMITS`), al posto di 1 000 000 e 30 minuti; quote 0,5 e 0,4.
- Nessuna voce `tool`, `agent`, `skill`, `endpoint` di catalogo: solo i capitoli delle due fasi (`completion`, `evolution`, più
  `endpoint` se la fase completion li produce oggi).
- Un'analisi `evolution` non chiude né sostituisce l'ultima analisi completa dell'App nella pagina del piano: le sue voci
  entrano nel piano come le altre (stessa `loadPlanItems`).

### 6.2 Scelta e approvazione delle voci (`lib/evolution/select.ts`, puro)

- Candidate: voci `pending` dell'analisi del giro nei capitoli `endpoint`, `completion`, `evolution`.
- Ordine: completamento per fase e dipendenze (stesso ordinamento di `plan-issues`), poi evoluzione per priorità (P1 prima),
  poi endpoint; una voce con una dipendenza non approvata né già fatta si salta.
- Le prime `items_per_round` diventano `approved` con `approved_by_cycle = true` (stessa funzione di `PATCH
  /analysis-items/:id`, senza `apply` perché questi capitoli non hanno effetti); le altre restano `pending` per l'utente.
- Zero candidate → giro `done` «nessuna voce nuova» (nessun costo oltre l'analisi).
- Se l'App ha il permesso Issues, si creano le issue delle voci scelte (`lib/plan-issues/service.ts`, conta nel limite di 5/min
  dell'utente); un errore delle issue non ferma il giro (le voci restano senza issue).

### 6.3 Fine del giro in 3a

In 3a, senza squadra del ciclo, il giro chiude `done` con «N voci approvate: usa Implementa per farle realizzare» ed evento
nel bollettino dell'utente (§11).

> §6.4–6.6 e §7 sono la prima stesura, superata dalla revisione del 17/11: vale §15.

### 6.4 Squadra del ciclo (3b)

- All'attivazione (o al primo giro) Botcave crea l'istanza dal modello scelto con `createInstance` e `ref`
  `{type: "evoluzione", id: <id dell'App>, title: "Evoluzione di <app>"}`, poi la attiva con `activated_by` = chi attiva il ciclo.
  Il modello deve avere un ruolo `cloud` o il capo con `code: merge` (altrimenti 400 «il modello di squadra deve poter unire le
  PR: serve un ruolo con Scrittura e merge»). Ruoli `node` ammessi (avviso di «Pronta a lavorare» nel dialogo).
- Tetto della squadra: `team_instances.monthly_budget_usd` = tetto del ciclo; `team-budget.ts` per un'istanza di ciclo somma anche
  le analisi del ciclo del mese (§10).
- A ogni giro, dopo l'approvazione delle voci, si accoda al capo un turno `request` con il testo di `implementMessage` (spostato da
  `artifacts/casello/src/lib/implement-plan.ts` in un modulo condiviso o riscritto lato server con lo stesso testo) e le voci del
  giro; giro `implementing`.

### 6.5 PLAN automatico (3b)

- Quando una voce `plan` o `plan_change` della squadra del ciclo entra in coda e il ciclo è `active` con consenso valido, si
  approva subito (`decidePlanItem` con `approved`, `decided_by_cycle = true`, `decided_by` = `activated_by`), nella stessa
  logica di `approveAction` (lock e transazioni di oggi). Con il ciclo in pausa la voce resta all'utente.
- Il freno «compito fallito 3 volte» e le regole del capo restano; il capo segnala i blocchi come oggi.

### 6.6 Merge e chiusura dell'implementazione (3b)

- Modalità `direct`: PR verso `main` e `unisci_pr` come oggi. Modalità `staging` (3c): base dei compiti = branch del giro.
- Il giro passa a `awaiting_release` (`staging`) o `done` (`direct`) quando tutti i compiti del PLAN nati per il giro sono `done` con la
  PR unita oppure `blocked|failed`, oppure il capo chiama `chiudi_lavoro`; nessuna PR unita → `blocked` «nessuna voce
  completata». Durata massima di un giro in `implementing`: 72 ore, poi `blocked` «giro scaduto».
- Una PR con script `-post` resta una voce `merge` all'utente (regole di `merge.ts` invariate); il giro aspetta la sua decisione.

## 7. Versione di prova e «Porta in produzione» (3c)

- **Impostazioni**: `staging_branch` (nome valido di branch, diverso dal base, non `main`/`master`, non con prefisso `botcave/`) e
  `staging_url` (https). Il branch di prova è **dedicato a Botcave**: il consenso dice che verrà riscritto a ogni giro.
- **Branch del giro** `botcave/giro-<ciclo>-<numero>`, creato dallo sha del base all'avvio dell'implementazione. Per la squadra del
  ciclo `team_instances.code_base_branch` (colonna nuova, null = base dell'App) punta al branch del giro: `nodeGitContext`, il
  base dei compiti cloud, `apri_pr` e i controlli di `unisci_pr` (`base.ref`) lo usano al posto del base dell'App. `unisci_pr` sul
  branch del giro: stessi controlli (CI verde, workflow e migrazioni), squash.
- **Fine dell'implementazione**: Botcave aggiorna `refs/heads/<staging_branch>` alla testa del giro con `force: true` (unica
  scrittura forzata di Botcave, solo su quel branch; se il branch non esiste lo crea). Il deploy di prova lo fa la CI/Coolify
  dell'App. Poi accoda la voce `release`.
- **Voce `release`** (`pending_actions.kind = 'release'`, `app_id`, niente tool; `args_public`: ciclo, giro, voci con titolo e
  issue, PR unite, branch del giro, testa, `staging_url`, file `-post` del giro): in «Da confermare» «Porta in produzione il giro
  N di <app>». Una sola aperta per ciclo; nessun giro nuovo finché è aperta.
  - **Approva** (`approveRelease`, nessun token utente, ambito `api:write` per i token): apre (o riusa) la PR dal branch del giro
    verso il base; se il base è avanzato, prima `POST /repos/{repo}/merges` (base = branch del giro, head = base), conflitto →
    voce `failed` «conflitto con <base>: il giro va rifatto» e giro `failed`; attende la CI sulla testa fino a 30 minuti
    (sorveglianza come `watcher.ts`): verde → controlli di `classifyPull` sulla PR (workflow rifiutati, migrazioni come per
    `unisci_pr`) → merge con **commit di merge** (conserva i commit delle voci e i loro «Closes #n») → voce `done` «giro N in
    produzione», giro `done`, `requestArchitectureRefresh`. CI rossa → voce `failed` col nome dei check, giro `failed`.
  - **Rifiuta** (nota ≤ 500): giro `rejected`, nota in `rejection_note`, entra nell'analisi del giro dopo; il branch del giro resta.
  - Con il ciclo in pausa la voce resta decidibile.
- Alfred e centralino: `coda_da_confermare` e `leggi_proposta` mostrano la voce `release` come le altre; `prepara_decisione`
  funziona (nessun token utente).
- Console: tipo «Rilascio», indirizzo di prova come link, voci e PR, «Porta in produzione» / «Rifiuta» (`components/actions/release-detail.tsx`).

## 8. Ferma e Riprendi

- `POST /api/apps/:id/evolution/stop`: ciclo `paused` con `paused_reason` «fermato dall'utente»; giro aperto `stopped`; analisi del
  giro `cancelled` (route di annullamento esistente); squadra del ciclo: compiti `queued` e `waiting_node` annullati come in
  `closeInstance` (ma la squadra resta `active` per riprendere), turni in coda falliti, nessun turno nuovo finché il ciclo è in
  pausa (controllo in `turn-runner.ts` per le istanze di ciclo); i compiti `running` finiscono ma `unisci_pr` per un'istanza di
  ciclo in pausa risponde «ciclo di evoluzione fermato». La voce `release` aperta resta da decidere.
- `POST /api/apps/:id/evolution/resume`: richiede consenso valido; ciclo `active`, errori azzerati, `next_round_at = now()`.
- Tetto raggiunto e troppi errori usano la stessa pausa, con il loro motivo.

## 9. Consenso

- Testo versionato in `lib/evolution/consent.ts` (`CONSENT_VERSION`, `consentText(settings)`): elenca in italiano cosa Botcave farà
  da solo (analisi a ogni giro, approvazione di N voci, squadra che modifica il codice, approvazione del PLAN, merge delle PR sul
  branch del giro o, in `direct`, su `<base>` con deploy in produzione, riscrittura del branch di prova) e cosa resta all'utente.
- `PUT /api/apps/:id/evolution` (solo login, `sessionOnly`; con token o embed 403) con le impostazioni e `consent: {accepted: true,
  appSlug, version, directMerge?: true}`: `appSlug` uguale allo slug dell'App, `version` uguale a `CONSENT_VERSION`, `directMerge`
  obbligatorio con `merge_mode = direct`; altrimenti 400 «consenso non valido».
- `consent_hash` = SHA-256 di: `merge_mode`, `staging_branch`, `team_template_id`, `analysis_ai_model_id`, `items_per_round`,
  `monthly_budget_usd`. Cambiare uno di questi campi senza un consenso nuovo → 400 «consenso da rinnovare», con due eccezioni che
  non lo chiedono: abbassare il tetto (il server ricalcola l'impronta col valore nuovo) e cambiare la frequenza (non è
  nell'impronta). Cambiare `CONSENT_VERSION` in una release futura mette in pausa i cicli con «consenso da rinnovare».
- Chi attiva paga: `activated_by` deve possedere il modello dell'analisi e l'installazione GitHub; un altro utente che cambia le
  impostazioni dà un consenso nuovo e diventa `activated_by`.

## 10. Spesa e tetto

- Spesa del ciclo nel mese (ora italiana, `lib/budget.ts`): `analyses.cost_usd` delle analisi con `evolution_round_id` del ciclo +
  turni e compiti della squadra del ciclo (`team-budget.ts`). Costi null contano come esecuzioni senza prezzo.
- Controllo prima di ogni giro (§5) e, per la squadra, a ogni turno e compito (`team-budget.ts` per le istanze di ciclo usa il tetto
  del ciclo e somma anche le analisi). Raggiunto: ciclo `paused` «tetto di spesa del ciclo raggiunto», evento nel bollettino;
  l'analisi in corso arriva in fondo (ha il suo tetto di 150k token).
- Le analisi del ciclo contano anche nei tetti di utente, modello e account come ogni analisi cloud.

## 11. API e console

- Contract-first (`openapi.yaml`, tag `evolution`): `GET /api/apps/:id/evolution` → `EvolutionCycle` (impostazioni, stato, motivo,
  consenso, spesa del mese, prossimo giro, testo del consenso per le impostazioni attuali) o `null`; `PUT` (§9); `POST …/stop`,
  `POST …/resume`, `POST …/run-now` (giro subito se possibile, 2/ora per App); `GET …/rounds` (ultimi 20, con analisi, voci, esito);
  `DELETE /api/apps/:id/evolution` (solo con ciclo in pausa e nessun giro aperto né voce `release` aperta; la squadra del ciclo resta
  e si chiude a mano). Ambiti per metodo; il token d'ambito `agent` riceve 403 su tutte le scritture (`AGENT_DENIED_ROUTES`).
- Notifiche: in 3a gli esiti si vedono nella carta del ciclo e nella Dashboard (contatore «Cicli in pausa» in
  `/api/dashboard/stats`); da 3b gli eventi del giro (avvio, voci approvate, pausa, voce `release`) sono `team_events` della squadra del
  ciclo e arrivano nel bollettino dell'utente che ha attivato.
- Console, scheda App, carta «Evoluzione automatica» (`components/apps/evolution-card.tsx`): LED (`work` giro in corso, `ok` attivo in
  attesa, `ask` voce `release` da decidere, `idle` in pausa, `ko` in pausa per errore o tetto), giro corrente con la fase, spesa del
  mese e tetto, prossimo giro, ultimi giri con esito e link all'analisi, «Attiva…», «Ferma» (sempre visibile con il ciclo attivo),
  «Riprendi», «Esegui ora», «Impostazioni…». Dialogo di attivazione (`evolution-consent-dialog.tsx`): impostazioni, testo del
  consenso, casella «Attivo a mio rischio», campo slug, seconda casella per `direct`. Niente scorrimento orizzontale a 1280 px.
  Voci approvate dal ciclo con l'etichetta «dal ciclo» nel piano.

## 12. Sicurezza

- Il ciclo non decide mai: tool/agenti/skill, `merge` con `-post`, azioni L2, `release`. Nessuna scrittura forzata salvo il branch di
  prova, validato al salvataggio e ricontrollato prima di scrivere.
- Tutte le scritture dei ruoli restano quelle di `code: merge` (workflow e meccanismo delle migrazioni rifiutati).
- Il testo delle analisi e delle note entra nei prompt come dati. Log: id, sha a 7, conteggi, esiti; mai contenuti, titoli delle
  voci o note.

## 13. Prove

- Vitest puri: `select.ts` (ordine, dipendenze, N), `consent.ts` (impronta, cosa la cambia), macchina a stati di `advanceRound`
  (orologio finto).
- 3a: prova di flusso `test/evolution-flow.test.ts` (finto provider e finto GitHub): attivazione con consenso → giro → analisi ridotta
  → voci approvate → giro `done`; tetto raggiunto → pausa; Ferma durante l'analisi; consenso da rinnovare.
- 3b: estensione della prova: squadra creata, PLAN approvato dal ciclo, compito con codice, PR, merge (`direct`), giro chiuso.
- 3c: branch del giro, PR dei compiti sul branch del giro, aggiornamento del branch di prova, voce `release`, approvazione con `main`
  avanzato (merge di `main`), CI verde → merge su `main`; rifiuto con nota → nota nell'analisi successiva.
- Console: test del dialogo di consenso (logica pura in `lib/evolution-consent.ts`).

## 14. Fuori ambito

Analisi completa periodica, preparazione dell'ambiente di prova (Coolify, branch Neon), cicli su App senza GitHub tramite
installazione, tool/agenti/skill nel ciclo, approvazione automatica degli script `-post` o delle azioni L2, più cicli per App,
scelta delle voci da parte di un modello (l'ordine è deterministico), Lucius e le best practice (sottoprogetto 2: quando ci sarà,
l'analisi ridotta potrà riceverle come dati).

## 15. Revisione del 17 novembre 2026: lavoro su branch unico per le squadre (3b) e squadra del ciclo (3c)

### 15.0 Perché

La squadra «Sviluppo The Hub Up in loop» (repository TwentIvan/AbapCrm) ha chiuso 23 compiti con 23 PR in bozza, tutte partite
da `main`: dopo il primo merge le altre vanno in conflitto (21 toccano `server/routes.ts`), una PR contiene i commit di altre,
il repository non ha CI sui branch `botcave/**` e il capo ha dichiarato ogni compito «nessuna CI, pronta», il revisore non ha avuto
compiti, «Lavoro finito» è uscito 4 volte e diversi turni del capo sono falliti per il limite di 10 giri. Ivan vuole che
l'implementazione di un piano arrivi fino al deploy di un **branch unico** su un ambiente di prova, e su `main` solo dopo la
sua approvazione. Decisioni del 17/11:

- versione di prova e «Porta in produzione» sono un **meccanismo di tutte le squadre con codice** (anche quelle di «Implementa»);
  il ciclo lo riusa senza logica propria;
- branch e indirizzo di prova sono **impostazioni dell'App**, non del ciclo;
- **compiti con codice in fila**: uno alla volta per lavoro, ognuno parte dalla testa del branch dopo il merge del precedente
  (niente conflitti tra le PR; i compiti senza codice restano in parallelo);
- **CI obbligatoria**: senza CI che giri sui branch di Botcave nessun compito con codice si unisce;
- **un solo «Lavoro finito»** per lavoro; «Porta in produzione» resta sempre una decisione dell'utente (mai del ciclo).

### 15.1 Dati (migrazione additiva della 3b)

- `apps.staging_branch` (testo, null = nessuna versione di prova) e `apps.staging_url` (https, facoltativo). Regole: nome di branch
  valido, diverso dal branch base, non `main`/`master`, non con prefisso `botcave/`; il branch è **dedicato a Botcave** e viene
  riscritto a ogni lavoro (lo dice la carta delle sorgenti dell'App, con conferma alla prima impostazione). Si modificano con
  `PATCH /api/apps/:id` (stesse regole della PATCH: il token d'ambito `agent` resta 403).
- Tabella `team_works` (un **lavoro** = un branch unico di una squadra): `id`, `instance_id` (`CASCADE`), `number` per squadra
  (`UNIQUE(instance_id, number)`), `status` `open | awaiting_release | releasing | released | abandoned`, `repo`, `branch`
  (`botcave/lavoro-<idSquadra>-<numero>`), `base_branch`, `base_sha` (testa del base alla creazione), `head_sha`, `post_scripts`
  (jsonb: nomi dei file `-post` uniti nel lavoro), `pending_action_id` (voce `release`, `SET NULL`), `release_pr_number`,
  `release_pr_url`, `rejection_note` (≤ 500), `finished_at`, `created_at`; indice unico parziale: al più un lavoro non chiuso
  (`open|awaiting_release|releasing`) per squadra.
- `team_code_tasks.work_id` (`SET NULL`): le righe dei compiti nati nel lavoro; il loro `base` è il branch del lavoro.
- Valore `release` di `pending_action_kind` (fuori da una transazione esplicita) e tipo di evento `lavoro_in_prova` di
  `team_event_type`.

### 15.2 Il lavoro e il branch unico

- **Apertura**: alla prima `assegna_compito` di un compito con codice (ruolo con `code ≠ none`, sia `cloud` sia `node`) senza un
  lavoro aperto, Botcave crea il lavoro e il branch `botcave/lavoro-<squadra>-<n>` dallo sha del base dell'App (`contents: write`,
  `force: false`). Le squadre senza ruoli con codice non hanno lavori.
- **Base dei compiti**: con un lavoro aperto il base di ogni compito con codice è il branch del lavoro: il branch del compito
  (`botcave/<squadra>-<compito>`) nasce dalla sua testa, la PR in bozza punta al branch del lavoro (`apri_pr` cloud e
  `createDraftPull` per i ruoli `node`), `nodeGitContext.baseBranch` = branch del lavoro; il controllo che non si scriva mai sul base
  vale anche per il branch del lavoro (lo scrive solo il merge).
- **In fila**: `assegna_compito` di un compito con codice è rifiutato con «un compito con codice è già in corso nel lavoro:
  aspetta che la sua PR sia unita» se nel lavoro c'è già un compito con codice `queued|running|waiting_node` oppure `done` con la PR
  ancora aperta. Un compito finito senza commit, `blocked` o `failed` non tiene la fila. Riassegnato dopo una CI rossa, il compito
  riparte dal suo branch (come oggi).
- **Merge sul branch del lavoro (automatico)**: la sorveglianza (`watcher.ts`), quando la CI della testa di una PR di un compito del
  lavoro è `success`, la unisce da sola sul branch del lavoro con gli stessi controlli di `mergeTeamPull` (squadra attiva,
  installazione di chi ha attivato, testa invariata, workflow e meccanismo delle migrazioni rifiutati, classificazione delle
  migrazioni) ma **senza** bisogno di un ruolo `code: merge` e **senza** voce `merge` per gli script `-post` (si uniscono e il loro
  nome finisce in `team_works.post_scripts`: li vedrà l'utente in «Porta in produzione»); squash, come `unisci_pr`. Il capo riceve il
  motivo `pr_closed` di sempre e assegna il compito successivo. `unisci_pr` resta per le PR verso il base delle squadre senza lavoro
  (dati vecchi) e rifiuta le PR di un lavoro («le PR del lavoro le unisce Botcave quando la CI è verde»).
- **CI obbligatoria**: una PR del lavoro con CI `none` sulla testa (nessun check dopo 10 minuti dal push) non si unisce: compito del
  PLAN `blocked` «nessuna CI sul branch: aggiungi un workflow che giri sui branch botcave/**» (prefisso in
  `ENVIRONMENT_FAILURE_PREFIXES`: non conta nel freno dei 3 fallimenti), evento `bloccato`, turno del capo che usa `segnala`
  (azione manuale). La «Pronta a lavorare» aggiunge `ci_missing` per i ruoli con codice: `error` se l'ultima PR di Botcave sullo
  stesso repository ha avuto CI `none`, `warning` «verifica che la CI giri sui branch botcave/**» se non ce n'è ancora una. Il prompt
  del capo dice che un compito con codice è finito solo con la PR unita sul branch del lavoro, mai «nessuna CI, pronta».
- **Revisore**: se la squadra ha un ruolo con `code: read`, il prompt del capo gli fa assegnare, prima di chiudere il lavoro, un
  compito di revisione del branch del lavoro (lettura del codice e del confronto con il base); il suo esito entra nella voce
  `release`. Senza un ruolo `read` nessun obbligo.

### 15.3 Chiusura del lavoro e versione di prova

- Il lavoro passa a `awaiting_release` quando il capo chiama `chiudi_lavoro` oppure quando tutti i compiti con codice del PLAN
  approvato sono `done` con la PR unita o `blocked|failed` e nessuna PR del lavoro è aperta (controllo della sorveglianza). Nessuna
  PR unita → lavoro `abandoned` con evento `bloccato` «nessun compito unito nel lavoro», nessuna voce.
- **Un solo «Lavoro finito»**: l'evento `lavoro_finito` si emette una volta per lavoro; un `chiudi_lavoro` con il lavoro già
  `awaiting_release|releasing` risponde `{ok:false}` «lavoro già chiuso: aspetta la decisione su Porta in produzione» senza evento.
- **Versione di prova**: con `apps.staging_branch` impostato Botcave aggiorna `refs/heads/<staging_branch>` alla testa del lavoro
  con `force: true` (unica scrittura forzata di Botcave, solo su quel branch, ricontrollato prima di scrivere; se non esiste lo
  crea), evento `lavoro_in_prova` con l'indirizzo di prova. Il deploy di prova lo fa la CI/Coolify dell'App. Senza branch di prova la
  voce dice «nessuna versione di prova configurata per l'App».
- **Voce `release`** in «Da confermare» dell'utente che ha attivato la squadra: «Porta in produzione il lavoro N di <squadra>»
  (`args_public`: squadra, lavoro, compiti con titolo e issue, PR unite, branch, testa, `staging_url`, script `-post`, esito del
  revisore). Una sola aperta per lavoro. Non la decide mai un automatismo (né il ciclo né un ruolo).
  - **Approva** (`approveRelease`, nessun token utente, ambito `api:write` per i token): lavoro `releasing`; apre (o riusa) la PR dal
    branch del lavoro verso il base; se il base è avanzato prima `POST /repos/{repo}/merges` (base = branch del lavoro, head = base):
    conflitto → voce `failed` «conflitto con <base>: va risolto nel lavoro», lavoro di nuovo `open` e turno del capo con motivo
    `release_failed` (assegna un compito di allineamento al ruolo con codice); attende la CI della testa fino a 30 minuti (come la
    sorveglianza): verde → `classifyPull` sulla PR (workflow e meccanismo delle migrazioni rifiutati; gli script `-post` sono ammessi e
    la voce li mostra «da applicare su Neon dopo il deploy») → merge con **commit di merge** (conserva i commit dei compiti e i loro
    «Closes #n») → voce `done` «lavoro N in produzione», lavoro `released`, `requestArchitectureRefresh`; CI rossa → voce `failed` col
    nome dei check, lavoro `open`, turno `release_failed`.
  - **Rifiuta** (nota ≤ 500): il lavoro torna `open` con `rejection_note`; il capo riceve un turno `request` con la nota (i compiti di
    correzione ripartono dal branch del lavoro); a fine correzioni una nuova voce `release`. Per buttare il lavoro l'utente chiude la
    squadra (il branch resta su GitHub).
  - Con la squadra chiusa la voce si può solo rifiutare.

### 15.4 Capo e limiti

- Con i compiti in fila il capo assegna un compito con codice per turno e il merge non passa più da lui: meno giri per turno. Il prompt
  (`turn-runner.ts`) spiega lavoro, fila, merge automatico, CI obbligatoria, revisore e chiusura unica; `leggi_piano` mostra il lavoro
  aperto (branch, compiti uniti, compito in corso).
- Un turno del capo che finisce per il limite di giri non perde i motivi (come oggi); i limiti `LEAD_LIMITS` non cambiano in 3b.

### 15.5 «Implementa» e squadre esistenti

- «Implementa» non cambia nell'interfaccia: la squadra lavora nel suo lavoro aperto e il testo del messaggio al capo lo dice.
- Le righe di `team_code_tasks` create prima della 3b (senza `work_id`) restano con base `main` e PR verso `main` (merge dell'utente o
  `unisci_pr` come oggi). Il primo compito con codice assegnato dopo il deploy apre un lavoro.

### 15.6 API e console

- `GET /api/team-instances/:id/works` (ultimi 20) e il lavoro aperto in `GET …/plan` (`work`: numero, stato, branch, testa, PR unite,
  compito in fila, voce `release`). Voce `release` nelle route di «Da confermare» come gli altri tipi; centralino, Alfred
  (`prepara_decisione`) e pannello la mostrano (nessun token utente).
- Console: carta «Piano» della squadra con il lavoro (branch, LED, PR unite, indirizzo di prova); tipo «Rilascio» in «Da confermare» con
  indirizzo di prova, compiti, PR, script `-post` e esito del revisore (`components/actions/release-detail.tsx`), «Porta in produzione»
  / «Rifiuta»; carta delle sorgenti dell'App con branch e indirizzo di prova.

### 15.7 Prove della 3b

- Prova di flusso (estensione di `code-team-flow.test.ts`, finto GitHub): due compiti con codice in fila → il secondo rifiutato finché
  la PR del primo non è unita → merge automatico sul branch del lavoro con CI verde → secondo compito dalla testa nuova → CI `none` →
  compito bloccato → chiusura unica con branch di prova riscritto → voce `release` → approvazione con il base avanzato (merge del base
  nel lavoro) → commit di merge su `main`; rifiuto con nota → lavoro di nuovo aperto e turno del capo.

### 15.8 Squadra del ciclo (nuova 3c)

- Il ciclo crea all'attivazione (o al primo giro) la sua squadra dal modello scelto (`ref` `{type: "evoluzione", id, title: "Evoluzione
  di <app>"}`, `activated_by` = chi paga il ciclo); serve almeno un ruolo con codice e la CI (regole della 3b). Tetto della squadra =
  tetto del ciclo, che somma analisi, turni e compiti.
- A ogni giro, dopo l'approvazione delle voci, il capo riceve il messaggio di «Implementa» con le voci del giro (giro `implementing`);
  le voci `plan`/`plan_change` della squadra del ciclo si approvano da sole con il ciclo attivo e il consenso valido
  (`pending_actions.decided_by_cycle`).
- Il giro segue il lavoro della squadra: `awaiting_release` quando il lavoro è in prova, `done` quando la voce `release` è approvata e
  il lavoro è in produzione, di nuovo `implementing` se l'utente rifiuta con una nota (la nota entra anche nell'analisi del giro dopo);
  nessun giro nuovo finché il lavoro non è chiuso. Durata massima in `implementing`: 72 ore, poi `blocked` «giro scaduto».
- `merge_mode` e la modalità `direct` non decidono più nulla: «Porta in produzione» resta sempre all'utente. Il consenso della 3c elenca
  squadra, PLAN approvato da solo, merge automatici sul branch del lavoro e riscrittura del branch di prova dell'App.
- «Ferma» si estende alla squadra del ciclo (compiti in coda annullati, nessun turno nuovo, nessun merge automatico sul branch del lavoro
  finché il ciclo è in pausa); la voce `release` aperta resta decidibile.
