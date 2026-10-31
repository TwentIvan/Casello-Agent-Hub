# Dal piano alle issue — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** creare da Casello le issue GitHub delle voci approvate del piano (endpoint, completamento, evoluzione),
ricordare il collegamento voce ↔ issue e rileggerne lo stato.

**Architecture:** colonne `issue_*` su `analysis_items`; client GitHub per issue ed etichette in
`lib/github/issues.ts` con token di installazione `issues: write`; logica pura del contenuto in
`lib/plan-issues/content.ts`, servizio (prenotazione, creazione sequenziale, aggiornamento stato) in
`lib/plan-issues/service.ts`; route in `routes/plan-issues.ts`; console in `components/plan/`.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React + TanStack Query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-30-casello-piano-issue-design.md`

## Global Constraints

- Italiano per commenti, messaggi d'errore, commit (`feat(casello): …`); identificatori in inglese.
- Contract-first: ogni route nuova o campo nuovo prima in `lib/api-spec/openapi.yaml`, poi
  `pnpm --filter @workspace/api-spec run codegen` (committare i generati). Body/params con `parseRequest`, risposte con `*Response.parse`.
- Migrazione solo additiva e idempotente: `docs/migrations/2026-10-piano-issue.sql` + `docs/schema-casello.sql` + fixture `test/fixtures/schema-pre-piano-issue.sql` (copia di `schema-casello.sql` prima della modifica) + test.
- Voci ammesse: `status = 'approved'` e `chapter IN ('endpoint','completion','evolution')`.
- Massimo 30 `itemIds` per richiesta; 5 creazioni/minuto per utente; refresh 6/minuto; 1 s di pausa tra due creazioni; refresh: `per_page=100`, al massimo 10 pagine.
- Mai il testo delle risposte di GitHub verso il client o nei log; messaggi fissi (spec §6, testo esatto in Task 2).
- Il token di installazione resta solo in memoria; quello di lettura del codice resta `contents: read`.
- Piè di pagina dell'issue: `---\nCreata da Casello · piano di <nome app> · voce #<id>`.
- Etichette: `casello`, capitolo (`endpoint` | `completamento` | `evoluzione`), `fase-N` (completamento con `phase`), `P1`…`P5` (evoluzione con `priority` 1-5).
- `pnpm run typecheck` verde prima di ogni commit; suite: `pnpm --filter @workspace/api-server run test`.

## Review Focus

1. Due richieste di creazione contemporanee sulle stesse voci (doppio clic, due schede): nessuna issue doppia → test «creazioni concorrenti» in Task 4.
2. Permesso Issues non ancora accettato sull'installazione: il lotto si ferma con il messaggio sul permesso, nessuna voce resta prenotata → test in Task 4.
3. Voce di un'altra app o non approvata nell'elenco: 400 se di un'altra app, `skipped` se non ammessa, nessuna chiamata a GitHub per lei → test in Task 4.
4. Dipendenza verso una voce che ha già un'issue da un lotto precedente: nel corpo compare `#numero`, non il titolo → test in Task 3 (contenuto) e Task 4 (lettura dal DB).
5. API riavviata a metà lotto: voci `creating` senza numero azzerate all'avvio, ricreabili → test in Task 4.

---

### Task 1: Schema, migrazione e forma pubblica della voce

**Files:**
- Create: `docs/migrations/2026-10-piano-issue.sql`, `artifacts/api-server/test/fixtures/schema-pre-piano-issue.sql`, `artifacts/api-server/test/migration-piano-issue.test.ts`
- Modify: `docs/schema-casello.sql` (in coda), `lib/db/src/schema/analysis-items.ts`, `lib/api-spec/openapi.yaml` (schema `AnalysisItem`, nuovo `ItemIssue`), `artifacts/api-server/src/routes/serializers.ts` (`toPublicItem`)

