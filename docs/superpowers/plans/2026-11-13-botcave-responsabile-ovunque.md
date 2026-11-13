# Responsabile di Botcave da ogni area · Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chat con il Responsabile di prodotto di Botcave (agente `general` dell'App `casello`) in una quinta scheda del pannello unico e da un pulsante AI nella caverna, dove ogni messaggio è una run.

**Architecture:** due tabelle nuove (`lead_conversations`, `lead_messages`); `lib/lead-chat/` costruisce l'input della run (puro) e gestisce conversazioni e messaggi sopra `createQueuedRun`; route `/api/lead-chat` e `/api/lead-conversations`; nella console un adattatore nuovo di `CharacterChat` con un terzo «personaggio» `responsabile`.

**Tech Stack:** Express 5, Drizzle, PGlite nei test, Vitest, OpenAPI + Orval, React + Tailwind + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-13-botcave-responsabile-ovunque-design.md`

## Global Constraints

- Testi visibili in italiano, «Botcave» (mai «Casello»); identificatori in inglese; nessun identificatore `casello` rinominato.
- Niente colori esadecimali né classi di palette Tailwind: solo token (`bg-surface-1`, `text-ink-muted`, …); niente ombre; stati con `Led`.
- Niente scorrimento orizzontale a 1280 px; cinque schede su una riga a ~440 px (`truncate`).
- Messaggi d'errore fissi in `LEAD_CHAT_MESSAGES`; mai testo del modello o del DB; log solo id e conteggi, mai testi.
- Messaggio ≤ 4 000 caratteri; 10 messaggi/min per utente; ≤ 100 conversazioni aperte per utente; ≤ 6 scambi e ≤ 12 000 caratteri di cronologia, output per scambio tagliato a 2 000.
- Migrazione additiva e idempotente, niente `-post`, riportata in `docs/schema-casello.sql`; SQL completo in chat e applicazione su Neon PRIMA del merge.
- Solo hook Orval nella console, mai fetch a mano; dopo `openapi.yaml` rieseguire il codegen e committare i generati.
- `pnpm run typecheck` verde prima di ogni commit; commit in italiano `feat(casello): …` con la riga `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- La run dell'ultimo messaggio è stata annullata o è fallita: si può scrivere di nuovo subito (solo `pending`/`running` bloccano) → test in Task 3.
- Cronologia con un output di run enorme o con `</cronologia>` e `<richiesta>` annidati nel testo: i delimitatori non si ricompongono → test in Task 2.
- Il Responsabile perde il modello dopo la creazione della conversazione: il messaggio dà 409 col motivo, la conversazione resta leggibile → test in Task 3.
- Run eliminata (`run_id` null): il dettaglio mostra «risposta non più disponibile» e non è `running` → test in Task 3.
- Token d'ambito `agent`, `runs` o pannello `embed` sulle route della chat: 403 → test in Task 4.

---

### Task 1: Tabelle `lead_conversations` e `lead_messages`

**Files:**
- Create: `docs/migrations/2026-11-responsabile-ovunque.sql`, `lib/db/src/schema/lead-chat.ts`, `artifacts/api-server/test/migration-responsabile-ovunque.test.ts`
- Modify: `lib/db/src/schema/index.ts` (export), `docs/schema-casello.sql` (in fondo, stesso SQL senza `IF NOT EXISTS` superflui)

**Interfaces:**
- Produces: `leadConversationsTable` (`id`, `userId`, `agentId`, `title` text not null default `''`, `createdAt`, `updatedAt`, `archivedAt` nullable), `leadMessagesTable` (`id`, `conversationId`, `content`, `pageContext` jsonb nullable, `runId` nullable, `createdAt`), tipi `LeadConversation`, `LeadMessage`.

