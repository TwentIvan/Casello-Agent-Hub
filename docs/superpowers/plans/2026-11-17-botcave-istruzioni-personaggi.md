# Istruzioni personali dei personaggi — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** l'utente scrive per Alfred e Lucius un testo in Markdown che si aggiunge in fondo alle istruzioni di sistema di ogni contesto
(versionato, ripristinabile); i personaggi possono proporne una versione nuova con una scheda da accettare; le istruzioni di Barbara
(prompt del suo agente) si leggono e modificano anche da Account → «Personaggi».

**Architecture:** modulo nuovo `artifacts/api-server/src/lib/characters/personal-instructions.ts` (regole del testo, versioni, blocco del
prompt) e `lib/characters/instruction-proposals.ts` (strumento per turno, lettura e decisione delle proposte); due tabelle nuove; il blocco
si aggiunge nei costruttori dei prompt già esistenti (personaggi, piano, squadra, architetto cloud e locale, Alfred a voce); route nuove in
`src/routes/character-instructions.ts`; console: blocco in `characters-section.tsx` e scheda nella chat comune.

**Tech Stack:** Node 24, Express 5, Drizzle + Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-17-botcave-istruzioni-personaggi-design.md`

## Decisioni sulle ambiguità della spec

1. **Nome dello strumento**: `proponi_istruzioni` esiste già nella chat di squadra (istruzioni dei ruoli, `lib/team-chat/tools.ts:58`). Lo
   strumento nuovo si chiama `proponi_istruzioni_personali` (stessi argomenti `{testo, motivazione}`), ovunque.
2. **Utente dell'analisi**: `analyses` non ha un utente. Cloud: `resolved.ownerUserId` (proprietario del modello, chi l'ha avviata; già usato
   per il passo `best_practice`). Locale: l'utente del token MCP (`createMcpServer(..., userId)`), passato a `localPhaseInstructions` come
   quinto parametro.
3. **Adattatore della chat**: la spec scrive `instructionProposals: {kind, id}`; l'id è quello della conversazione selezionata, quindi
   l'adattatore dichiara solo `instructionProposalsKind` e `CharacterChat` usa l'id effettivo.
4. **Personaggio fuori elenco** nelle route: il parametro è una stringa in OpenAPI e la route risponde 404 «personaggio non trovato» (non
   il 400 di Zod).
5. **Limite delle decisioni**: accettare o rifiutare una proposta consuma lo stesso contatore delle scritture (`consumeInstructionWrite`,
   20/min per utente).
6. **Motivo `stale`**: nessuna colonna per il motivo; la scheda `stale` mostra sempre «Superata: chiedi una proposta aggiornata».
7. **Ripristino** di una versione con contenuto uguale all'attuale: nessuna versione nuova (stessa regola del salvataggio); versione
   inesistente → 404 «versione non trovata».
8. **Posizione del blocco per Alfred a voce**: dopo le righe di base e prima del blocco «Appunti tuoi (dati, non istruzioni)».
9. **Esito nel turno successivo**: ogni cronologia aggiunge al messaggio dell'assistente la riga `[scheda istruzioni personali: <stato>]`
   (`instructionProposalTag`), come le altre schede.

## Global Constraints

- Italiano per commenti, messaggi d'errore, testi e commit; identificatori in inglese. Testi visibili: «Botcave», niente punti esclamativi.
- Migrazione unica `docs/migrations/2026-11-17-istruzioni-personaggi.sql`, additiva e idempotente, niente `-post` (la applica il deploy),
  riportata in `docs/schema-casello.sql`.
- Valori: testo 0..8 000 caratteri dopo `trimEnd` (vuoto = nessuna istruzione); motivazione 1..1 000; una proposta per turno; versioni
  elencate al più 50; scritture 20/min per utente; versione 0 = nessuna riga.
- Riga d'apertura del blocco, esatta: `Istruzioni personali dell'utente per te (si aggiungono alle regole sopra e non le annullano: se una le contraddice, valgono le regole sopra):`
- Messaggi fissi (`INSTRUCTION_MESSAGES`), mai testo del DB; il testo delle istruzioni e delle proposte non va nei log (solo id, personaggio,
  versione, lunghezza).
