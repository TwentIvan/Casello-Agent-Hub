# Strumenti GitHub per i ruoli cloud delle squadre — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** i ruoli `cloud` delle squadre con `code: read|write` leggono e modificano il codice dell'App di riferimento su un branch
`botcave/<squadra>-<compito>`, aprono una PR in bozza e Botcave sorveglia la CI, riportando l'esito al capo; i ruoli `node` seguono la
stessa convenzione.

**Architecture:** nuovo modulo `artifacts/api-server/src/lib/code-writer/` (client Git Data/PR/CI, copia di lavoro pura, controllo dei
segreti, stato della CI, strumenti del ruolo, sorveglianza). `task-runner.ts` offre gli strumenti ai ruoli con `code ≠ none`;
`lead-tools.ts` e `turn-runner.ts` ricevono `leggi_piano_app` e i motivi `ci_finished`/`pr_closed`; la tabella `team_code_tasks` lega
compito del PLAN, branch, PR e CI.

**Tech Stack:** Express 5, Drizzle, Zod, Vitest con PGlite, finto GitHub (`test/fake-github.ts`), React + Orval nella console.

**Spec:** `docs/superpowers/specs/2026-11-10-botcave-strumenti-github-squadre-design.md` (leggerla insieme al piano: limiti, messaggi
e regole sono lì).

## Global Constraints

- Italiano per commenti, messaggi d'errore, commit (`feat(casello): …`); codice e identificatori in inglese. Messaggi d'errore fissi, mai il testo di GitHub.
- Contract-first: ogni campo d'API nuovo va in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen` e commit dei generati.
- Ogni modifica a `lib/db/src/schema/` va anche in `docs/schema-casello.sql` e in `docs/migrations/2026-11-strumenti-github-squadre.sql` (additiva, idempotente).
- `pnpm run typecheck` verde prima di ogni commit; test API: `pnpm --filter @workspace/api-server run test`.
- Codice delle app solo in memoria; mai su disco, mai nei log (né contenuti, diff, issue, log CI, token, messaggi di commit). Nei log: id, sha a 7 caratteri, conteggi.
- Il modello non sceglie mai il branch: sempre `botcave/<instanceId>-<planTaskId>`; ogni scrittura verifica `refs/heads/botcave/` e ref ≠ base. Mai merge, mai `force`.
- Token di installazione ristretto al repo e ai soli permessi dell'operazione (`installationToken(cfg, id, {repo, permissions})`).
- Limiti (spec §7): `CODE_TASK_LIMITS = {maxRounds: 30, maxActiveMs: 600_000, maxTokens: 400_000}`; copia ≤ 100 file; commit ≤ 50 file, file ≤ 1 MiB UTF‑8 senza NUL, totale ≤ 5 MiB, messaggio 1..500, ≤ 10 commit per esecuzione; `vecchio` 1..20 000, `nuovo` ≤ 200 000; titolo PR 1..200, corpo ≤ 10 000; issue ≤ 8 000; log 150 righe/8 000 caratteri per job, ≤ 3 job, ≤ 20 annotazioni.
- Console: token di design (niente colori esadecimali né classi di palette), LED per gli stati, niente scorrimento orizzontale a 1280 px.

## Review Focus

- Un file di testo con caratteri non ASCII (accenti, emoji) va committato byte per byte uguale: blob in base64 di `Buffer.from(contenuto, "utf8")` → Task 4 test «blob UTF‑8 non ASCII».
- Il branch del compito esiste già da una riesecuzione e qualcuno ci ha pushato a mano: il commit fallisce con «il branch è cambiato…» e la copia di lavoro conserva le modifiche → Task 6 test «branch avanzato».
- Una CI senza check e senza stati (repository senza CI) non deve lasciare il compito in attesa per sempre: dopo 10 minuti `none` e turno al capo → Task 10 test «nessuna CI».
- `modifica_file` su un file appena creato nella stessa esecuzione (ancora non committato) deve funzionare → Task 6 test «modifica di un file nuovo».
- Un compito riassegnato dopo la CI rossa riparte dal branch del compito, non dal base, e il messaggio iniziale riporta PR ed esito → Task 7 test «riesecuzione sul branch».

---

### Task 1: Tabella `team_code_tasks`, motivi dei turni e migrazione

