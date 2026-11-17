# Lavoro su branch unico e «Porta in produzione» (3b): piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni squadra con codice lavora su un branch unico per lavoro: i compiti con codice vanno in fila, Botcave unisce da solo le loro PR sul branch del
lavoro quando la CI è verde (CI obbligatoria), a fine lavoro sposta il branch di prova dell'App sulla testa e chiede in «Da confermare» «Porta in produzione»,
che solo l'utente decide.

**Architecture:** tabella nuova `team_works` e modulo `artifacts/api-server/src/lib/teams/works.ts` (apertura, fila, chiusura, versione di prova); il base dei
compiti diventa il branch del lavoro in `task-runner.ts` (cloud) e `node-git.ts` (node); il merge automatico sul branch del lavoro e la sorveglianza delle voci
`release` stanno nella sorveglianza esistente (`code-writer/watcher.ts`) riusando i controlli di `code-writer/merge.ts`; voce `release` con decisione in
`lib/teams/release.ts`; impostazioni di prova sull'App; console nella carta «Piano», in «Da confermare» e nella carta delle sorgenti dell'App.

**Tech Stack:** TypeScript, Express 5, Drizzle/Postgres (PGlite nei test), Vitest, Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-16-botcave-evoluzione-automatica-design.md`, **§15.0–15.7** (la §15.8 è la 3c, fuori da questo piano).

**Base:** branch nuovo `feat/lavoro-branch-unico` da `main` **dopo il merge della PR #139** (serve la §15 della spec e il codice del ciclo è indipendente).

## Global Constraints

- Lingua: testi, commenti, messaggi d'errore e commit in italiano; identificatori in inglese. Testi visibili: «Botcave», mai «Casello».
- Comandi: `corepack pnpm …`; typecheck con `PATH=/private/tmp/claude-501/pnpmbin:$PATH corepack pnpm run typecheck` (wrapper di pnpm); test API
  `corepack pnpm --filter @workspace/api-server run test`, console `corepack pnpm --filter @workspace/casello run test`; dopo `openapi.yaml` il codegen
  `corepack pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Migrazione `docs/migrations/2026-11-17-lavoro-branch-unico.sql`: additiva, idempotente, senza BEGIN/COMMIT, niente `-post` (`ALTER TYPE … ADD VALUE IF NOT EXISTS`
  fuori da una transazione); riportata in `docs/schema-casello.sql`; la applica il deploy.
- Nomi e valori fissi: branch del lavoro `botcave/lavoro-<idSquadra>-<numero>`; un lavoro non chiuso per squadra (`open|awaiting_release|releasing`); CI `none` = nessun
  check 10 minuti dopo il commit (`CI_NONE_AFTER_MS` esistente); attesa della CI della PR di rilascio 30 minuti (`RELEASE_CI_TIMEOUT_MS = 1_800_000`); nota di rifiuto ≤ 500;
  commit di merge (non squash) per il rilascio; squash per le PR dei compiti sul branch del lavoro.