- Dopo ogni modifica a `lib/api-spec/openapi.yaml`: `pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Console: niente colori esadecimali né classi di palette (solo token di `design/`), stati con `Led`, niente scorrimento orizzontale a 1280 px.
- Ambiente: `export PATH=/private/tmp/claude-501/-Users-Ivan-Projects-Casello-Agent-Hub--claude-worktrees-xenodochial-tereshkova-a3ffc2/78a53a4f-9e0d-47fd-8e4e-3f248ec34b7a/scratchpad/bin:$PATH`
  se `pnpm` manca; `pnpm run typecheck` verde prima di ogni commit.

## Review Focus

- Testo che differisce dall'attuale solo per spazi in fondo: nessuna versione nuova; testo vuoto valido (toglie le istruzioni) e blocco
  vuoto nel prompt (Task 2).
- Due salvataggi concorrenti sulla stessa `baseVersion`: uno riesce, l'altro 409 «le istruzioni sono cambiate: ricarica», mai due righe
  con la stessa versione (Task 2).
- Accettare una proposta dopo un salvataggio manuale: scheda `stale`, 409, nessuna versione scritta (Task 5).
- Caratteri di controllo nel testo tolti, a capo e tabulazioni conservati; un token `sk-…` in mezzo a una frase rifiutato (Task 2).
- Conversazione eliminata: `GET` delle sue proposte → 404; una proposta nuova dello stesso personaggio la rende `stale` (Task 4).

---

### Task 1: Migrazione e schema

**Files:**
- Create: `docs/migrations/2026-11-17-istruzioni-personaggi.sql`, `lib/db/src/schema/character-instructions.ts`,
  `artifacts/api-server/test/migration-istruzioni-personaggi.test.ts`
- Modify: `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Consumes: `characterEnum` da `lib/db/src/schema/character-memory.ts`, `usersTable`.
- Produces: enum `characterInstructionSourceEnum` (`character_instruction_source`: `manual|proposal|restore`), `instructionConversationKindEnum`
  (`instruction_conversation_kind`: `character|plan_chat|team_chat`), `instructionProposalStatusEnum` (`instruction_proposal_status`:
  `pending|accepted|rejected|stale`); `characterInstructionsTable` (`id`, `userId` FK cascade, `character`, `version` int, `content` text,
  `source`, `proposalId` FK set null, `createdAt`; `uniqueIndex character_instructions_user_char_version_uniq (user_id, character, version)`;
  CHECK `version >= 1`); `characterInstructionProposalsTable` (`id`, `userId` FK cascade, `character`, `conversationKind`, `conversationId` int,
  `messageId` int null, `baseVersion` int, `content`, `reason`, `status` default `pending`, `decidedAt`, `createdAt`;
  `index character_instruction_proposals_conv_idx (conversation_kind, conversation_id)`); tipi `CharacterInstruction`, `CharacterInstructionProposal`.

- [ ] Step 1: test sul modello di `test/migration-lucius-best-practice.test.ts`: `docs/schema-casello.sql` senza le due tabelle e i tre enum
  (si tolgono nel test), poi il file applicato due volte; asserzioni: insert di due versioni uguali per utente e personaggio → errore di
  vincolo unico; `version = 0` → errore del CHECK; eliminare l'utente cancella righe e proposte; eliminare la proposta mette `proposal_id` a null.