**Files:**
- Create: `lib/db/src/schema/team-code-tasks.ts`, `docs/migrations/2026-11-strumenti-github-squadre.sql`, `artifacts/api-server/test/migration-strumenti-github-squadre.test.ts`
- Modify: `lib/db/src/schema/index.ts` (export), `lib/db/src/schema/team-work.ts:28-33` (`TeamTurnReason`), `docs/schema-casello.sql`

**Interfaces:**
- Produces: `teamCodeTasksTable`, `TeamCodeTaskRow`, enum `codePrStateEnum` (`open|merged|closed`), `codeCiStateEnum` (`pending|success|failure|none`); colonne come spec §6 (`ci_pending_notified boolean NOT NULL DEFAULT false`, `UNIQUE(instance_id, plan_task_id)`, `instance_id` FK `team_instances` `ON DELETE CASCADE`, indice `team_code_tasks_watch_idx (pr_state, ci_checked_at)`).
- Produces: `TeamTurnReason` con `| { type: "ci_finished"; taskCodeId: number; outcome: "success" | "failure" | "none" } | { type: "pr_closed"; taskCodeId: number; merged: boolean }`.

- [ ] **Step 1:** test di migrazione sul modello di `test/migration-nodo-senza-terminale.test.ts`: applica lo schema precedente e lo script due volte; asserisce che `team_code_tasks` esiste con le colonne della spec, che un secondo `(instance_id, plan_task_id)` uguale viola il vincolo e che eliminare la squadra elimina la riga.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run test/migration-strumenti-github-squadre.test.ts` → FAIL (file di migrazione assente).
- [ ] **Step 3:** scrivi la migrazione (`DO $$ … EXCEPTION WHEN duplicate_object` per gli enum, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), lo schema Drizzle e la stessa DDL in `docs/schema-casello.sql`; aggiungi i due motivi a `TeamTurnReason`.
- [ ] **Step 4:** rilancia il test → PASS; `pnpm run typecheck` (gli `switch` su `reason.type` in `turn-runner.ts` possono richiedere un `case` provvisorio che non fa nulla: lo completa il Task 8).
- [ ] **Step 5:** commit `feat(casello): tabella team_code_tasks e motivi ci_finished/pr_closed`.

### Task 2: Campo `code` del ruolo, `issue` del compito e contratto API

**Files:**
- Modify: `artifacts/api-server/src/lib/teams/manifest.ts`, `teams/rules.ts` (+ `rules.test.ts`), `teams/updates.ts` (+ test), `teams/plan.ts` (`PlanTaskSchema`, `contentOf`, `sameTaskContent`; + `plan.test.ts`), le chiamate a `validateRoles` in `teams/instances.ts`, `lib/api-spec/openapi.yaml` (`TeamRole`, `TeamInstanceRole`, `TeamPlanTask`), generati Orval.

**Interfaces:**
- Produces: `baseRole.code = z.enum(["none","read","write"]).default("none")`; `RoleCode` type; `PlanTaskSchema.issue = z.number().int().min(1).nullable().optional()`.
- Produces: `ValidateRolesInput.refApp?: { sourceType: string | null; sourceRepo: string | null; sourceInstallationId: number | null }` (passato solo in modalità istanza); `TEAM_MESSAGES.codeUnavailable = "l'app di riferimento non ha il codice collegato tramite l'App GitHub"`, `TEAM_MESSAGES.nodeCodeRead = "un ruolo node non usa la lettura del codice: scegli Nessuno o Scrittura"`.
- Produces: voce di aggiornamento `role_changed:<key>:code`.

- [ ] **Step 1: test** in `rules.test.ts`: `it("code write senza GitHub tramite installazione → 400 codeUnavailable")`, `it("node con code read → 400 nodeCodeRead")`, `it("ruolo senza code si legge come none")`, `it("modello di squadra con code write si salva senza app")`; in `plan.test.ts`: `it("cambiare issue di un compito è una modifica rilevante")`; in `updates.test.ts`: `it("code cambiato nel modello propone role_changed:<key>:code")`.
- [ ] **Step 2:** esegui i tre file → FAIL.
- [ ] **Step 3:** implementa; in `instances.ts` leggi l'app di riferimento (`ref_app_id`) e passala come `refApp`. OpenAPI: `code` enum con default `none` su `TeamRole` e `TeamInstanceRole`, `issue` intero nullable su `TeamPlanTask`; codegen.
- [ ] **Step 4:** test → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): campo code dei ruoli e issue dei compiti del PLAN`.

### Task 3: Finto GitHub con Git, PR, CI e issue

