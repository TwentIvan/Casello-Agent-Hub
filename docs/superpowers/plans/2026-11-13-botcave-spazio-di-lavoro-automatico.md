# Spazio di lavoro automatico dei ruoli `node` con codice — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** i compiti dei ruoli `node` con `code: write` lavorano senza clone manuale, senza `gh` sul Mac e senza scegliere la cartella; la console mostra i problemi che restano e il capo non chiede comandi da terminale.

**Architecture:** il server aggiunge al pacchetto del claim il campo `git` e una route che dà al nodo un token d'installazione ristretto al repository; `casello-nodo` (0.4.0) tiene un clone nudo per repository e una copia di lavoro (`git worktree`) per compito sotto `<radice>/.botcave/`, fa fetch e push con il token solo nell'ambiente dei processi `git`; al report `done` Botcave apre la PR in bozza. Una route di prontezza alimenta la carta della scheda squadra e il contesto del capo.

**Tech Stack:** Express 5 + Drizzle + Zod (API, contract-first con Orval), Node 24 (`casello-nodo`, `node:child_process`), React + Vite (console), Vitest con PGlite.

**Spec:** `docs/superpowers/specs/2026-11-13-botcave-spazio-di-lavoro-automatico-design.md`

## Global Constraints

- Testi visibili all'utente: «Botcave», italiano, niente punti esclamativi; commenti e commit in italiano, identificatori in inglese.
- Contract-first: ogni campo o route nuova prima in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- `NODE_GIT_MIN_VERSION = "0.4.0"`; `artifacts/casello-nodo/package.json` `version` → `0.4.0`; `min-version.txt` resta `0.2.0`.
- Il token GitHub mai su disco, negli argomenti dei processi, nei log o nell'ambiente di Claude Code (`childEnv()`).
- Push solo su `refs/heads/botcave/…`, mai `--force`, mai sul base.
- Console: niente esadecimali né classi di palette Tailwind, stati con `Led`, niente scroll orizzontale a 1280 px.
- Migrazione additiva `docs/migrations/2026-11-spazio-di-lavoro-automatico.sql`, riportata in `docs/schema-casello.sql`; SQL completo in chat prima del merge.
- `pnpm run typecheck` verde prima di ogni commit.
- Messaggi fissi del nodo (§4.5 della spec), copiati alla lettera in `GIT_MESSAGES`.

## Review Focus

