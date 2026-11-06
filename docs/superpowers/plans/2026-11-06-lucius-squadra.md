# Lucius sulla squadra e memorie dei personaggi — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chat di Lucius sulla squadra con proposte di identità e file MD per ruolo, e memorie separate (appunti + storico
riassunto) per Alfred e Lucius.

**Architecture:** la chat di squadra ricalca la chat del piano (`lib/plan-chat/`): tabelle proprie, turno in background, schede
da accettare applicate con le regole di `saveInstance`. Le memorie sono un modulo unico (`lib/memory/`) con strumenti in formato
OpenAI per Lucius e dichiarazioni Gemini per Alfred; i riassunti li scrive il modello predefinito dell'utente con uno sweeper.

**Tech Stack:** Express 5, Drizzle/Postgres, Vitest + PGlite, OpenAPI + Orval, React + shadcn.

**Spec:** `docs/superpowers/specs/2026-11-06-botcave-lucius-squadra-design.md`

## Global Constraints

- Contract-first: ogni route nuova prima in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen`; il frontend usa solo gli hook generati.
- Body/parametri con `parseRequest` (400), risposte con `*Response.parse` (500).
- Messaggi d'errore fissi in italiano, mai il testo del DB o del provider; testi visibili dicono «Botcave», mai «Casello».
- Testi dell'utente, della squadra e della memoria al modello solo come messaggi `user` di dati, mai nel prompt di sistema; niente segreti né indirizzi delle app nel contesto.
- Identità: il campo resta `roles[].task`; cambia solo l'etichetta («Identità») e la riga del prompt («Identità del ruolo:»).
- Istruzioni del ruolo: skill specializzata `ruolo-<key>`, tipo `casello`, ≤ 20 000 caratteri, frontmatter con `name` = key.
- Limiti chat di squadra: 6 giri, 40 000 token, 120 s; messaggio ≤ 8 000; contesto ~30 000 token; 10 messaggi/min per utente; ≤ 10 proposte per turno; identità ≤ 8 000, motivazione ≤ 1 000.
- Memorie: appunti ≤ 300 caratteri, ≤ 50 per personaggio e utente; storico: titolo ≤ 120, riassunto ≤ 1 500, ≤ 500 voci (si tolgono le più vecchie); nel contesto solo i titoli degli ultimi 3; ricerca ≤ 5 risultati; trascrizione di Alfred ≤ 20 000 e mai salvata.
- Riassunti: modello predefinito dell'utente, 30 s, 1 000 token; conversazioni ferme da 30 minuti, controllo ogni 10 minuti; costo nella spesa di utente, modello e account.
- Migrazione `docs/migrations/2026-11-lucius-squadra.sql` additiva e idempotente, riportata in `docs/schema-casello.sql`; nessuna rinomina di identificatori.
- Console: token di design, LED al posto dei badge, niente scorrimento orizzontale a 1280 px.
- `pnpm run typecheck` verde prima di ogni commit; commit in italiano `feat(casello): …` con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Due schede accettate di fila sullo stesso ruolo: la seconda, nata prima della prima accettazione, deve diventare `stale` (409), non sovrascrivere.
- Accettare istruzioni su un ruolo che ha già 30 skill: 400 con il messaggio di `validateRoles`, nulla salvato, scheda resta `pending`.
- Squadra chiusa mentre un turno di Lucius è in corso: le proposte di quel turno si salvano ma non si accettano (409 «squadra chiusa»).
- Un appunto che contiene una chiave (`sk-…`, `ghp_…`, `cas_…`, `AIza…`, stringhe esadecimali/base64 ≥ 32 caratteri) viene rifiutato anche se inserito a mano dalla console.
- Riassunto quando il modello predefinito non c'è più o fallisce: nessuna voce di storico, `summarized_at` aggiornato comunque per non ritentare all'infinito.

---

### Task 1: Schema, migrazione, budget

**Files:**
- Create: `lib/db/src/schema/team-chat.ts`, `lib/db/src/schema/character-memory.ts`, `docs/migrations/2026-11-lucius-squadra.sql`, `artifacts/api-server/test/migration-lucius-squadra.test.ts`
- Modify: `lib/db/src/schema/index.ts`, `lib/db/src/schema/plan-conversations.ts` (`summarizedAt`), `docs/schema-casello.sql`, `artifacts/api-server/src/lib/budget.ts`

**Interfaces:**
- Produces: tabelle Drizzle `teamChatConversationsTable`, `teamChatMessagesTable`, `teamChatProposalsTable`, `characterNotesTable`, `characterHistoryTable`; enum `characterEnum` (`alfred|lucius`), `teamChatProposalKindEnum` (`role_identity|role_instructions`), `characterHistoryKindEnum` (`alfred_session|plan_conversation|team_chat`); riuso degli enum `plan_turn_status`, `plan_message_role`, `plan_proposal_status`.
- Colonne: come nella spec §2 e §3, più su `character_history` `ai_model_id` (SET NULL), `tokens_used` int default 0, `cost_usd` numeric(12,6) per la spesa dei riassunti; `team_chat_conversations.summarized_at`, `plan_conversations.summarized_at` (timestamp null). Indici: `(team_instance_id, user_id)` sulle conversazioni, `(user_id, character)` su note e storico.

- [ ] **Step 1:** test di migrazione `migration-lucius-squadra.test.ts` sul modello di `migration-alfred.test.ts`: lo script si applica due volte senza errori su uno schema pre-esistente e crea tabelle, enum e colonne elencati.
- [ ] **Step 2:** eseguirlo: `pnpm --filter @workspace/api-server run test -- migration-lucius-squadra` → FAIL.
- [ ] **Step 3:** schema Drizzle, script SQL idempotente (`CREATE TABLE IF NOT EXISTS`, enum in `DO $$ … EXCEPTION WHEN duplicate_object`), stesse definizioni in `docs/schema-casello.sql`.
- [ ] **Step 4:** in `spendsBy` (`budget.ts`) aggiungere due fonti: `team_chat_conversations` (come `planConversationsTable`, mese di `updated_at`) e `character_history` (mese di `created_at`, unpriced = costo null e `tokens_used > 0`); test in `budget.test.ts`: una conversazione di squadra da 0,5 USD e un riassunto da 0,01 USD sul modello dell'utente sommano 0,51 in `userSpend`.
- [ ] **Step 5:** test verdi, `pnpm run typecheck`, commit «feat(casello): tabelle della chat di squadra e delle memorie».

### Task 2: «Identità» al posto di «Compito»

**Files:**
- Modify: `artifacts/api-server/src/lib/teams/task-runner.ts` (riga «Istruzioni del ruolo:» → «Identità del ruolo:»), `artifacts/api-server/src/lib/teams/turn-runner.ts` (se descrive i ruoli con il compito, stessa etichetta), `artifacts/casello/src/components/teams/roles-editor.tsx:126` (etichetta «Identità», segnaposto «Chi è il ruolo e qual è il suo mandato, in poche righe»), relativi test.

- [ ] **Step 1:** nel test esistente del prompt dei compiti (`task-runner.test.ts`) aspettarsi `"Identità del ruolo:"` e non più `"Istruzioni del ruolo:"` → FAIL.
- [ ] **Step 2:** cambiare le etichette; test verdi; typecheck; commit «feat(casello): il compito del ruolo diventa identità».

### Task 3: Memorie (appunti e storico)

**Files:**
- Create: `artifacts/api-server/src/lib/memory/notes.ts`, `artifacts/api-server/src/lib/memory/history.ts`, `artifacts/api-server/src/lib/memory/credentials.ts`, test accanto (`*.test.ts`)

**Interfaces:**
- Produces:
  - `type Character = "alfred" | "lucius"`; `MEMORY_MESSAGES` (`full`: «memoria piena: unisci o togli un appunto», `credential`: «non salvo credenziali in memoria», `notFound`: «appunto non trovato», `empty`: «appunto vuoto», `tooLong`: «appunto troppo lungo: al massimo 300 caratteri»); `class MemoryError extends Error { status: number }`.
  - `NOTE_MAX_CHARS = 300`, `NOTES_MAX = 50`, `HISTORY_MAX = 500`, `HISTORY_TITLE_MAX = 120`, `HISTORY_SUMMARY_MAX = 1500`, `HISTORY_SEARCH_MAX = 5`, `RECENT_TITLES = 3`.
  - `looksLikeCredential(text: string): boolean` — vero per prefissi `sk-`, `sk_`, `ghp_`, `gho_`, `github_pat_`, `cas_`, `cao_`, `car_`, `AIza`, `xox`, `-----BEGIN`, e per token senza spazi di ≥ 32 caratteri esadecimali o base64/url-safe.
  - `listNotes(userId, character): Promise<NoteView[]>` (`{id, content, ref, createdAt, updatedAt}`, ordine di creazione), `addNote(userId, character, content, ref?)`, `updateNote(userId, character, id, content)`, `deleteNote(userId, character, id)`; testo `trim`, vuoto → 400, > 300 → 400, credenziale → 400, 50 già presenti → 409 (conteggio con la riga utente bloccata `FOR UPDATE` su `users`), id altrui o dell'altro personaggio → 404.
  - `addHistory(entry: {userId, character, kind, refId, title, summary, aiModelId, tokensUsed, costUsd}): Promise<void>` — sostituisce la voce con stesso `(user, character, kind, refId)`, tronca titolo e riassunto, poi pota oltre 500 togliendo le più vecchie.
  - `recentHistoryTitles(userId, character): Promise<{id, title, createdAt}[]>` (ultime 3), `searchHistory(userId, character, query): Promise<HistoryView[]>` (ILIKE su titolo e riassunto, più recenti prima, ≤ 5; query vuota → le ultime 5), `listHistory(userId, character, q?)` (per la console, ≤ 100), `deleteHistory(userId, character, id)`.
  - `memoryContextBlock(userId, character): Promise<string>` — testo dati: «Appunti (id · testo)» e «Conversazioni recenti (titoli)»; stringa vuota se non c'è nulla.

- [ ] **Step 1:** test: isolamento (appunto di Lucius invisibile ad Alfred e a un altro utente: 404), cinquantunesimo appunto → 409 `full`, `sk-proj-abc…` e una stringa esadecimale di 40 caratteri → 400 `credential`, testo con spazi normale accettato, `addHistory` due volte sullo stesso ref sostituisce, 501 voci → restano 500 senza la più vecchia, `searchHistory("consegna")` trova per riassunto, `memoryContextBlock` vuoto senza dati.
- [ ] **Step 2:** FAIL; implementare; verdi; typecheck; commit «feat(casello): memorie dei personaggi».

### Task 4: Strumenti di memoria e riassunti

**Files:**
- Create: `artifacts/api-server/src/lib/memory/tools.ts`, `artifacts/api-server/src/lib/memory/summaries.ts`, test accanto
- Modify: `artifacts/api-server/src/index.ts` (avvio dello sweeper)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `MEMORY_TOOL_NAMES = ["ricorda", "aggiorna_appunto", "dimentica", "cerca_nello_storico"] as const`.
  - `MEMORY_TOOLS: ChatCompletionFunctionTool[]` (OpenAI) con parametri `ricorda {testo}`, `aggiorna_appunto {id, testo}`, `dimentica {id}`, `cerca_nello_storico {testo}`; descrizioni che vietano credenziali e chiedono appunti brevi e stabili.
  - `runMemoryTool(userId, character, name, args): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>` — argomenti validati con Zod (errore → «argomenti non validi»), `MemoryError` → `ok: false` con il suo messaggio.
  - `summarizeConversation(input: {userId, character, kind, refId, title, transcript: string}, deps?: {chat?}): Promise<"saved" | "skipped">` — modello predefinito via `default-model.ts` (se non è più di un account dell'utente → `skipped`), prompt fisso (decisioni prese, preferenze emerse, punti aperti, ≤ 1 500 caratteri, nessuna credenziale), 30 s, `max_tokens` 1 000; errore del provider → `skipped`; altrimenti `addHistory` con costo e token.
  - `sweepSummaries(now = new Date()): Promise<number>` — conversazioni di `plan_conversations` e `team_chat_conversations` con `turn_status = idle`, `updated_at < now - 30 min` e (`summarized_at` null o < `updated_at`); trascrizione = messaggi in ordine (`Utente:` / `Lucius:`), tagliata dalla fine a 20 000 caratteri; titolo = titolo della conversazione; `summarized_at = now` sempre, anche se `skipped`. Al più 20 conversazioni per giro.
  - `startMemorySweeper(): () => void` — ogni 10 minuti.

- [ ] **Step 1:** test con modello finto (`test/fake-provider.ts`): conversazione ferma da 31 minuti → una voce di storico con costo; ferma da 29 → nulla; senza modello predefinito → nessuna voce e `summarized_at` valorizzato; un nuovo messaggio dopo il riassunto → il giro successivo aggiorna la stessa voce; `runMemoryTool` con `ricorda` al cinquantunesimo → `ok: false` «memoria piena…».
- [ ] **Step 2:** FAIL; implementare; avviare lo sweeper in `index.ts` dopo `startAlfredSweeper()`; verdi; typecheck; commit «feat(casello): riassunti e strumenti di memoria».

### Task 5: Turno generico e memoria nella chat del piano

**Files:**
- Modify: `artifacts/api-server/src/lib/plan-chat/turn.ts`, `artifacts/api-server/src/lib/plan-chat/tools.ts`, `artifacts/api-server/src/lib/plan-chat/context.ts`, `artifacts/api-server/src/lib/plan-chat/run-turn.ts`, test relativi

**Interfaces:**
- Produces: `runPlanTurn(messages, deps, limits, tools: ChatCompletionFunctionTool[] = PLAN_TOOLS)` (strumenti come parametro, comportamento invariato per default); il turno del piano passa `[...PLAN_TOOLS, ...MEMORY_TOOLS]`, `PlanToolRunner` delega i nomi di `MEMORY_TOOL_NAMES` a `runMemoryTool(userId, "lucius", …)`; `buildPlanMessages` aggiunge `memoryContextBlock` dentro il blocco dati `user` (input `memory: string`).

- [ ] **Step 1:** test: un turno con `tools` personalizzati offre al modello finto esattamente quelli; nel piano `ricorda` crea un appunto di Lucius; il contesto contiene gli appunti nel messaggio `user` e non nel `system`.
- [ ] **Step 2:** FAIL; implementare; tutti i test della chat del piano verdi; commit «feat(casello): memoria di Lucius nella chat del piano».

### Task 6: Chat di squadra (logica)

**Files:**
- Create: `artifacts/api-server/src/lib/team-chat/context.ts`, `tools.ts`, `decide.ts`, `run-turn.ts`, `instructions-file.ts`, test accanto; `artifacts/api-server/src/lib/zip-writer.ts` (+ test)
- Modify: `artifacts/api-server/src/middlewares/rate-limit.ts` (`consumeTeamChatMessage(userId): boolean`, 10/min), `artifacts/api-server/src/index.ts` (`failInterruptedTeamChatTurns()` all'avvio)

**Interfaces:**
- Consumes: `getInstance`, `saveInstance`, `INSTANCE_MESSAGES` (`lib/teams/instances.ts`), `validateRoles` via `saveInstance`, Task 3–5.
- Produces:
  - `instructions-file.ts`: `INSTRUCTIONS_SKILL_PREFIX = "ruolo-"`, `instructionsSkillCode(roleKey): string`, `parseInstructionsFile(markdown, roleKey): { ok: true; name: string; description: string } | { ok: false; error: string }` (frontmatter `---` iniziale con `name` = roleKey e `description` non vuota; errori «il file deve iniziare con il frontmatter del ruolo», «il nome nel frontmatter deve essere <key>»), `INSTRUCTIONS_TEMPLATE` (lo scheletro delle sezioni della spec §1, usato nel prompt e nei test).
  - `context.ts`: `TEAM_CHAT_SYSTEM_PROMPT` (Lucius, ingegnere del laboratorio di Botcave, «lei», chiede prima di proporre quando mancano obiettivo, confini o forma dell'esito, una scheda per ruolo alla volta, usa `INSTRUCTIONS_TEMPLATE`), `buildTeamChatMessages(input: {team: TeamSnapshot, memory: string, history: HistoryMessage[], userMessage: string}): ChatCompletionMessageParam[]` con budget ~30 000 token come il piano; `TeamSnapshot` = squadra, ruoli con strumenti (nome, app, descrizione, livello effettivo, `available`) e skill col contenuto, PLAN se esiste; nessun `base_url`, segreto o header.
  - `tools.ts`: `TEAM_CHAT_TOOLS` (`leggi_squadra`, `leggi_skill {code}`, `leggi_strumento {id}`, `proponi_identita {roleKey, testo, motivazione}`, `proponi_istruzioni {roleKey, markdown, motivazione}`) + `MEMORY_TOOLS`; `class TeamChatToolRunner` (proposte raccolte in memoria, ≤ 10 per turno → «hai già proposto 10 schede in questo turno», ruolo inesistente → «ruolo <key> inesistente», `leggi_strumento` oscura i parametri `x-sensitive`).
  - `decide.ts`: `currentValueHash(instance, kind, roleKey): string` (SHA-256 dell'identità o del contenuto della skill `ruolo-<key>`, stringa vuota se manca), `decideTeamChatProposal(userId, proposalId, decision: "accept" | "reject"): Promise<ProposalView>` — accept: squadra chiusa → 409 «squadra chiusa»; hash cambiato → `stale` + 409 «la squadra è cambiata: chiedi a Lucius una proposta aggiornata»; altrimenti `saveInstance` con ruoli e skill specializzate aggiornati (identità; oppure skill `ruolo-<key>` creata/sostituita con nome «Istruzioni · <nome ruolo>» e aggiunta a `localSkills` del ruolo); errori di `saveInstance` propagati col loro stato, scheda resta `pending`; proposta già decisa → 409 «scheda già decisa».
  - `run-turn.ts`: `startTeamChatTurn(conversationId, content)`, `executeTeamChatTurn(conversationId, assistantMessageId)` (tetti con `userBudgetBlock`, costo e token su conversazione e messaggio, proposte salvate con `target_hash`), `failInterruptedTeamChatTurns()`, `TEAM_CHAT_MESSAGE_MAX_CHARS = 8_000`.
  - `zip-writer.ts`: `buildZip(files: {name: string; content: Buffer}[]): Buffer` (metodo store, CRC32, directory centrale; nomi ASCII).

- [ ] **Step 1:** test di `instructions-file` (frontmatter mancante, nome diverso, valido) e di `buildZip` (letto da `lib/architect/zip-reader.ts` con gli stessi nomi e contenuti).
- [ ] **Step 2:** test di `decide`: accetta identità → `roles[key].task` aggiornato; accetta istruzioni → skill `ruolo-dev` creata e in `localSkills`; due proposte nate sullo stesso valore → la seconda `stale` 409; ruolo con 30 skill → 400 e scheda `pending`; squadra chiusa → 409.
- [ ] **Step 3:** test di `run-turn` con modello finto: il modello chiama `proponi_istruzioni` → scheda `pending` con `target_hash`; undicesima proposta nello stesso turno rifiutata; il contesto non contiene `base_url` né il segreto di servizio dell'app.
- [ ] **Step 4:** FAIL; implementare; verdi; typecheck; commit «feat(casello): chat di Lucius sulla squadra».

### Task 7: API (contratto, route, scarichi)

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (tag `team-chat` e `memories`), generati di `lib/api-client-react` e `lib/api-zod`, `artifacts/api-server/src/routes/index.ts`
- Create: `artifacts/api-server/src/routes/team-chat.ts`, `artifacts/api-server/src/routes/memories.ts`, `artifacts/api-server/test/team-chat-routes.test.ts`, `artifacts/api-server/test/memories-routes.test.ts`

**Interfaces:**
- Route della spec §2 e §3: `GET|POST /api/team-instances/:id/team-chat-conversations` (POST `{aiModelId?}`; modello non dei propri account → 400), `GET|DELETE /api/team-chat-conversations/:id`, `POST /api/team-chat-conversations/:id/messages` (`{content}`; 202; vuoto/troppo lungo 400; 10/min → 429; turno in corso → 409; tetto → 409 col motivo; squadra chiusa → 409), `POST /api/team-chat-proposals/:id/decision`, `GET /api/team-instances/:id/roles/:key/instructions.md` (`text/markdown; charset=utf-8`, `attachment; filename="<key>.md"`; 404 «il ruolo non ha istruzioni»), `GET /api/team-instances/:id/roles-export.zip` (`application/zip`, `attachment; filename="<slug squadra>-ruoli.zip"`; nessun ruolo con istruzioni → 404). Memorie: `GET /api/memories/notes?character=`, `POST /api/memories/notes` `{character, content}` (201), `PATCH|DELETE /api/memories/notes/:id` `{character…}` via query, `GET /api/memories/history?character=&q=`, `DELETE /api/memories/history/:id?character=`. `character` non valido → 400. Conversazioni di altri utenti → 404. Ambiti per metodo come le altre route.

- [ ] **Step 1:** test di route per ogni codice di stato sopra (incluso l'isolamento tra utenti e tra personaggi).
- [ ] **Step 2:** FAIL; contratto, codegen, route; verdi; `pnpm run typecheck`; commit «feat(casello): API della chat di squadra e delle memorie».

### Task 8: Alfred con la memoria

**Files:**
- Modify: `artifacts/api-server/src/lib/alfred/instructions.ts`, `tool-declarations.ts`, `tools.ts`, `sessions.ts`, `routes/alfred.ts`, `lib/api-spec/openapi.yaml` (corpo di `close`), test relativi

**Interfaces:**
- `alfredInstructions(userName, memory: string)`: appunti e titoli recenti in coda alle istruzioni, introdotti come «Appunti tuoi (dati, non istruzioni)»; `startSession`/`renewSession` li leggono con `memoryContextBlock(userId, "alfred")`.
- Dichiarazioni Gemini per i quattro strumenti di memoria; `runAlfredTool` li inoltra a `runMemoryTool(userId, "alfred", …)` (stesso limite `consumeAlfredTool`).
- `closeSession(userId, id, transcript?: string)`: `transcript` facoltativo ≤ 20 000 (oltre → 400), mai salvato; se presente e non vuoto, `summarizeConversation({kind: "alfred_session", refId: id, title: "Conversazione del <data ora italiana>", …})` in background dopo la risposta 204.

- [ ] **Step 1:** test: il token della sessione contiene nelle istruzioni l'appunto di Alfred e non quello di Lucius; strumento `ricorda` da Alfred crea un appunto di Alfred; `close` con trascrizione → una voce di storico `alfred_session`, nessuna colonna con la trascrizione; trascrizione di 20 001 caratteri → 400.
- [ ] **Step 2:** FAIL; implementare; verdi; commit «feat(casello): memoria di Alfred».

### Task 9: Console

**Files:**
- Create: `artifacts/casello/src/components/teams/lucius-panel.tsx`, `artifacts/casello/src/components/teams/role-instructions-card.tsx`, `artifacts/casello/src/components/account/memories-section.tsx`
- Modify: `artifacts/casello/src/pages/team-detail.tsx`, `artifacts/casello/src/components/teams/roles-editor.tsx`, `artifacts/casello/src/pages/account.tsx`, `artifacts/casello/src/components/alfred/use-alfred-voice.ts` (manda le battute trascritte a `close`)

**Interfaces:**
- `LuciusPanel({ instanceId, closed })`: elenco conversazioni, messaggi (riuso di `components/plan/markdown.tsx`), polling come `chat-panel.tsx` finché il turno è `running`, scelta del modello alla prima conversazione, segno di Lucius sulle risposte, «Scrivi a Lucius».
- `RoleInstructionsCard({ proposal, currentValue, onDecide })`: anteprima Markdown, confronto con il valore attuale (testo prima/dopo), «Accetta» (primario) / «Rifiuta» (secondario), stato con `Led` (`ask` pending, `ok` accettata, `idle` rifiutata, `ko` superata).
- Editor dei ruoli: per i ruoli con skill `ruolo-<key>` link «Scarica .md»; in testa «Scarica tutti i ruoli (.zip)» (link diretti alle route, sono scarichi, non fetch).
- `MemoriesSection`: schede Alfred / Lucius con i loro segni, appunti (aggiungi, modifica in linea, elimina; contatore «n di 50»), storico con ricerca e elimina.
- Alfred: alla chiusura volontaria («Basta così») invia `transcript` = battute «Tu:»/«Alfred:» della pagina, tagliate a 20 000 caratteri dalla fine.

- [ ] **Step 1:** typecheck e build del frontend; prova in console locale (squadra con due ruoli: conversazione, scheda accettata, scarico .md e .zip; Account → Memorie in chiaro e scuro; niente scorrimento orizzontale a 1280 px e 375 px).
- [ ] **Step 2:** commit «feat(casello): Lucius nella scheda squadra e memorie in Account».

### Task 10: Documentazione e verifica finale

**Files:**
- Modify: `CLAUDE.md` (sezioni «Squadre (definizione)», «Alfred», nuova sezione «Lucius sulla squadra e memorie», elenco tabelle), spec se il codice differisce.

- [ ] **Step 1:** `pnpm run typecheck`, test dell'API e di `casello-nodo` tutti verdi, build.
- [ ] **Step 2:** commit «docs(casello): Lucius sulla squadra e memorie».