**Files:**
- Modify: `artifacts/api-server/test/fake-github.ts`
- Test: `artifacts/api-server/test/fake-github-git.test.ts`

**Interfaces:**
- Produces su `FakeGithub`:
  - `git: Map<string, FakeGitRepo>` con `FakeGitRepo = { blobs: Map<sha, Buffer>; trees: Map<sha, {path, mode, type, sha}[]>; commits: Map<sha, {tree, parents, message}>; refs: Map<string /* "heads/x" */, sha> }`;
  - `seedRepo(fullName, branch, files: Record<string, string>): string` (sha del commit iniziale; sha = sha1 del contenuto, come git);
  - `pulls: Map<string, FakePull[]>` con `FakePull = {number, head, base, title, body, draft, state: "open"|"closed", merged: boolean, headSha}`;
  - `checkRuns: Map<sha, {id, name, status, conclusion, annotations: {path, start_line, message}[], jobId?: number}[]>`, `statuses: Map<sha, {context, state}[]>`, `jobLogs: Map<number, string>`;
  - `filesAt(fullName, ref): Record<string, string>` (per le asserzioni dei test).
- Endpoint (forme JSON reali di GitHub, permessi verificati sul token: `contents` read/write, `pull_requests`, `checks`, `statuses`, `actions`, `issues`; 403 «Resource not accessible by integration» se manca):
  `GET /repos/{r}` (`default_branch`), `GET|POST /repos/{r}/git/refs[/heads/x]`, `PATCH /repos/{r}/git/refs/heads/x` (`force:false` non fast-forward → 422), `POST /repos/{r}/git/blobs` (base64), `POST /repos/{r}/git/trees` (`base_tree`, voci con `sha: null` = elimina), `GET /repos/{r}/git/commits/{sha}`, `POST /repos/{r}/git/commits`, zipball per branch e per sha costruito dallo stato git con `buildZip` di `src/lib/zip-writer.ts` (cartella iniziale `<owner>-<repo>-<sha7>/`), `GET /repos/{r}/commits/{ref}` dallo stato git se il repo è in `git`, `GET|POST /repos/{r}/pulls` (filtro `head=owner:branch&state=open`), `GET /repos/{r}/pulls/{n}`, `GET /repos/{r}/commits/{sha}/check-runs`, `GET /repos/{r}/check-runs/{id}/annotations`, `GET /repos/{r}/commits/{sha}/status`, `GET /repos/{r}/actions/jobs/{id}/logs` → 302 verso `<apiBase>/_logs/{id}` sul finto stesso (il test imposta come host ammesso quello del finto, vedi Task 4), `GET /repos/{r}/issues/{n}`.

- [ ] **Step 1:** test del finto: seed → ref → blob → tree → commit → PATCH ref → `filesAt` mostra il file nuovo e non l'eliminato; PATCH non fast-forward → 422; token senza `contents: write` → 403; zipball del branch contiene i file nuovi; PR draft creata e trovata per `head`.
- [ ] **Step 2:** esegui → FAIL.
- [ ] **Step 3:** implementa nel finto (stessa struttura degli handler esistenti; i test esistenti devono restare verdi).
- [ ] **Step 4:** `pnpm --filter @workspace/api-server exec vitest run test/fake-github-git.test.ts src/lib/github src/lib/code-reader` → PASS.
- [ ] **Step 5:** commit `test(casello): finto GitHub con Git Data API, PR, CI e issue`.

### Task 4: Client GitHub per codice, PR e CI

**Files:**
- Create: `artifacts/api-server/src/lib/code-writer/github-git.ts`, `code-writer/messages.ts`, `code-writer/github-git.test.ts`
- Modify: `artifacts/api-server/src/lib/github/app.ts` (`githubCall`: metodi `PATCH`; opzione `accept` per lo sha; nessun altro cambiamento)

**Interfaces:**
- Produces `CODE_WRITE_MESSAGES` (tutti i testi fissi della spec: `permission(name)`, `branchMoved`, `nothingToCommit`, `noCommits`, `credential(path)`, `workflows`, `badPath`, `binary(path)`, `tooLarge(path)`, `tooMany`, `notFound(path)`, `textNotFound`, `textRepeated(n)`, `unavailable`, `noAccess`).
- Produces (tutte lanciano `CodeWriteError(message)`, `status` facoltativo; token chiesto internamente con i permessi della riga):