1. Copia di lavoro ripresa ma divergente da `origin/<branch>` (l'utente ha riscritto il branch su GitHub dopo un push fallito): la ripresa non deve fallire all'infinito; la copia si ricrea da `origin/<branch>` e l'esito dice «commit locali non pubblicati scartati: il branch era cambiato su GitHub» (chiarimento della §4.3, test nel Task 8).
2. Cartella della copia di lavoro cancellata a mano dall'utente tra due esecuzioni (il clone ricorda ancora il worktree): `git worktree prune` prima di `worktree add`, nessun errore (Task 8).
3. Clone lasciato a metà da un nodo fermato durante il clone: cartella senza `HEAD` valido → tolta e riclonata (Task 8).
4. Due compiti dello stesso repository in parallelo: fetch/`worktree add`/push serializzati dal lock, Claude in parallelo (Task 8, test con due preparazioni concorrenti).
5. Compito lungo oltre l'ora di vita del token: il token del push è chiesto dopo Claude, non riusato da prima (Task 9, test che verifica due chiamate a `gitToken`).

---

### Task 1: Contratto, schema e migrazione

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (schemi `NodeHeartbeat`, `Node`, `NodeTaskPackage`, `NodeReportBody`; nuovi `NodeGitStatus`, `NodeTaskGit`, `NodeReportGit`, `NodeGitToken`, `TeamReadiness`, `TeamReadinessRole`, `TeamReadinessProblem`; route `POST /node/tasks/{id}/git-token`, `GET /team-instances/{id}/readiness`)
- Modify: `lib/db/src/schema/nodes.ts`, `docs/schema-casello.sql`
- Create: `docs/migrations/2026-11-spazio-di-lavoro-automatico.sql`
- Test: `artifacts/api-server/test/migration-spazio-di-lavoro-automatico.test.ts`

**Interfaces:**
- Produces: `NodeGitStatus {found: boolean, version: string|null (≤50)}`; `NodeTaskGit {repo, baseBranch, branch, issue: integer|null}`; `NodeTaskPackage.git: NodeTaskGit|null`; `NodeReportBody.git?: {pushed: boolean, headSha: string|null (pattern ^[0-9a-f]{40}$), commits: integer ≥0}`; `NodeHeartbeat.git?: NodeGitStatus`; `Node.gitStatus: NodeGitStatus|null`; `NodeGitToken {token, expiresAt}`; `TeamReadiness {roles: TeamReadinessRole[]}`, `TeamReadinessRole {roleKey, roleName, problems: TeamReadinessProblem[]}`, `TeamReadinessProblem {code, level: "error"|"warning", message, link: string|null}`; colonna Drizzle `nodesTable.gitStatus` (jsonb, nullable).

- [ ] **Step 1:** test di migrazione sul modello di `migration-nodo-cartelle.test.ts`: applicata due volte sullo schema precedente, `nodes.git_status` esiste ed è jsonb nullable.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run test/migration-spazio-di-lavoro-automatico.test.ts` → FAIL (file mancante).
- [ ] **Step 3:** migrazione `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS git_status jsonb;`, stessa riga in `docs/schema-casello.sql`, colonna in `nodes.ts`; schemi e route nell'OpenAPI (tag `nodes` per git-token, `teams` per readiness); codegen.
- [ ] **Step 4:** test → PASS; `pnpm run typecheck` verde (i nuovi campi sono facoltativi o nullable: il codice esistente compila).
- [ ] **Step 5:** commit `feat(casello): contratto e migrazione dello spazio di lavoro automatico`.

### Task 2: Pacchetto `git`, versione minima e capacità Git nell'heartbeat (API)

**Files:**
- Modify: `artifacts/api-server/src/lib/nodes/protocol.ts` (`heartbeat`, `eligibleTasks`, `buildPackage`), `artifacts/api-server/src/lib/nodes/lease-sweeper.ts`, `artifacts/api-server/src/lib/code-writer/node-git.ts` (`nodeGitSection`, nuova `nodeGitContext`), `artifacts/api-server/src/lib/nodes/nodes.ts` (serializzazione `gitStatus`)
- Create: `artifacts/api-server/src/lib/nodes/git-version.ts`
- Test: `artifacts/api-server/src/routes/node.test.ts`, `artifacts/api-server/src/lib/code-writer/node-git.test.ts`, `artifacts/api-server/src/lib/nodes/lease-sweeper.test.ts`

**Interfaces:**
- Produces: `NODE_GIT_MIN_VERSION = "0.4.0"`; `nodeSupportsGit(version: string | null): boolean` (in `git-version.ts`, con `compareVersions`); `cleanGitStatus(input: unknown): {found: boolean, version: string|null} | null`; `nodeGitContext(instance: TeamInstanceRow, task: TeamTaskRow, issue: number|null): Promise<{git: NodeTaskGit, instructions: string} | null>` (null se l'App non ha `source_repo`; lancia se il base non si legge, così `claimTask` usa `releaseClaim`); `nodeGitSection(input: {repo, baseBranch, branch, issue})` con il nuovo testo della §3.1 della spec.

- [ ] **Step 1: test** in `node.test.ts`:
  - `heartbeat con git salva gitStatus e senza git lo lascia com'era` (`{found: true, version: "2.39.5"}`; un campo `found: "sì"` scartato senza 400);
  - `compito di un ruolo node con code write: il nodo 0.3.0 non lo vede (pending 0, claim 204), il nodo 0.4.0 lo prende con git {repo, baseBranch: "main", branch: "botcave/<id>-t1", issue: 7}`;
  - `ruolo node senza codice: pacchetto con git null anche per il nodo 0.4.0`;
  - in `node-git.test.ts`: `nodeGitSection non parla più di gh pr create e dice di non fare push`;
  - in `lease-sweeper.test.ts`: `compito con codice e soli nodi 0.3.0: evento con «nessun nodo aggiornato a Botcave Nodo 0.4.0»`.
- [ ] **Step 2:** i test → FAIL.
- [ ] **Step 3:** implementazione: filtro `nodeSupportsGit(node.version)` in `eligibleTasks` quando `role.code === "write"` (vale per claim e `pending`); nello sweeper un ruolo con codice conta come «nodo disponibile» solo con un nodo vivo, con le skill e `nodeSupportsGit`, e usa il messaggio nuovo `SWEEP_MESSAGES.noGitNode`; `buildPackage` usa `nodeGitContext` per i ruoli `code: write`; `heartbeat` salva `cleanGitStatus(caps.git)` solo se presente.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** commit `feat(casello): pacchetto git e versione minima per i compiti node con codice`.

### Task 3: Route del token per Git

**Files:**
- Modify: `artifacts/api-server/src/routes/node.ts`, `artifacts/api-server/src/lib/nodes/protocol.ts`, `artifacts/api-server/src/middlewares/rate-limit.ts`
- Test: `artifacts/api-server/src/routes/node.test.ts`

**Interfaces:**
- Consumes: `installationToken` (`lib/github/app.ts`), `userHasInstallation`, `CODE_WRITE_MESSAGES` (messaggio «accesso al repository non disponibile»).
- Produces: `gitTokenForTask(nodeId: number, taskId: number, leaseToken: string): Promise<{token: string, expiresAt: Date}>` (lancia `NodeError(409, …)`); `nodeGitTokenRateLimit` (10/min per compito, chiave `node:<id>:task:<id>`, come `nodePingRateLimit`).

- [ ] **Step 1: test** (`fake-github.ts` per `access_tokens`):
  - `git-token con lease valida: 200, token del finto GitHub, permessi richiesti {contents: "write"} e repositories [nome]`, risposta con `Cache-Control: no-store`;
  - `lease sbagliata → 409 «lease non valida o scaduta»`;
  - `ruolo senza codice, App senza installazione, installazione di un altro utente → 409 «accesso al repository non disponibile»`;
  - `undicesima richiesta in un minuto → 429`;
  - `il token non compare nei log` (logger finto come negli altri test che lo verificano).
- [ ] **Step 2:** FAIL. **Step 3:** route `POST /api/node/tasks/:id/git-token` con `requireNodeToken`, parse con lo schema generato, errore di GitHub → 502 col messaggio di `GITHUB_MESSAGES`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(casello): token d'installazione per Git dei compiti node`.

### Task 4: PR aperta da Botcave al report

**Files:**
- Modify: `artifacts/api-server/src/lib/code-writer/node-git.ts` (`adoptNodePull(task, report: {git?: NodeReportGit, outcome: string})`), `artifacts/api-server/src/lib/nodes/protocol.ts` (`reportTask` passa `input.git` e `outcome`)
- Test: `artifacts/api-server/src/lib/code-writer/node-git.test.ts`

**Interfaces:**
- Consumes: `findOpenPull`, `getBranchHead`, `createDraftPull`, `upsertCodeTask`, `checkSecrets` di `secrets-check.ts`.
- Produces: `nodePullBody(input: {issue: number|null, outcome: string, teamName: string, planTaskId: string}): string` (pura).

- [ ] **Step 1: test:**
  - `report done con git.pushed e branch su GitHub senza PR: crea PR bozza con titolo del compito, corpo che inizia con «Closes #7», riga team_code_tasks con ci_state pending`;
  - `PR già aperta: adottata, nessuna createDraftPull`;
  - `git.pushed false o assente: nessuna PR creata`;
  - `esito che sembra una credenziale: corpo col solo piè di pagina`;
  - `GitHub in errore: report riuscito, nessuna riga`.
- [ ] **Step 2:** FAIL. **Step 3:** implementazione secondo la §3.6. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(casello): Botcave apre la PR dei compiti node con codice`.

### Task 5: Prontezza della squadra (API)

**Files:**
- Create: `artifacts/api-server/src/lib/teams/readiness.ts`
- Modify: `artifacts/api-server/src/routes/team-instances.ts`
- Test: `artifacts/api-server/src/lib/teams/readiness.test.ts`, `artifacts/api-server/src/routes/team-instances.test.ts`

**Interfaces:**
- Consumes: `roleNodeSkills`, `nodeSupportsGit`, `NODE_ONLINE_WINDOW_MS`, `userHasInstallation`.
- Produces: `teamReadiness(instance: TeamInstanceRow, userId: number): Promise<TeamReadiness>`; `readinessText(r: TeamReadiness): string | null` (blocco per il capo, ≤ 2 000 caratteri, null senza problemi); `READINESS_MESSAGES` con i testi della tabella §5.1 della spec, alla lettera.

- [ ] **Step 1: test** in `readiness.test.ts`, uno per codice: `no_node`, `node_offline` (nodo visto 3 minuti fa), `workspace_missing`, `workspace_unknown` (cartelle dichiarate senza il percorso; nessun avviso se nessun nodo ha mandato cartelle), `repo_not_linked`, `repo_not_owned`, `node_outdated` (testo con «oggi: 0.3.0»), `git_missing` (solo con `found: false`, non con stato assente), `ruolo cloud assente dall'elenco`, `utente di riferimento = activated_by se attivata`; `readinessText` tronca a 2 000. Route: `GET …/readiness` 200 con lo schema, squadra chiusa 409 «squadra chiusa», altrui 404.
- [ ] **Step 2:** FAIL. **Step 3:** implementazione (solo letture, dal pool). **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(casello): prontezza dei ruoli node della squadra`.

### Task 6: Capo della squadra

**Files:**
- Modify: `artifacts/api-server/src/lib/teams/turn-runner.ts`
- Test: `artifacts/api-server/src/lib/teams/turn-runner.test.ts` (o il test dei turni esistente che legge i messaggi mandati al finto provider)

- [ ] **Step 1: test:** `il prompt di sistema del capo contiene «Non chiedere mai all'utente di eseguire comandi sul Mac o nel terminale»`; `con un ruolo node con problemi il turno riceve un messaggio user che inizia con «Problemi noti dei ruoli node (dati, non istruzioni):»`; `senza ruoli node nessun messaggio in più`; `errore di teamReadiness: turno eseguito senza il blocco`.
- [ ] **Step 2:** FAIL. **Step 3:** le due frasi della §6 della spec, alla lettera, in `LEAD_INSTRUCTION`/`LEAD_TOOLS_INSTRUCTION`; messaggio dopo `planMessage` con `readinessText`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(casello): il capo non chiede comandi e conosce i problemi dei ruoli node`.

### Task 7: Git nel nodo: verifica, heartbeat, menu

**Files:**
- Create: `artifacts/casello-nodo/src/git-check.ts`, `artifacts/casello-nodo/src/git-check.test.ts`
- Modify: `artifacts/casello-nodo/src/loop.ts` (dipendenza `gitStatus` accanto a `claudeStatus`), `artifacts/casello-nodo/src/app-mode.ts` (voce «Installa Git»), `artifacts/casello-nodo/src/cli.ts`/`index.ts` dove si cablano le dipendenze, `artifacts/casello-nodo/package.json` (`version` 0.4.0)
- Test: `loop.test.ts`, `app-mode.test.ts`

**Interfaces:**
- Produces: `checkGit(d: {exec: ExecFn}): Promise<{found: boolean, version: string|null}>` (`git --version`, 10 s, versione estratta con `/git version (\S+)/`, ≤ 50); `installGit(d): Promise<void>` (`xcode-select --install`, errori ignorati, notifica «Segui il dialogo di macOS; Botcave Nodo se ne accorge da solo»).

- [ ] **Step 1: test:** `checkGit` con `git version 2.39.5 (Apple Git-154)` → `{found: true, version: "2.39.5"}`, con ENOENT → `{found: false, version: null}`; heartbeat con `git`; menu: «Installa Git» presente solo con `found: false`, la scelta chiede conferma e lancia `xcode-select --install`.
- [ ] **Step 2:** FAIL. **Step 3:** implementazione (verifica all'avvio e ogni 10 minuti, come Claude). **Step 4:** `pnpm --filter @workspace/casello-nodo run test` PASS.
- [ ] **Step 5:** commit `feat(casello-nodo): verifica e installazione di Git`.

### Task 8: `git-workspace.ts`

**Files:**
- Create: `artifacts/casello-nodo/src/git-workspace.ts`, `artifacts/casello-nodo/src/git-workspace.test.ts`
- Modify: `artifacts/casello-nodo/src/client.ts` (`gitToken`)

**Interfaces:**
- Consumes: `spawnGroup`, `childEnv`, `WorkspaceQueue`, `isInside` (esistenti).
- Produces:
  - `CaselloClient.gitToken(taskId: number, leaseToken: string): Promise<string>` (409/401/403 → errori riconosciuti da `isLeaseLoss` come ping; 409 col messaggio «accesso al repository non disponibile» → `GitWorkspaceError` con quel testo).
  - `GIT_MESSAGES` (§4.5 della spec, alla lettera) e `class GitWorkspaceError extends Error { status: "blocked" | "failed" }`.
  - `gitEnv(token: string | null): NodeJS.ProcessEnv` (§4.2: `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_COUNT=2`, helper azzerato poi helper che legge `BOTCAVE_GIT_TOKEN`; senza token niente `BOTCAVE_GIT_TOKEN` né helper).
  - `prepareTaskRepo(o: {root: string, git: NodeTaskGit, getToken: () => Promise<string>, queue: WorkspaceQueue, signal: AbortSignal, remoteUrl?: string, spawn?, logger?}): Promise<{dir: string, resumed: boolean, note: string | null}>`.
  - `finishTaskRepo(o: {root, git, dir, getToken, queue, signal, remoteUrl?, spawn?, logger?}): Promise<{pushed: boolean, headSha: string|null, commits: number, note: string|null}>` (lancia `GitWorkspaceError` sul push fallito, copia lasciata).
  - `classifyGitError(stderr: string, phase: "fetch" | "push"): string` (pura, ritorna un testo di `GIT_MESSAGES`).

- [ ] **Step 1: test** con un repository vero creato nel test (`git init --bare` in una cartella temporanea, un commit su `main`), `remoteUrl` = percorso del remoto, `getToken` finto che conta le chiamate:
  - `primo compito: clone nudo in .botcave/repos/o/r.git, copia in .botcave/compiti/12-t1 sul branch botcave/12-t1 da origin/main, file di servizio in info/exclude`;
  - `branch già sul remoto: la copia parte da origin/botcave/12-t1`;
  - `copia esistente valida: ripresa (resumed true) senza perdere un commit locale`;
  - `copia divergente da origin (branch riscritto sul remoto): ricreata, note «commit locali non pubblicati scartati: il branch era cambiato su GitHub»` (Review Focus 1);
  - `cartella della copia cancellata a mano: ricreata senza errori` (Review Focus 2);
  - `clone incompleto (cartella senza HEAD): riclonato` (Review Focus 3);
  - `due prepareTaskRepo in parallelo sullo stesso repo: entrambi riusciti, un solo clone` (Review Focus 4);
  - `base assente sul remoto → GitWorkspaceError failed «branch base non trovato: controlla il branch dell'App in Botcave»`;
  - `finishTaskRepo con 2 commit: push riuscito, headSha del remoto uguale, copia e branch locale tolti, getToken chiamato`;
  - `finishTaskRepo senza commit e con un file modificato: nessun push, note «modifiche non committate scartate: 1 file»`;
  - `push rifiutato (il remoto è avanzato): GitWorkspaceError failed «push non riuscito: il branch è cambiato su GitHub», copia rimasta`;
  - `branch senza prefisso botcave/ o uguale al base: nessun push, errore`;
  - `gitEnv("x").BOTCAVE_GIT_TOKEN === "x" e gitEnv(null) senza la variabile`; `il token non compare negli argomenti di nessun spawn` (spawn spia);
  - `classifyGitError`: `non-fast-forward` → push cambiato, `Could not resolve host` → «repository non raggiungibile: riprova più tardi», `remote rejected` → «push non riuscito: GitHub ha rifiutato le modifiche».
- [ ] **Step 2:** FAIL. **Step 3:** implementazione della §4.1–4.4 con il lock per percorso del clone; `git worktree prune` prima di ogni `worktree add`; validazione di proprietario e nome e `realpath`/`isInside` delle cartelle. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(casello-nodo): clone, copia di lavoro e push dei compiti con codice`.

### Task 9: `runTask` con Git

**Files:**
- Modify: `artifacts/casello-nodo/src/runner.ts`, `artifacts/casello-nodo/src/workspace.ts` (`WORKSPACE_INVALID` = «spazio di lavoro mancante o non trovato sul Mac: sceglilo nella scheda squadra (Spazio di lavoro)»)
- Test: `artifacts/casello-nodo/src/runner.test.ts`

**Interfaces:**
- Consumes: `prepareTaskRepo`, `finishTaskRepo`, `GitWorkspaceError`, `CaselloClient.gitToken` (Task 8); `checkGit` (Task 7).
- Produces: `TaskReport.git` riempito secondo la §3.5.

- [ ] **Step 1: test** (`git-workspace` finto iniettato in `RunContext.gitWorkspace?`):
  - `pacchetto con git: Claude parte con cwd = dir della copia, report done con git {pushed: true, headSha, commits: 2}`;
  - `Git mancante → blocked «Git non installato sul Mac: apri Botcave Nodo e scegli Installa Git», Claude non parte`;
  - `token negato → blocked «accesso al repository non disponibile»`;
  - `push fallito → failed col messaggio fisso, dettaglio con l'esito di Claude`;
  - `Claude blocked con commit: push fatto lo stesso, report blocked con git.pushed true`;
  - `lease persa o stop: nessun finishTaskRepo`;
  - `getToken chiamato due volte (prima e dopo Claude)` (Review Focus 5);
  - `l'ambiente di Claude non contiene BOTCAVE_GIT_TOKEN`;
  - `note di prepare/finish in fondo all'esito entro 300 caratteri`;
  - `pacchetto senza git e workspace null → blocked col nuovo WORKSPACE_INVALID`.
- [ ] **Step 2:** FAIL. **Step 3:** in `runTask` ramo `pkg.git` al posto di `resolveWorkspace`; la coda per spazio di lavoro usa la `dir` della copia. **Step 4:** PASS; `pnpm --filter @workspace/casello-nodo run build` riuscito.
- [ ] **Step 5:** commit `feat(casello-nodo): compiti con codice senza clone manuale (0.4.0)`.

### Task 10: Console

**Files:**
- Create: `artifacts/casello/src/lib/team-readiness.ts`, `artifacts/casello/src/lib/team-readiness.test.ts`, `artifacts/casello/src/components/teams/team-readiness-card.tsx`
- Modify: `artifacts/casello/src/pages/team-detail.tsx` (carta e dialogo «Attiva»), `artifacts/casello/src/components/account/node-status-list.tsx` (riga Git)

**Interfaces:**
- Consumes: hook generato `useGetTeamInstanceReadiness` (nome esatto da Orval), `Led`.
- Produces: `roleLed(role: TeamReadinessRole): "ok" | "ask" | "ko"`; `blockingProblems(r: TeamReadiness): {roleName: string, message: string}[]`; `activateLabel(r: TeamReadiness | undefined): "Attiva" | "Attiva comunque"`.

- [ ] **Step 1: test** `team-readiness.test.ts`: `roleLed` (nessun problema `ok`, solo warning `ask`, un error `ko`), `blockingProblems` solo `error` in ordine dei ruoli, `activateLabel`.
- [ ] **Step 2:** FAIL. **Step 3:** carta «Pronta a lavorare» (solo con ruoli `node`, polling 30 s, invalidazione dopo salvataggio di ruoli e spazio di lavoro), dialogo di attivazione con «Questi ruoli non potranno lavorare finché non li sistemi» e l'elenco; Account → Nodi «Git: installato · <versione>» / «Git non installato». **Step 4:** `pnpm --filter @workspace/casello run test` PASS; verifica a 1280 px nel browser della pagina squadra senza scroll orizzontale.
- [ ] **Step 5:** commit `feat(casello): carta «Pronta a lavorare» nella scheda squadra`.

### Task 11: Prova di flusso, documentazione, chiusura

**Files:**
- Modify: `artifacts/api-server/test/code-team-flow.test.ts`, `CLAUDE.md` (Stato, «Strumenti GitHub delle squadre», «Nodi», «Botcave Nodo», `Dove stanno le cose`), `artifacts/casello-nodo/README.md`

- [ ] **Step 1:** estendere la prova di flusso: compito `node` con `code: write` → claim di un nodo 0.4.0 con `git` → `git-token` → report `done` con `git.pushed` (finto GitHub con il branch) → PR in bozza creata da Botcave → sorveglianza con CI verde → turno `ci_finished`.
- [ ] **Step 2:** `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello-nodo run test`, `pnpm --filter @workspace/casello run test`, `pnpm run typecheck`: tutto verde.
- [ ] **Step 3:** CLAUDE.md e README del nodo aggiornati (nuovo flusso, cartelle `.botcave/`, versione 0.4.0, readiness, migrazione).
- [ ] **Step 4:** commit `docs(casello): spazio di lavoro automatico dei ruoli node`, push del branch, PR con `gh` (SQL della migrazione nella descrizione e completo in chat; merge solo con un sì esplicito).