**Interfaces:**
- Produces (Drizzle, `analysisItemsTable`): `issueRepo: text`, `issueNumber: integer`, `issueUrl: text`, `issueState: text` (`creating` | `open` | `closed`), `issueStateReason: text`, `issueCreatedAt: timestamp`, `issueCheckedAt: timestamp`; indice `analysis_items_issue_idx` su `(issue_repo, issue_number)` WHERE `issue_number IS NOT NULL`.
- Produces (OpenAPI): `ItemIssue { repo: string, number: integer, url: string, state: "open"|"closed", stateReason: string|null, checkedAt: date-time|null }`; `AnalysisItem.issue: ItemIssue | null` (required).
- Produces: `toPublicItem(item)` toglie le colonne `issue*` e aggiunge `issue` (null se `issueNumber` è null, quindi anche durante la prenotazione).

- [ ] **Step 1:** copia `docs/schema-casello.sql` in `test/fixtures/schema-pre-piano-issue.sql`.
- [ ] **Step 2: test di migrazione** (modello: `test/migration-tetti-di-spesa.test.ts`): `"le voci esistenti non hanno issue"` (tutte le colonne null), `"accetta un collegamento e lo indicizza"` (`pg_indexes` contiene `analysis_items_issue_idx`), `"è idempotente"` (eseguita 3 volte, un solo indice).
- [ ] **Step 3:** esegui `pnpm --filter @workspace/api-server exec vitest run test/migration-piano-issue.test.ts` → FAIL (file SQL assente).
- [ ] **Step 4:** scrivi la migrazione (`BEGIN; ALTER TABLE … ADD COLUMN IF NOT EXISTS …; CREATE INDEX IF NOT EXISTS …; COMMIT;`, intestazione come `2026-10-tetti-di-spesa.sql`), la stessa parte in coda a `schema-casello.sql`, le colonne in Drizzle.
- [ ] **Step 5:** OpenAPI + codegen + `toPublicItem`; aggiungi in `src/routes/analyses.test.ts` un'asserzione che una voce appena creata ha `issue: null` in `GET /analyses/:id`.
- [ ] **Step 6:** test di migrazione e `analyses.test.ts` verdi, `pnpm run typecheck` verde.
- [ ] **Step 7:** commit `feat(casello): colonne delle issue sulle voci del piano`.

### Task 2: Client GitHub per issue ed etichette

**Files:**
- Create: `artifacts/api-server/src/lib/github/issues.ts`, `artifacts/api-server/src/lib/github/issues.test.ts`
- Modify: `artifacts/api-server/src/lib/github/app.ts` (export di `call`, `installationToken` con permessi), `artifacts/api-server/test/fake-github.ts`

**Interfaces:**
- Produces in `app.ts`: `installationToken(cfg, installationId, scope?: { repo: string; permissions?: Record<string, string> })` — default `{ contents: "read" }`; chiave di cache `${id}:${repo}:${JSON.stringify(permissions)}`. `export async function githubCall(...)` = l'attuale `call`, esteso a `method: "GET" | "POST" | "PATCH"`.
- Produces in `issues.ts`:
  - `export const ISSUE_MESSAGES = { permission: "L'App Casello non ha il permesso Issues su questo repository (o non lo vede più): attivalo nelle impostazioni dell'installazione su GitHub", notFound: "Repository non trovato o non accessibile all'App Casello", disabled: "Le issue sono disattivate su questo repository", rateLimited: "GitHub ha limitato le richieste: riprova tra qualche minuto", unavailable: "GitHub non raggiungibile", rejected: "GitHub ha rifiutato l'issue" } as const`
  - `export class IssueError extends Error { readonly scope: "batch" | "item" }` (batch: permission, notFound, disabled, rateLimited; item: unavailable, rejected).
  - `export async function issuesToken(cfg, installationId, repo): Promise<string>` — `installationToken` con `{ issues: "write" }`; un `GithubError` con stato 403/404/422 → `IssueError(permission, "batch")`, stato null/5xx → `IssueError(unavailable, "batch")`.
  - `export async function ensureLabels(cfg, token, repo, names: string[]): Promise<void>` — `POST /repos/{repo}/labels {name, color: "ededed"}` per ciascuna; 201 e 422 ok.
  - `export async function createIssue(cfg, token, repo, input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>`.
  - `export async function listCaselloIssues(cfg, token, repo, since: Date | null): Promise<Map<number, { state: "open" | "closed"; stateReason: string | null }>>` — `GET /repos/{repo}/issues?state=all&labels=casello&per_page=100&page=N[&since=ISO]`, al massimo 10 pagine, si ferma alla prima pagina con meno di 100 elementi.
  - Mappa degli stati (creazione, etichette, lista): `GithubError` 429 o 403 di rate limit → `rateLimited` (batch); `GithubError` altro → `unavailable` (item); 401/403 → `permission`; 404 → `notFound`; 410 → `disabled`; 422 su createIssue → `rejected` (item).
