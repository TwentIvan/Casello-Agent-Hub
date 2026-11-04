# Squadre di agenti — esecuzione: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** far lavorare le squadre: capo a turni guidati dagli eventi con PLAN strutturato da approvare, compiti dei ruoli
cloud eseguiti in Casello, eventi e bollettino, voci di piano nella coda «Da confermare», strumenti del centralino su
`/mcp` e scheda della squadra in console.

**Architecture:** `lib/teams/` cresce con PLAN (`plan.ts`), strumenti dei ruoli (`role-tools.ts`), eventi (`events.ts`),
esecuzione dei compiti (`task-runner.ts`) e dei turni (`turn-runner.ts`), tutti sul ciclo dell'agente esistente
(`agent-loop.ts`) con dipendenze iniettate; la coda esistente impara i tipi `plan`/`plan_change`; il server MCP espone gli
strumenti del centralino.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Zod, Vitest, OpenAPI + Orval, React + shadcn/ui,
`@modelcontextprotocol/sdk` (server `/mcp` esistente).

**Spec:** `docs/superpowers/specs/2026-11-04-casello-squadre-esecuzione-design.md`

## Global Constraints

- Italiano per commenti, messaggi, UI e commit (`feat(casello): …`); identificatori in inglese.
- `pnpm run typecheck` verde prima di ogni commit; codegen dopo ogni modifica a `openapi.yaml`.
- Schema: ogni modifica anche in `docs/schema-casello.sql` e in `docs/migrations/2026-11-squadre-esecuzione.sql`
  (additiva, idempotente, PRIMA del merge, nessuna colonna tolta).
- PLAN: `objective` max 2 000; `constraints`/`openPoints` max 30 da 500; `tasks` max 50 (`title` max 200,
  `instructions` max 4 000, `outcome` max 300); `manualActions` max 30 (`text` max 500).
- Limiti: turno del capo 6 giri, 90 000 ms, 40 000 token; compito 8 giri, 120 000 ms, 60 000 token; 3 compiti
  `running` per squadra; un turno `running` e al più uno `queued` per squadra; richiesta al capo max 4 000 caratteri;
  `invia_al_capo` e `POST …/messages` 10/min per utente; `detail` di un compito max 20 000; evento `bulletin` max 300,
  `detail` max 4 000.
- Messaggi fissi: «il compito non è nel piano approvato: proponi una modifica», «tetto di spesa della squadra
  raggiunto», «interrotto dal riavvio», «superata dalla modifica dell'utente».
- Le richieste dell'utente e le note di rifiuto arrivano al modello come messaggi `user`, mai nel prompt di sistema.
- Nel PLAN e negli eventi niente segreti né indirizzi delle app; argomenti `x-sensitive` oscurati nei passi.
- Validazione delle regole delle squadre (`validateRoles`) e letture dal pool sempre fuori dalle transazioni di scrittura.
- Console senza scorrimento orizzontale a 1280 px; solo hook Orval.

## Review Focus

- Due strumenti con lo stesso nome in app diverse assegnati allo stesso ruolo: il modello deve vederli con nomi
  distinti e ciascuno deve chiamare la sua app (test nel Task 4).
- Uno strumento di app con il nome di uno strumento interno (`riferisci`, `proponi_piano`, …): mai scambiato con lo
  strumento interno (test nel Task 4).
- La spesa di turni e compiti deve contare nei tetti di modello, account e utente esistenti, non solo nel tetto della
  squadra (test nel Task 4).
- Approvare una voce `plan` di una squadra chiusa nel frattempo: 409 senza turni nuovi (test nel Task 3).
- Un compito che finisce mentre il capo è in turno: il motivo si accoda e genera un solo turno successivo, non si perde
  (test nel Task 5).

---

### Task 1: Dati e migrazione

**Files:** schema Drizzle nuovi `lib/db/src/schema/team-plans.ts` (team_plans, team_plan_versions),
`team-work.ts` (team_tasks, team_task_steps, team_turns, team_turn_steps, team_events); modifiche a
`team-instances.ts`, `pending-actions.ts`, `users.ts`, indice degli schemi; `docs/schema-casello.sql`;
`docs/migrations/2026-11-squadre-esecuzione.sql`; `artifacts/api-server/test/migration-squadre-esecuzione.test.ts`
(+ fixture `schema-pre-squadre-esecuzione.sql`).