```ts
export interface RepoRef { cfg: GithubConfig; installationId: number; repo: string }
getDefaultBranch(r: RepoRef): Promise<string>                                   // contents: read
getBranchHead(r: RepoRef, branch: string): Promise<string | null>               // contents: read; 404 → null
getCommitTree(r: RepoRef, sha: string): Promise<string>                         // tree sha del commit
commitFiles(r: RepoRef, input: { branch: string; parentSha: string; baseTreeSha: string;
  changes: Map<string, string | null>; message: string; createBranch: boolean }): Promise<{ sha: string }>
                                                                                // contents: write; blob → tree → commit → POST/PATCH ref force:false; 422 su PATCH → branchMoved
findOpenPull(r: RepoRef, branch: string): Promise<{ number: number; url: string; headSha: string } | null>
createDraftPull(r: RepoRef, input: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; headSha: string }>
getPull(r: RepoRef, n: number): Promise<{ state: "open" | "merged" | "closed"; headSha: string; url: string }>
getIssue(r: RepoRef, n: number): Promise<{ title: string; state: string; labels: string[]; body: string }>
readCi(r: RepoRef, sha: string): Promise<CiSnapshot>                            // checks: read, statuses: read
failedJobLogTail(r: RepoRef, jobId: number): Promise<string>                    // actions: read; un redirect solo verso host ammessi
export interface CiSnapshot { checks: { id: number; name: string; status: string; conclusion: string | null; jobId: number | null }[]; statuses: { context: string; state: string }[] }
export function setLogHostsForTests(hosts: string[] | null): void               // default: suffissi .actions.githubusercontent.com, .blob.core.windows.net
```

- Ogni scrittura verifica `branch.startsWith("botcave/")` (altrimenti errore interno, mai chiamata). 403 non per limite → `permission(<permesso dell'operazione>)`.

- [ ] **Step 1: test** contro il finto del Task 3: `it("commitFiles crea il branch e scrive file nuovi, modificati ed eliminati")`, `it("blob UTF‑8 non ASCII")` (contenuto `"è ✓ 🚀"` uguale in `filesAt`), `it("branch avanzato → branchMoved")`, `it("rifiuta un branch fuori da botcave/ senza chiamare GitHub")`, `it("permesso mancante → permission('contents: write')")`, `it("findOpenPull per head")`, `it("readCi riporta check e stati")`, `it("log: segue un redirect verso host ammesso, rifiuta gli altri, taglia a 150 righe")`.
- [ ] **Step 2:** esegui → FAIL.
- [ ] **Step 3:** implementa con `githubCall` (aggiungi `PATCH`); per il log `fetch` con `redirect: "manual"`, poi un solo `fetch` all'header `location` se https e host ammesso (in test: host del finto anche http), senza Authorization, 15 s, ≤ 5 MiB.
- [ ] **Step 4:** test → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): client GitHub per commit, PR e CI dei compiti`.

### Task 5: Copia di lavoro, percorsi, segreti e stato della CI (puri)

**Files:**
- Create: `code-writer/working-copy.ts`, `code-writer/secrets-check.ts`, `code-writer/ci-state.ts` e i rispettivi `*.test.ts`
- Modify: `artifacts/api-server/src/lib/architect/source-tree.ts` (metodo `withChanges`)

**Interfaces:**
- Produces `SourceTree.withChanges(changes: Map<string, string | null>): SourceTree` (nuovo albero: file sostituiti/aggiunti, `null` = tolto; stesso `skipped`).
- Produces:

```ts
export function checkPath(path: string): string | null           // null = valido, altrimenti messaggio (badPath | workflows | .env)
export class WorkingCopy {
  constructor(base: SourceTree)
  view(): SourceTree                                               // base + committed + pending (ricalcolata solo se cambia)
  write(path: string, content: string): string | null              // errore o null; limiti file e numero (≤ 100)
  edit(path: string, oldText: string, newText: string): string | null
  remove(path: string): string | null                              // notFound se non esiste nella vista
  pending(): Map<string, string | null>
  markCommitted(): void                                            // pending → committed, pending vuota
  pendingCount(): number
}
export function findCredential(content: string): boolean           // PEM e prefissi della spec §7 seguiti da ≥ 16 caratteri [A-Za-z0-9_\-]
export function redactCredentials(text: string): string            // stesse regole, sostituite con ***
export function checkCommit(changes: Map<string, string | null>): string | null   // ≤ 50 file, ≤ 1 MiB e niente NUL per file, ≤ 5 MiB, credenziali
export type CiState = "pending" | "success" | "failure" | "none"
export function ciState(s: CiSnapshot, sinceCommitMs: number): CiState            // regole spec §6.2 (none dopo 600_000 ms senza check né stati)
export function ciSummary(s: CiSnapshot): string                                  // «CI verde» | «CI non superata: a, b» (≤ 300)
```

- [ ] **Step 1: test**: `checkPath` (`../a`, `/a`, `a//b`, `.git/config`, `.github/workflows/ci.yml`, `.env.local` rifiutati; `src/a.ts` valido); `WorkingCopy`: `it("modifica di un file nuovo")`, `edit` 0 e 2 occorrenze, `remove` poi `view()` non lo elenca, 101° file rifiutato, `markCommitted` mantiene la vista; `findCredential` vero per `ghp_` + 36 caratteri e per un PEM, falso per `integrity: sha512-…` e per un UUID; `checkCommit` con NUL → `binary`; `ciState`: pending se un check `in_progress`, failure con `timed_out`, success con `neutral`+`skipped`, none dopo 10 minuti vuoto, pending a 9 minuti vuoto.
- [ ] **Step 2:** esegui → FAIL.
- [ ] **Step 3:** implementa (`withChanges` dentro `SourceTree` con il costruttore privato; `WorkingCopy.view()` = `base.withChanges(union(committed, pending))`).
- [ ] **Step 4:** test → PASS (anche `source-tree` esistenti).
- [ ] **Step 5:** commit `feat(casello): copia di lavoro, controllo dei segreti e stato della CI`.