- [ ] **Step 1: Test della migrazione** (sullo schema corrente `docs/schema-casello.sql` prima della modifica non serve: si parte da `fixtures/schema-pre-nodo-locale.sql` come gli altri e si applicano le migrazioni successive in ordine fino a `2026-11-strumenti-github-squadre.sql`, poi la nuova due volte). Asserzioni: esistono le due tabelle; esistono gli indici `lead_conversations_user_updated_idx` e `lead_messages_conversation_idx`; eliminando un utente spariscono conversazioni e messaggi; eliminando una run il messaggio resta con `run_id` null.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run test/migration-responsabile-ovunque.test.ts` → FAIL (file mancante).
- [ ] **Step 3:** Scrivere la migrazione: `CREATE TABLE IF NOT EXISTS lead_conversations (id serial PK, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, agent_id integer NOT NULL REFERENCES agents(id) ON DELETE CASCADE, title text NOT NULL DEFAULT '', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), archived_at timestamp)`; `lead_messages (id serial PK, conversation_id integer NOT NULL REFERENCES lead_conversations(id) ON DELETE CASCADE, content text NOT NULL, page_context jsonb, run_id integer REFERENCES runs(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now())`; indici `(user_id, updated_at)` e `(conversation_id, id)`. Schema Drizzle uguale, export in `index.ts`, stesso SQL in `docs/schema-casello.sql`.
- [ ] **Step 4:** test della migrazione e `pnpm --filter @workspace/api-server exec vitest run src/lib/db-smoke.test.ts` → PASS; `pnpm run typecheck` verde.
- [ ] **Step 5:** commit «feat(casello): tabelle delle conversazioni con il Responsabile».

### Task 2: Input della run, pagine e frasi dei passi (funzioni pure)

**Files:**
- Create: `artifacts/api-server/src/lib/lead-chat/input.ts`, `artifacts/api-server/src/lib/lead-chat/input.test.ts`
- Modify: `artifacts/api-server/src/lib/turn-progress/describe.ts` (+ test esistente `describe.test.ts` o nuovo)

**Interfaces:**
- Produces:
  - `LEAD_CHAT_INPUT_MARKER = "dal pannello di Botcave"`; `LEAD_CHAT_LIMITS = { messageMax: 4000, historyTurns: 6, historyChars: 12000, replyChars: 2000 }`.
  - `LEAD_PAGES: Record<string, string>` pagina → etichetta: `dashboard` «Dashboard», `apps` «App», `app` «App», `app_plan` «Piano dell'app», `analysis` «Analisi», `agents` «Agenti», `agent` «Agente», `runs` «Run», `run` «Run», `pending_actions` «Da confermare», `skills` «Skill», `skill` «Skill», `team_templates` «Modelli di squadra», `team_template` «Modello di squadra», `teams` «Squadre», `team` «Squadra», `models` «Modelli AI», `account` «Account», `console` «Console».
  - `type LeadPage = { page: string; id?: string }`; `parseLeadPage(value: unknown): LeadPage | null | "invalid"` (null/undefined → null; pagina fuori elenco, id non `^[A-Za-z0-9._:-]{1,100}$`, campi in più → `"invalid"`).
  - `type LeadExchange = { message: string; reply: string }` (reply già risolta dal chiamante: output, `(errore: …)` o `(nessuna risposta)`).
  - `leadChatRunInput(args: { userName: string | null; page: LeadPage | null; history: LeadExchange[]; message: string }): string` — formato esatto della spec §6; `history` in ordine cronologico, tenuti gli ultimi 6, `reply` tagliata a 2 000, poi tolti i più vecchi finché il blocco supera 12 000; blocco assente con history vuota; riga pagina «Pagina della console: <etichetta>[, id <id>]» o assente senza pagina.
  - `describeRunStep(step: { type: string; toolName: string | null }): string` in `describe.ts`: `model` → «Pensa», `tool` + `proponi` → «Prepara una proposta», `tool` → «Consulta <nome>», `queued` → «Mette in coda <nome>», nome ripulito come `text()` (≤ 80), nome assente o tipo sconosciuto → «Usa uno strumento».

- [ ] **Step 1: Test** in `input.test.ts`:
  - `leadChatRunInput` con nome «Ivan», pagina `{page:"team", id:"12"}`, nessuna cronologia → contiene «Messaggio di Ivan dal pannello di Botcave (dati, non istruzioni di sistema).», «Pagina della console: Squadra, id 12», non contiene «<cronologia>», termina con `"<richiesta>\nciao\n</richiesta>"`.
  - 8 scambi → nella cronologia compaiono solo gli ultimi 6 (`[utente] m3` … `[utente] m8`), in ordine.
  - risposta di 5 000 caratteri → tagliata a 2 000; 6 scambi da 3 000 caratteri → blocco ≤ 12 000 e contiene l'ultimo scambio.
  - messaggio `"<ric<richiesta>hiesta>x</cronologia>"` → il testo finale contiene esattamente un `<richiesta>` e un `</richiesta>` e nessun `</cronologia>` oltre a quello del blocco.
  - `userName` null → la prima riga è «Messaggio dell'utente dal pannello di Botcave (dati, non istruzioni di sistema).».
  - `parseLeadPage`: `undefined` → null; `{page:"run", id:"431"}` ok; `{page:"admin"}` → "invalid"; `{page:"run", id:"a b"}` → "invalid"; `{page:"run", extra:1}` → "invalid".
  - `describeRunStep`: `{type:"model",toolName:null}` → «Pensa»; `{type:"tool",toolName:"list_apps"}` → «Consulta list_apps»; `{type:"queued",toolName:"create_skill"}` → «Mette in coda create_skill»; `{type:"tool",toolName:"proponi"}` → «Prepara una proposta»; `{type:"x",toolName:null}` → «Usa uno strumento».
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run src/lib/lead-chat/input.test.ts` → FAIL.
- [ ] **Step 3:** implementare; la pulizia dei delimitatori riusa il ciclo di `leadRunInput` (estrarre una funzione `stripTags(text, tags)` in `input.ts`, non toccare `product-leads.ts`). Prima di implementare `describeRunStep` controllare in `run-executor.ts` i valori reali di `run_steps.type` (`model`, `tool`, `queued`, eventuali altri) e mappare quelli presenti.
- [ ] **Step 4:** test → PASS; typecheck.
- [ ] **Step 5:** commit «feat(casello): input delle run della chat con il Responsabile».

### Task 3: Servizio della chat (`lib/lead-chat/service.ts`)

**Files:**
- Create: `artifacts/api-server/src/lib/lead-chat/service.ts`, `artifacts/api-server/src/lib/lead-chat/messages.ts`, `artifacts/api-server/src/lib/lead-chat/service.test.ts`
- Modify: `artifacts/api-server/src/middlewares/rate-limit.ts` (`consumeLeadChatMessage(userId): boolean`, 10/min, contatore proprio), `artifacts/api-server/src/lib/product-leads.ts` (esportare `queueItems` e `userOwnsModel` senza cambiarli)

**Interfaces:**
- Consumes: Task 1 tabelle; Task 2 `leadChatRunInput`, `parseLeadPage`, `describeRunStep`, `LEAD_CHAT_LIMITS`; `productLead(appId)` (`lib/escalation.ts`), `createQueuedRun`, `scheduleRuns`, `runBudgetBlock`, `DEFAULT_LEAD_APP_SLUG`.
- Produces:
  - `LEAD_CHAT_MESSAGES` = `{ noApp: "Botcave non è registrata come App", inactive: "il Responsabile di Botcave non è attivo", noModel: "scegli per il Responsabile un modello di uno dei tuoi account AI", changed: "il Responsabile è cambiato: apri una nuova conversazione", notFound: "conversazione non trovata", archived: "conversazione archiviata", busy: "il Responsabile sta già rispondendo", empty: "messaggio vuoto", tooLong: "messaggio troppo lungo: al massimo 4000 caratteri", badPage: "contesto della pagina non valido", tooMany: "Troppe richieste: riprova tra poco", tooManyConversations: "troppe conversazioni: eliminane qualcuna", queueFull: "troppe run in attesa per il Responsabile", gone: "risposta non più disponibile" }`; classe `LeadChatError(status: number, message: string)`.
  - `type LeadChatAvailability = { available: true; agentId: number; agentName: string; appName: string; aiModelId: number; modelName: string } | { available: false; reason: string; agentId: number | null }`; `resolveLeadChat(userId): Promise<LeadChatAvailability>` (App slug `casello` `active` → altrimenti `noApp`; `general` `active` → altrimenti `inactive`; modello dell'utente → altrimenti `noModel`).
  - `listLeadConversations(userId)` → `LeadConversationSummary[]` `{id, title, updatedAt, tokensUsed, costUsd}` (non archiviate, `updated_at` desc, ≤ 100).
  - `createLeadConversation(userId) → Promise<LeadConversation>` (disponibilità richiesta → 409 col motivo; > 100 aperte → 409 `tooManyConversations`).
  - `sendLeadMessage(userId, conversationId, input: { content: string; pageContext?: unknown }) → Promise<{ messageId: number; runId: number }>` nell'ordine della spec §6; titolo = prima riga del primo messaggio, ≤ 80.
  - `getLeadConversation(userId, id) → Promise<LeadConversationDetail>`: `{id, title, agentId, aiModelId, createdAt, updatedAt, turnStatus: "idle"|"running", tokensUsed, costUsd: number|null, messages: [{id, content, pageContext, createdAt, run: {id, status, output, error, costUsd, items: LeadQueueItem[]} | null}], progress: TurnProgress | null}`; `tokensUsed` = somma `prompt_tokens + completion_tokens` delle run (usare le colonne vere di `runs`); `costUsd` null se una run conclusa non ha costo; `progress` dagli ultimi 8 `run_steps` della run in corso, `omitted` = gli altri, ultimo passo `running`, gli altri `done`, `startedAt` = `runs.started_at ?? runs.created_at`.
  - `deleteLeadConversation(userId, id) → Promise<void>`.

- [ ] **Step 1: Test** in `service.test.ts` (fixture come `product-leads.test.ts`: utente, account AI e modello, App slug `casello` con `general` attivo; la coda NON parte, salvo dove serve un esito: allora `startRunQueue` + finto provider come in quel test):
  - `resolveLeadChat` per i tre motivi (App assente, `general` `draft`, modello di un altro utente) e il caso disponibile con `modelName`.
  - `sendLeadMessage`: crea una run `pending` dell'agente con input che contiene `LEAD_CHAT_INPUT_MARKER` e la pagina; messaggio salvato con `run_id`; titolo impostato.
  - secondo messaggio con la run precedente `pending` → `LeadChatError` 409 `busy`; dopo aver messo la run a `cancelled` → riesce e l'input contiene «(nessuna risposta)»; con la run precedente `succeeded` e output «fatto» → l'input contiene «[responsabile] fatto»; con `failed` e errore «boom» → «(errore: boom)».
  - testo vuoto 400 `empty`, 4 001 caratteri 400 `tooLong`, pagina `{page:"admin"}` 400 `badPage`, conversazione di un altro utente 404, archiviata 409 `archived`.
  - Responsabile senza modello dopo la creazione → 409 `noModel`; `getLeadConversation` funziona ancora.
  - `agent_id` della conversazione diverso dal Responsabile attuale → 409 `changed`.
  - 11° messaggio nel minuto → 429 `tooMany` (ultimo test del file; mettere ogni run a `succeeded` tra un messaggio e l'altro).
  - `getLeadConversation`: run in corso con 10 `run_steps` → `turnStatus` `running`, `progress.steps` lunghi 8, `omitted` 2, ultimo `running`; voce in `pending_actions` con `run_id` della run → `items[0]` con numero e sintesi; `run_id` null → `run` null e `turnStatus` `idle`.
  - `deleteLeadConversation` → conversazione e messaggi spariti, run ancora presente.
  - 101ª conversazione → 409 `tooManyConversations`.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run src/lib/lead-chat/service.test.ts` → FAIL.
- [ ] **Step 3:** implementare. Creazione della run e INSERT del messaggio nella stessa transazione (`createQueuedRun({ agent, input, tx })`), poi `void scheduleRuns()` dopo il commit. Coda piena → 429 `queueFull`. Tetto → 409 con il testo di `runBudgetBlock`.
- [ ] **Step 4:** test → PASS; typecheck.
- [ ] **Step 5:** commit «feat(casello): conversazioni con il Responsabile fatte di run».

### Task 4: OpenAPI, codegen e route

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (tag `lead-chat`; schemi `LeadChatAvailability`, `LeadConversation`, `LeadConversationDetail`, `LeadMessage`, `LeadRunView`, `LeadQueueItem`, `LeadPageContext`, `LeadMessageCreate`, `LeadMessageAccepted`; riuso di `TurnProgress`), file generati (`pnpm --filter @workspace/api-spec run codegen`)
- Create: `artifacts/api-server/src/routes/lead-chat.ts`, `artifacts/api-server/src/routes/lead-chat.test.ts`
- Modify: `artifacts/api-server/src/routes/index.ts` (`router.use(createLeadChatRouter())` dopo `createCharactersRouter()`)

**Interfaces:**
- Consumes: Task 3.
- Produces (operationId → hook Orval): `getLeadChat` (`GET /lead-chat`), `listLeadConversations` (`GET /lead-conversations`), `createLeadConversation` (`POST /lead-conversations`, 201), `getLeadConversation` (`GET /lead-conversations/{id}`), `deleteLeadConversation` (`DELETE …/{id}`, 204), `sendLeadMessage` (`POST …/{id}/messages`, 202 `{messageId, runId}`).

- [ ] **Step 1: Test** in `lead-chat.test.ts` (app Express vera con `AUTH_DISABLED=true` come `characters.test.ts`): ciclo GET disponibilità → POST conversazione → POST messaggio 202 → GET dettaglio con il messaggio e `run.status` `pending` → DELETE 204 → GET 404; id non numerico 400; `LeadChatError` tradotto con stato e `{error}`. Token: creare token personali con ambiti `agent`, `runs` e `api:read`: con `agent` e `runs` ogni route → 403 «il token non ha l'ambito per questa operazione»; con `api:read` GET 200 e POST 403. Pannello `embed`: simulare `req.auth.via = "embed"` con un token `cao_` come in `embed-token.test.ts` → 403.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run src/routes/lead-chat.test.ts` → FAIL.
- [ ] **Step 3:** OpenAPI + codegen; router con `parseRequest` e `*Response.parse`; un middleware del router rifiuta con 403 `TOKEN_MESSAGES.scope` i token con ambito `agent` o `runs` e quelli con `via: "embed"` (prima di toccare il DB). Gli ambiti per metodo restano a `requireAuth`.
- [ ] **Step 4:** test → PASS; `pnpm --filter @workspace/api-server run test` tutto verde; typecheck.
- [ ] **Step 5:** commit «feat(casello): route della chat con il Responsabile».

### Task 5: Pagina corrente e schede per ambiente (console, puro)

**Files:**
- Modify: `artifacts/casello/src/components/panel/page-subject.ts` (+ `page-subject.test.ts`), `artifacts/casello/src/components/panel/tabs.ts`, `artifacts/casello/src/components/panel/panel-state.ts` (+ test)

**Interfaces:**
- Produces:
  - `leadPageFromPath(path: string): { page: string; id?: string }` con le rotte di `App.tsx`: `/` dashboard, `/apps` apps, `/apps/:id` app, `/apps/:id/plan` app_plan, `/analyses/:id` analysis, `/agents` agents, `/agents/:id` agent, `/runs` runs, `/runs/:id` run, `/pending-actions` pending_actions, `/skills` skills, `/skills/:code` skill, `/team-templates` team_templates, `/team-templates/:id` team_template, `/teams` teams, `/teams/:id` team, `/models` models, `/account` account, altro `console`; id decodificato e accettato solo se `^[A-Za-z0-9._:-]{1,100}$`, altrimenti la pagina senza id.
  - `PanelTab = EmbedTab | "lead"`; `TAB_LABELS.lead = "Responsabile"`; `tabOrder(surface: "console" | "embed"): readonly PanelTab[]` (console: alfred, pending, bulletin, lucius, lead; embed: le quattro di oggi). `TAB_ORDER` rimosso o lasciato come alias dell'embed: aggiornare gli usi.
- [ ] **Step 1: Test**: `leadPageFromPath("/teams/12")` → `{page:"team", id:"12"}`; `"/apps/3/plan"` → `{page:"app_plan", id:"3"}`; `"/skills/ruolo-capo"` → `{page:"skill", id:"ruolo-capo"}`; `"/skills/a%20b"` → `{page:"skill"}`; `"/runs/"` → `{page:"runs"}`; `"/nodes/pair"` → `{page:"console"}`. `tabOrder("embed")` non contiene `lead`; `tabOrder("console")` finisce con `lead`. Riduttore: `selectTab("lead")` e `open` con `tab: "lead"` funzionano.
- [ ] **Step 2:** `pnpm --filter @workspace/casello run test` → FAIL.
- [ ] **Step 3:** implementare; `protocol.ts` dell'embed NON accetta `lead` (resta `EmbedTab`).
- [ ] **Step 4:** test → PASS; typecheck.
- [ ] **Step 5:** commit «feat(casello): pagina corrente e scheda Responsabile nel pannello».

### Task 6: Scheda «Responsabile», adattatore e pulsante AI

**Files:**
- Create: `artifacts/casello/src/components/characters/lead-adapter.tsx`, `artifacts/casello/src/components/panel/tabs/lead-tab.tsx`, `artifacts/casello/src/components/characters/lead-run-card.tsx`
- Modify: `characters/adapters.ts` (`Character = "alfred" | "lucius" | "responsabile"`; `ChatTarget` + `{kind: "lead"}`; `useCharacterAdapter`; `characterOf`; `ChatAdapter.createWithoutDialog?: boolean`), `characters/targets.ts` (`targetKey` → `"lead"`; `characterDisplay(c)` → `{name, placeholder, sendLabel}`: Alfred / Lucius / «Responsabile», «Scrivi al Responsabile…», «Scrivi al Responsabile»), `characters/character-chat.tsx` e `chat-messages.tsx` (nome, segno e testi da `characterDisplay`; segno del Responsabile = icona `Sparkles` di lucide alla stessa misura; «Nuova» chiama `adapter.create(null)` senza dialogo se `createWithoutDialog`), `panel/botcave-panel.tsx` (`tabOrder(env.surface)`, `case "lead"`), `panel/page-subject.ts` `targetLabel` (`case "lead"` → «Responsabile»), `layout/app-shell.tsx` (pulsante)

**Interfaces:**
- Consumes: hook Orval del Task 4; `leadPageFromPath`, `tabOrder` del Task 5.
- Produces: `useLeadChatAdapter(page: { page: string; id?: string }): ChatAdapter`; `LeadTab`.

Comportamento dell'adattatore:
- `useConversations` → `listLeadConversations`; `useConversation` → `getLeadConversation` con `refetchInterval` `POLL_MS` mentre `turnStatus` è `running`.
- `ConvDetail`: `aiModelId` = quello del dettaglio (picker disattivato: niente `setModel`), `readOnlyReason` null, `subjectId` null, `progress` dal server. Messaggi: per ogni `LeadMessage` id `2*m.id` utente e, se `run` non è `pending`/`running`, id `2*m.id+1` assistente: `succeeded` → `output` (vuoto → «(nessuna risposta)»), `failed`/`cancelled` → `error` con `error: true` (null → «run non riuscita»), `run` null → `LEAD_GONE` «risposta non più disponibile» con `error: true`.
- `proposals`: una `ProposalLike` per messaggio con run conclusa, `kind: "lead_run"`, `messageId` = id assistente, `payload: {runId, items}`, `status: "accepted"`; `renderProposal` → `LeadRunCard`: elenco delle voci (`Led` `ask` se `pending`, `ok` se `done`, `ko` se `failed`, `idle` altrimenti; «#numero · sintesi»), clic su una voce → `selectTab("pending")`; link «Apri la run» → `PanelLink` a `/runs/:id`. `decide` → no-op.
- `send(id, content)` → `sendLeadMessage` con `pageContext: page` (la pagina letta al momento dell'invio); `create` → `createLeadConversation`; `remove` → `deleteLeadConversation`, `deleteNote` «Le run restano nella pagina Run»; `emptyHint` «Chiedi al Responsabile di Botcave: conosce squadre, agenti, run, skill e coda. Le scritture le propone in Da confermare.»; `subjectLabel` «Botcave · <nome dell'agente>».

`LeadTab`: legge `getLeadChat`; non disponibile → `Led idle` con `reason` e, se `agentId`, `Button` secondario «Apri il Responsabile» (`PanelLink` `/agents/:id`); disponibile → `CharacterChat` con `target {kind:"lead"}`. La pagina viene da `leadPageFromPath(location)` (`useLocation`).

Pulsante in `CaveHeader`, a sinistra di quello di Alfred: stessa forma e misura, icona `Sparkles` chiara su scuro (stesse classi del segno di Alfred), `aria-label`/`title` «Chiedi al Responsabile di Botcave», `onClick={() => openPanel("lead")}`, `LedDot state="work"` solo quando la conversazione aperta nella scheda `lead` ha il turno in corso (stato condiviso dal `PanelProvider`, nessuna richiesta periodica in più dalla barra). Differenza dalla spec, da annotare nel Task 7: la spec diceva «mentre una tua run del Responsabile è in corso».

- [ ] **Step 1:** implementare adattatore, card, scheda, generalizzazione di `CharacterChat`, pulsante.
- [ ] **Step 2:** `pnpm --filter @workspace/casello run test` e `pnpm run typecheck` → verdi.
- [ ] **Step 3: Prova nel browser** (`AUTH_DISABLED=true pnpm run dev` con un DB di sviluppo, schema da `pnpm --filter @workspace/db run push`; App slug `casello` con `general` e un modello): aprire `/teams`, premere il pulsante, scrivere, vedere la run `pending` e il messaggio; a 1280 px nessuno scorrimento orizzontale, cinque schede su una riga; tema chiaro e scuro. Se non c'è un DB di sviluppo disponibile, dirlo nel resoconto invece di fingere la prova.
- [ ] **Step 4:** commit «feat(casello): scheda e pulsante del Responsabile di Botcave».

### Task 7: Documentazione e verifica finale

**Files:**
- Modify: `CLAUDE.md` (riga in «Stato»; voce in «Dove stanno le cose»; sezione «Responsabile da ogni area» con tabelle, route, limiti, marcatore, migrazione; elenco tabelle in `lib/db/src/schema/`; menzione della quinta scheda solo nella console in «Alfred e Lucius nelle aree»), spec (sezione «Differenze dal codice» se ce ne sono, es. LED del pulsante)

- [ ] **Step 1:** aggiornare i documenti.
- [ ] **Step 2:** `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test` → tutti verdi (riportare i numeri).
- [ ] **Step 3:** commit «docs(casello): Responsabile di Botcave da ogni area».