**Interfaces:**
- Produces: tabelle e colonne di spec §2 con questi enum: `team_plan_status` (`draft|proposed|approved`),
  `team_task_status` (`queued|running|waiting_node|done|blocked|failed|cancelled`), `team_turn_status`
  (`queued|running|done|failed`), `team_event_type` (i sette di spec §2), `pending_action_kind` (`action|plan|plan_change`).
  `team_task_steps`/`team_turn_steps` con le colonne di `run_steps` (posizione, tipo, tool, argomenti, ok, stato HTTP,
  durata, errore) e FK cascade. `pending_actions.tool_id`/`app_id` nullable + CHECK
  `kind <> 'action' OR (tool_id IS NOT NULL AND app_id IS NOT NULL)`. Indici: `team_tasks (instance_id, status)`,
  `team_turns (instance_id, status)`, `team_events (instance_id, created_at)`, unico parziale
  `team_turns (instance_id) WHERE status = 'queued'` e uno `WHERE status = 'running'`.

- [ ] **Step 1:** test della migrazione (fixture prima del task, script due volte): tabelle ed enum creati; righe
  esistenti di `pending_actions` con `kind = 'action'`; CHECK che rifiuta un'azione senza `tool_id`; voce `plan` senza
  tool accettata; due turni `queued` per la stessa istanza → violazione.
- [ ] **Step 2:** FAIL → script, Drizzle, `schema-casello.sql` → PASS; suite e typecheck verdi.
- [ ] **Step 3: Commit** `feat(casello): tabelle di PLAN, compiti, turni ed eventi delle squadre`

### Task 2: PLAN

**Files:** Create `artifacts/api-server/src/lib/teams/plan.ts` (+ test); modify `routes/team-instances.ts`,
`openapi.yaml` (+ codegen).

**Interfaces:**
- Produces in `plan.ts`:
  - `PlanTaskSchema`, `PlanSchema` (Zod, limiti delle Global Constraints), tipi `Plan`, `PlanTask`, `ManualAction`;
    `PlanTask.status` ∈ `planned|running|waiting_node|done|blocked|failed`.
  - `getPlan(instanceId): Promise<PlanView>` (crea `draft` vuoto se manca), `PlanView = Plan & { version; status;
    approvedVersion; updatedAt }`.
  - `writePlanVersion(instanceId, plan: Plan, status, executor?): Promise<PlanView>` — versione+1 con riga in
    `team_plan_versions`, lock della riga.
  - `isRelevantChange(before: Plan | null, after: Plan): boolean` — puro: obiettivo, vincoli, compiti aggiunti/tolti,
    `roleKey`/`instructions`/`title` cambiati di un compito; non rilevanti `openPoints`, `manualActions`, `status`/`outcome`.
  - `diffSummary(before: Plan | null, after: Plan): string` — puro, testo in italiano per la voce in coda (es. «compiti
    aggiunti: t4 Verifica SCC1; obiettivo cambiato»).
  - `nextTaskIds(plan: Plan, n: number): string[]` → `t<max+1>`…
- Route: `GET /api/team-instances/:id/plan`, `PUT …/plan` (`Plan` completo; correzione dell'utente: versione nuova
  `approved` con `approvedVersion`; rifiuta le voci `plan`/`plan_change` `pending` dell'istanza con nota «superata dalla
  modifica dell'utente»; accoda un turno con motivo `request` «Il piano è stato modificato dall'utente: <diffSummary>» —
  chiamata a `enqueueTurnReason` del Task 5: in questo task una funzione di `turn-queue.ts` vuota pronta, vedi sotto),
  `POST …/manual-actions/:actionId/done`. Istanza `closed` → 409 «squadra chiusa» sulle scritture.
  `roleKey` dei compiti deve esistere nei ruoli dell'istanza (400 «ruolo <key> inesistente»).
