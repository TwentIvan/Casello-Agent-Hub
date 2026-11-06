# Alfred e Lucius nelle aree · piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alfred (anche scritto) e Lucius richiamabili con un pulsante nelle aree della console, con contesto della pagina,
schede da accettare, passaggio di consegne, modello e tetto di spesa per personaggio.

**Architecture:** Un motore unico per le conversazioni nuove (`lib/characters/`: tabelle `character_*`, registro degli
argomenti, turno sopra `runPlanTurn`, schede); chat del piano e chat di squadra restano sui loro backend e la console le
mostra con lo stesso componente `CharacterChat` attraverso adattatori. Budget per personaggio in `lib/budget.ts`.

**Tech Stack:** Express 5, Drizzle, Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React + Vite + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-06-botcave-personaggi-design.md` (leggerla prima di ogni compito: i numeri §
qui sotto rimandano a lei).

## Global Constraints

- Italiano per commenti, documentazione, messaggi di commit (`feat(casello): …`) e testi; codice e identificatori in inglese.
- Testi visibili: «Botcave», mai «Casello»; nessun riferimento a Batman; pulsanti che dicono cosa fanno, niente punti
  esclamativi, numeri precisi.
- Colori solo dai token (`bg-surface-1`, `text-ink-muted`, `text-accent-text`, `bg-brand`…): nessun esadecimale né classi di
  palette Tailwind; stati con `Led`, non badge colorati; niente ombre.
- Niente scorrimento orizzontale a 1280 px; pannello a schermo intero sotto `sm`, ~440 px sopra.
- Contratto prima: ogni route nuova in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen`, file
  generati committati; nella console solo hook Orval, mai fetch a mano.
- Body, parametri e query con `parseRequest`; risposte con `*Response.parse`; errori `{error}` in italiano, mai testo del DB
  o del provider.
- Schema DB: ogni modifica in `lib/db/src/schema/`, in `docs/schema-casello.sql` e nella migrazione additiva e idempotente
  `docs/migrations/2026-11-personaggi.sql` (niente `-post`).
- Nei log solo id e conteggi, mai contenuti dei messaggi, token o chiavi.
- Limiti: turno 6 giri / 40 000 token / 120 s (`PLAN_TURN_LIMITS`); messaggio ≤ 8 000; contesto ~30 000 token; 10
  messaggi/min per utente e personaggio; ≤ 10 schede per turno; motivazione ≤ 1 000; nota di rifiuto ≤ 500; domanda di
  `passa_a` ≤ 2 000; decisioni 20/min (`consumeActionDecision`).
- `pnpm run typecheck` verde prima di ogni commit.

## Review Focus

- Oggetto modificato nell'editor della pagina (non salvato) mentre si accetta una scheda di Lucius: l'utente deve essere
  avvisato prima di perdere le modifiche (Task 12).
- Voce della coda decisa altrove (pagina Da confermare o Alfred a voce) dopo che Alfred ha proposto la scheda: il clic non
  deve decidere una seconda volta né una voce diversa → `stale` (Task 7, test `decision_stale_when_decided_elsewhere`).
- Due schede aperte del browser che chiedono il filo di Alfred insieme: deve esistere un solo filo aperto (Task 5, test
  `alfred_thread_concurrent_get`).
- Oggetto eliminato mentre un turno è in corso: gli strumenti rispondono `ok: false` e il turno chiude normalmente (Task 6,
  test `tool_on_deleted_subject`).
- Passaggio di consegne verso un oggetto che l'utente non può vedere o che non esiste: nessuna scheda creata, lo strumento
  risponde `ok: false` (Task 4, test `handoff_rejects_unknown_subject`).

---

## Mappa dei file

API (`artifacts/api-server/src/`):
- `lib/characters/types.ts` — tipi `Character`, `SubjectType`, `PageContext`, `ProposalKind`, `SubjectHandler`, `TurnContext`, `CHARACTER_MESSAGES`, `CharacterError`
- `lib/characters/registry.ts` — `getSubject(type)`, `subjectsOf(character)`
- `lib/characters/instructions.ts` — istruzioni di sistema dei due personaggi
- `lib/characters/conversations.ts` — creazione/lettura/eliminazione delle conversazioni, filo di Alfred
- `lib/characters/run-turn.ts` — `startCharacterTurn`, `executeCharacterTurn`, `failInterruptedCharacterTurns`
- `lib/characters/proposals.ts` — `recordProposal`, `decideCharacterProposal`, `toProposalView`
- `lib/characters/handoff.ts` — strumento `passa_a`
- `lib/characters/subjects/alfred-thread.ts`, `agent.ts`, `skill.ts`, `team-template.ts`, `areas.ts`
- `lib/characters/settings.ts` — modelli e tetti per personaggio
- `lib/budget.ts` — spesa e blocco per personaggio
- `routes/characters.ts`, `routes/account-characters.ts`
- `middlewares/rate-limit.ts` — `consumeCharacterMessage`