- Produces in `fake-github.ts`: `installationPermissions: Map<number, Record<string, string>>` (default per installazione: `{ contents: "read", metadata: "read", issues: "write" }`; richiesta di un permesso non concesso → 422); `issues: Map<string, FakeGithubIssue[]>` con `FakeGithubIssue { number, title, body, labels: string[], state: "open"|"closed", stateReason: string|null, updatedAt: string }`; `labels: Map<string, Set<string>>`; `issuesDisabled: Set<string>` (→ 410). Endpoint: `POST /repos/:o/:r/issues` (201 `{ number, html_url }`, token con `issues: write` e repo nello scope, altrimenti 403), `POST /repos/:o/:r/labels`, `GET /repos/:o/:r/issues` (filtri `state`, `labels`, `since`, paginazione).

- [ ] **Step 1: test** in `issues.test.ts` contro il finto GitHub: `"crea un'issue con etichette e restituisce numero e url"`; `"etichetta già esistente non è un errore"`; `"token senza permesso issues → IssueError batch con il messaggio del permesso"` (installazione con `installationPermissions` senza `issues`); `"issue disattivate → disabled batch"`; `"rate limit (failWith 429) → rateLimited batch"`; `"500 su una creazione → unavailable item"`; `"lista: stato e state_reason, paginazione su 150 issue, since passato in query"`; `"il token di lettura resta contents: read"` (ultimo `issuedTokens` di `installationToken(cfg, id, { repo })` ha `permissions` `{ contents: "read" }`).
- [ ] **Step 2:** esegui `pnpm --filter @workspace/api-server exec vitest run src/lib/github/issues.test.ts` → FAIL.
- [ ] **Step 3:** estendi il finto GitHub, `app.ts` e scrivi `issues.ts`.
- [ ] **Step 4:** il test passa; anche `src/lib/github/app.test.ts` e `src/routes/apps-github.test.ts` restano verdi.
- [ ] **Step 5:** commit `feat(casello): client GitHub per issue ed etichette`.

### Task 3: Contenuto delle issue (puro)

**Files:**
- Create: `artifacts/api-server/src/lib/plan-issues/content.ts`, `artifacts/api-server/src/lib/plan-issues/content.test.ts`
- Modify: `artifacts/api-server/src/lib/architect/issues.ts` (export di `topoSort` e `completionData`)

**Interfaces:**
- Consumes: `issueMarkdown(item, depTitles)` da `lib/architect/issues.ts`.
- Produces:
  - `export function isEligible(item: AnalysisItem): boolean`.
  - `export function creationOrder(items: AnalysisItem[]): AnalysisItem[]` — completamento per fase e in ordine di dipendenza (come `exportIssues`), poi le altre nell'ordine ricevuto.
  - `export function issueLabels(item: AnalysisItem): string[]`.
  - `export function issueContent(item: AnalysisItem, ctx: { appName: string; issueByKey: Map<string, number>; titleByKey: Map<string, string> }): { title: string; body: string; labels: string[] }` — per il completamento `depTitles` = per ogni `dependsOn` `#n` se `issueByKey` lo conosce, altrimenti il titolo (o la chiave); poi il piè di pagina dei Global Constraints.