- Create `lib/teams/turn-queue.ts` con `enqueueTurnReason(instanceId: number, reason: TurnReason): Promise<void>` che in
  questo task inserisce/aggiorna la riga `queued` di `team_turns` (append al jsonb `reasons`, UPDATE con
  `ON CONFLICT` sull'indice parziale) e chiama un hook `onTurnQueued` sostituibile (no-op finché il Task 5 non lo collega).
  `TurnReason = { type: "request"; text: string } | { type: "task_finished"; taskId: number } | { type: "decision";
  number: number; approved: boolean; note: string | null } | { type: "activation" } | { type: "restart" }`.

- [ ] **Step 1: test** — `isRelevantChange` per ogni campo; `diffSummary` con un compito aggiunto e l'obiettivo
  cambiato; `PUT plan` crea v2 approvata, rifiuta una voce `plan` aperta con la nota, accoda un turno `queued` con
  motivo `request`; due `enqueueTurnReason` → una sola riga `queued` con due motivi; `roleKey` inesistente → 400;
  limiti (51 compiti → 400); squadra chiusa → 409; azione manuale «Fatto» → `done: true`, `doneAt`.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): PLAN delle squadre versionato`

### Task 3: Voci di piano nella coda

**Files:** Create `artifacts/api-server/src/lib/teams/plan-decisions.ts` (+ test); modify `lib/actions/decide.ts`,
`lib/actions/queue.ts`, `routes/pending-actions.ts`, `openapi.yaml` (`QueuedAction` con `kind`, `team {id, name} | null`,
`tool`/`app` nullable) + codegen.

**Interfaces:**
- Consumes: Task 2 (`getPlan`, `writePlanVersion`, `diffSummary`, `enqueueTurnReason`).
- Produces:
  - `queue.ts`: `enqueuePlanItem(input: { userId; instanceId; kind: "plan" | "plan_change"; planVersion: number;
    recipient: string; summary: string; detail: Record<string, unknown> }): Promise<EnqueueResult>` (stessa
    numerazione e limite di 50; `args_enc` = detail cifrato, `args_public` = detail; `recipient` = nome della squadra).
    `enqueueAction` accetta `teamInstanceId?: number | null`.
  - `plan-decisions.ts`: `decidePlanItem(row: PendingActionRow, approved: boolean, note: string | null):
    Promise<DecideResult>` — approvato: se `plan_version` è ancora la versione corrente `proposed` → stato `approved`,
    `approvedVersion`, voce `done`, `enqueueTurnReason({type: "decision", …})`; versione superata → voce `failed`
    «proposta superata da una versione più recente»; squadra `closed` → 409 «squadra chiusa» e voce invariata.
    Rifiutato: voce `rejected`, PLAN torna allo stato precedente (`approved` se esiste `approvedVersion`, altrimenti
    `draft`, senza nuova versione), turno con motivo `decision` e la nota.
  - `decide.ts`: `approveAction`/`rejectAction` instradano `kind <> 'action'` su `decidePlanItem` (nessun `userToken`).

- [ ] **Step 1: test** — approvazione di `plan` → PLAN `approved`, turno `queued` con `decision`; rifiuto con nota →
  turno con la nota, PLAN `draft`; versione superata → `failed`; squadra chiusa → 409, nessun turno; numerazione unica
  tra azioni e piani dello stesso utente; `GET /api/pending-actions` mostra `kind` e `team`; le azioni esistenti
  funzionano come prima.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): piani e modifiche del piano nella coda da confermare`

### Task 4: Strumenti dei ruoli e compiti degli operai

**Files:** Create `artifacts/api-server/src/lib/teams/role-tools.ts`, `events.ts`, `task-runner.ts`, `team-budget.ts`
(+ test); modify `lib/budget.ts` (spesa di turni e compiti), `src/index.ts` (avvio).

**Interfaces:**
- Consumes: `runAgentLoop`, `LoopDeps`, `DEFAULT_LIMITS` (`agent-loop.ts`); `resolveModel`, `modelChat`
  (`lib/ai/executor.ts`); `executeTool`, `loadAppConnection`, `toFunctionTools`/catalogo (`lib/tools/`);
  `enqueueAction` (con `teamInstanceId`); `userBudgetBlock`, `monthStart` (`lib/budget.ts`); Task 2/3.