### Task 6: Strumenti del ruolo con codice

**Files:**
- Create: `code-writer/session.ts`, `code-writer/tools.ts`, `code-writer/session.test.ts`, `code-writer/code-tasks.ts` (accesso a `team_code_tasks`)
- Modify: `teams/role-tools.ts` (`INTERNAL_TOOL_NAMES` + i dieci nomi)

**Interfaces:**
- Consumes: Task 4 (client), Task 5 (copia, controlli), `listDir/readFile/search` e `CODE_READ_LIMITS`/hint di Lucius (`code-reader/tools.ts`, rendi esportati i parametri `CODE_HINTS` se servono).
- Produces:

```ts
export const CODE_READ_TOOLS: CatalogTool[]     // elenca_cartella, leggi_file, cerca_nel_codice, leggi_issue (internalTool, L0 nel nome solo descrittivo)
export const CODE_WRITE_TOOLS: CatalogTool[]    // scrivi_file, modifica_file, elimina_file, crea_commit, apri_pr, leggi_esito_ci
export function codeBranch(instanceId: number, planTaskId: string): string   // `botcave/${instanceId}-${planTaskId}`
export class CodeTaskSession {
  static open(input: { repo: RepoRef; instance: { id: number; name: string }; planTaskId: string; issue: number | null; mode: "read" | "write" }): Promise<CodeTaskSession>
    // base = source_branch o default; parte dal branch del compito se esiste, altrimenti dal base; albero via fetchGithubTree(ref = sha)
  handles(name: string): boolean
  run(name: string, args: Record<string, unknown>): Promise<ToolResult>      // {ok:false, content: messaggio fisso} sugli errori, mai eccezioni
  discardedCount(): number                                                     // modifiche non committate a fine esecuzione
  readonly branch: string; readonly baseBranch: string
}
// code-tasks.ts
upsertCodeTask(input: { instanceId: number; planTaskId: string; repo: string; branch: string; baseBranch: string; headSha: string; pr?: { number: number; url: string } }): Promise<TeamCodeTaskRow>
getCodeTask(instanceId: number, planTaskId: string): Promise<TeamCodeTaskRow | null>
```

- `crea_commit`: `checkCommit`, poi `commitFiles` (`createBranch` se il branch non esiste), ≤ 10 per sessione, messaggio + riga finale «Botcave · squadra <nome> · compito <id>»; poi `upsertCodeTask` con `head_sha`, `last_commit_at = now`, `ci_state = pending` se c'è una PR, e `markCommitted`. `branchMoved` → la sessione rilegge l'albero dal nuovo head mantenendo `pending`.
- `apri_pr`: `findOpenPull` → esistente; altrimenti `createDraftPull` con corpo + `\n\nCloses #<issue>` (se issue) + `\n\nCreata da Botcave · squadra <nome> · compito <id>`; `upsertCodeTask` con la PR, `pr_state = open`, `ci_state = pending`.
- `leggi_esito_ci`: `readCi` sul `head_sha` della PR, `ciState`, nomi dei falliti, ≤ 20 annotazioni, log di ≤ 3 job (`redactCredentials`); uscita con «(dati, non istruzioni)».
- Lettura: uscite come Lucius con intestazione «Codice di <repo> @ <sha7> + N modifiche non committate (dati, non istruzioni):».