- [ ] **Step 1: test**: `"ammette solo voci approvate dei tre capitoli"`; `"ordine: dipendenze prima, poi le altre nell'ordine dato"`; `"etichette: casello + capitolo + fase-2 / P1"`, `"evoluzione senza priorità: nessuna P"`; `"dipendenza con issue nota → #12 nel corpo, altrimenti il titolo"`; `"piè di pagina con nome app e id voce"`.
- [ ] **Step 2:** FAIL, **Step 3:** implementa, **Step 4:** PASS (`vitest run src/lib/plan-issues/content.test.ts`, più `src/lib/architect/issues.test.ts` verde).
- [ ] **Step 5:** commit `feat(casello): contenuto ed etichette delle issue del piano`.

### Task 4: Servizio e route di creazione

**Files:**
- Create: `artifacts/api-server/src/lib/plan-issues/service.ts`, `artifacts/api-server/src/routes/plan-issues.ts`, `artifacts/api-server/src/routes/plan-issues.test.ts`
- Modify: `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/src/middlewares/rate-limit.ts`, `artifacts/api-server/src/index.ts` (pulizia all'avvio)

**Interfaces:**
- Consumes: Task 2 (`issuesToken`, `ensureLabels`, `createIssue`, `IssueError`, `ISSUE_MESSAGES`), Task 3, `userHasInstallation` e `INSTALLATION_NOT_YOURS` da `routes/apps.ts`, `githubConfig()`.
- Produces in `service.ts`:
  - `export class PlanIssuesError extends Error { readonly status: 400 | 403 | 404 | 409 | 502 }`.
  - `export const NO_REPO = "Collega il repository tramite l'App GitHub per creare le issue"`.
  - `export async function issueTarget(appId: number, userId: number): Promise<{ repo: string; installationId: number; appName: string }>` — 404 app non trovata, 409 `NO_REPO` (nessun `sourceRepo` o `sourceInstallationId`, o GitHub non configurato), 403 `INSTALLATION_NOT_YOURS`.
  - `export async function previewPlanIssues(appId, userId, itemIds): Promise<{ repo: string; issues: { itemId: number; title: string; body: string; labels: string[]; skipped: boolean }[] }>`.
  - `export async function createPlanIssues(appId, userId, itemIds, opts?: { pauseMs?: number }): Promise<{ repo: string; results: { itemId: number; outcome: "created" | "skipped" | "failed"; number?: number; url?: string; error?: string }[] }>` — 400 se una voce non è dell'app (via `analyses.app_id`); token una volta per lotto (un `IssueError` qui → 502 con il messaggio); `ensureLabels` una volta con l'unione delle etichette; per voce: prenotazione (`UPDATE … SET issue_state = 'creating' WHERE id = $1 AND issue_number IS NULL AND issue_state IS NULL RETURNING id`, nessuna riga → `skipped`), `createIssue`, scrittura di repo/numero/url/`open`/`issue_created_at`/`issue_checked_at`; `IssueError` item → `failed` e prenotazione tolta (`issue_state = NULL`); `IssueError` batch → prenotazione tolta, quella voce e le restanti `failed` con il messaggio; pausa `pauseMs` (default 1000) tra due creazioni. `issueByKey` parte dalle voci di completamento dell'app già collegate (chiave `completionData(item).key`) e cresce con le creazioni del lotto.
  - `export async function resetStaleIssueReservations(): Promise<number>` — `issue_state = 'creating' AND issue_number IS NULL` → `NULL`.
- Produces (OpenAPI): `POST /apps/{id}/plan/issues` (`createPlanIssues`), corpo `PlanIssuesRequest { itemIds: integer[] (1..30, uniqueItems), dryRun?: boolean }`, risposta 200 `PlanIssuesPreview | PlanIssuesResult` (`oneOf`), errori 400/403/404/409/429/502.
- Produces in `rate-limit.ts`: `export const issueCreateRateLimit = rateLimit({ limit: 5, windowMs: 60_000 })` applicato solo quando `dryRun` non è true (middleware che salta se `req.body?.dryRun === true`), `export const issueRefreshRateLimit = rateLimit({ limit: 6, windowMs: 60_000 })`.

- [ ] **Step 1: test** in `plan-issues.test.ts` (app con finto GitHub come `apps-github.test.ts`, `createPlanIssues` con `pauseMs: 0` iniettato tramite route option `createPlanIssuesRouter({ pauseMs: 0 })`):
  - `"anteprima: titoli, etichette, nessuna chiamata di creazione"`;
  - `"crea in ordine di dipendenza, #numero nel corpo, voci collegate"` (verifica `issue` in `GET /apps/:id/plan`);
  - `"seconda richiesta sulle stesse voci → skipped, nessuna issue nuova"`;
  - `"creazioni concorrenti sulle stesse voci → una sola issue per voce"` (due POST in `Promise.all`);
  - `"dipendenza collegata in un lotto precedente → #numero"`;
  - `"voce di un'altra app → 400; voce non approvata → skipped"`;
  - `"permesso Issues mancante → 502 con il messaggio, nessuna voce prenotata"`;
  - `"500 su una voce → failed solo lei, le altre created, prenotazione tolta"`;
  - `"issue disattivate a metà lotto → restanti failed"`;
  - `"app senza installazione → 409 NO_REPO; installazione di un altro utente → 403"`;
  - `"resetStaleIssueReservations azzera le prenotazioni senza numero"`;
  - `"sesta creazione nel minuto → 429, anteprime non limitate"`.
- [ ] **Step 2:** FAIL. **Step 3:** OpenAPI + codegen, servizio, route, rate limit, `resetStaleIssueReservations()` chiamato in `src/index.ts` accanto a `failInterruptedPlanTurns`. **Step 4:** PASS + `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(casello): creazione delle issue dal piano`.

### Task 5: Stato delle issue e riepilogo del piano

**Files:**
- Modify: `lib/plan-issues/service.ts`, `routes/plan-issues.ts`, `routes/plan-chat.ts` (`GET /apps/:id/plan`), `lib/api-spec/openapi.yaml` (`AppPlan.issues`, `POST /apps/{id}/plan/issues/refresh`), `routes/plan-issues.test.ts`

**Interfaces:**
- Produces: `export async function planIssuesSummary(appId: number, userId: number): Promise<PlanIssuesSummary>` con `PlanIssuesSummary { available: boolean; unavailableReason: string | null; repo: string | null; open: integer; closed: integer; approvedWithoutIssue: integer; checkedAt: date-time | null }` (conteggi sulle voci del piano: `loadPlanItems` dell'ultima analisi completata; `checkedAt` = il più vecchio `issue_checked_at` tra le voci collegate; `available`/`unavailableReason` da `issueTarget` senza lanciare).
- Produces: `export async function refreshPlanIssues(appId, userId): Promise<PlanIssuesSummary>` — `listCaselloIssues(..., since = min(issue_checked_at))` sul repo; per ogni voce dell'app con `issue_repo = repo` e numero presente nella mappa aggiorna stato e motivo; `issue_checked_at = now()` per tutte le voci collegate a quel repo; errori come in Task 4 (502).
- Produces (OpenAPI): `AppPlan.issues: PlanIssuesSummary` (required); `POST /apps/{id}/plan/issues/refresh` → `PlanIssuesSummary`.

- [ ] **Step 1: test**: `"GET plan: riepilogo con aperte, chiuse, approvate senza issue"`; `"refresh: chiusa completed e not_planned aggiornate, checkedAt avanzato"`; `"refresh: issue non più in lista resta com'era"`; `"GET plan di un'app senza installazione: available false con NO_REPO"`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS + typecheck (anche `plan-chat.test.ts` verde).
- [ ] **Step 5:** commit `feat(casello): stato delle issue nel piano`.

### Task 6: Voci con issue come «già pianificate» nella rianalisi

**Files:**
- Modify: `artifacts/api-server/src/lib/architect/planned.ts`, il suo test (o `run-analysis` test esistente sulle voci da chat)

**Interfaces:**
- Produces: `chatPlannedItems(appId, beforeAnalysisId)` include anche le voci approvate con `issue_number IS NOT NULL` (qualsiasi origine), senza duplicati per id.

- [ ] **Step 1: test** `"voce dell'architetto con issue → già pianificata; senza issue → no"`. **Step 2:** FAIL. **Step 3:** cambia la condizione in `or(eq(origin, "chat"), isNotNull(issueNumber))`. **Step 4:** PASS. **Step 5:** commit `feat(casello): la rianalisi non ripropone le voci con issue`.

### Task 7: Console

**Files:**
- Create: `artifacts/casello/src/components/plan/issue-badge.tsx`, `artifacts/casello/src/components/plan/create-issues-dialog.tsx`, `artifacts/casello/src/components/plan/issues-summary.tsx`
- Modify: `artifacts/casello/src/components/plan/plan-list.tsx`, `artifacts/casello/src/components/analysis/item-card.tsx` (badge in sola lettura)

**Interfaces:**
- Consumes: hook generati `useGetAppPlan`, `useCreatePlanIssues`, `useRefreshPlanIssues`; `AnalysisItem.issue`, `AppPlan.issues`.
- Produces:
  - `IssueBadge({ issue }: { issue: ItemIssue })` — «#12 aperta» verde, «#12 chiusa» viola (`stateReason !== "not_planned"`) o grigia, link `issue.url` in nuova scheda.
  - `IssuesSummary({ appId, summary })` — testo «Issue: X aperte, Y chiuse, Z voci approvate senza issue», «aggiornato … fa» (`formatRelative`), pulsante «Aggiorna stato»; all'apertura chiama il refresh se `available` e `checkedAt` è null o più vecchio di 10 minuti e ci sono voci collegate (una volta per montaggio).
  - `CreateIssuesDialog({ appId, itemIds, repo, open, onOpenChange })` — all'apertura `dryRun: true` e mostra titolo + etichette + corpo in `<details>`; «Crea su owner/repo»; poi esito per voce (creata con link, saltata, errore); invalida `getGetAppPlanQueryKey(appId)`.
  - In `plan-list.tsx`: casella su ogni voce idonea (approvata, capitoli ammessi, `issue === null`), «Seleziona tutte le approvate senza issue», pulsante «Crea issue (N)» (disattivato con `unavailableReason` come tooltip/testo quando `available` è false), `IssueBadge` sulle voci collegate.

- [ ] **Step 1:** implementa i componenti. **Step 2:** `pnpm run typecheck` e `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/casello exec vite build` verdi.
- [ ] **Step 3:** prova nel browser (DB in memoria con dati di esempio e finto GitHub, oppure solo anteprima e badge con voci collegate inserite a mano): selezione, anteprima, esito, badge, riepilogo.
- [ ] **Step 4:** commit `feat(casello): crea issue dal piano nella console`.

### Task 8: Documentazione e verifica finale

**Files:**
- Modify: `CLAUDE.md` (sezione «Dal piano alle issue»: route, colonne, limiti, permesso Issues della GitHub App da aggiungere e accettare; route nell'elenco di «Dove stanno le cose»; permessi della GitHub App nella sezione «Autenticazione»)

- [ ] **Step 1:** aggiorna CLAUDE.md.
- [ ] **Step 2:** `pnpm run typecheck` e suite API completa verdi.
- [ ] **Step 3:** commit `docs(casello): issue dal piano in CLAUDE.md`.