- [ ] Step 2: `pnpm --filter @workspace/api-server exec vitest run test/migration-istruzioni-personaggi.test.ts` → FAIL (file mancante).
- [ ] Step 3: SQL con enum in `DO … EXCEPTION WHEN duplicate_object`, `CREATE TABLE IF NOT EXISTS`, vincoli FK in blocchi `IF NOT EXISTS`
  su `pg_constraint`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`; schema Drizzle; stesse definizioni in `docs/schema-casello.sql`.
  `character_instructions.proposal_id` si aggiunge dopo la creazione della tabella delle proposte.
- [ ] Step 4: il test → PASS; `pnpm --filter @workspace/api-server exec vitest run test/migrations-auto.test.ts` → PASS.
- [ ] Step 5: commit `feat(casello): schema delle istruzioni personali dei personaggi`.

### Task 2: Regole del testo, versioni e blocco del prompt

**Files:**
- Create: `artifacts/api-server/src/lib/characters/personal-instructions.ts`, `personal-instructions.test.ts`

**Interfaces:**
- Consumes: `looksLikeCredential` (`lib/memory/credentials.ts`), `Character` (`lib/memory/types.ts`), tabelle del Task 1.
- Produces:
  - `INSTRUCTIONS_MAX_CHARS = 8_000`, `INSTRUCTION_REASON_MAX = 1_000`, `INSTRUCTION_VERSIONS_LIST = 50`;
  - `INSTRUCTION_MESSAGES` = `{ tooLong: "istruzioni troppo lunghe: al massimo 8 000 caratteri", credential: "non salvo credenziali nelle istruzioni",
    changed: "le istruzioni sono cambiate: ricarica", characterNotFound: "personaggio non trovato", versionNotFound: "versione non trovata",
    rateLimited: "Troppe richieste: riprova tra poco", sameAsCurrent: "la proposta è uguale alle istruzioni attuali",
    badReason: "motivazione obbligatoria, al massimo 1 000 caratteri", onePerTurn: "hai già proposto in questo turno",
    proposalNotFound: "proposta non trovata", alreadyDecided: "proposta già decisa",
    proposalStale: "le istruzioni sono cambiate: chiedi una proposta aggiornata", conversationNotFound: "conversazione non trovata",
    proposalFailed: "proposta non riuscita: riprova più tardi" }`;
  - `class InstructionError extends Error { status: 400 | 404 | 409 | 429 }`;
  - `normalizeInstructions(text: string): string` (toglie i controlli tranne `\n` e `\t`, `trimEnd`; lancia `InstructionError` 400 `tooLong`/`credential`);
  - `getCurrentInstructions(userId, character, tx?): Promise<{ version: number; content: string; updatedAt: Date | null }>` (nessuna riga → `{0, "", null}`);
  - `listInstructionVersions(userId, character): Promise<Array<{ version; source; createdAt; length }>>` (dalla più recente, al più 50);
  - `getInstructionVersion(userId, character, version): Promise<{ version; source; content; createdAt }>` (404 `versionNotFound`);
  - `writeInstructionVersion(tx, input: { userId; character; content; baseVersion; source; proposalId?: number | null }): Promise<{ version; content; updatedAt; created: boolean }>`
    (testo già normalizzato; uguale all'attuale → `created: false`; `baseVersion` ≠ attuale o violazione del vincolo unico → 409 `changed`);
  - `saveInstructions(userId, character, content, baseVersion)` e `restoreInstructions(userId, character, version, baseVersion)`: stessa forma di ritorno, in una transazione;
  - `PERSONAL_INSTRUCTIONS_HEADER` (riga dei Global Constraints) e `personalInstructionsBlock(userId, character): Promise<string>` (`""` senza testo,
    altrimenti header + `\n` + testo); `withPersonalInstructions(system: string, block: string): string` (`block` vuoto → `system`, altrimenti `system + "\n\n" + block`).

- [ ] Step 1: test (PGlite come gli altri test di `lib/`): `normalizeInstructions("a\u0007b\n\tc  ")` = `"ab\n\tc"`; 8 001 caratteri → 400 `tooLong`,
  8 000 seguiti da spazi → ok; `"usa sk-abcdefghijklmnop1234 per entrare"` → 400 `credential`; prima `saveInstructions(u,"lucius","Dimmi sempre il costo",0)`
  → version 1, `created: true`; stesso testo con `"  \n"` in fondo e base 1 → version 1, `created: false`; base 0 dopo la versione 1 → 409 `changed`;
  `Promise.all` di due salvataggi su base 1 con testi diversi → uno version 2, l'altro 409, una sola riga con version 2; `restoreInstructions(u,"lucius",1,2)`
  → version 3 con il testo della 1 e `source = restore`; versione 9 → 404; `""` su base 3 → version 4 e `personalInstructionsBlock` = `""`;
  utenti e personaggi separati (Alfred non vede il testo di Lucius); `listInstructionVersions` ordinate dalla più recente con `length`.
- [ ] Step 2: `pnpm --filter @workspace/api-server exec vitest run src/lib/characters/personal-instructions.test.ts` → FAIL.
- [ ] Step 3: implementare le funzioni sopra (INSERT unica con `version = baseVersion + 1`; il 409 nasce dal confronto con l'attuale letto nella
  transazione o dal codice `23505`). Log solo id, personaggio, versione, lunghezza.
- [ ] Step 4: test → PASS; `pnpm run typecheck`.
- [ ] Step 5: commit `feat(casello): regole e versioni delle istruzioni personali`.

### Task 3: API delle istruzioni

**Files:**
- Create: `artifacts/api-server/src/routes/character-instructions.ts`, `character-instructions.test.ts`
- Modify: `lib/api-spec/openapi.yaml` (+ file generati), `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/src/middlewares/rate-limit.ts`

**Interfaces:**
- Consumes: funzioni del Task 2; `sessionOnly`, `currentUserId` (`lib/auth.ts`); `parseRequest`.
- Produces: `consumeInstructionWrite(userId: number): boolean` (20/min, contatore `fixedWindowCounter`); `createCharacterInstructionsRouter(): IRouter`
  (montato dopo `createCharactersRouter()`); OpenAPI, tag `characters`:
  - `GET /account/character-instructions/{character}` → `getCharacterInstructions` → `CharacterInstructions {character, version, content, updatedAt|null}`;
  - `GET …/{character}/versions` → `listCharacterInstructionVersions` → `CharacterInstructionVersionSummary[] {version, source, createdAt, length}`;
  - `GET …/{character}/versions/{version}` → `getCharacterInstructionVersion` → `CharacterInstructionVersion {version, source, content, createdAt}`;
  - `PUT …/{character}` → `updateCharacterInstructions`, corpo `CharacterInstructionsUpdate {content: string, baseVersion: integer ≥ 0}` → `CharacterInstructions`;
  - `POST …/{character}/restore` → `restoreCharacterInstructions`, corpo `CharacterInstructionsRestore {version ≥ 1, baseVersion ≥ 0}` → `CharacterInstructions`.
  `character` è `string`; la route accetta solo `alfred|lucius`, altrimenti 404. Scritture `sessionOnly` + `consumeInstructionWrite` (429). Errori `{error}`.

- [ ] Step 1: test di route sul modello di `src/routes/account-characters.test.ts`: GET senza righe → `{version: 0, content: "", updatedAt: null}`;
  `GET …/barbara` → 404 «personaggio non trovato»; PUT → 200 version 1, poi PUT con base 0 → 409 «le istruzioni sono cambiate: ricarica»; PUT
  9 000 caratteri → 400; restore; versions e versions/:version; GET con token `cas_` `api:read` → 200, PUT con token `api:write` → 403
  (`sessionOnly`), PUT con token d'ambito `agent` → 403; 21ª scrittura nel minuto → 429.
- [ ] Step 2: `pnpm --filter @workspace/api-server exec vitest run src/routes/character-instructions.test.ts` → FAIL.
- [ ] Step 3: OpenAPI, `pnpm --filter @workspace/api-spec run codegen`, route e contatore.
- [ ] Step 4: test → PASS; `pnpm run typecheck`.
- [ ] Step 5: commit `feat(casello): API delle istruzioni personali dei personaggi`.

### Task 4: Blocco nei prompt di ogni contesto

**Files:**
- Modify: `artifacts/api-server/src/lib/characters/run-turn.ts`, `lib/plan-chat/context.ts`, `lib/plan-chat/run-turn.ts`, `lib/team-chat/context.ts`,
  `lib/team-chat/run-turn.ts`, `lib/architect/run-analysis.ts`, `lib/architect/local-executor.ts`, `lib/mcp/server.ts`, `lib/alfred/instructions.ts`,
  `lib/alfred/sessions.ts`
- Test: `src/lib/characters/run-turn.test.ts`, `src/lib/plan-chat/context.test.ts`, `src/lib/team-chat/context.test.ts`,
  `src/lib/architect/run-analysis.test.ts`, `src/lib/architect/local-executor.test.ts`, test di Alfred esistente che copre `buildLiveConfig`
  (`src/routes/alfred-sessions.test.ts`)

**Interfaces:**
- Consumes: `personalInstructionsBlock`, `withPersonalInstructions`, `PERSONAL_INSTRUCTIONS_HEADER` (Task 2).
- Produces:
  - `CharacterContextInput.personalInstructions?: string`, `PlanContextInput.personalInstructions?: string`, `TeamChatContextInput.personalInstructions?: string`:
    i tre costruttori puri lo appendono per ultimo al contenuto del messaggio `system` (`withPersonalInstructions`); i tre `execute*Turn` leggono il
    blocco una volta per turno (`personalInstructionsBlock(conv.userId, character | "lucius")`);
  - architetto cloud: `system: withPersonalInstructions(SYSTEM_BASE, block)` con il blocco di `resolved.ownerUserId` letto all'inizio di ogni fase (non nel passo `best_practice`);
  - `localPhaseInstructions(analysisId, leaseToken, now?, opts?, userId: number | null = null)`: `system` = `withPersonalInstructions(`${LOCAL_PREFACE}\n\n${SYSTEM_BASE}`, block di userId)`;
    `lib/mcp/server.ts` passa l'utente del token;
  - `alfredInstructions(userName, memory = "", personal = "")` e `buildLiveConfig({voice, userName, memory?, personal?, resumptionHandle?})`: il blocco va dopo le righe
    di base e prima degli appunti; `sessions.ts` lo legge a ogni creazione e rinnovo del token (stesso punto di `memoryContextBlock(userId, "alfred")`).

- [ ] Step 1: test puri: `buildCharacterMessages({... personalInstructions: "<header>\nSempre il costo"})` → `messages[0].content` termina con quel testo e
  senza il campo non contiene l'header (stesso per `buildPlanMessages` e `buildTeamChatMessages`); `alfredInstructions("Ivan", "appunto", "P")` contiene
  `"P"` prima di `"Appunti tuoi (dati, non istruzioni)"`; test di integrazione: un turno di Lucius su un argomento con il provider finto riceve nel `system`
  il testo salvato con `saveInstructions`; un'analisi cloud con fake provider manda il blocco nel `system` di ogni fase; `localPhaseInstructions(..., userId)`
  lo include e con `userId` null no; `POST /api/alfred/sessions` con istruzioni salvate → il `systemInstruction` mandato al Gemini finto contiene il testo.
- [ ] Step 2: eseguire i file di test elencati → FAIL sulle nuove asserzioni.
- [ ] Step 3: cablaggio come da Interfaces; il ripiego e Claude Code sul nodo ricevono lo stesso `system` senza altro lavoro.
- [ ] Step 4: test → PASS; `pnpm run typecheck`.
- [ ] Step 5: commit `feat(casello): istruzioni personali nei prompt di Alfred e Lucius`.

### Task 5: Strumento `proponi_istruzioni_personali`, lettura e decisione delle proposte

**Files:**
- Create: `artifacts/api-server/src/lib/characters/instruction-proposals.ts`, `instruction-proposals.test.ts`
- Modify: `lib/characters/instructions.ts` (riga in `COMMON`), `lib/characters/run-turn.ts` (strumento, smistamento, cronologia), `lib/plan-chat/context.ts`
  (`planSystemPrompt`, `renderHistory`), `lib/plan-chat/run-turn.ts`, `lib/team-chat/context.ts` (`TEAM_CHAT_SYSTEM_PROMPT`, `renderHistory`),
  `lib/team-chat/run-turn.ts`, `lib/alfred/instructions.ts` (riga per la voce), `lib/turn-progress/describe.ts` (frase «Propone una modifica alle sue istruzioni»)

**Interfaces:**
- Consumes: Task 2 (`normalizeInstructions`, `getCurrentInstructions`, `writeInstructionVersion`, `INSTRUCTION_MESSAGES`, `InstructionError`); `toolOk`/`toolFail` (`lib/characters/types.ts`).
- Produces:
  - `INSTRUCTION_PROPOSAL_TOOL_NAME = "proponi_istruzioni_personali"`, `INSTRUCTION_PROPOSAL_TOOL: ChatCompletionFunctionTool` (`testo` string, `motivazione` string, entrambi obbligatori),
    `isInstructionProposalTool(name: string): boolean`;
  - `INSTRUCTION_PROPOSAL_RULE` (riga di base): proporre solo quando l'utente chiede una regola stabile («d'ora in poi», «sempre», «mai») o conferma di volerla;
    le preferenze piccole restano appunti; `testo` è il testo completo nuovo (le istruzioni attuali, che sono in fondo a queste istruzioni, più la modifica);
    una proposta per turno; la proposta si applica solo con il clic dell'utente;
  - `ALFRED_VOICE_INSTRUCTION_LINE` in `alfredInstructions`: a voce non proponi; per un cambio stabile l'utente lo chiede nel filo scritto o in Account → Personaggi;
  - `type InstructionConversationKind = "character" | "plan_chat" | "team_chat"`;
  - `class InstructionProposer { constructor(ctx: { userId; character: Character; conversationKind; conversationId: number; messageId: number | null }); run(rawArgs: string): Promise<string> }`
    (una per turno; risultato `toolOk({id})` o `toolFail(messaggio fisso)`, mai eccezioni);
  - `instructionProposalTag(status: string): string` → `[scheda istruzioni personali: <status>]`; `loadInstructionProposalStatuses(kind, conversationId): Promise<Map<number, string[]>>` (per `messageId`);
  - `listInstructionProposals(userId, kind, conversationId): Promise<InstructionProposalView[]>` con `InstructionProposalView = { id; character; content; reason; status; baseVersion; currentContent; messageId: number | null; createdAt }`
    (conversazione non dell'utente o inesistente → `InstructionError` 404 `conversationNotFound`);
  - `decideInstructionProposal(userId, proposalId, action: "accept" | "reject"): Promise<InstructionProposalView>`.
  - Offerta dello strumento: Alfred nel filo scritto e Lucius sugli argomenti (`run-turn.ts` dei personaggi: `conversationKind "character"`), Lucius nel piano
    (`plan_chat`) e nella squadra (`team_chat`); mai a voce, nelle analisi, a Barbara.

- [ ] Step 1: test di `InstructionProposer.run`: argomenti non JSON o `motivazione` vuota/oltre 1 000 → `ok:false` `badReason`; `testo` uguale all'attuale (anche con
  spazi in fondo) → `sameAsCurrent`; testo con credenziale → `credential`; prima chiamata → `ok:true, id` con `baseVersion` attuale e `messageId`; seconda nello stesso
  turno → `onePerTurn`; una proposta nuova (turno nuovo) porta a `stale` le `pending` dello stesso utente e personaggio, non quelle dell'altro personaggio né di altri utenti.
- [ ] Step 2: test della decisione: accept → versione `attuale + 1` con `source = proposal` e `proposal_id`, proposta `accepted` con `decidedAt`; reject → `rejected`,
  nessuna versione; già decisa → 409 `alreadyDecided`; di un altro utente → 404 `proposalNotFound`; dopo un `saveInstructions` manuale → 409 `proposalStale`, proposta
  `stale` (scritta fuori dalla transazione annullata), nessuna versione. Lettura: `currentContent` uguale alla versione attuale; conversazione altrui o eliminata → 404.
- [ ] Step 3: test dei contesti: `buildCharacterMessages`, `buildPlanMessages`, `buildTeamChatMessages` con un messaggio dell'assistente che ha lo stato `accepted` →
  la riga `[scheda istruzioni personali: accepted]` nella cronologia; il `system` contiene `INSTRUCTION_PROPOSAL_RULE`; i tre turni offrono `proponi_istruzioni_personali`
  (asserzione sugli strumenti passati al provider finto) e il nome non collide con `proponi_istruzioni` della squadra.
- [ ] Step 4: `pnpm --filter @workspace/api-server exec vitest run src/lib/characters/instruction-proposals.test.ts src/lib/characters/run-turn.test.ts src/lib/plan-chat src/lib/team-chat` → FAIL.
- [ ] Step 5: implementare. Decisione: in una transazione, UPDATE condizionato `pending → accepted` (0 righe → 409 o 404), lettura dell'attuale, `baseVersion` diverso →
  rollback e UPDATE separato a `stale` + 409; altrimenti `writeInstructionVersion(..., source "proposal", proposalId)`. La cronologia dei tre `loadHistory` aggiunge gli stati
  con `loadInstructionProposalStatuses`.
- [ ] Step 6: test → PASS; `pnpm run typecheck`.
- [ ] Step 7: commit `feat(casello): Alfred e Lucius propongono le proprie istruzioni`.

### Task 6: Route delle proposte

**Files:**
- Modify: `artifacts/api-server/src/routes/character-instructions.ts`, `character-instructions.test.ts`, `lib/api-spec/openapi.yaml` (+ file generati)

**Interfaces:**
- Consumes: `listInstructionProposals`, `decideInstructionProposal` (Task 5); `sessionOrEmbed` (`lib/auth.ts`); `consumeInstructionWrite`.
- Produces: OpenAPI, tag `characters`:
  - `GET /character-instruction-proposals?conversationKind=character|plan_chat|team_chat&conversationId=n` → `listCharacterInstructionProposals` → `CharacterInstructionProposal[]`
    (campi di `InstructionProposalView`; `createdAt` ISO);
  - `POST /character-instruction-proposals/{id}/decision` corpo `CharacterInstructionProposalDecision {action: accept|reject}` → `decideCharacterInstructionProposal` → `CharacterInstructionProposal`.
  Entrambe `sessionOrEmbed`; la decisione consuma `consumeInstructionWrite` (429).

- [ ] Step 1: test: con sessione elenco e decisione (accept, 409 già decisa, 409 superata); token embed (`embed-token.test.ts` come modello) → 200; token `cas_` `api:write` → 403;
  token `agent` → 403; conversazione di un altro utente → 404; `conversationKind` fuori elenco → 400.
- [ ] Step 2: `pnpm --filter @workspace/api-server exec vitest run src/routes/character-instructions.test.ts` → FAIL.
- [ ] Step 3: OpenAPI, codegen, route.
- [ ] Step 4: test → PASS; `pnpm run typecheck`.
- [ ] Step 5: commit `feat(casello): API delle proposte di istruzioni`.

### Task 7: Console, Account → «Personaggi»

**Files:**
- Create: `artifacts/casello/src/components/account/personal-instructions-block.tsx`, `artifacts/casello/src/components/account/barbara-instructions-block.tsx`,
  `artifacts/casello/src/lib/instructions-text.ts`, `instructions-text.test.ts`
- Modify: `artifacts/casello/src/components/account/characters-section.tsx`

**Interfaces:**
- Consumes: hook generati `useGetCharacterInstructions`, `useListCharacterInstructionVersions`, `useGetCharacterInstructionVersion`, `useUpdateCharacterInstructions`,
  `useRestoreCharacterInstructions`; `useGetLeadChat`, `useGetAgent`, `useUpdateAgent` (`systemPrompt`); `lineDiff`/`DiffLine` di `src/lib/architecture.ts`; `apiErrorMessage`.
- Produces: `INSTRUCTIONS_MAX_CHARS = 8000` e `instructionsCounter(text: string): { length: number; over: boolean }` (lunghezza dopo `trimEnd`) in `lib/instructions-text.ts`;
  `PersonalInstructionsBlock({ character: "alfred" | "lucius" })`; `BarbaraInstructionsBlock()`.

- [ ] Step 1: test di `instructionsCounter`: `"abc  \n"` → `{3, false}`, 8 001 caratteri → `over: true`.
- [ ] Step 2: `pnpm --filter @workspace/casello exec vitest run src/lib/instructions-text.test.ts` → FAIL; poi implementare → PASS.
- [ ] Step 3: `PersonalInstructionsBlock`: titolo «Istruzioni personali», avviso «Si aggiungono alle istruzioni di base: non possono annullarne le regole», area di testo
  con contatore (`instructionsCounter`, «Salva» disattivato oltre 8 000), «Anteprima» (Markdown come nelle chat), «Salva» (PUT con `baseVersion` letta), «Versione N · data»,
  «Versioni» (dialogo: elenco, apertura, confronto con `lineDiff` contro l'attuale, «Ripristina»); un 409 mostra «Le istruzioni sono cambiate: ricarica» con «Ricarica»
  (refetch e testo sostituito). Inserito nei blocchi di Alfred e di Lucius di `CharactersSection`.
- [ ] Step 4: `BarbaraInstructionsBlock`: terza sezione «Barbara» in `CharactersSection` con «Istruzioni» = `systemPrompt` dell'agente di `GET /lead-chat` (`agentId`),
  «Salva» con la PATCH esistente, link «Apri l'agente di Barbara» (`/agents/:id`); non disponibile (`available: false`) → il `reason`.
- [ ] Step 5: `pnpm --filter @workspace/casello run test`, `pnpm run typecheck`; controllo a 1280 px nella console (`AUTH_DISABLED=true pnpm run dev`) senza scorrimento orizzontale.
- [ ] Step 6: commit `feat(casello): istruzioni personali in Account`.

### Task 8: Console, scheda della proposta nella chat comune

**Files:**
- Create: `artifacts/casello/src/components/characters/instruction-proposal-card.tsx`, `artifacts/casello/src/components/characters/use-instruction-proposals.ts`,
  `artifacts/casello/src/lib/instruction-proposals.ts`, `instruction-proposals.test.ts`
- Modify: `components/characters/adapters.ts` (`ChatAdapter.instructionProposalsKind?`), `character-adapters.ts` (Alfred e Lucius: `"character"`),
  `plan-team-adapters.tsx` (`"plan_chat"`, `"team_chat"`), `character-chat.tsx`, `chat-messages.tsx`

**Interfaces:**
- Consumes: `useListCharacterInstructionProposals`, `useDecideCharacterInstructionProposal`, tipo `CharacterInstructionProposal`; `lineDiff`; `Led`.
- Produces:
  - `instructionCardState(p: Pick<CharacterInstructionProposal, "status">): { led: LedState; label: string; canDecide: boolean }` — `pending` → `ask`, «Da decidere», true;
    `accepted` → `ok`, «Accettata»; `rejected` → `idle`, «Rifiutata»; `stale` → `idle`, «Superata: chiedi una proposta aggiornata»;
  - `proposalsByMessage(list, messageIds: number[]): { byMessage: Map<number, CharacterInstructionProposal[]>; trailing: CharacterInstructionProposal[] }`
    (`messageId` null o non tra i messaggi → `trailing`, mostrate in fondo);
  - `useInstructionProposals(kind: InstructionConversationKind | undefined, conversationId: number | null, running: boolean)` (refetch ogni 2 s mentre `running`, una volta
    a fine turno, invalidato dopo una decisione);
  - `InstructionProposalCard({ proposal, readOnly, onDecided })`: motivazione, confronto riga per riga `lineDiff(currentContent, content)`, «Accetta» / «Rifiuta», LED e
    stato; errore 409 nel toast con il messaggio del server. `ChatMessages` riceve `instructionProposals` già raggruppate.

- [ ] Step 1: test di `instructionCardState` (quattro stati) e `proposalsByMessage` (messaggio noto, `messageId` null, messaggio eliminato).
- [ ] Step 2: `pnpm --filter @workspace/casello exec vitest run src/lib/instruction-proposals.test.ts` → FAIL; implementare → PASS.
- [ ] Step 3: hook, scheda e cablaggio in `CharacterChat` (solo con `instructionProposalsKind`; la chat di Barbara non lo dichiara). Vale in console, pannello ed embed.
- [ ] Step 4: `pnpm --filter @workspace/casello run test`, `pnpm run typecheck`; prova a mano: chiedere a Lucius nel piano «d'ora in poi dimmi sempre il costo stimato»,
  accettare la scheda, verificare in Account la versione nuova e al turno dopo il comportamento.
- [ ] Step 5: commit `feat(casello): schede delle proposte di istruzioni nelle chat`.

### Task 9: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] Step 1: voce in «Stato» (istruzioni personali di Alfred e Lucius, proposte con scheda, Barbara dalla carta «Personaggi», con la spec); in «Dove stanno le cose»
  i file nuovi (`lib/characters/personal-instructions.ts`, `instruction-proposals.ts`, `routes/character-instructions.ts`, schema `character-instructions.ts`, componenti
  della console) e le due tabelle nell'elenco dello schema; sezione nuova «Istruzioni personali dei personaggi» con regole, valori, route, strumento
  `proponi_istruzioni_personali` (e perché non `proponi_istruzioni`), dove entra il blocco, utente dell'analisi, migrazione, fuori ambito.
- [ ] Step 2: `pnpm run typecheck` e tutti i test: `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test` → verdi.
- [ ] Step 3: commit `docs(casello): istruzioni personali dei personaggi in CLAUDE.md`.