- Produces:
  - `role-tools.ts`: `INTERNAL_TOOL_NAMES` (`riferisci`, `leggi_piano`, `proponi_piano`, `aggiorna_piano`,
    `assegna_compito`, `leggi_esito`, `segnala`, `chiudi_lavoro`); `loadRoleTools(toolIds: number[]):
    Promise<{ tools: CatalogTool[]; connections: Map<number, AppConnection>; nameMap: Map<string, CatalogTool> }>` —
    solo tool `active`, non L3, `kind` http/mcp; nome esposto al modello = nome del tool se unico tra i tool del ruolo e
    diverso dagli `INTERNAL_TOOL_NAMES`, altrimenti `${name}_${appId}` (troncato a 64 tenendo il suffisso).
    `internalTool(name, description, paramsSchema): CatalogTool` (sintetico, `kind` `"internal"` gestito solo dal
    runner, livello L1).
  - `events.ts`: `emitEvent(input: { instanceId; type; taskId?: number | null; bulletin: string; detail?: string }):
    Promise<TeamEventRow>` (tronca ai limiti), `listEvents(instanceId, { unread? })`, `markRead(userId, ids)`,
    `unreadBulletin(userId)` (squadre con `activated_by = userId`).
  - `team-budget.ts`: `teamSpend(instanceId, since = monthStart())`, `teamBudgetBlock(instanceId, aiModelId):
    Promise<string | null>` — tetto della squadra per primo («tetto di spesa della squadra raggiunto»), poi
    `userBudgetBlock(aiModelId)`.
  - `lib/budget.ts`: la spesa di utente, account e modello include `team_tasks.cost_usd` e `team_turns.cost_usd` (per
    `ai_model_id`), con le stesse regole dei costi null.
  - `task-runner.ts`: `TASK_LIMITS = { maxRounds: 8, maxActiveMs: 120_000, maxTokens: 60_000 }`, `MAX_RUNNING_TASKS = 3`;
    `startTask(instanceId, planTaskId): Promise<TeamTaskRow>` (crea la riga: ruolo `node` → `waiting_node`, altrimenti
    `queued`; aggiorna lo stato del compito nel PLAN; avvia lo scheduler); `pumpTasks(instanceId)` (porta a `running`
    fino a 3 compiti con UPDATE condizionato e li esegue in background); `runTask(taskId)` — prompt del ruolo + skill
    (testo delle versioni fissate e delle specializzate) + PLAN in sola lettura + istruzioni; strumenti del ruolo +
    `riferisci`; `executeTool` con la connessione dell'app del tool; L2 → `enqueueAction` con `teamInstanceId` e utente
    `activated_by`; passi in `team_task_steps` (oscurati come le run); fine: `riferisci` o ultimo messaggio o errore →
    stato/esito nel compito e nel PLAN (`aggiorna` senza nuova approvazione), `emitEvent` (`compito_finito` o
    `bloccato`), `enqueueTurnReason({type: "task_finished", taskId})`, poi `pumpTasks`. Prima di partire
    `teamBudgetBlock` → se bloccato: compito `blocked`, evento `bloccato` col messaggio, nessuna chiamata al modello.
  - `failInterruptedTeamWork(): Promise<void>` (avvio): turni e compiti `running` → `failed` («interrotto dal
    riavvio»), evento `interrotto`, `enqueueTurnReason({type: "restart"})` per le istanze `active` coinvolte.

