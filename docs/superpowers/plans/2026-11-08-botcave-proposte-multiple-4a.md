# Proposte multiple (4a) — piano di implementazione

> **Per chi esegue:** sotto-skill richiesta: superpowers:subagent-driven-development (consigliata) o superpowers:executing-plans,
> un compito alla volta. I passi usano le caselle (`- [ ]`).

**Obiettivo:** una voce `proposal` in «Da confermare»: più passi ordinati (tool di servizio dell'app) con riferimenti agli id creati dai
passi precedenti, proposta da un agente con lo strumento interno `proponi`, approvata per intero o in parte, rifiutata, eseguita in ordine
fino al primo errore; visibile e decidibile da console, pannello incorporato e Alfred.

**Architettura:** la voce resta una riga di `pending_actions` (`kind = proposal`, proposta cifrata in `args_enc`, copia oscurata in
`args_public`); l'esito per passo sta nella tabella nuova `pending_action_steps`. La logica pura (forma della proposta, riferimenti,
dipendenze) sta in `lib/actions/proposal.ts`; la creazione (`proponi`) in `lib/actions/propose.ts`; l'esecuzione in
`lib/actions/proposal-exec.ts`, chiamata da `approveAction`. La vista (`proposal` nella `QueuedAction`) la costruisce
`lib/actions/proposal-view.ts`, usata da route, centralino e Alfred.