- Messaggi fissi (`WORK_MESSAGES` in `lib/teams/works.ts`, `RELEASE_MESSAGES` in `lib/teams/release.ts`), testo esatto:
  «un compito con codice è già in corso nel lavoro: aspetta che la sua PR sia unita», «nessuna CI sul branch: aggiungi un workflow che giri sui branch botcave/**»,
  «lavoro già chiuso: aspetta la decisione su Porta in produzione», «nessun compito unito nel lavoro», «le PR del lavoro le unisce Botcave quando la CI è verde»,
  «nessuna versione di prova configurata per l'App», «conflitto con <base>: va risolto nel lavoro», «CI non superata sulla PR di rilascio: <check>»,
  «CI della PR di rilascio non conclusa entro 30 minuti», «lavoro N in produzione», «branch di prova non valido», «indirizzo di prova non valido».
- «Porta in produzione» non la decide mai un automatismo; Botcave non scrive mai sul base salvo il merge approvato; l'unica scrittura forzata è su `apps.staging_branch`,
  ricontrollato prima di scrivere (`checkStagingBranch`).
- Log: id, numeri di PR, sha a 7, conteggi, esiti; mai contenuti, titoli, note o SQL.
- Console: token di `design/`, LED per gli stati, niente scorrimento orizzontale a 1280 px, solo hook Orval.

## Review Focus

- Due compiti con codice assegnati nello stesso turno: il secondo è rifiutato con il messaggio della fila, anche con assegnazioni concorrenti (controllo con la squadra bloccata) — test in Task 3.
- Branch del lavoro avanzato da un merge mentre un compito è in corso: il compito successivo parte dalla testa nuova, quello in corso non viene riscritto — test in Task 3 e Task 9.
- Voce `release` approvata e riavvio del server durante l'attesa della CI: la voce `executing` non diventa «esito incerto», la sorveglianza la riprende — test in Task 6.
- `apps.staging_branch` uguale al base o con prefisso `botcave/`, o cambiato in mezzo al lavoro: niente scrittura forzata, messaggio fisso — test in Task 2 e Task 5.
- Squadre esistenti con PR verso `main` (righe senza `work_id`): continuano come oggi, nessun lavoro aperto finché non si assegna un compito nuovo — test in Task 3.

---

### Task 1: Migrazione e schema

**Files:**
- Create: `docs/migrations/2026-11-17-lavoro-branch-unico.sql`, `lib/db/src/schema/team-works.ts`, `artifacts/api-server/test/migration-lavoro-branch-unico.test.ts`
- Modify: `lib/db/src/schema/apps.ts`, `lib/db/src/schema/team-code-tasks.ts`, lo schema di `pending_actions` (enum `pending_action_kind`), lo schema degli eventi (enum `team_event_type`), `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces: `appsTable.stagingBranch` (text null), `appsTable.stagingUrl` (text null); enum `team_work_status` (`open|awaiting_release|releasing|released|abandoned`);
  `teamWorksTable` (§15.1: `id`, `instanceId` CASCADE, `number`, `status` default `open`, `repo`, `branch`, `baseBranch`, `baseSha`, `headSha`, `postScripts` jsonb `string[]` default `[]`,
  `pendingActionId` SET NULL, `releasePrNumber`, `releasePrUrl`, `releaseCiSince` timestamp null, `rejectionNote`, `finishedAt`, `createdAt`, `updatedAt`), `UNIQUE(instance_id, number)`,
  indice unico parziale `team_works_one_open` su `instance_id` con `status in ('open','awaiting_release','releasing')`; `teamCodeTasksTable.workId` (SET NULL);
  valore `release` di `pending_action_kind`; valore `lavoro_in_prova` di `team_event_type`. Tipi `TeamWork`.
- [ ] **Step 1:** test di migrazione (modello `migration-evoluzione-automatica.test.ts`): file applicato due volte; due lavori aperti per la stessa squadra → violazione; un
  lavoro `released` più uno `open` ammessi; eliminare la squadra elimina i lavori; `team_code_tasks.work_id` SET NULL; i valori nuovi degli enum esistono.
- [ ] **Step 2:** rosso. **Step 3:** migrazione, schema, `schema-casello.sql`. **Step 4:** verdi anche `migrations-auto.test.ts`, typecheck.
- [ ] **Step 5:** commit `feat(casello): tabelle del lavoro su branch unico`.

### Task 2: Versione di prova dell'App

**Files:**
- Create: `artifacts/api-server/src/lib/teams/staging.ts` (+ test)
- Modify: `lib/api-spec/openapi.yaml` (`App.stagingBranch`, `App.stagingUrl`, `AppUpdate` stessi campi), generati, `artifacts/api-server/src/routes/apps.ts` (PATCH e serializer),
  `artifacts/casello/src/components/apps/app-sources-card.tsx`

**Interfaces:**
- Produces: `checkStagingBranch(name: string, baseBranch: string | null): string | null` (null = valido; altrimenti «branch di prova non valido»: nome di branch Git valido 1..100,
  non uguale al base, non `main`/`master`, non con prefisso `botcave/`, niente `..`, spazi, `~^:?*[\` né fine con `/` o `.lock`); `checkStagingUrl(url: string): string | null` (https,
  ≤ 500, altrimenti «indirizzo di prova non valido»). PATCH `/api/apps/:id` accetta `stagingBranch`/`stagingUrl` (null = tolto); il token `agent` resta 403 (regola esistente).
  Console: nella carta delle sorgenti due campi «Branch di prova» e «Indirizzo di prova» con l'avviso «Botcave riscrive questo branch a ogni lavoro: usalo solo per l'ambiente di prova»
  e conferma alla prima impostazione.
- [ ] **Step 1:** test puri (validi, `main`, uguale al base, `botcave/x`, `a..b`, `x.lock`, url http) e di route (PATCH salva, 400 col messaggio, null toglie).
- [ ] **Step 2–4:** rosso, implementa con codegen, verde + typecheck + test console.
- [ ] **Step 5:** commit `feat(casello): branch e indirizzo di prova dell'App`.

### Task 3: Lavoro, branch unico e fila dei compiti con codice

**Files:**
- Create: `artifacts/api-server/src/lib/teams/works.ts` (+ `works.test.ts`)
- Modify: `artifacts/api-server/src/lib/code-writer/github-git.ts` (`createBranch`), `teams/lead-tools.ts` (`assignTask`), `teams/task-runner.ts` (base della sessione),
  `code-writer/node-git.ts` (`nodeGitContext`, `adoptNodePull`), `code-writer/code-tasks.ts` (`workId`), `test/fake-github.ts` (ref nuove)

**Interfaces:**
- Produces: `WORK_MESSAGES`; `workBranch(instanceId: number, n: number): string`; `getOpenWork(instanceId: number, executor?): Promise<TeamWork | null>`;
  `ensureWorkForCodeTask(instance: TeamInstanceRow): Promise<TeamWork>` (riusa il lavoro non chiuso; altrimenti legge il base dell'App (`sourceBranch` o predefinito) e la sua testa,
  crea `refs/heads/botcave/lavoro-…` con `createBranch(r, name, sha)` (`contents: write`, `force: false`; 422 «Reference already exists» con la stessa testa = ok), poi INSERT con il
  numero successivo; violazione di `team_works_one_open` → rilegge e riusa); `codeQueueBlock(instanceId: number, workId: number, tx): Promise<string | null>` (il messaggio della fila
  se nel lavoro c'è un compito con codice `queued|running|waiting_node` o `done` con PR `open`, guardando `team_tasks` per i ruoli con `code ≠ none` e `team_code_tasks.work_id`).
  `assignTask`: per un compito di un ruolo con `code ≠ none` (cloud o node) chiama `ensureWorkForCodeTask` fuori dalla transazione e `codeQueueBlock` dentro quella con la squadra bloccata;
  `{ok:false}` col messaggio. `CodeTaskSession.open` riceve `baseBranch` = branch del lavoro aperto (in `task-runner.ts`), `nodeGitContext` mette `baseBranch` = branch del lavoro,
  `upsertCodeTask` scrive `workId`, `adoptNodePull` apre la PR verso il branch del lavoro. Squadre senza lavoro aperto e righe senza `work_id`: comportamento di oggi.
- [ ] **Step 1:** test (PGlite, finto GitHub): primo compito con codice → lavoro 1 e branch creato dalla testa di `main`; secondo compito con codice mentre il primo è `running` →
  rifiutato col messaggio; compito senza codice → nessuna fila; primo `done` con PR aperta → ancora rifiutato; PR unita → ammesso e la sessione parte dalla testa nuova del lavoro;
  compito `node` con codice → pacchetto con `baseBranch` = branch del lavoro; riga vecchia senza `work_id` invariata; due `ensureWorkForCodeTask` concorrenti → un solo lavoro.
- [ ] **Step 2–4:** rosso, implementa, verde (anche i test esistenti di `code-team-flow`, `node-git`, `lead-tools`) + typecheck.
- [ ] **Step 5:** commit `feat(casello): lavoro su branch unico e compiti con codice in fila`.

### Task 4: Merge automatico sul branch del lavoro e CI obbligatoria

**Files:**
- Modify: `artifacts/api-server/src/lib/code-writer/merge.ts` (core riusabile), `code-writer/watcher.ts`, `teams/lead-tools.ts` (`ENVIRONMENT_FAILURE_PREFIXES`), test di watcher e merge

**Interfaces:**
- Produces: in `merge.ts` `mergeIntoWork(code: TeamCodeTaskRow): Promise<"merged" | "refused" | "skipped">` con gli stessi controlli di `loadContext`/`checkPull`/`classifyLivePull`
  (squadra attiva, installazione di chi ha attivato, testa invariata, base della PR = branch del lavoro, workflow e meccanismo delle migrazioni rifiutati, migrazioni esistenti
  modificate rifiutate, distruttive non `-post` rifiutate) ma: classificazione `queue` (script `-post`) = si unisce e i nomi vanno in `team_works.post_scripts`; nessun limite orario;
  stessa prenotazione `botcave_merged_at`; squash. Un rifiuto emette `bloccato` col messaggio fisso e il compito del PLAN `blocked`, una volta per testa. `mergeTeamPull` su una riga con
  `work_id` → `{ok:false}` «le PR del lavoro le unisce Botcave quando la CI è verde». La sorveglianza (`watchRow`) per una riga con `work_id`: con CI `success` notificata chiama
  `mergeIntoWork` dopo la transazione della notifica (il `pr_closed` arriva al giro dopo come oggi); con CI `none` compito `blocked` «nessuna CI sul branch: …» (aggiunto a
  `ENVIRONMENT_FAILURE_PREFIXES`) al posto dell'evento «nessuna CI configurata, pronta per la revisione».
- [ ] **Step 1:** test: CI verde → PR unita sul branch del lavoro (squash, testa controllata) e al giro dopo `pr_closed`; PR con un `-post` → unita e nome in `post_scripts`; PR che
  tocca `.github/workflows/` → `bloccato`, nessun merge; CI `none` → compito `blocked` con il messaggio, evento una volta; `unisci_pr` su una PR del lavoro → rifiuto; riga senza
  `work_id` → comportamento di oggi (test esistenti verdi).
- [ ] **Step 2–4:** rosso, implementa, verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): merge automatico sul branch del lavoro con CI obbligatoria`.

### Task 5: Chiusura del lavoro, versione di prova e voce `release`

**Files:**
- Modify: `teams/works.ts`, `teams/lead-tools.ts` (`closeWork`), `code-writer/watcher.ts`, `code-writer/github-git.ts` (`forceUpdateRef`), `actions/queue.ts` (`enqueueReleaseItem`), test

**Interfaces:**
- Produces: `closeWorkIfDone(instanceId: number): Promise<void>` (dalla sorveglianza dopo ogni `pr_closed` e da `chiudi_lavoro`): lavoro `open` con tutti i compiti con codice del PLAN
  approvato `done` con PR unita o `blocked|failed` e nessuna PR del lavoro aperta → `awaiting_release` (UPDATE condizionato a `open`); nessuna PR unita → `abandoned` ed evento
  `bloccato` «nessun compito unito nel lavoro». In `awaiting_release`: con `staging_branch` valido `forceUpdateRef(r, branch, sha)` (`PATCH /git/refs/heads/<b>` con `force: true`, 422
  ref assente → `createBranch`) ed evento `lavoro_in_prova` con l'indirizzo; poi `enqueueReleaseItem({userId: activatedBy, instanceId, workId, summary: "Porta in produzione il lavoro N di
  <squadra>", detail})` con `args_public` della §15.3 e `team_works.pending_action_id`. `chiudi_lavoro`: con un lavoro `open` lo chiude come sopra ed emette `lavoro_finito` una volta per
  lavoro; con un lavoro `awaiting_release|releasing` → `{ok:false}` «lavoro già chiuso: aspetta la decisione su Porta in produzione» senza evento; senza lavoro: comportamento di oggi.
- [ ] **Step 1:** test: ultimo compito unito → `awaiting_release`, branch di prova riscritto alla testa, evento `lavoro_in_prova`, voce `release` con i dati; `chiudi_lavoro` due volte → un
  solo `lavoro_finito`; lavoro senza PR unite → `abandoned`; `staging_branch` nullo → voce con «nessuna versione di prova configurata per l'App», nessuna scrittura forzata; branch di prova
  cambiato in `main` dopo il salvataggio (riga modificata a mano) → nessuna scrittura, stesso avviso.
- [ ] **Step 2–4:** rosso, implementa, verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): versione di prova e voce Porta in produzione a fine lavoro`.

### Task 6: Decisione della voce `release`

**Files:**
- Create: `artifacts/api-server/src/lib/teams/release.ts` (+ test)
- Modify: `actions/decide.ts` (instradamento `release`, `failInterruptedActions` che esclude `release`), `code-writer/github-git.ts` (`mergeBranches`, `createPull`, `mergeCommit`),
  `code-writer/watcher.ts` (giro delle rilasci), `teams/turn-runner.ts` (motivo `release_failed`), test

**Interfaces:**
- Produces: `RELEASE_MESSAGES`; `approveRelease(userId: number, action: PendingActionRow): Promise<DecideResult>` (controlli: squadra non chiusa, lavoro `awaiting_release`, installazione
  di chi ha attivato; poi lavoro `releasing`, voce `executing`; `mergeBranches(r, {base: workBranch, head: baseBranch})` se il base è avanzato (409 conflitto → voce `failed` «conflitto con
  <base>: …», lavoro `open`, turno `release_failed`); apre o riusa la PR lavoro → base con `createPull` (non bozza); salva `release_pr_*` e `release_ci_since`; risponde con la voce `executing`);
  `rejectRelease(action, note, tx)` dentro la transazione del rifiuto (lavoro `open`, `rejection_note`, turno `request` con la nota); `watchReleasesOnce(now)`: per ogni lavoro `releasing`
  legge CI della testa della PR di rilascio: `success` → `classifyPull` sulla PR (workflow e meccanismo delle migrazioni rifiutati, `-post` ammessi) → `mergeCommit(r, n, {sha})`
  (`merge_method: merge`) → voce `done` «lavoro N in produzione», lavoro `released`, `requestArchitectureRefresh`; `failure` → voce `failed` «CI non superata sulla PR di rilascio: …», lavoro
  `open`, turno `release_failed`; `pending` oltre 30 minuti da `release_ci_since` → `failed` «CI della PR di rilascio non conclusa entro 30 minuti», lavoro `open`. Tutti gli esiti con UPDATE
  condizionati (`releasing`, voce `executing`). `failInterruptedActions` lascia `executing` le voci `release` (le riprende la sorveglianza). Squadra chiusa: approvare → 409 «squadra chiusa», rifiutare ammesso.
- [ ] **Step 1:** test: approvazione con base fermo → PR aperta, voce `executing`; CI verde al giro → commit di merge su `main`, voce `done`, lavoro `released`; base avanzato → merge del base nel
  lavoro prima della PR; conflitto → voce `failed`, lavoro `open`, turno; CI rossa → `failed`, `open`, turno; CI ferma 30 minuti → `failed`; riavvio con voce `executing` → resta e il giro la
  conclude; rifiuto con nota → lavoro `open`, turno `request` con la nota; PR di rilascio che tocca workflow → `failed` senza merge.
- [ ] **Step 2–4:** rosso, implementa, verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): Porta in produzione con merge approvato dall'utente`.

### Task 7: Capo, prontezza e API

**Files:**
- Modify: `teams/turn-runner.ts` (prompt), `teams/lead-tools.ts` (`leggi_piano` con il lavoro), `teams/readiness.ts` (`ci_missing` anche per i ruoli cloud con codice), `routes/team-instances.ts`
  (`GET …/works`, `work` nella vista del PLAN), `lib/api-spec/openapi.yaml` e generati, test

**Interfaces:**
- Produces: prompt del capo (testo fisso nuovo in `turn-runner.ts`): lavoro su branch unico, un compito con codice alla volta, il merge lo fa Botcave con la CI verde, un compito con codice è finito
  solo con la PR unita sul branch del lavoro (mai «nessuna CI, pronta»), con un ruolo `code: read` assegnargli la revisione del branch del lavoro prima di `chiudi_lavoro`, `chiudi_lavoro` una
  volta. `leggi_piano` aggiunge `lavoro {numero, stato, branch, prUnite, compitoInFila}`. Prontezza: `ci_missing` (`error` se l'ultima riga di `team_code_tasks` dello stesso repository ha
  `ci_state = none`, `warning` «verifica che la CI giri sui branch botcave/**» se non c'è ancora una riga) per ogni ruolo con `code ≠ none`, cloud compresi (la carta oggi elenca solo i ruoli
  `node`: estenderla ai ruoli con codice). API: `GET /api/team-instances/:id/works` (ultimi 20: numero, stato, branch, testa, PR unite, voce `release`, PR di rilascio) e `work` nella risposta di
  `GET|PUT …/plan`; `TeamWork` in OpenAPI.
- [ ] **Step 1:** test di prompt (il testo c'è), di `leggi_piano`, di prontezza (cloud con codice + ultima CI `none` → errore) e di route.
- [ ] **Step 2–4:** rosso, implementa con codegen, verde + typecheck.
- [ ] **Step 5:** commit `feat(casello): il capo e la prontezza conoscono il lavoro su branch unico`.

### Task 8: Console

**Files:**
- Create: `artifacts/casello/src/components/actions/release-detail.tsx`, `artifacts/casello/src/lib/work-status.ts` (+ test)
- Modify: `artifacts/casello/src/components/teams/plan-card.tsx` (sezione «Lavoro»), `team-readiness-card.tsx`, le viste di «Da confermare» (tipo «Rilascio», `pending-action-item.tsx`,
  `action-dialog.tsx`, `components/panel/tabs/pending-tab.tsx`)

**Interfaces:**
- Produces: `workLed(status): LedState` (`open` → `work`, `awaiting_release` → `ask`, `releasing` → `work`, `released` → `ok`, `abandoned` → `idle`), `releaseLabel(kind)`; carta «Piano»: branch del
  lavoro con link, LED, PR unite, compito in fila, indirizzo di prova come link, avviso CI mancante; «Da confermare»: tipo «Rilascio» con indirizzo di prova, compiti con issue, PR unite, script `-post`
  «da applicare su Neon dopo il deploy», esito del revisore, «Porta in produzione» / «Rifiuta» (nota ≤ 500), stato `executing` «in attesa della CI della PR di rilascio».
- [ ] **Step 1:** test puri di `work-status.ts`. **Step 2–4:** rosso, implementa, verde, typecheck e build della console.
- [ ] **Step 5:** commit `feat(casello): lavoro e Porta in produzione nella console`.

### Task 9: Prova di flusso, CLAUDE.md, PR

**Files:**
- Modify: `artifacts/api-server/test/code-team-flow.test.ts` (scenario nuovo), `CLAUDE.md` («Stato», «Dove stanno le cose», «Strumenti GitHub delle squadre», «Squadre (esecuzione)»,
  elenco tabelle, «Ciclo di evoluzione automatica» per la 3c che resta da fare)

- [ ] **Step 1:** scenario §15.7: due compiti con codice in fila → rifiuto del secondo → merge automatico sul branch del lavoro → secondo compito dalla testa nuova → terzo compito con CI `none` →
  bloccato → chiusura unica → branch di prova riscritto → voce `release` → approvazione con `main` avanzato → merge del base nel lavoro → CI verde → commit di merge su `main`; seconda squadra: rifiuto
  con nota → lavoro di nuovo aperto e turno del capo con la nota.
- [ ] **Step 2:** suite completa API e console, typecheck.
- [ ] **Step 3:** CLAUDE.md allineato al codice (differenze dalla spec dichiarate).
- [ ] **Step 4:** commit `docs(casello): lavoro su branch unico in CLAUDE.md`; push del branch e PR con `gh` verso `main` (cosa cambia, prova, migrazione additiva applicata dal deploy,
  nessuna variabile nuova, dopo il deploy: impostare branch e indirizzo di prova dell'App e un workflow CI sui branch `botcave/**`). Merge solo con un sì di Ivan.