- [ ] **Step 1: test** (`test/fake-provider.ts` per il modello, `test/fake-mcp.ts` e un server HTTP finto per gli
  strumenti) — compito che chiama uno strumento di un'app e poi `riferisci` → `done`, esito nel PLAN, evento, turno
  `queued`; due tool `leggi_wi` di app diverse → nomi distinti, ciascuno chiama la sua app; tool di app chiamato
  `riferisci` → esposto come `riferisci_<appId>`; L2 → voce `action` con `team_instance_id`; senza `riferisci` →
  `done` con l'ultimo messaggio troncato; limite di giri → `failed`; 4 compiti → 3 `running`, 1 `queued` che parte alla
  fine di uno; ruolo `node` → `waiting_node` senza chiamate; tetto della squadra raggiunto → `blocked` ed evento; la
  spesa del compito compare in `userSpend` e `modelSpends`; riavvio → `failed`, evento `interrotto`, turno `restart`;
  argomenti `x-sensitive` oscurati in `team_task_steps`.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): compiti dei ruoli cloud con strumenti di più app`

### Task 5: Turni del capo, attivazione e messaggi

**Files:** Create `artifacts/api-server/src/lib/teams/turn-runner.ts`, `lead-tools.ts` (+ test); modify
`turn-queue.ts` (collega `onTurnQueued`), `instances.ts` (`closeInstance`), `routes/team-instances.ts`,
`middlewares/rate-limit.ts`, `openapi.yaml` (+ codegen), `src/index.ts`.

**Interfaces:**
- Consumes: Task 2, 3, 4.
- Produces:
  - `turn-runner.ts`: `LEAD_LIMITS = { maxRounds: 6, maxActiveMs: 90_000, maxTokens: 40_000 }`; `pumpTurn(instanceId)` —
    se nessun turno `running`, porta il `queued` a `running` (UPDATE condizionato) e lo esegue in background; alla fine
    `done`/`failed` e di nuovo `pumpTurn`. `runTurn(turnId)` — prompt di sistema = ruolo capo + istruzioni d'uso degli
    strumenti; messaggi `user` = PLAN corrente (JSON compatto) + motivi (testo delle richieste e note come messaggi
    `user` separati; per `task_finished` l'esito breve). Strumenti = quelli del ruolo capo + `lead-tools`. Budget come i
    compiti (blocco → turno `failed`, evento `bloccato`). Passi in `team_turn_steps`. `last_turn_at` aggiornato.
  - `lead-tools.ts`: implementazione degli strumenti di spec §4 sopra `plan.ts`, `queue.ts` (`enqueuePlanItem`),
    `task-runner.ts` (`startTask`), `events.ts`. `proponi_piano` senza versione approvata → voce `plan`; con versione
    approvata e `isRelevantChange` → voce `plan_change` con `diffSummary`; non rilevante → scrive senza voce.
    `assegna_compito` fuori piano approvato o compito in stato non assegnabile → errore al modello col messaggio fisso.
  - `activateInstance(userId, id)` (`draft`→`active`, `activated_by`, PLAN `draft` se manca, turno `activation`);
    `sendToLead(userId, id, text)` (turno `request`); `closeInstance` esteso: compiti `queued` → `cancelled`, voci
    `plan`/`plan_change` `pending` → `rejected` con nota «squadra chiusa», nessun nuovo turno (i turni `queued` →
    `failed`).
  - Route: `POST /api/team-instances/:id/activate`, `POST …/messages` (`{ text }` max 4 000, `teamMessageRateLimit`
    10/min per utente), `PUT …/budget` (`{ monthlyBudgetUsd: number | null }`), `GET …/tasks`, `GET …/tasks/:taskId`
    (con i passi), `GET …/turns` (con i passi), `GET …/events`; `GET /api/team-events?unread=true`,
    `POST /api/team-events/read` (`{ ids }`); `InstanceView` aggiunge `activatedBy`, `monthlyBudgetUsd`, `lastTurnAt`.

- [ ] **Step 1: test** (modello finto che recita il capo) — attivazione → turno → `proponi_piano` → voce `plan`, evento
  `piano_proposto`; approvazione (Task 3) → turno → `assegna_compito` → compito che riferisce → turno successivo che
  legge l'esito; rifiuto con nota → il turno riceve la nota come messaggio `user`; `assegna_compito` fuori piano →
  messaggio fisso al modello; `proponi_piano` dopo l'approvazione con un compito nuovo → voce `plan_change`, solo punti
  aperti → nessuna voce; un compito che finisce durante un turno → un solo turno `queued` successivo che parte dopo;
  chiusura → compiti `queued` annullati, voci di piano rifiutate, nessun turno; 11ª richiesta nel minuto → 429; turno
  con tetto della squadra raggiunto → `failed`, evento `bloccato`.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): turni del capo, attivazione e messaggi alla squadra`