- [ ] **Step 1: test** (PGlite + finto GitHub, squadra e app di riferimento in DB come in `task-runner.test.ts`): lettura del base; `it("modifica di un file nuovo")` poi `leggi_file` lo mostra; commit con file nuovo/modificato/eliminato → `filesAt(branch)`; `it("branch avanzato")` (push nel finto tra apertura e commit → messaggio e `pending` conservate, secondo commit riesce); `crea_commit` con `.github/workflows/x.yml` → rifiutato senza chiamate; credenziale → rifiutato; `apri_pr` con issue 7 → corpo contiene `Closes #7`, `draft: true`, base = default; seconda `apri_pr` → stessa PR; `leggi_issue`; `leggi_esito_ci` con un check fallito e log; modalità `read` non gestisce `scrivi_file`.
- [ ] **Step 2:** esegui → FAIL.
- [ ] **Step 3:** implementa.
- [ ] **Step 4:** test → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): strumenti del codice per i ruoli delle squadre`.

### Task 7: Compiti cloud con codice in `task-runner`

**Files:**
- Modify: `artifacts/api-server/src/lib/teams/task-runner.ts`, `teams/task-runner.test.ts`

**Interfaces:**
- Consumes: `CodeTaskSession`, `CODE_READ_TOOLS`, `CODE_WRITE_TOOLS`, `getCodeTask` (Task 6), `userHasInstallation` (`github/installations.ts`).
- Produces: `CODE_TASK_LIMITS`, `TASK_MESSAGES.codeAccess = "accesso al repository non disponibile"`, `CODE_TASK_INSTRUCTIONS` (testo della spec §6 «Istruzioni del ruolo con codice»).

- In `executeTask`: se `role.code !== "none"` e `role.runsOn === "cloud"`: carica l'app di riferimento; senza GitHub tramite installazione o se `activatedBy` non la possiede → `{status: "blocked", outcome: codeAccess}`; errore di `CodeTaskSession.open` → `blocked` col messaggio fisso. Strumenti = ruolo + `REPORT_TOOL` + strumenti del codice della modalità; l'handler interno delega a `session.run` se `session.handles(name)`; limiti `CODE_TASK_LIMITS`; system prompt + `CODE_TASK_INSTRUCTIONS`; messaggio `user` aggiuntivo con repository, branch base, branch del compito, issue, PR esistente ed esito CI (da `getCodeTask`), con la riga sulla CI rossa della spec. A fine esecuzione, se `discardedCount() > 0`, aggiungi all'esito « (modifiche non committate scartate: N file)» rispettando i 300 caratteri.

- [ ] **Step 1: test**: `it("ruolo code write: legge, modifica, committa, apre la PR e riferisce")` (script del finto provider con le chiamate; asserisce `team_code_tasks` con PR e `filesAt`); `it("riesecuzione sul branch")` (seconda esecuzione: il messaggio `user` contiene branch e «PR #1» e `leggi_file` legge il contenuto del branch, non del base); `it("chi ha attivato non possiede l'installazione → blocked codeAccess")`; `it("limiti CODE_TASK_LIMITS per i ruoli con codice")` (31° giro → failed); `it("modifiche non committate segnalate nell'esito")`.
- [ ] **Step 2:** esegui → FAIL.
- [ ] **Step 3:** implementa.
- [ ] **Step 4:** `vitest run src/lib/teams` → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): compiti cloud con codice su GitHub`.

### Task 8: Capo: `leggi_piano_app`, `issue` e motivi CI

**Files:**
- Modify: `teams/lead-tools.ts` (+ test), `teams/turn-runner.ts` (+ test)