Console (`artifacts/casello/src/`):
- `components/characters/character-chat.tsx`, `character-sheet.tsx`, `character-button.tsx`, `proposal-cards.tsx`, `adapters.ts`, `handoff-context.tsx`
- `components/account/characters-section.tsx` (sostituisce `alfred-section.tsx`)
- pagine della mappa (§3.2) per i pulsanti

---

### Task 1: Migrazione e schema

**Files:**
- Create: `docs/migrations/2026-11-personaggi.sql`, `lib/db/src/schema/characters.ts`, `artifacts/api-server/test/migration-personaggi.test.ts`
- Modify: `lib/db/src/schema/index.ts`, `lib/db/src/schema/users.ts`, `lib/db/src/schema/character-memory.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces: `characterConversationsTable`, `characterMessagesTable`, `characterProposalsTable` e i tipi `CharacterConversation`,
  `CharacterMessage`, `CharacterProposal`; colonne `usersTable.alfredChatAiModelId`, `luciusAiModelId`,
  `alfredMonthlyBudgetUsd`, `luciusMonthlyBudgetUsd`; valore `character_chat` in `characterHistoryKindEnum`.

- [ ] **Step 1: Test della migrazione** (`migration-personaggi.test.ts`, stessa struttura di `migration-lucius-squadra.test.ts`:
  schema di produzione + migrazioni 2026-11 fino a `lucius-squadra`, poi `personaggi` due volte). Asserzioni:
  `migration_is_idempotent` (seconda applicazione senza errori); `alfred_thread_unique_open` (due INSERT `alfred_thread` aperte
  dello stesso utente → la seconda viola l'indice; una con `archived_at` passa); `subject_type_check` (`subject_type = 'boh'`
  → errore); `proposal_kind_check` (kind fuori elenco → errore); `history_kind_has_character_chat` (INSERT in
  `character_history` con `kind = 'character_chat'` passa); `users_columns` (le quattro colonne esistono e sono null).
- [ ] **Step 2:** `pnpm --filter @workspace/api-server run test -- test/migration-personaggi.test.ts` → FAIL (file mancante).
- [ ] **Step 3: Scrivere migrazione e schema** come in spec §4.1. CHECK su `subject_type` ∈ (`alfred_thread`, `agent`,
  `skill`, `team_template`, `area_agents`, `area_skills`, `area_team_templates`); CHECK su `kind` ∈ (`agent_prompt`,
  `agent_tools`, `skill_content`, `template_roles`, `agent_create`, `skill_create`, `template_create`, `decision`,
  `handoff`); `character` usa l'enum `character` esistente; `turn_status` usa `plan_turn_status`, `status` usa
  `plan_proposal_status`; `ALTER TYPE character_history_kind ADD VALUE IF NOT EXISTS 'character_chat'` in testa allo script
  (fuori da transazioni esplicite); indice unico parziale `character_conversations_alfred_open_uniq` su (`user_id`) WHERE
  `subject_type = 'alfred_thread' AND archived_at IS NULL`. Riportare tutto in `docs/schema-casello.sql`.
- [ ] **Step 4:** test della migrazione → PASS; `pnpm --filter @workspace/api-server run test` → PASS (lo schema dei test
  carica `schema-casello.sql`); `pnpm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(casello): tabelle delle conversazioni dei personaggi e tetti per personaggio`.

### Task 2: Spesa e tetti per personaggio

**Files:**
- Modify: `artifacts/api-server/src/lib/budget.ts`
- Create: `artifacts/api-server/src/lib/characters/settings.ts`, `artifacts/api-server/src/lib/budget-characters.test.ts` (accanto a `budget-alfred.test.ts` e `budget-lucius.test.ts`)

**Interfaces:**
- Produces:
  - `characterSpend(userId: number, character: Character, since?: Date): Promise<Spend>`
  - `characterBudgetBlock(userId: number, character: Character, aiModelId: number | null): Promise<string | null>` — ordine:
    personaggio, poi `userBudgetBlock(aiModelId)` (modello, account, utente).
  - `getCharacterSettings(userId): Promise<{alfredChatAiModelId, luciusAiModelId, alfredMonthlyBudgetUsd, luciusMonthlyBudgetUsd}>`
    (numeri o null), `setCharacterSettings(userId, patch)` (modello non dei propri account → `CharacterError(400, "modello non disponibile")`),
    `characterModelFor(userId, character): Promise<number | null>` (modello del personaggio se ancora proprio, altrimenti
    `getDefaultModel`, altrimenti null).
  - `spendsBy` include anche `character_conversations` (mese di `updated_at`, costo cumulativo).

- [ ] **Step 1: Test** in `budget-characters.test.ts`:
  `character_spend_alfred_sources` (sessione Alfred 0,10 + conversazione `alfred` 0,20 + voce di storico di Alfred 0,05 →
  0,35; una conversazione `lucius` non conta); `character_spend_lucius_sources` (piano 0,10 + chat di squadra 0,20 +
  conversazione `lucius` 0,30 + storico di Lucius 0,05 → 0,65; un'analisi non conta);
  `character_block_message` (tetto Lucius 0,50 con spesa 0,65 → «Tetto di spesa mensile di Lucius raggiunto: spesi 0,65 su
  0,50 USD. Alzalo nella pagina Account o attendi il mese prossimo.»); `character_block_order` (tetto personaggio e tetto
  utente entrambi raggiunti → messaggio del personaggio); `character_conversations_in_user_spend` (conversazione nuova con
  modello dell'utente conta in `userSpend`); `model_for_falls_back_to_default` (modello del personaggio di un account
  eliminato → modello predefinito).
- [ ] **Step 2:** `pnpm --filter @workspace/api-server run test -- src/lib/budget-characters.test.ts` → FAIL.
- [ ] **Step 3: Implementare** in `budget.ts` e `settings.ts`. Formato dei numeri e frase finale come i messaggi di
  `userBudgetBlock` (`usd()`, `RAISE_IN_ACCOUNT`); nome nel messaggio «Alfred» o «Lucius».
- [ ] **Step 4:** test → PASS; tutti i test di `lib/budget*` → PASS.
- [ ] **Step 5: Commit** `feat(casello): spesa e tetti di Alfred e Lucius`.

### Task 3: Account → modelli e tetti dei personaggi (API)

**Files:**
- Modify: `lib/api-spec/openapi.yaml`, generati di `lib/api-client-react` e `lib/api-zod`, `artifacts/api-server/src/routes/index.ts`
- Create: `artifacts/api-server/src/routes/account-characters.ts`, `artifacts/api-server/src/routes/account-characters.test.ts`

**Interfaces:**
- Consumes: `getCharacterSettings`, `setCharacterSettings` (Task 2).
- Produces: `GET|PUT /api/account/characters` (`operationId` `getCharacterSettings` / `updateCharacterSettings`, schema
  `CharacterSettings` con i quattro campi nullable; tetti ≥ 0), solo con il login (`sessionOnly`).

- [ ] **Step 1: Test** (supertest come le altre route): `get_returns_nulls`; `put_saves_and_reads_back`;
  `put_foreign_model_400` («modello non disponibile»); `put_negative_budget_400`; `token_forbidden_403` («operazione
  disponibile solo con il login»).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** contratto, codegen, route.
- [ ] **Step 4:** test → PASS; typecheck → PASS.
- [ ] **Step 5: Commit** `feat(casello): modelli e tetti dei personaggi in Account (API)`.

### Task 4: Registro, conversazioni, turno e passaggio di consegne

**Files:**
- Create: `artifacts/api-server/src/lib/characters/types.ts`, `registry.ts`, `instructions.ts`, `conversations.ts`,
  `run-turn.ts`, `handoff.ts`, `proposals.ts` (solo `recordProposal` e `toProposalView` in questo compito), test
  `run-turn.test.ts`, `handoff.test.ts`
- Modify: `artifacts/api-server/src/middlewares/rate-limit.ts`, `artifacts/api-server/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  type Character = "alfred" | "lucius";
  type SubjectType = "alfred_thread" | "agent" | "skill" | "team_template" | "area_agents" | "area_skills" | "area_team_templates";
  type PageContext = { page: string; id?: string };
  interface TurnContext { userId: number; conversationId: number; messageId: number; subjectId: string | null; proposalsLeft: () => number; }
  interface SubjectHandler {
    character: Character; type: SubjectType;
    resolve(userId: number, subjectId: string | null): Promise<{ title: string } | null>;
    context(userId: number, subjectId: string | null, page: PageContext | null): Promise<string[]>;
    tools: ChatCompletionFunctionTool[];
    runTool(call: ChatToolCall, ctx: TurnContext): Promise<string>;
  }
  getSubject(type: SubjectType): SubjectHandler; subjectsOf(character: Character): SubjectHandler[];
  createConversation(userId, character, subjectType, subjectId): Promise<CharacterConversation>; // CharacterError 404 se resolve → null
  startCharacterTurn(conversationId: number, content: string, page: PageContext | null): Promise<CharacterMessage>; // TurnBusyError
  failInterruptedCharacterTurns(): Promise<number>;
  recordProposal(ctx: TurnContext, kind: ProposalKind, payload: unknown, rationale: string, targetHash: string | null): Promise<{ id: number } | { error: string }>;
  HANDOFF_TOOL: ChatCompletionFunctionTool; runHandoff(character: Character, args: unknown, ctx: TurnContext): Promise<string>;
  consumeCharacterMessage(userId: number, character: Character): boolean; // 10/min, contatori separati
  CHARACTER_MESSAGES = { notFound: "conversazione non trovata", subjectGone: "argomento eliminato", busy: "il personaggio sta già rispondendo", empty: "messaggio vuoto", tooMany: "Troppe richieste: riprova tra poco", tooManyProposals: "troppe schede in questo turno", noModel: "Scegli un modello per la conversazione." }
  ```
- `passa_a {argomento, oggetto?, domanda}`: `argomento` ∈ argomenti dell'altro personaggio più, per Lucius come destinatario,
  `plan` (oggetto = id app) e `team` (oggetto = id squadra); verifica con `resolve` (per `plan`/`team`: app o squadra
  esistenti); payload della scheda `handoff` `{to, subjectType, subjectId, question}`.

- [ ] **Step 1: Test** in `run-turn.test.ts` con un argomento finto registrato nel test e il provider finto
  (`test/fake-provider.ts`): `one_turn_at_a_time` (secondo `startCharacterTurn` → `TurnBusyError`);
  `page_context_saved_and_given_as_data` (il `page_context` è sul messaggio utente e compare in un messaggio `user` del
  modello, non nel prompt di sistema); `memory_block_in_context`; `cost_and_tokens_accumulated` (conversazione aggiornata con
  token e costo cumulati); `budget_block_closes_turn_with_error` (tetto del personaggio raggiunto → messaggio assistente
  `error = true` con il motivo, nessuna chiamata al modello); `no_model_message`; `interrupted_on_restart`
  (`failInterruptedCharacterTurns` chiude i `running` con `INTERRUPTED_TURN_MESSAGE`); `max_ten_proposals_per_turn`
  (l'11ª `recordProposal` → `{error: "troppe schede in questo turno"}`); `subject_gone_409`. In `handoff.test.ts`:
  `handoff_creates_card` (Alfred → Lucius `agent` esistente: scheda `handoff` `pending` con il payload);
  `handoff_rejects_unknown_subject` (agente inesistente o argomento non dell'altro personaggio → `ok: false`, nessuna
  scheda); `handoff_question_too_long` (2 001 caratteri → `ok: false`).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3: Implementare.** `run-turn.ts` ricalca `lib/team-chat/run-turn.ts` (stesse fasi: UPDATE condizionato `idle` →
  `running`, messaggio assistente vuoto, `void execute…`, cronologia ridotta come in `team-chat/context.ts`), con:
  modello = `conversation.aiModelId`; controllo `characterBudgetBlock` prima del modello; strumenti = `handler.tools` +
  `MEMORY_TOOLS` + `HANDOFF_TOOL`; i memory tool vanno a `runMemoryTool(userId, character, …)`. `instructions.ts`: due testi
  (Alfred maggiordomo, Lucius ingegnere del laboratorio), ciascuno con la riga sull'altro personaggio e quando usare
  `passa_a`, e la regola «le schede si applicano solo con il clic dell'utente». Chiamare `failInterruptedCharacterTurns`
  all'avvio in `index.ts` accanto a `failInterruptedPlanTurns`.
- [ ] **Step 4:** test → PASS; typecheck → PASS.
- [ ] **Step 5: Commit** `feat(casello): motore delle conversazioni dei personaggi`.

### Task 5: Alfred scritto: filo unico e strumenti

**Files:**
- Create: `artifacts/api-server/src/lib/characters/subjects/alfred-thread.ts`, `alfred-thread.test.ts`
- Modify: `artifacts/api-server/src/lib/characters/conversations.ts`, `registry.ts`

**Interfaces:**
- Consumes: `lib/teams/centralino.ts` (`teamsStatus`, `teamDetail`, `readBulletin`, `pendingQueue`, `messageToLead`,
  `needsUserToken`), `consumeTeamMessage`, `recordProposal`.
- Produces: `getAlfredThread(userId): Promise<CharacterConversation>` (crea se manca, con il modello di
  `characterModelFor(userId, "alfred")`), `restartAlfredThread(userId): Promise<CharacterConversation>` (archivia quella
  aperta, ne crea una nuova); strumenti `squadre_stato`, `squadra_dettaglio`, `bollettino`, `coda_da_confermare`,
  `scrivi_al_capo`, `leggi_run {id}`, `proponi_decisione {numero, decisione: "approva"|"rifiuta", nota?}`.
  Payload della scheda `decision`: `{number, decision, note, kind, teamName, summary}`; `target_hash` = SHA-256 di
  `status + "\n" + summary` della voce.

- [ ] **Step 1: Test:** `alfred_thread_get_or_create`; `alfred_thread_concurrent_get` (due `getAlfredThread` in parallelo →
  stesso id, nessun errore: su violazione dell'indice unico si rilegge); `restart_archives_old`;
  `context_lists_teams_and_counts` (squadre attive una riga ciascuna, conteggi della coda e del bollettino; pagina `team` con
  id → riga «Pagina: squadra <nome>»); `leggi_run_own_only` (run di un altro utente → `ok: false` «run non trovata»; errore e
  argomenti oscurati come in `run_steps`); `proponi_decisione_records_card` (voce `pending` → scheda con sintesi e hash);
  `proponi_decisione_needs_user_token` (scheda creata con `needsUserToken: true` nel payload); `nota_only_with_reject`
  (nota con `approva` → `ok: false`); `scrivi_al_capo_rate_limit` (11° messaggio nel minuto → «Troppe richieste: riprova
  tra poco»).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3: Implementare.** Nessun `prepara_decisione` / `conferma_decisione`. Contesto e risultati senza segreti né
  indirizzi delle app.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(casello): Alfred scritto con il filo unico`.

