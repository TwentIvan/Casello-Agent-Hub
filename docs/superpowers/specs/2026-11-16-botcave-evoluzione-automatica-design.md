# Botcave · Ciclo di evoluzione automatica di un'App (sottoprogetto 3 di 3)

Data: 16 novembre 2026. Stato: approvata in brainstorming con Ivan, da rileggere prima del piano di 3a.

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
- **3b · Squadra del ciclo e PLAN automatico** (§6.4–6.6): il giro prosegue fino al merge delle PR; in 3b il merge va sul
  branch del giro solo se 3c è presente, altrimenti la modalità disponibile è solo «unisci direttamente su main».
- **3c · Versione di prova e voce `release`** (§7).

Fino a 3c la modalità `staging` non si può scegliere (400 «modalità non ancora disponibile»).

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