**Interfaces:**
- Produces: strumento `leggi_piano_app` (nessun parametro) in `LEAD_TOOLS`: con l'analisi completata più recente dell'App di riferimento (`latestCompletedAnalysis` / query come in `plan-chat/run-turn.ts`) chiama `loadPlanItems`, tiene `status = approved`, restituisce JSON `[{id, chapter, title, phase, priority, dependsOn, issue: {number, state} | null}]` (≤ 100, ≤ 20 000 caratteri); senza analisi → `{ok:false, "nessun piano per l'app di riferimento"}`.
- `proponi_piano`: schema dei compiti con `issue` facoltativo (passa a `writePlanVersion`).
- `reasonMessages`: `ci_finished` → «Novità: CI del compito <planTaskId> (PR #n): verde | non superata (<riepilogo>) | nessuna CI configurata.»; `pr_closed` → «Novità: la PR #n del compito <planTaskId> è stata unita | chiusa senza merge.» (dati letti da `team_code_tasks` per `taskCodeId` e squadra).
- Prompt del capo: aggiungi il paragrafo della spec §6 «Capo».

- [ ] **Step 1: test**: `leggi_piano_app` con due voci approvate (una con issue) e una proposta → solo le approvate con `issue`; `proponi_piano` con `issue: 7` lo salva; `reasonMessages` per i due motivi nuovi.
- [ ] **Step 2:** → FAIL. **Step 3:** implementa. **Step 4:** → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): il capo legge il piano dell'app e riceve gli esiti della CI`.

### Task 9: Ruoli node: sezione Git e PR trovata dal branch

**Files:**
- Modify: `artifacts/api-server/src/lib/nodes/protocol.ts` (`buildPackage`, gestione del report `done`), test esistente del protocollo (`nodes/*.test.ts` o `test/team-node-fixture.ts`)
- Create: `code-writer/node-git.ts`

**Interfaces:**
- Produces: `nodeGitSection(input: { repo: string; baseBranch: string; branch: string; issue: number | null }): string` (testo della spec §6 «Compito node», con il comando `gh pr create --draft --base <base> --head <branch>`); `adoptNodePull(task: TeamTaskRow): Promise<void>` (ruolo `code = write`, app con installazione: `findOpenPull` → `upsertCodeTask` con `head_sha`, `last_commit_at = now`, `pr_state = open`, `ci_state = pending`; errori GitHub solo nel log).
- `buildPackage`: con `role.code === "write"` le istruzioni diventano `task.instructions + "\n\n" + nodeGitSection(...)` (branch base letto con `getDefaultBranch` se `source_branch` è null; errore → sezione senza base, «usa il branch predefinito»). Nessuna modifica in `artifacts/casello-nodo`.
- Report `done` di un compito con `code = write`: dopo `finishTaskExecution` riuscita chiama `adoptNodePull` (senza bloccare la risposta 204 in caso di errore).

- [ ] **Step 1: test**: pacchetto del claim contiene «botcave/<id>-t1» e «gh pr create --draft»; report `done` con una PR aperta nel finto → riga in `team_code_tasks`; senza PR → nessuna riga.
- [ ] **Step 2:** → FAIL. **Step 3:** implementa. **Step 4:** → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): convenzione Git per i compiti dei nodi`.

### Task 10: Sorveglianza della CI

**Files:**
- Create: `code-writer/watcher.ts`, `code-writer/watcher.test.ts`
- Modify: `artifacts/api-server/src/index.ts` (`startCodeWatcher()` dopo `startTriggerPoller`)

**Interfaces:**
- Produces: `watchCodeTasksOnce(now?: Date): Promise<void>` e `startCodeWatcher(): () => void` (60 s, un giro alla volta, `unref`).
- Un giro: fino a 20 righe `pr_state = 'open'` di squadre `active`, ordine `ci_checked_at NULLS FIRST`; per ognuna `getPull` (merged/closed → evento, `enqueueTurnReason({type: "pr_closed", taskCodeId, merged})`, `pr_state`), aggiorna `head_sha` e `last_commit_at = now` se la PR ha un commit nuovo (il confronto `head_sha ≠ ci_notified_sha` riapre la notifica), `readCi` → `ciState` con `now − last_commit_at`; esito finale con `head_sha ≠ ci_notified_sha` → `ci_notified_sha`, `ci_state`, `ci_summary`, evento (`compito_finito`/`bloccato`), con failure `patchPlan(instanceId, {tasks: [{id: planTaskId, status: "blocked", outcome: "CI non superata: …"}]})`, turno `ci_finished`; `pending` oltre 2 h da `last_commit_at` e `!ci_pending_notified` → evento `bloccato` una volta. `ci_checked_at = now` sempre; errori di GitHub: riga saltata, log con id e nome dell'errore. Testi degli eventi dalla spec §6.

- [ ] **Step 1: test**: `it("CI rossa: compito blocked nel PLAN, evento e turno ci_finished una volta sola")` (due giri sullo stesso sha → un solo turno); `it("CI verde")`; `it("nessuna CI")` (now = commit + 11 minuti); `it("pending da 2 ore: evento una volta")`; `it("PR unita: pr_closed merged e nessuna sorveglianza dopo")`; `it("nuovo commit dopo la CI rossa riapre la notifica")`; `it("squadra chiusa: riga ignorata")`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementa. **Step 4:** → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): sorveglianza della CI delle PR delle squadre`.