### Task 6: Argomenti di Lucius

**Files:**
- Create: `artifacts/api-server/src/lib/characters/subjects/agent.ts`, `skill.ts`, `team-template.ts`, `areas.ts` e i test
  `subjects.test.ts`
- Modify: `registry.ts`

**Interfaces:**
- Consumes: `maskSchema` (`lib/team-chat/tools.ts`), `getSkill`, `listSkills`, `listSkillVersions`, `getSkillVersion`,
  `getTemplate`, `listTemplates`, `describeRoles`, `recordProposal`.
- Produces, per argomento (spec §4.4): strumenti di lettura e di proposta. Funzione d'impronta esportata per Task 7:
  `subjectHash(type: SubjectType, subjectId: string): Promise<string | null>` (null = oggetto sparito):
  - `agent`: SHA-256 di JSON `{systemPrompt, toolIds ordinati}`;
  - `skill`: SHA-256 di JSON `{currentVersion}`;
  - `team_template`: SHA-256 di JSON `{version}`.
  Payload delle schede come in spec §5.1.

- [ ] **Step 1: Test:** `agent_context_no_urls_no_secrets` (il contesto non contiene `base_url`, `internal_base_url`, segreti);
  `leggi_strumenti_app_masks_sensitive`; `agent_tools_only_area_role` (`proponi_strumenti_agente` sull'agente `general` →
  `ok: false` «l'agente generale usa tutti gli strumenti attivi dell'app»); `skill_content_validated_at_proposal`
  (contenuto vuoto → `ok: false` con il messaggio di `validateSkillContent`); `template_roles_shape_checked` (ruoli non validi
  per lo schema del manifesto → `ok: false`); `area_lists` (le tre aree elencano gli oggetti con ricerca `q`);
  `tool_on_deleted_subject` (agente eliminato durante il turno → strumenti `ok: false` «argomento eliminato», il turno
  chiude con risposta normale); `hash_changes_on_edit` (`subjectHash` cambia dopo `PATCH` del prompt, nuova versione della
  skill, nuova versione del modello).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3: Implementare.** La validazione completa (`validateRoles`, nomi usati) avviene all'accettazione (Task 7): alla
  proposta solo forma e limiti di lunghezza.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(casello): Lucius su agenti, skill e modelli di squadra`.

### Task 7: Decisione sulle schede

**Files:**
- Modify: `artifacts/api-server/src/lib/characters/proposals.ts`, `artifacts/api-server/src/routes/agents.ts`
- Create: `artifacts/api-server/src/lib/characters/proposals.test.ts`, `artifacts/api-server/src/lib/agents.ts`

**Interfaces:**
- Consumes: `subjectHash` (Task 6), `updateSkill`, `createSkill`, `saveTemplate`, `createTemplate`, la logica di
  `PATCH /agents/:id` e `PUT /agents/:id/tools` (estrarla nel nuovo `artifacts/api-server/src/lib/agents.ts`: `updateAgentPrompt(agentId, systemPrompt, executor)` e
  `setAgentTools(agentId, toolIds, executor)`, con le stesse regole e messaggi della route, che poi le usa),
  creazione agente come `POST /agents` con `resolveAgentModel`, `approveAction`, `rejectAction`, `consumeActionDecision`.
- Produces: `decideCharacterProposal(userId: number, proposalId: number, decision: "accept" | "reject"): Promise<ProposalView>`;
  errori `CharacterError` con stato: già decisa 409 «scheda già decisa»; cambiata 409 «l'oggetto è cambiato: chiedi a Lucius
  una proposta aggiornata» (Lucius) o «la voce è cambiata: ricarica la coda» (Alfred); limite 429; errori di regola con il loro
  stato e messaggio. `handoff`: accept la marca `accepted` senza effetti (la console apre l'altro personaggio).

- [ ] **Step 1: Test:** uno per tipo che applica e marca `accepted` (`accept_agent_prompt`, `accept_agent_tools`,
  `accept_skill_content_new_version`, `accept_template_roles_new_version`, `accept_agent_create_draft`,
  `accept_skill_create`, `accept_template_create`); `stale_when_hash_changed` (scheda `stale`, 409); `rule_error_keeps_pending`
  (ruoli senza capo → 400 «una squadra ha esattamente un capo», scheda `pending`); `concurrent_accept_one_wins` (due accept in
  parallelo → uno 200, l'altro 409 «scheda già decisa», una sola versione nuova); `reject_has_no_effect`;
  `decision_approve` e `decision_reject_with_note` (voce decisa, scheda `accepted`);
  `decision_stale_when_decided_elsewhere` (voce rifiutata dalla coda dopo la proposta → `stale`, 409, nessuna seconda
  decisione); `decision_user_token_refused` (approvare una voce `needsUserToken` → 409 «questa voce si approva dalla pagina
  Da confermare»); `decision_rate_limited` (21ª decisione nel minuto → 429); `foreign_proposal_404`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3: Implementare.** Accept in una transazione: riga della scheda `FOR UPDATE` (`pending` altrimenti 409), riga
  dell'oggetto `FOR UPDATE`, ricalcolo dell'impronta con `tx`, applicazione con `tx`, scheda `accepted`. Validazioni dal pool
  prima della transazione. Per `decision` l'impronta si ricontrolla leggendo la voce, poi `approveAction`/`rejectAction`
  (che hanno le loro transazioni), poi la scheda `accepted`.
- [ ] **Step 4:** test → PASS; test esistenti degli agenti → PASS.
- [ ] **Step 5: Commit** `feat(casello): decisione sulle schede dei personaggi`.

### Task 8: Route delle conversazioni

**Files:**
- Modify: `lib/api-spec/openapi.yaml` + generati, `artifacts/api-server/src/routes/index.ts`
- Create: `artifacts/api-server/src/routes/characters.ts`, `artifacts/api-server/src/routes/characters.test.ts`

**Interfaces:**
- Consumes: Task 4, 5, 7.
- Produces (spec §8, tag OpenAPI `characters`): `GET /characters/alfred/thread` (`getAlfredThread`), `POST
  /characters/alfred/thread/restart` (`restartAlfredThread`), `GET|POST /character-conversations`
  (`listCharacterConversations` con `character`, `subjectType`, `subjectId`; `createCharacterConversation`), `GET|PATCH|DELETE
  /character-conversations/{id}` (`getCharacterConversation` con messaggi e schede, `updateCharacterConversation` con
  `aiModelId`/`title`, `deleteCharacterConversation`), `POST /character-conversations/{id}/messages`
  (`sendCharacterMessage`, `{content, pageContext?}`, 202), `POST /character-proposals/{id}/decision`
  (`decideCharacterProposal`). Schemi `CharacterConversation` (con `subjectTitle`, `subjectGone`, `costUsd`, `turnStatus`),
  `CharacterMessage`, `CharacterProposal` (`kind`, `payload`, `rationale`, `status`).

- [ ] **Step 1: Test:** `create_and_list`; `foreign_conversation_404`; `send_empty_400`; `send_too_long_400` (8 001
  caratteri); `send_rate_limited_429`; `send_busy_409`; `subject_gone_409`; `patch_foreign_model_400`; `token_scopes`
  (token `api:read`: GET 200, POST 403; `api:write`: decisione ammessa).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** contratto, codegen, route (ricalcano `routes/team-chat.ts`).
- [ ] **Step 4:** test → PASS; typecheck → PASS.
- [ ] **Step 5: Commit** `feat(casello): route delle conversazioni dei personaggi`.

### Task 9: Tetti dei personaggi nei percorsi esistenti e riassunti

**Files:**
- Modify: `lib/memory/summaries.ts`, `lib/memory/types.ts` (o dove sta il tipo dello storico), `routes/alfred.ts` (o
  `lib/alfred/sessions.ts`), `lib/plan-chat/run-turn.ts`, `lib/team-chat/run-turn.ts`, `routes/plan-chat.ts`,
  `routes/team-chat.ts`
- Test: `lib/memory/summaries.test.ts`, test esistenti di Alfred, chat del piano e chat di squadra

**Interfaces:**
- Consumes: `characterBudgetBlock`, `characterModelFor` (Task 2).

- [ ] **Step 1: Test:** `summarizes_character_conversations` (conversazione `lucius` ferma da 30 min → voce di storico
  `character_chat` di Lucius; archiviata di Alfred → voce di Alfred); `summary_skipped_on_character_cap` (tetto di Lucius
  raggiunto → nessun riassunto, `summarized_at` scritto); `alfred_session_blocked_by_character_cap` (409 «Tetto di spesa
  mensile di Alfred raggiunto…» prima del controllo del modello); `plan_turn_blocked_by_lucius_cap` e
  `team_chat_turn_blocked_by_lucius_cap` (turno chiuso con messaggio d'errore dell'assistente, come per gli altri tetti);
  `new_plan_conversation_uses_lucius_model` e `new_team_chat_conversation_uses_lucius_model` (senza modello nel body si usa
  `characterModelFor(userId, "lucius")`).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3: Implementare** sostituendo nei tre percorsi il controllo `userBudgetBlock` con `characterBudgetBlock`
  (stesso punto, stesso trattamento dell'errore) e il modello predefinito con `characterModelFor`.
- [ ] **Step 4:** tutta la suite API → PASS.
- [ ] **Step 5: Commit** `feat(casello): tetti di Alfred e Lucius anche su voce, piano e squadra; riassunti delle conversazioni nuove`.

### Task 10: `CharacterChat` e adattatori

**Files:**
- Create: `artifacts/casello/src/components/characters/adapters.ts`, `character-chat.tsx`, `proposal-cards.tsx`,
  `character-sheet.tsx`, `character-button.tsx`, `handoff-context.tsx`
- Modify: `artifacts/casello/src/App.tsx` (o dove si montano i provider: `HandoffProvider`)

**Interfaces:**
- Produces:
  ```ts
  interface ChatAdapter {
    character: "alfred" | "lucius";
    subjectLabel: string;                       // «Agente · Supporto clienti», «Area Skill», «Il filo di Alfred»
    useConversations(): { items: ConvSummary[]; isLoading: boolean } | null; // null = filo unico
    useConversation(id: number | null): { data?: ConvDetail; isLoading: boolean };
    create(modelId: number | null): Promise<number>;
    remove?(id: number): Promise<void>;
    restart?(): Promise<number>;                // solo Alfred
    send(id: number, content: string): Promise<void>;
    setModel(id: number, aiModelId: number): Promise<void>;
    decide(proposalId: number, decision: "accept" | "reject"): Promise<void>;
    renderProposal?(p: ProposalLike): ReactNode; // per piano e squadra: le schede di oggi
  }
  useCharacterAdapter(target: ChatTarget): ChatAdapter;
  type ChatTarget =
    | { kind: "alfred"; page: PageContext }
    | { kind: "character"; subjectType: Exclude<SubjectType, "alfred_thread">; subjectId: string | null; title: string }
    | { kind: "plan"; appId: number }
    | { kind: "team"; instanceId: number; closed: boolean };
  <CharacterChat target={ChatTarget} draft?={string} hasUnsavedChanges?={() => boolean} layout?={"sheet" | "page"} />
  <CharacterButton target={ChatTarget} hasUnsavedChanges?={() => boolean} />  // apre CharacterSheet
  useHandoff(): { open(target: ChatTarget, draft: string): void };
  ```
- Comportamenti: polling 1,5 s finché `turnStatus = running`; LED `work` durante il turno; costo con `formatCost`; modello con
  `ModelPicker`; limite 8 000 caratteri con contatore; schede `decision` («Approva» / «Rifiuta» con nota ≤ 500; senza
  «Approva» se `needsUserToken`, con link a Da confermare), `handoff` («Chiedo a Lucius» / «Chiedo ad Alfred» → accept, poi
  `useHandoff().open` con la domanda nel campo, non inviata), schede di Lucius con anteprima (Markdown per prompt e skill,
  elenco dei ruoli o degli strumenti) e «Accetta» / «Rifiuta»; prima di accettare, se `hasUnsavedChanges()`, `ConfirmDialog`
  «Hai modifiche non salvate in questa pagina: accettando la scheda andranno perse.»; dopo l'accettazione invalidare le query
  dell'oggetto (agente, skill, modello). Errori con `apiErrorMessage` in un toast. Sheet: `side="right"`, `w-full sm:max-w-[440px]`.
  Il pulsante usa il segno del personaggio da `marks.tsx` e il testo «Chiedi a Lucius» / «Chiedi ad Alfred».

- [ ] **Step 1:** implementare adattatori e componenti.
- [ ] **Step 2:** `pnpm run typecheck` → PASS.
- [ ] **Step 3: Commit** `feat(casello): pannello comune dei personaggi`.

### Task 11: Piano e squadra sul componente comune

**Files:**
- Modify: `artifacts/casello/src/components/teams/lucius-panel.tsx` (diventa un involucro di `CharacterChat` con target
  `team`, oppure si elimina e `team-detail.tsx` usa `CharacterButton`), `artifacts/casello/src/components/plan/chat-panel.tsx`,
  `artifacts/casello/src/pages/app-plan.tsx`, `artifacts/casello/src/pages/team-detail.tsx`

- [ ] **Step 1:** scheda squadra: `LuciusPanel` sostituito da `CharacterButton` con target `team` (stesso
  `hasUnsavedChanges` dell'editor dei ruoli, `RoleInstructionsCard` come `renderProposal`), più `CharacterButton` di Alfred
  con target `{kind: "alfred", page: {page: "team", id}}`. Pagina del piano: `CharacterChat` con target `plan` e
  `layout="page"`, `ProposalCard` di oggi come `renderProposal`.
- [ ] **Step 2:** typecheck → PASS; prova manuale (`AUTH_DISABLED=true pnpm run dev`): conversazione nel piano e nella
  squadra, accettazione di una scheda di ciascun tipo, avviso delle modifiche non salvate nella squadra.
- [ ] **Step 3: Commit** `refactor(casello): chat del piano e di squadra sul pannello comune`.

### Task 12: Pulsanti nelle aree

**Files:**
- Modify: `pages/dashboard.tsx`, `teams.tsx`, `pending-actions.tsx`, `runs.tsx`, `run-detail.tsx`, `app-detail.tsx`,
  `analysis-detail.tsx`, `agents.tsx`, `agent-detail.tsx`, `skills.tsx`, `skill-detail.tsx`, `team-templates.tsx`,
  `team-template-detail.tsx`

- [ ] **Step 1:** un `CharacterButton` per pagina secondo la mappa (spec §3.2), in alto a destra nell'intestazione del
  contenuto. Pagine `page` per Alfred: `dashboard`, `teams`, `team`, `pending_actions`, `runs`, `run`. Scheda app e analisi →
  target `plan` con l'id dell'app. Schede di agente, skill e modello → `hasUnsavedChanges` dei loro editor (prompt, contenuto,
  ruoli).
- [ ] **Step 2:** typecheck → PASS; prova manuale di ogni pagina a 1280 px e a 375 px, tema chiaro e scuro: nessuno
  scorrimento orizzontale, pannello sopra la pagina; un passaggio di consegne Alfred → Lucius (agente) e Lucius → Alfred
  (filo) apre l'altro con la domanda scritta e non inviata.
- [ ] **Step 3: Commit** `feat(casello): Alfred e Lucius nelle aree`.

### Task 13: Account → «Personaggi», documentazione e verifica

**Files:**
- Create: `artifacts/casello/src/components/account/characters-section.tsx`
- Modify: `artifacts/casello/src/pages/account.tsx`, rimozione o assorbimento di `components/account/alfred-section.tsx`,
  `CLAUDE.md`

- [ ] **Step 1:** carta «Personaggi»: Alfred (voce: modello e voce di oggi, «Apri Alfred»; scritto: modello; tetto mensile
  con spesa del mese e avviso dall'80%), Lucius (modello, tetto con spesa). Usa `getCharacterSettings` /
  `updateCharacterSettings` e gli hook di `/api/account/alfred`.
- [ ] **Step 2:** `CLAUDE.md`: voce in «Stato», sezione «Alfred e Lucius nelle aree» (motore, argomenti, schede, tetti,
  route, migrazione da applicare PRIMA del merge), file in «Dove stanno le cose», tabelle nell'elenco dello schema, fonti
  della spesa in «Tetti di spesa».
- [ ] **Step 3:** `pnpm run build` → PASS; `pnpm --filter @workspace/api-server run test` → PASS.
- [ ] **Step 4: Commit** `feat(casello): carta Personaggi in Account e documentazione`.
- [ ] **Step 5:** PR verso `main` con: cosa cambia, come si è provato, migrazione `2026-11-personaggi.sql` (SQL completo in
  chat, da applicare su Neon PRIMA del merge), nessuna variabile nuova.