**Tecnologie:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-08-botcave-proposte-multiple-design.md` (§3, §4; fuori ambito §5, §6, §7).

## Vincoli globali

- Testi visibili in italiano, «Botcave» nei testi, codice e identificatori in inglese; commit `feat(casello): …` in italiano.
- Messaggi fissi della spec, alla lettera: «riferimento non valido nel passo pK», «hai già proposto in questa run: usa la discussione»,
  «passi da escludere non validi», «nessun passo da eseguire: rifiuta la proposta», «riferimento non risolto», «strumento non più
  utilizzabile», «eseguiti n passi su m: si è fermata al passo pK», «esito incerto: verifica sul servizio».
- Limiti: titolo 1..200, motivo ≤ 1 000, 1..20 passi, id `p1`…`p20` nell'ordine, sintesi 1..300, riferimento = stringa intera
  `{{pN.campo(.sottocampo){0,4}}}` con segmenti `^[A-Za-z0-9_-]{1,64}$`, risultato di un passo ≤ 20 000 caratteri, `summary` della voce
  = titolo, `recipient` = nome dell'app.
- Nei passi solo tool della stessa app, `active`, `http`/`mcp`, livello effettivo ≠ L3, identità `service`; per un agente `area` solo i
  suoi tool collegati.
- Un'eccezione dello strumento non ferma la run: risultati `ok: false` con messaggio fisso. Mai argomenti, risultati o segreti nei log
  (solo id e nome dell'errore).
- Migrazione additiva e idempotente, niente `-post`, niente BEGIN/COMMIT (contiene `ALTER TYPE … ADD VALUE`); riportata in
  `docs/schema-casello.sql`; SQL completo a Ivan in chat prima della PR.
- Niente colori o esadecimali nella console: token e LED (`Led`/`LedDot`); niente scorrimento orizzontale a 1280 px.
- `pnpm run typecheck`, test dell'API e della console verdi prima di ogni commit che li tocca.

## Punti da guardare in revisione

1. **Tipo dei valori sostituiti**: `{{p1.id}}` con `id: 7` deve arrivare al passo come numero 7, non come stringa "7" (schema
   `type: integer` del tool successivo). Test nel compito 2 e 4.
2. **Riferimenti risolti dal risultato completo**: un tool HTTP con `responseFields` o una risposta oltre 20 000 caratteri non deve
   perdere il campo citato; si esegue con `raw: true` e si tronca solo ciò che si salva. Test nel compito 4.
3. **Rifiuto e approvazione instradati per tipo**: oggi `rejectAction` e `approveAction` mandano ogni `kind ≠ action` a
   `decidePlanItem`; una proposta deve restare fuori (rifiuto = UPDATE semplice). Test nel compito 4.
4. **Tool cambiato tra proposta e approvazione** (disattivato, livello alzato a L3, identità `user`): il passo diventa `failed`
   «strumento non più utilizzabile», quelli prima restano `done`, quelli dopo `not_run`. Test nel compito 4.
5. **Esclusioni a catena e tutte escluse**: escludere `p1` salta `p3` che usa `p2` che usa `p1`; escludere tutto (anche solo per
   catena) → 400 senza toccare la voce; `escludi` su una voce non `proposal` → 400. Test nei compiti 2 e 4.

---

### Compito 1: Schema e migrazione

**File:**
- Modifica: `lib/db/src/schema/pending-actions.ts` (valore `proposal`), `lib/db/src/schema/alfred.ts` (`alfred_confirmations.exclude_steps`)
- Crea: `lib/db/src/schema/pending-action-steps.ts` (export in `lib/db/src/schema/index.ts`)
- Crea: `docs/migrations/2026-11-proposte-multiple.sql`; modifica `docs/schema-casello.sql`
- Test: `artifacts/api-server/test/migration-proposte-multiple.test.ts`

**Interfacce prodotte:**
- `pendingActionStepStatusEnum` = `pending_action_step_status` (`pending|excluded|skipped|done|failed|not_run`)
- `pendingActionStepsTable`: `id` serial, `pendingActionId` (FK `pending_actions`, `CASCADE`), `key` text, `position` int, `toolId`
  (FK `app_tools`, `RESTRICT`), `summary` text, `status` (default `pending`), `result` text, `errorMessage` text, `finishedAt`
  timestamp; `UNIQUE(pending_action_id, key)` (`pending_action_steps_action_key_unique`), indice su `tool_id`. Tipo `PendingActionStepRow`.
- `alfredConfirmationsTable.excludeSteps`: jsonb nullable (array di id di passi).

- [ ] **Passo 1: test della migrazione.** Come `migration-inneschi.test.ts`: `schema-pre-nodo-locale.sql`, tutte le migrazioni fino a
  `2026-11-inneschi`, poi `2026-11-proposte-multiple` due volte. Asserzioni: `enum_range(NULL::pending_action_kind)` termina con
  `proposal`; esiste `pending_action_steps` con i sei stati; inserire un passo con `tool_id` usato e poi cancellare il tool → errore FK;
  cancellare la voce cancella i passi; colonna `alfred_confirmations.exclude_steps` jsonb nullable.
- [ ] **Passo 2:** eseguire `pnpm --filter @workspace/api-server exec vitest run test/migration-proposte-multiple.test.ts` → FAIL (file mancante).
- [ ] **Passo 3:** scrivere la migrazione (blocchi `DO $$ … IF NOT EXISTS` per tipo e vincoli, `CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`), lo schema Drizzle e la stessa struttura in `docs/schema-casello.sql`. Nessun CHECK che citi il valore
  `proposal` (un valore nuovo di un enum non si usa nella stessa transazione di PGlite): `app_id` obbligatorio lo garantisce il codice.
- [ ] **Passo 4:** test della migrazione e `pnpm --filter @workspace/api-server run test` (lo schema dei test viene da
  `docs/schema-casello.sql`) → PASS; `pnpm run typecheck` → PASS.
- [ ] **Passo 5:** commit `feat(casello): schema delle proposte multiple`.

### Compito 2: Logica pura della proposta

**File:** Crea `artifacts/api-server/src/lib/actions/proposal.ts`; test `…/lib/actions/proposal.test.ts`.

**Interfacce prodotte:**
```ts
export const PROPOSAL_MESSAGES: { badRef: (key: string) => string; alreadyProposed: string; badExclude: string;
  nothingToRun: string; unresolved: string; toolUnusable: string; stoppedAt: (done: number, total: number, key: string) => string };
export const PROPOSAL_TITLE_MAX = 200, PROPOSAL_REASON_MAX = 1_000, PROPOSAL_STEPS_MAX = 20, STEP_SUMMARY_MAX = 300;
export interface ProposalStepInput { key: string; toolName: string; args: Record<string, unknown>; summary: string }
export interface ProposalInput { title: string; reason: string | null; steps: ProposalStepInput[] }
export interface StepRef { param: string; step: string; field: string[] } // param = percorso puntato negli argomenti, es. "projectId" o "dati.cliente"
export function parseProposalArgs(args: Record<string, unknown>): { ok: true; value: ProposalInput } | { ok: false; message: string };
export function stepRefs(args: unknown): StepRef[] | { badRef: true };
export function resolveRefs(args: Record<string, unknown>, results: Map<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false };
export function planExclusion(steps: { key: string; refs: StepRef[] }[], exclude: string[]):
  { ok: true; excluded: Set<string>; skipped: Set<string> } | { ok: false; message: string };