### Task 6: Centralino

**Files:** modify `artifacts/api-server/src/lib/mcp/server.ts` (+ test), `routes/account-model.ts` (o nuovo
`routes/centralino.ts`), `openapi.yaml` (+ codegen).

**Interfaces:**
- Consumes: Task 3 (decisioni), 4 (`unreadBulletin`, `markRead`), 5 (`sendToLead`); `approveAction`/`rejectAction`.
- Produces: strumenti MCP `squadre_stato`, `bollettino`, `squadra_dettaglio`, `invia_al_capo`, `coda_da_confermare`,
  `approva`, `rifiuta` (parametri e comportamento di spec §7; solo squadre e voci dell'utente del token; `invia_al_capo`
  con lo stesso limite di 10/min). `squadre_stato`: con più di 5 squadre `active`, riassunto in massimo 5 righe col
  modello del centralino (`users.centralino_ai_model_id`, altrimenti `default_ai_model_id`); senza modello o con errore,
  elenco completo. `GET|PUT /api/account/centralino-model` (`sessionOnly`; modello dei propri account; 400 «modello non
  disponibile»).

- [ ] **Step 1: test** — ogni strumento con un token `mcp`: dati solo dell'utente; `bollettino` restituisce e segna
  letti; `approva` di una voce `plan` e di una voce `action`; `rifiuta` con nota; `invia_al_capo` accoda un turno;
  `squadre_stato` con 6 squadre usa il modello finto e con il modello in errore restituisce l'elenco; route del modello
  del centralino (proprio → ok, altrui → 400, con token → 403).
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): strumenti del centralino su /mcp e modello del centralino`

### Task 7: Console

**Files:** modify `artifacts/casello/src/pages/team-detail.tsx`, `components/teams/` (nuovi: `plan-card.tsx`,
`plan-approval-card.tsx`, `team-activity.tsx`, `team-bulletin.tsx`, `lead-message.tsx`, `team-budget.tsx`),
`pages/pending-actions.tsx` e `components/actions/`, `pages/account.tsx` (modello del centralino), menu.

- [ ] **Step 1:** come spec §8: sezioni «Piano» (obiettivo, vincoli, compiti con stato ed esito, azioni manuali con
  «Fatto», punti aperti, «Modifica» → editor del PLAN che salva con `PUT …/plan`), riquadro «Piano da approvare» (voce
  `plan`/`plan_change` pendente della squadra con sintesi e Approva / Rifiuta con nota, usando gli hook della coda),
  «Attività» (turni e compiti con stato, costo e passi espandibili; polling ogni 5 s mentre c'è un turno o un compito
  `running`), «Bollettino» (eventi, «Segna come letti»), «Scrivi al capo» (max 4 000), «Attiva» (squadre `draft`),
  tetto di spesa; «Da confermare» mostra tipo e squadra (voci senza strumento: niente campo token); Account: scelta del
  modello del centralino. Testi in italiano, errori dell'API come arrivano.
- [ ] **Step 2:** typecheck e build verdi.
- [ ] **Step 3: Commit** `feat(casello): esecuzione delle squadre nella console`
  (la prova nel browser la fa il controller con un modello finto: attivazione, piano proposto, approvazione, compito
  che riferisce, bollettino, a 1280 px.)

### Task 8: Documentazione

**Files:** `CLAUDE.md`.

- [ ] **Step 1:** sezione «Squadre (esecuzione)» dopo «Squadre (definizione)»: capo a turni, PLAN e approvazioni,
  coda con i tipi, compiti e limiti, eventi e bollettino, centralino su `/mcp` e modello del centralino, costi e tetti,
  avvio e riavvio, route, migrazione (PRIMA del merge), cosa resta al sottoprogetto 4; aggiornare «Stato», «Dove
  stanno le cose» (file di `lib/teams/`, route, tabelle) ed «Esecutore locale» (nuovi strumenti di `/mcp`). Ogni
  percorso, limite e messaggio verificato sul codice.
- [ ] **Step 2: Commit** `docs(casello): esecuzione delle squadre nel CLAUDE.md`