### Task 11: API `codeTasks` nel PLAN

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (`TeamPlan.codeTasks`, schema `TeamCodeTask`), generati, `artifacts/api-server/src/routes/team-instances.ts` (`GET …/plan`), test della route.

**Interfaces:**
- Produces: `TeamCodeTask {planTaskId, branch, baseBranch, prNumber|null, prUrl|null, prState|null, ciState|null, ciSummary|null, ciCheckedAt|null}`; `TeamPlan.codeTasks: TeamCodeTask[]` (sempre presente, vuoto se nessuna riga).

- [ ] **Step 1:** test della route: `GET /api/team-instances/:id/plan` con una riga → `codeTasks[0]` con PR e `ciState`.
- [ ] **Step 2:** → FAIL. **Step 3:** OpenAPI, codegen, route. **Step 4:** → PASS; typecheck.
- [ ] **Step 5:** commit `feat(casello): stato di branch, PR e CI nel PLAN della squadra`.

### Task 12: Console

**Files:**
- Modify: `artifacts/casello/src/components/teams/roles-editor.tsx`, `role-draft.ts`, `plan-card.tsx`, `plan-editor-dialog.tsx`, `pages/team-detail.tsx` (passaggio dell'app di riferimento se serve)

**Interfaces:**
- Consumes: `TeamRole.code`, `TeamPlanTask.issue`, `TeamPlan.codeTasks` (hook Orval generati).
- Editor dei ruoli: tendina «Codice» con Nessuno / Lettura / Scrittura (node: Nessuno / Scrittura); disattivata, con il testo «Collega il repository dell'app tramite l'App GitHub per dare il codice ai ruoli», se l'app di riferimento non ha `sourceType = github` con installazione (nei modelli di squadra sempre attiva).
- Carta «Piano»: per i compiti con una voce in `codeTasks`, riga con branch (link `https://github.com/<repo>/tree/<branch>` dalla PR o dal repo dell'app), «PR #n» (link `prUrl`), `Led` (`work` pending, `ok` success, `ko` failure, `idle` none o PR chiusa/unita) e `ciSummary`; «Issue #n» se il compito l'ha.
- Editor del PLAN: campo numerico «Issue» facoltativo per compito.

- [ ] **Step 1:** implementa; `pnpm --filter @workspace/casello run test` e `pnpm run typecheck` verdi.
- [ ] **Step 2:** prova a mano con `AUTH_DISABLED=true pnpm run dev` (o anteprima): editor dei ruoli e carta Piano a 1280 px senza scorrimento orizzontale, tema chiaro e scuro.
- [ ] **Step 3:** commit `feat(casello): codice dei ruoli, issue e PR nella scheda squadra`.

### Task 13: Prova di flusso e documentazione

**Files:**
- Create: `artifacts/api-server/test/code-team-flow.test.ts`
- Modify: `CLAUDE.md` (stato, «Dove stanno le cose», sezione nuova «Strumenti GitHub delle squadre», permessi della GitHub App in «Autenticazione»), spec (sezione «Differenze dal codice» se ce ne sono)

- [ ] **Step 1: test di flusso** (spec §9): squadra attiva con capo e ruolo `cloud` `code: write`, finto provider con script per capo e ruolo, finto GitHub con repo seminato e issue 7: assegnazione → commit + PR (`Closes #7`) → check rosso nel finto → `watchCodeTasksOnce` → turno del capo con `ci_finished` → riassegnazione → correzione e commit sullo stesso branch → check verde → `watchCodeTasksOnce` → evento «CI verde» → PR segnata merged nel finto → `pr_closed`. Compito node: report `done` con PR sul branch → sorvegliato.
- [ ] **Step 2:** esegui → deve passare (se fallisce, correggi il codice dei task precedenti, non il test).
- [ ] **Step 3:** suite completa `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test`, `pnpm run typecheck` → verdi.
- [ ] **Step 4:** aggiorna `CLAUDE.md` e la spec; commit `docs(casello): strumenti GitHub delle squadre`.