```

- [ ] **Passo 1: test.** Casi, con i valori della spec:
  - `parseProposalArgs` accetta `{titolo, motivo?, passi:[{id, strumento, argomenti, sintesi}]}` e lo traduce; rifiuta titolo vuoto o
    > 200, motivo > 1 000, 0 o 21 passi, sintesi vuota o > 300, `argomenti` non oggetto, id `p2` al primo posto o `p1` ripetuto (messaggio
    «id dei passi non validi: p1, p2… nell'ordine»).
  - Riferimenti: `{{p1.id}}` in `p2` ok; `{{p2.id}}` in `p2` o `{{p3.id}}` in `p2` o `{{p9.id}}` inesistente →
    «riferimento non valido nel passo p2»; `"progetto {{p1.id}}"` (dentro una stringa più lunga) → stesso messaggio; 6 segmenti o
    segmento `a.b c` → stesso messaggio; riferimenti dentro array e oggetti annidati trovati con il loro `param`.
  - `resolveRefs`: `{{p1.id}}` con risultato `{id: 7}` → `7` numero; `{{p1.data.id}}` annidato; campo mancante, risultato non oggetto o
    `__proto__`/proprietà ereditate → `{ok:false}`.
  - `planExclusion`: `p1→p2→p3` (p3 usa p2, p2 usa p1), escludi `["p1"]` → excluded `{p1}`, skipped `{p2,p3}`, `{ok:false,
    nothingToRun}`; escludi `["p2"]` su `p1,p2,p3(usa p2),p4` → skipped `{p3}`; `["p1","p1"]` o `["p9"]` → `badExclude`; `[]` → nessuna
    esclusione.
- [ ] **Passo 2:** `pnpm --filter @workspace/api-server exec vitest run src/lib/actions/proposal.test.ts` → FAIL.
- [ ] **Passo 3:** implementare (funzioni pure; regex del riferimento
  `^\{\{(p(?:[1-9]|1\d|20))\.([A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,4})\}\}$`; una stringa che contiene `{{p` seguito da cifra
  e non è un riferimento intero è un riferimento non valido; accesso solo a proprietà proprie con `Object.hasOwn`).
- [ ] **Passo 4:** test → PASS.
- [ ] **Passo 5:** commit `feat(casello): forma e riferimenti delle proposte multiple`.

### Compito 3: Strumento interno `proponi` e accodamento

**File:**
- Crea `artifacts/api-server/src/lib/actions/propose.ts`; modifica `lib/actions/queue.ts` (`enqueueProposal`), `lib/teams/role-tools.ts`
  (`proponi` in `INTERNAL_TOOL_NAMES`), `lib/run-executor.ts` (offerta e smistamento degli strumenti interni per nome).
- Test: `lib/actions/propose.test.ts`, un caso in `lib/run-executor.test.ts`.

**Interfacce:**
- Consuma: `parseProposalArgs`, `stepRefs`, `PROPOSAL_MESSAGES` (compito 2); `checkQueuedText`, `maskArgsWithSchema`, `validateArgs`.
- Produce:
```ts
export const PROPOSE_TOOL_NAME = "proponi";
export function proposeTool(): CatalogTool;               // schema della spec §4.2 (titolo, motivo, passi[id, strumento, argomenti, sintesi])
export function proposalEligible(tool: CatalogTool): boolean; // active, http|mcp, livello effettivo ≠ L3, identity service
export async function handlePropose(ctx: { run: Run; agent: Agent; app: App; tools: CatalogTool[]; owner: () => Promise<number | null> },
  args: Record<string, unknown>): Promise<ToolResult>;    // content JSON {ok:true, numero}
// queue.ts
export async function enqueueProposal(input: { userId: number; appId: number; agentId: number; runId: number; recipient: string;
  proposal: ProposalInput; publicProposal: Record<string, unknown>; steps: { key: string; position: number; toolId: number; summary: string }[] }): Promise<EnqueueResult>;
```

- [ ] **Passo 1: test di `handlePropose`** (DB dei test, app con tool `create_project` e `create_task` service L2 e un tool `user`):
  proposta di 2 passi con `{{p1.id}}` → `{ok:true, numero}`; nella voce `kind = proposal`, `tool_id` null, `app_id` dell'agente, `run_id`,
  `agent_id`, `summary` = titolo, `recipient` = nome dell'app, `args_public` con `x-sensitive` oscurati, due righe `pending_action_steps`
  `pending` con `position` 0 e 1; `args_enc` decifrato = `{title, reason, steps:[{key, toolName, args, summary}]}`. Errori `ok: false`
  (nessuna voce creata): strumento sconosciuto o non tra quelli dell'agente → «strumento <nome> non disponibile per le proposte»; tool `user`
  → stesso messaggio; argomenti senza riferimenti che non rispettano lo schema → «argomenti non validi nel passo p1: …»; segnaposto
  `[nome]` in una sintesi → «testo non pronto: …»; seconda chiamata nella stessa run con la prima ancora `pending` →
  `alreadyProposed`; proprietario nullo → `QUEUE_FAILED`; 50 voci in attesa → `TOO_MANY_PENDING_MESSAGE`.
- [ ] **Passo 2: test in `run-executor.test.ts`:** l'agente `general` con tool idonei riceve `proponi` tra gli strumenti offerti al
  modello e una chiamata del modello a `proponi` crea la voce (la run prosegue fino a `succeeded`).
- [ ] **Passo 3:** test → FAIL.
- [ ] **Passo 4: implementare.** `enqueueProposal` riusa `insertQueued` dentro una transazione e inserisce i passi nella stessa
  transazione. In `loadContext` il tool `proponi` si aggiunge (dopo `withConfirmedWrites`, togliendo un tool omonimo) se tra i tool
  caricati dell'agente ce n'è almeno uno `proposalEligible`; `handlePropose` riceve i tool **caricati prima** di `withConfirmedWrites` e
  degli strumenti interni. In `driveLoop` lo smistamento dei tool interni diventa per nome (`proponi` → `handlePropose`, altrimenti
  `handleEscalation`); il proprietario si legge con la stessa memoizzazione di `queueAction` (estrarla in una funzione `ownerOf`).
  Controllo «già proposto»: voce `kind = proposal`, `status = pending`, stesso `run_id`. Controllo del testo: titolo come `summary`,
  sintesi dei passi e argomenti oscurati di ogni passo in `args`, `recipient` = nome dell'app.
- [ ] **Passo 5:** test → PASS; typecheck.
- [ ] **Passo 6:** commit `feat(casello): strumento interno proponi`.

### Compito 4: Decisione ed esecuzione

**File:** Crea `lib/actions/proposal-exec.ts`; modifica `lib/actions/decide.ts`, `routes/app-tools.ts` (tool usato da un passo → 409
`TOOL_HAS_ACTIONS`). Test: `lib/actions/proposal-exec.test.ts` (fake MCP con risultati JSON), `lib/actions/decide.test.ts`.

**Interfacce:**
- Consuma: `planExclusion`, `resolveRefs`, `PROPOSAL_MESSAGES` (compito 2); `enqueueProposal` (compito 3, per preparare i test).
- Produce:
```ts
// decide.ts
export async function approveAction(userId: number, number: number, opts?: { userToken?: string; exclude?: string[] }): Promise<DecideResult>;
export async function failInterruptedActions(): Promise<number>; // anche i passi `pending` delle proposte rimaste `executing` → `not_run`
// proposal-exec.ts
export async function approveProposal(userId: number, action: PendingActionRow, exclude: string[]): Promise<DecideResult>;
export async function loadProposalSteps(actionIds: number[]): Promise<Map<number, PendingActionStepRow[]>>;
```

- [ ] **Passo 1: test.**
  - Approva tutto: passo 1 `create_project` risponde `{"id":7}`, passo 2 `create_task` con `projectId: "{{p1.id}}"` riceve `projectId: 7`
    (numero, letto dalle `calls` del fake); voce `done`, passi `done` con `result` e `finished_at`.
  - Esclusione: `escludi ["p1"]` su p1, p2(usa p1), p3 → p1 `excluded`, p2 `skipped`, p3 `done`, voce `done`.
  - Errori 400 senza cambiare la voce (resta `pending`): `["p1","p1"]`, `["p9"]` → «passi da escludere non validi»; tutti esclusi →
    «nessun passo da eseguire: rifiuta la proposta»; `escludi` non vuoto su una voce `action` → «passi da escludere non validi».
  - Errore al passo 2 di 3 (il fake risponde `isError`): p1 `done`, p2 `failed` con il messaggio del tool, p3 `not_run`, voce `failed`
    «eseguiti 1 passi su 3: si è fermata al passo p2».
  - Riferimento a un campo assente → p2 `failed` «riferimento non risolto».
  - Tool del passo 2 disattivato (o livello L3, o identità `user`) dopo la proposta → p2 `failed` «strumento non più utilizzabile».
  - Valore `x-sensitive` dell'argomento non compare nel `result` del passo.
  - Il riferimento si risolve anche se il risultato supera 20 000 caratteri (campo `id` in testa, poi testo lungo); `result` salvato ≤ 20 000.
  - Due approvazioni concorrenti: una sola esegue (l'altra 409 «azione già decisa»).
  - `rejectAction` su una proposta → `rejected` con la nota, passi invariati, `decidePlanItem` mai chiamato.
  - `failInterruptedActions`: proposta `executing` con passi `done` e `pending` → voce `failed` «esito incerto: verifica sul servizio»,
    passo `done` invariato, passo `pending` → `not_run`.
  - Eliminare un tool usato solo da un passo di proposta → 409 `TOOL_HAS_ACTIONS` (in `routes/pending-actions.test.ts` o nel test delle
    route dei tool esistente).
- [ ] **Passo 2:** test → FAIL.
- [ ] **Passo 3: implementare.** `approveAction` smista per `kind`: `plan|plan_change` → `decidePlanItem`, `proposal` →
  `approveProposal`, `action` come oggi (con `exclude` non vuoto → 400); `rejectAction` cerca la riga solo tra `plan|plan_change` per
  `decidePlanItem`. `approveProposal`: decifra `args_enc`, legge i passi, `planExclusion` (400 se `ok: false`), poi in una transazione
  l'UPDATE condizionato `pending → executing` (`decidedBy`, `decidedAt`) e gli stati `excluded`/`skipped`; poi i passi da eseguire in
  `position`: rilegge il tool (`proposalEligible` del compito 3 e stessa app, altrimenti `toolUnusable`), `resolveRefs` sui risultati JSON
  dei passi `done` (testo non JSON = nessun risultato), `executeTool({conn, tool, args, raw: true})`, salva `redact(truncate(content),
  sensitiveValues(schema, args))` su `result` o `errorMessage`; al primo errore i passi `pending` rimasti → `not_run` e stop. Esito: `done`
  con `result` «eseguiti m passi su m», altrimenti `failed` con `stoppedAt`. Stesso schema di «chiamata partita = esito incerto» di
  `approveAction` per le eccezioni (passo corrente `failed` «esito incerto: verifica sul servizio», resto `not_run`).
- [ ] **Passo 4:** test → PASS (anche `decide.test.ts`, `pending-actions.test.ts` esistenti).
- [ ] **Passo 5:** commit `feat(casello): approvazione ed esecuzione delle proposte`.

### Compito 5: API (OpenAPI, route, codegen)

**File:** `lib/api-spec/openapi.yaml`, codegen (`lib/api-client-react/src/generated/`, `lib/api-zod`), crea
`lib/actions/proposal-view.ts`, modifica `routes/pending-actions.ts`. Test: `routes/pending-actions.test.ts`.

**Interfacce prodotte:**
- OpenAPI: `QueuedAction.kind` + `proposal`; `QueuedAction.proposal` (`QueuedProposal | null`, richiesto); `QueuedProposal {title,
  reason (string|null), steps: QueuedProposalStep[]}`; `QueuedProposalStep {key, position, toolName (string|null: tool eliminato),
  summary, argsPublic, refs: [{param, step, field}], status (enum dei sei stati), result (string|null), errorMessage (string|null)}`;
  `ApproveActionRequest.escludi` (array di stringhe, maxItems 20).
- `proposal-view.ts`: `export function toProposalView(action: PendingActionRow, steps: PendingActionStepRow[], toolNames: Map<number,
  string>): QueuedProposal | null` (null se `kind ≠ proposal`); `refs` calcolati con `stepRefs` dagli argomenti pubblici.

- [ ] **Passo 1: test di route:** `GET /pending-actions` e `GET /pending-actions/:number` restituiscono `proposal` con passi, `refs`
  (`{param:"projectId", step:"p1", field:["id"]}`) e argomenti oscurati, `proposal: null` sulle voci `action`; `POST …/approve
  {escludi:["p1"]}` → 200 con stati per passo; `escludi` con 21 voci → 400; con un token `api:read` → 403.
- [ ] **Passo 2:** test → FAIL.
- [ ] **Passo 3:** OpenAPI, `pnpm --filter @workspace/api-spec run codegen`, route (un'unica lettura dei passi per tutte le voci
  dell'elenco con `loadProposalSteps`, nomi dei tool con una query `inArray`).
- [ ] **Passo 4:** test → PASS; typecheck (la console compila ancora: `kind` nuovo nelle mappe `Record` delle etichette va aggiunto qui,
  `ACTION_KIND_LABELS.proposal = "Proposta"`).
- [ ] **Passo 5:** commit `feat(casello): proposte nell'API della coda` (con i file generati).

### Compito 6: Console e pannello incorporato

**File:** crea `artifacts/casello/src/lib/proposal-steps.ts` (+ `proposal-steps.test.ts`) e
`artifacts/casello/src/components/actions/proposal-steps.tsx`; modifica `components/actions/pending-action-item.tsx`,
`components/actions/action-dialog.tsx`, `components/actions/plan-proposal.tsx` (etichetta), `pages/pending-actions.tsx` (colonna
«Strumento»: «n passi»), `embed/tabs/pending-tab.tsx` (solo il commento).

**Interfacce:**
- Consuma: `QueuedProposal`, `useApprovePendingAction` con `data: { escludi }` (compito 5).
- Produce: `export function dependentsOf(steps: { key: string; refs: { step: string }[] }[], excluded: Set<string>): Set<string>` (passi
  saltati a catena, stessa regola di `planExclusion`); `ProposalSteps({ proposal, excluded?, onToggle? })`: elenco dei passi (numero,
  sintesi, tool in mono, argomenti pubblici in un `<details>`, riferimenti come «id creato al passo p2»), con le caselle se `onToggle`
  c'è (un passo saltato a catena è segnato e disabilitato, etichetta «salta: usa un passo escluso»), altrimenti LED per stato
  (`done` → `ok`, `failed` → `ko`, gli altri `idle` con l'etichetta: «da eseguire», «escluso», «saltato», «eseguito», «fallito», «non
  eseguito») ed esito/errore troncato.

- [ ] **Passo 1: test di `dependentsOf`** (Vitest della console): catena p1→p2→p3, esclusione di un passo intermedio, nessuna esclusione.
- [ ] **Passo 2:** test → FAIL; implementare; → PASS.
- [ ] **Passo 3: interfaccia.** In `PendingActionItem` una proposta mostra titolo, motivo e `ProposalSteps` con le caselle; il pulsante
  principale è «Approva» senza esclusioni e «Approva i passi scelti» con almeno un'esclusione (disabilitato se non resta nessun passo);
  `approve.mutate({number, data: escludi.length ? {escludi} : {}})`; il toast dice «Proposta n. N approvata» ed esito. Nessun «Apri in
  Botcave» per le proposte nel pannello. `ActionDialog` per una proposta già decisa mostra `ProposalSteps` senza caselle (stati ed esiti).
  `decidedTitle` al femminile per «Proposta».
- [ ] **Passo 4:** `pnpm --filter @workspace/casello run test`, `pnpm run typecheck`, `pnpm run build` → PASS. Verifica a 1280 px (dev
  server con `AUTH_DISABLED=true`, una proposta inserita con il test seed o a mano): niente scorrimento orizzontale, pannello `/embed`
  compatto.
- [ ] **Passo 5:** commit `feat(casello): proposte in «Da confermare» e nel pannello`.

### Compito 7: Alfred (voce, chat) e centralino

**File:** `lib/teams/centralino.ts`, `lib/mcp/` (strumento `approva`), `lib/alfred/tools.ts`, `lib/alfred/tool-declarations.ts`,
`lib/alfred/confirmations.ts`, `lib/alfred/instructions.ts` (una riga sulle proposte), `lib/characters/subjects/alfred-thread.ts`,
`lib/characters/proposals.ts`, console `components/characters/proposal-cards.tsx`. Test: `routes/alfred-tools.test.ts`,
`routes/characters.test.ts`.

**Interfacce:**
- Consuma: `loadProposalSteps`, `planExclusion` (validazione anticipata di `escludi`), `approveAction(…, { exclude })`.
- Produce:
```ts
// centralino.ts
export async function approvePending(userId: number, number: number, userToken?: string, exclude?: string[]);
export async function readProposal(userId: number, number: number): Promise<{ numero: number; titolo: string; motivo: string | null;
  stato: string; passi: { passo: string; numero: number; sintesi: string; stato: string }[] }>; // CentralinoError «proposta non trovata»
// pendingQueue: per kind = proposal aggiunge `steps: number` (numero di passi)
```
- `escludi` per Alfred: array (≤ 20) di `"p3"` o di numeri `3` (normalizzati a `"p3"`).

- [ ] **Passo 1: test.**
  - Voce: `coda_da_confermare` riporta `passi: 3` per una proposta; `leggi_proposta {numero}` → titolo, motivo, passi con numero e
    sintesi; numero di una voce non proposta → «proposta non trovata».
  - `prepara_decisione {numero, decisione: "approva", escludi: [3]}` → risultato con `passiEsclusi: ["p3"]` e `passiSaltati` (catena);
    `escludi` con `rifiuta` → «i passi da escludere valgono solo con approva»; `escludi` non valido → «passi da escludere non validi»;
    `conferma_decisione` esegue escludendo p3 (stati dei passi controllati nel DB).
  - Chat di Alfred: `proponi_decisione` con `escludi` salva la scheda con `exclude`; accettarla approva escludendo; `leggi_proposta`
    disponibile anche in chat.
  - MCP `approva {numero, escludi}` passa le esclusioni.
- [ ] **Passo 2:** test → FAIL.
- [ ] **Passo 3: implementare.** `alfred_confirmations.exclude_steps` salva le esclusioni preparate e `confirmDecision` le passa;
  `KIND_LABEL.proposal = "proposta"`; payload `decision` con `exclude: string[] | null`; la scheda `DecisionCard` mostra «Senza i passi
  p3, p4». Dichiarazione Gemini di `leggi_proposta` e del parametro `escludi` (`ARRAY` di `STRING`, descrizione «id dei passi da non
  eseguire, es. p3»); istruzioni di Alfred: leggere la proposta passo per passo con `leggi_proposta` prima di prepararne la decisione e
  ripetere i passi esclusi.
- [ ] **Passo 4:** test → PASS; typecheck.
- [ ] **Passo 5:** commit `feat(casello): proposte con Alfred e centralino`.

### Compito 8: Documentazione, verifica finale, PR

**File:** `CLAUDE.md` (sezione «Proposte multiple» dopo «Inneschi», righe in «Stato», «Dove stanno le cose», elenco tabelle).

- [ ] **Passo 1:** sezione in `CLAUDE.md`: dati, `proponi` e controlli, decisione ed esecuzione, vista, console/pannello, Alfred,
  migrazione `docs/migrations/2026-11-proposte-multiple.sql` (additiva, PRIMA del merge, niente `-post`), fuori ambito (4b, 4c).
- [ ] **Passo 2:** `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test`,
  `pnpm run build` → tutto verde.
- [ ] **Passo 3:** revisione dell'intero branch (code review), correzioni.
- [ ] **Passo 4:** SQL completo della migrazione a Ivan in chat; push del branch; link compare di GitHub con titolo e corpo precompilati
  (cosa cambia, come si è provato, migrazione da applicare su Neon prima del merge, nessuna variabile nuova).
