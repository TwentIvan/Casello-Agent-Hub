# Nuova app da zero, tappa 1 — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'utente fa nascere un'app da zero. Crea il repository dal modello, compila «Nuova app → Da zero» e approva una voce in «Da confermare». Botcave personalizza il repository, registra l'App con il Responsabile, avvia l'analisi e guida il primo deploy.

**Architecture:** La richiesta è una riga di `app_bootstraps`, legata a una voce `app_bootstrap` di `pending_actions`. L'approvazione avvia in background un esecutore a passi ripetibili (`lib/app-bootstrap/`), che registra l'esito di ogni passo in `steps`. La lista guidata si calcola dalla riga. Un controllo periodico di `https://<dominio>/api/healthz` chiude l'ultima voce.

**Tech Stack:** Express 5, Drizzle, Postgres (PGlite nei test), Vitest, React con Orval, Git Data API di GitHub tramite il token d'installazione.

**Spec:** `docs/superpowers/specs/2026-11-22-botcave-nuova-app-da-zero-design.md`

## Global Constraints

- Testi visibili in italiano, con il nome «Botcave», senza punti esclamativi. Identificatori in inglese. Commit `feat(casello): …` in italiano, chiusi da `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Contract-first: ogni route nuova va in `lib/api-spec/openapi.yaml`, poi `pnpm --filter @workspace/api-spec run codegen` e commit anche dei file generati. Corpi letti con `parseRequest` e risposte con `*Response.parse`.
- Migrazione additiva e idempotente `docs/migrations/2026-11-22-nuova-app-da-zero.sql`, senza BEGIN/COMMIT perché contiene `ALTER TYPE … ADD VALUE IF NOT EXISTS`. Va riportata in `docs/schema-casello.sql`. Niente `-post`.
- Variabili facoltative, entrambe solo nell'API:
  - `APP_TEMPLATE_REPO`, default `TwentIvan/botcave-modello-app`;
  - `APP_BASE_DOMAIN`, default `fantamister.cloud`.
- Errori `{error}` con messaggi fissi in `APP_BOOTSTRAP_MESSAGES` (`lib/app-bootstrap/messages.ts`). Mai il testo di GitHub o del DB.
- Log: solo id, slug, sha a 7 caratteri ed esiti. Mai brief, contenuti dei file o token.
- Niente scorrimento orizzontale a 1280 px. Colori solo dai token (`bg-surface-1`, `text-ink-muted`…), stati con `Led`.
- Le scritture vogliono il login o `api:write`. Il token d'ambito `agent` riceve 403: le route POST e PUT vanno in `AGENT_DENIED_ROUTES` di `lib/auth.ts`.
- Comandi senza `pnpm` nel PATH: `corepack pnpm …`.
- Typecheck: `corepack pnpm run typecheck:libs && corepack pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck`.

## Review Focus

1. **Slug preso tra richiesta e approvazione.** Un'altra App nasce con lo stesso slug. Il passo «registrazione» fallisce con «lo slug <slug> è già usato da un'altra App», senza creare doppioni né toccare l'App esistente. Test nel Task 4.
2. **`main` cambiato dopo la richiesta**, per esempio da un push dell'utente. La verifica rifiuta con «il repository non è più quello appena creato: ricrealo dal modello» e non scrive nulla. Test nel Task 3.
3. **Ripresa dopo un commit riuscito e una registrazione fallita.** «Riprova» non rifà il commit: lo riconosce dal marcatore con lo slug. Crea l'App una volta sola. Test nel Task 4.
4. **Brief con una credenziale o con testo che imita i segnaposto.** La credenziale è rifiutata alla richiesta con 400. Un `__SLUG__` scritto nel brief resta testo e non viene sostituito. Test nel Task 2.
5. **Dominio in maiuscolo, con spazi o con il punto finale.** Viene normalizzato in minuscolo senza punto finale. Un dominio uguale al `base_url` di un'altra App o a quello di Botcave è rifiutato. Test nel Task 2 e nel Task 5.

---

### Task 1: Schema, migrazione e contratto

**Files:**
- Create: `lib/db/src/schema/app-bootstraps.ts`, `docs/migrations/2026-11-22-nuova-app-da-zero.sql`, `artifacts/api-server/test/migration-nuova-app-da-zero.test.ts`
- Modify: `lib/db/src/schema/pending-actions.ts` (valore `app_bootstrap` dell'enum), `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`, `lib/api-spec/openapi.yaml`, file generati

**Interfaces:**
- Produces:
  - tabella `appBootstrapsTable`, enum `appBootstrapStatusEnum` (`pending | running | done | failed | rejected`);
  - colonne:

    | Colonna | Tipo |
    |---|---|
    | `id` | serial |
    | `userId` | FK `users`, `CASCADE` |
    | `slug` | varchar 64 |
    | `name` | varchar 80 |
    | `domain` | varchar 253 |
    | `repo` | text |
    | `installationId` | integer |
    | `brief` | text |
    | `aiModelId` | FK `ai_models`, `SET NULL` |
    | `status` | enum |
    | `steps` | jsonb `BootstrapStep[]`, default `[]` |
    | `initCommitSha` | text, nullable |
    | `appId` | FK `apps`, `SET NULL` |
    | `analysisId` | FK `analyses`, `SET NULL` |
    | `pendingActionId` | FK `pending_actions`, `SET NULL` |
    | `checklist` | jsonb `Record<string, {doneAt: string}>`, default `{}` |
    | `healthOkAt`, `healthCheckedAt` | timestamp, nullable |
    | `createdAt`, `updatedAt` | timestamp |

  - indici unici parziali `app_bootstraps_slug_open_uidx` e `app_bootstraps_repo_open_uidx`, su `slug` e `repo`, `WHERE status IN ('pending','running','done')`;
  - indice `app_bootstraps_app_id_idx`.
- `type BootstrapStep = { key: "verify" | "personalize" | "register" | "analyze"; status: "pending" | "done" | "failed"; message: string | null; at: string | null }`, esportato dallo schema.
- OpenAPI:
  - schemi `AppBootstrap`:
    - `id`, `slug`, `name`, `domain`, `repo`, `status`, `steps`;
    - `initCommitSha`, `appId`, `analysisId`;
    - `pendingActionNumber` (number | null);
    - `checklist`: array di `BootstrapChecklistItem` `{key, label, detail, auto: boolean, done: boolean, doneAt}`;
    - `healthOkAt`, `healthCheckedAt`, `createdAt`;
  - `AppBootstrapCreate`: `{name, slug, domain, brief, repo, installationId, aiModelId}`;
  - `AppBootstrapCreated`: `{id, pendingActionNumber}`;
  - `app_bootstrap` aggiunto all'enum `kind` di `QueuedAction`, alla riga 8468 circa.
  - Route dichiarate qui, implementate nel Task 5:

    | Route | operationId |
    |---|---|
    | `POST /app-bootstraps` | `createAppBootstrap` |
    | `GET /app-bootstraps/{id}` | `getAppBootstrap` |
    | `POST /app-bootstraps/{id}/retry` | `retryAppBootstrap` |
    | `PUT /app-bootstraps/{id}/checklist/{item}` | `setAppBootstrapChecklistItem`, body `{done: boolean}` |
    | `POST /app-bootstraps/{id}/health-check` | `checkAppBootstrapHealth` |
    | `GET /apps/{id}/bootstrap` | `getAppBootstrapForApp` (200 `AppBootstrap`, o 404 se l'App non è nata da zero) |
    | `GET /app-bootstraps/config` | `getAppBootstrapConfig` → `{templateRepo, baseDomain}` |

  - Tag `apps`.

- [ ] **Step 1: Write the failing test** `migration-nuova-app-da-zero.test.ts`, sul modello di `migration-plugin-riordino.test.ts`:
  - applica la migrazione due volte sullo schema senza la tabella;
  - verifica con `pg_enum` che `app_bootstrap` è in `pending_action_kind`;
  - verifica che una seconda riga aperta con lo stesso `slug` dà la violazione `app_bootstraps_slug_open_uidx`;
  - verifica che con la prima riga a `failed` la seconda si inserisce.
- [ ] **Step 2:** `corepack pnpm --filter @workspace/api-server exec vitest run test/migration-nuova-app-da-zero.test.ts` → FAIL.
- [ ] **Step 3:** Scrivere migrazione, schema Drizzle, blocco in `docs/schema-casello.sql`, OpenAPI e codegen.
- [ ] **Step 4:** Il test passa e il typecheck è verde.
- [ ] **Step 5:** Commit `feat(casello): schema della nuova app da zero`.

### Task 2: Regole pure (nomi, dominio, personalizzazione)

**Files:**
- Create: `artifacts/api-server/src/lib/app-bootstrap/{messages,config,naming,personalize}.ts` con i test `naming.test.ts` e `personalize.test.ts`

**Interfaces:**
- Produces:
  - `APP_BOOTSTRAP_MESSAGES`, con questi testi esatti:

    | Chiave | Testo |
    |---|---|
    | `slugTaken` | «lo slug <slug> è già usato da un'altra App» |
    | `slugInvalid` | «slug non valido: minuscole, cifre e trattini, al più 64 caratteri» |
    | `slugReserved` | «lo slug casello è riservato» |
    | `nameInvalid` | «nome obbligatorio, al più 80 caratteri» |
    | `domainInvalid` | «dominio non valido» |
    | `domainTaken` | «il dominio è già usato da un'altra App» |
    | `briefInvalid` | «brief obbligatorio, al più 20 000 caratteri» |
    | `briefCredential` | «il brief sembra contenere una credenziale: toglila» |
    | `repoMismatch` | «il repository deve chiamarsi come lo slug» |
    | `requestOpen` | «c'è già una richiesta aperta per questo slug o repository» |
    | `notVisible` | «l'App GitHub non vede il repository: aggiungilo all'installazione» |
    | `notFromTemplate` | «il repository non è nato dal modello» |
    | `notFresh` | «il repository non è più quello appena creato: ricrealo dal modello» |
    | `tooManyFiles` | «il modello ha troppi file da personalizzare» |
    | `githubUnavailable` | «GitHub non raggiungibile: riprova» |
    | `interrupted` | «interrotto dal riavvio: usa Riprova» |
    | `notRetryable` | «la richiesta non è da riprendere» |
    | `notFound` | «richiesta non trovata» |
    | `itemNotManual` | «voce verificata da Botcave: non si segna a mano» |
    | `budget` | testo del tetto, passato così com'è |

  - `appTemplateRepo(): string` e `appBaseDomain(): string` in `config.ts`, da variabile con default.
  - `validateSlug(s: string): string | null` (messaggio o null): regola `^[a-z0-9][a-z0-9-]{0,63}$`, e `casello` è riservato.
  - `normalizeDomain(raw: string): { ok: true; domain: string } | { ok: false; message: string }`: trim, minuscolo, toglie un `.` finale. Etichette `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, almeno due etichette, 1..253 caratteri. Rifiuta IP, `localhost`, `*.localhost` e l'host di `PUBLIC_APP_URL`.
  - `defaultDomain(slug: string): string` → `${slug}.${appBaseDomain()}`.
  - `bootstrapNames(slug: string, owner: string)` → `{ apiImage, webImage, apiService, webService, webDir }`, con:
    - `apiImage` = `ghcr.io/${owner.toLowerCase()}/${slug}-api`;
    - `webImage` = `…-web`;
    - `apiService` = `${slug}-api`, `webService` = `${slug}-web`;
    - `webDir` = `artifacts/${slug}-web`.
  - `personalizeFiles(files: Map<string, string>, vars: { slug: string; name: string; domain: string; brief: string }): { changes: Map<string, string | null> } | { error: string }`:
    - sostituisce `__SLUG__`, `__APP_NAME__` e `__DOMAIN__` nei percorsi e nel contenuto;
    - non tocca i percorsi sotto `.github/`;
    - un percorso cambiato dà l'aggiunta del nuovo e `null` sul vecchio;
    - scrive `AGENT_BRIEF.md` = brief **dopo** le sostituzioni, così il brief non viene sostituito;
    - in `.botcave/modello.json` aggiunge `"slug"`, conservando gli altri campi;
    - più di 200 file → `tooManyFiles`;
    - i file invariati non entrano in `changes`.

- [ ] **Step 1: Write the failing tests.**
  - `validateSlug("casello")` → `slugReserved`; `validateSlug("Porta")` → `slugInvalid`.
  - `normalizeDomain(" Portfolio.Example.COM. ")` → `{ok:true, domain:"portfolio.example.com"}`.
  - `normalizeDomain("1.2.3.4")`, `normalizeDomain("localhost")` e `normalizeDomain("casello.fantamister.cloud")` (con `PUBLIC_APP_URL` impostata) → `ok:false`.
  - `personalizeFiles` su `{"artifacts/__SLUG__-web/index.html": 'data-app="__SLUG__"', ".github/workflows/deploy.yml": "__SLUG__", ".botcave/modello.json": '{"template":"botcave-modello-app","version":1}'}`, con slug `portfolio` e brief `"usa __SLUG__"`, deve dare:
    - `artifacts/portfolio-web/index.html` = `data-app="portfolio"`;
    - il vecchio percorso a `null`;
    - nessuna voce per il workflow;
    - `AGENT_BRIEF.md` = `"usa __SLUG__"`;
    - `JSON.parse` del marcatore uguale a `{template:"botcave-modello-app", version:1, slug:"portfolio"}`.
- [ ] **Step 2:** `vitest run src/lib/app-bootstrap` → FAIL.
- [ ] **Step 3:** Implementare.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(casello): regole della nuova app da zero`.

### Task 3: GitHub (ispezione e commit di inizializzazione)

**Files:**
- Modify:
  - `artifacts/api-server/src/lib/code-writer/github-git.ts`: estrarre il corpo di `commitFiles`, dopo `assertTaskBranch`, in `writeCommit(r, input)` non esportata. Restano invariati `commitFiles` e i suoi controlli.
  - `artifacts/api-server/test/fake-github.ts`: `template_repository` su `GET /repos/{o}/{r}` e `GET /repos/{o}/{r}/commits`.
- Create: `artifacts/api-server/src/lib/app-bootstrap/github.ts`, `github.test.ts`

**Interfaces:**
- Consumes: `personalizeFiles` (Task 2), `fetchGithubTree` (`lib/architect/sources.ts`), `installationToken` (`lib/github/app.ts`), `checkCommit` (`lib/code-writer/secrets-check.ts`).
- Produces:
  - `inspectRepo(input: { repo: string; installationId: number; slug: string }): Promise<RepoInspection>`, dove:
    ```ts
    type RepoInspection =
      | { kind: "fresh"; headSha: string; treeSha: string; files: Map<string, string> }
      | { kind: "initialized"; headSha: string }
      | { kind: "error"; message: string };
    ```
    Logica:
    - token `contents: read` ristretto al repo: 401, 403 o 404 → `notVisible`;
    - `GET /repos/{r}`: se c'è `template_repository.full_name` diverso da `appTemplateRepo()` (senza distinguere maiuscole) → `notFromTemplate`;
    - `GET /repos/{r}/commits?sha=main&per_page=3`;
    - zipball di `main` con `fetchGithubTree`: senza `.botcave/modello.json` valido con `template === "botcave-modello-app"` → `notFromTemplate`;
    - 1 commit → `fresh`;
    - 2 commit e marcatore con `slug` uguale → `initialized`;
    - altrimenti → `notFresh`;
    - rete o 5xx → `githubUnavailable`.
  - `initializeRepo(input: { repo: string; installationId: number; parentSha: string; baseTreeSha: string; changes: Map<string, string | null>; message: string }): Promise<{ sha: string } | { error: string }>`:
    - `checkCommit(changes)`: con un errore, quel messaggio;
    - `writeCommit` su `main` con `PATCH … force:false`, `createBranch: false` e token `contents: write`;
    - 422 → `notFresh`.
- Messaggio di commit: `Inizializza <nome>\n\nBotcave · nuova app da zero · richiesta <id>`.

- [ ] **Step 1: Write the failing tests** con il finto GitHub:
  - repo fresco → `fresh` con i file;
  - repo con `template_repository.full_name = "altro/modello"` → `notFromTemplate`;
  - repo senza marcatore → `notFromTemplate`;
  - 3 commit → `notFresh`;
  - 2 commit e marcatore `slug:"portfolio"` → `initialized`;
  - `initializeRepo` con `main` avanzato nel frattempo (422) → `notFresh`, e `main` invariato;
  - `commitFiles` con un branch non `botcave/…` lancia ancora.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementare.
- [ ] **Step 4:** PASS, e i test esistenti di `code-writer` sono ancora verdi (`vitest run src/lib/code-writer`).
- [ ] **Step 5:** Commit `feat(casello): ispezione e inizializzazione del repository dal modello`.

### Task 4: Servizio (richiesta, decisione, esecuzione a passi)

**Files:**
- Create: `artifacts/api-server/src/lib/app-bootstrap/service.ts`, `service.test.ts`
- Modify:
  - `lib/actions/queue.ts`: `enqueueAppBootstrapItem`;
  - `lib/actions/decide.ts`: rami `app_bootstrap` in `approveAction` e `rejectAction`;
  - `artifacts/api-server/src/index.ts`: `failInterruptedBootstraps()` **prima** di `failInterruptedActions()`.

**Interfaces:**
- Consumes: Task 2, Task 3, `userRepoAccess`, `looksLikeCredential`, `chooseCloudModel` (`lib/ai/choice.ts`), `userBudgetBlock` (`lib/budget.ts`).
  - Inserimento dell'analisi e `startAnalysis`: spostare `insertAnalysis` e `createAndStart` da `routes/analyses.ts` in `lib/architect/start.ts` (`createAndStartAnalysis(app, choice, maxTokens?, bestPractice)`), usato da entrambi.
- Produces:
  - `createBootstrap(userId: number, body: AppBootstrapCreate): Promise<{ ok: true; id: number; pendingActionNumber: number } | { ok: false; status: 400 | 403 | 409; message: string }>`:
    - **Controlli**, in ordine:
      1. nome;
      2. slug;
      3. dominio;
      4. brief (1..20 000, `looksLikeCredential` → `briefCredential`);
      5. `repo.split("/")[1].toLowerCase() === slug`, altrimenti `repoMismatch`;
      6. `userRepoAccess`, che dà 403 con i messaggi esistenti `REPO_NOT_VISIBLE` e `REPOS_NOT_VERIFIED`;
      7. modello cloud dell'utente;
      8. slug libero tra le App (409 `slugTaken`);
      9. dominio libero tra i `base_url` (409 `domainTaken`).
    - **Inserimento**: riga `pending` con i 4 passi a `pending`, e voce in coda `app_bootstrap` nella stessa transazione:
      - `recipient` = repo;
      - `summary` = «Crea l'app <nome> da zero»;
      - `argsPublic` = `{name, slug, domain, repo, names: bootstrapNames(...), steps: [quattro descrizioni con i nomi esatti], analysisEstimateUsd, monthly: "in tappa 1 nulla: Neon e Coolify li crei tu (lista guidata)"}`, dove `analysisEstimateUsd` viene dalla stessa funzione di `GET /api/ai/estimate`, oppure è null.
    - **Violazione degli indici unici** → 409 `requestOpen`. Coda piena → 409 col messaggio della coda.
  - `approveBootstrap(userId, action): Promise<DecideResult>`:
    - voce `pending` → `executing` con UPDATE condizionato;
    - riga → `running`;
    - `void runBootstrap(id, action.id)`;
    - restituisce la voce `executing`.
  - `rejectBootstrap(action, note, tx)`: riga → `rejected`.
  - `runBootstrap(id: number, actionId: number): Promise<void>`:
    - Esegue i passi non `done` in ordine e salva ogni passo.
    - **`verify`**: `inspectRepo`.
    - **`personalize`**: con `initialized` il passo si salta e `initCommitSha` = `headSha`. Altrimenti `personalizeFiles`, poi `initializeRepo`.
    - **`register`**:
      - con `appId` già valorizzato il passo si salta;
      - altrimenti, in una transazione: App con lo slug esatto (niente `uniqueSlug`):
        - `name`;
        - `baseUrl` = `https://<domain>`;
        - `sourceType` = `github`, `sourceRepo`, `sourceInstallationId`, `sourceBranch` = `main`;
        - `functionalDescription` = brief;
        - `status` come `POST /apps`;
      - e l'agente `general` con il modello scelto, come `POST /apps`;
      - violazione dell'unicità dello slug → `slugTaken`.
    - **`analyze`**:
      - con `analysisId` il passo si salta;
      - altrimenti `userBudgetBlock`, poi `createAndStartAnalysis` con `bestPractice` = default dell'utente;
      - `AnalysisBusyError` → considerato riuscito con l'analisi già in corso.
    - **Fine**: riga `done`, voce `done` con `result` «App <nome> pronta: completa la lista guidata». Al primo errore: passo `failed` con il messaggio, riga `failed`, voce `failed` con «passo <key>: <messaggio>». Non lancia mai.
  - `retryBootstrap(userId, id)`:
    - solo il proprietario e solo da `failed` (altrimenti 409 `notRetryable`);
    - riga → `running`, voce `failed` → `executing`, condizionati;
    - poi `void runBootstrap`.
  - `failInterruptedBootstraps(): Promise<number>`: righe `running` → `failed`; il passo in corso → `failed` con `interrupted`; voce → `failed` con lo stesso testo.

- [ ] **Step 1: Write the failing tests** (PGlite e finto GitHub, sul modello di `release.test.ts`):
  1. **Creazione e passi**: `createBootstrap` valido dà la voce `app_bootstrap` con `argsPublic.names.apiService === "portfolio-api"`. Dopo `approveAction` e l'attesa di `runBootstrap`:
     - i 4 passi sono `done`;
     - l'App `portfolio` ha `sourceBranch` `main` e un agente `general`;
     - l'analisi è `queued` o `running`;
     - la voce è `done`;
     - sul finto GitHub c'è il commit con `AGENT_BRIEF.md`.
  2. **Review Focus 1**: un'App `portfolio` creata dopo la richiesta fa finire il passo `register` `failed` con `slugTaken`, e c'è una sola App `portfolio`.
  3. **Review Focus 3**: con un errore simulato al passo `register`, `retryBootstrap` porta a `done` con un solo commit di inizializzazione (il finto GitHub ne conta due in tutto) e una sola App.
  4. **Brief**: un brief con `sk-` seguito da 20 caratteri → 400 `briefCredential`.
  5. **Richieste aperte**: una seconda richiesta per lo stesso repo → 409 `requestOpen`.
  6. **Rifiuto**: `rejectAction` porta la riga a `rejected` e libera lo slug.
  7. **Riavvio**: `failInterruptedBootstraps` su una riga `running` dà riga e voce `failed` con `interrupted`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementare, compresi lo spostamento in `lib/architect/start.ts` e i rami in `decide.ts`.
- [ ] **Step 4:** PASS, e `vitest run src/lib/actions src/routes/analyses` verdi.
- [ ] **Step 5:** Commit `feat(casello): esecuzione della nuova app da zero`.

### Task 5: Route, lista guidata e controllo di healthz

**Files:**
- Create: `artifacts/api-server/src/lib/app-bootstrap/checklist.ts`, `health.ts` con i test, `routes/app-bootstraps.ts` con `app-bootstraps.test.ts`
- Modify:
  - `routes/index.ts`: montare le route;
  - `lib/auth.ts`: in `AGENT_DENIED_ROUTES` vanno `POST /app-bootstraps`, `POST /app-bootstraps/:id/retry`, `PUT /app-bootstraps/:id/checklist/:item` e `POST /app-bootstraps/:id/health-check`;
  - `middlewares/rate-limit.ts`: `consumeBootstrapHealthCheck`, 6 al minuto per utente;
  - `index.ts`: `startBootstrapHealthChecker()`.

**Interfaces:**
- Consumes: Task 4, `embedAllowedOrigins()`, `fetchPage` (deps iniettabili nei test).
- Produces:
  - `buildChecklist(row, names): BootstrapChecklistItem[]`, con 7 voci in quest'ordine:
    1. `dns` (manuale; il testo cambia a seconda che `domain` finisca o no con `.${appBaseDomain()}`);
    2. `neon` (manuale, progetto `<slug>`);
    3. `coolify_api` (manuale: immagine, porta 3000, rete interna, health check `/api/healthz`, variabili `DATABASE_URL`, `PORT=3000`, `NODE_ENV=production`, `LOG_LEVEL=info`, `PUBLIC_APP_URL=https://<domain>`);
    4. `coolify_web` (manuale: immagine e dominio);
    5. `secrets` (manuale: `COOLIFY_TOKEN`, `COOLIFY_WEBHOOK_API`, `COOLIFY_WEBHOOK_WEB`);
    6. `embed_origin` (automatica: `done` se `https://<domain>` è in `embedAllowedOrigins()`);
    7. `health` (automatica: `done` se `healthOkAt` non è null).
  - `checkHealth(id: number, fetcher?: WebFetcher): Promise<boolean>`:
    - `fetchPage("https://<domain>/api/healthz")`;
    - `ok` → `healthOkAt` = ora;
    - sempre `healthCheckedAt` = ora.
  - `startBootstrapHealthChecker()`:
    - ogni 10 minuti, per le righe `done` senza `healthOkAt`, al più 20 per giro, una alla volta;
    - primo giro dopo 60 s.
  - Route:
    - `GET /app-bootstraps/config` → `{templateRepo: appTemplateRepo(), baseDomain: appBaseDomain()}`, con `api:read`;
    - `POST /app-bootstraps` è `sessionOnly`: 201, o 400/403/409 con `{error}`;
    - `GET /app-bootstraps/:id` e `GET /apps/:id/bootstrap`: solo il proprietario, altrimenti 404 `notFound`;
    - `POST /app-bootstraps/:id/retry` è `sessionOnly`: 202;
    - `PUT …/checklist/:item`: chiave fuori elenco → 404; voce automatica → 400 `itemNotManual`; risponde 200 `AppBootstrap`;
    - `POST …/health-check`: 200 `AppBootstrap`, oltre il limite 429 «Troppe richieste: riprova tra poco».

- [ ] **Step 1: Write the failing tests.**
  - `buildChecklist` con `domain = "portfolio.fantamister.cloud"` e `EMBED_ALLOWED_ORIGINS` che la contiene → `embed_origin.done === true`, `auto === true`.
  - `checkHealth` con un fetcher finto `{ok:true}` → `healthOkAt` valorizzato; con `{ok:false, code:"http_status"}` → resta null.
  - Route:
    - POST con un token `agent` → 403;
    - POST con un dominio uguale al `base_url` di un'App esistente → 409 `domainTaken` (**Review Focus 5**);
    - GET di un utente diverso → 404;
    - PUT `health` → 400 `itemNotManual`;
    - il settimo POST `health-check` in un minuto → 429.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementare.
- [ ] **Step 4:** PASS e typecheck verde.
- [ ] **Step 5:** Commit `feat(casello): route e lista guidata della nuova app da zero`.

### Task 6: Prova di flusso

**Files:**
- Create: `artifacts/api-server/test/app-bootstrap-flow.test.ts`

**Interfaces:**
- Consumes: le route vere (Task 5), il finto GitHub, il finto provider (`fake-provider.ts`) per l'analisi.

- [ ] **Step 1: Write the test.** In sequenza:
  1. `POST /api/app-bootstraps`;
  2. `GET /api/pending-actions/:n` → `kind: "app_bootstrap"`;
  3. `POST …/approve` → 200;
  4. polling su `GET /api/app-bootstraps/:id` fino a `done` (al più 5 s);
  5. `GET /api/apps/:appId/bootstrap` con 7 voci, `health.done === false`;
  6. `PUT …/checklist/neon {done:true}` → `neon.done`;
  7. `POST …/health-check` con il fetcher iniettato `ok` → `health.done`.

  Secondo scenario: errore simulato del finto GitHub sul commit (500 una volta) → `failed` sul passo `personalize`, poi `POST …/retry` → `done`.
- [ ] **Step 2:** Eseguire `vitest run test/app-bootstrap-flow.test.ts` → PASS. Se fallisce, correggere il codice dei Task 2–5, non il test.
- [ ] **Step 3:** Commit `test(casello): prova di flusso della nuova app da zero`.

### Task 7: Console

**Files:**
- Create:
  - `artifacts/casello/src/components/apps/app-bootstrap-form.tsx`;
  - `artifacts/casello/src/lib/app-bootstrap.ts` con il test `app-bootstrap.test.ts`;
  - `artifacts/casello/src/components/actions/app-bootstrap-detail.tsx`;
  - `artifacts/casello/src/components/apps/first-deploy-card.tsx`.
- Modify:
  - `components/apps/app-form-dialog.tsx`: scelta «App esistente» / «Da zero» in alto;
  - `components/actions/action-dialog.tsx` e `pending-action-item.tsx`: tipo «Nuova app», dettaglio, pulsante «Approva e crea», genere femminile;
  - `pages/app-detail.tsx`: carta «Primo deploy» sotto le carte esistenti, solo se `GET /apps/:id/bootstrap` è 200.

**Interfaces:**
- Consumes: gli hook Orval del Task 1.
- Produces, funzioni pure in `lib/app-bootstrap.ts` (stessa regola del server, testo per testo):
  - `suggestedDomain(slug, baseDomain = "fantamister.cloud")`;
  - `domainFollowsSlug(domain, previousSlug)`: true se il dominio è ancora quello proposto per lo slug precedente;
  - `repoMatchesSlug(repo, slug)`;
  - `templateGenerateUrl(templateRepo)` = `https://github.com/${templateRepo}/generate`;
  - `checklistLed(item)`: `ok` se fatta, `idle` se no, `work` per `health` con `healthCheckedAt` e senza `healthOkAt`.

  Comportamento:
  - **Modulo**:
    - lo slug si propone dal nome (minuscole e trattini) finché l'utente non lo tocca;
    - il dominio segue lo slug finché `domainFollowsSlug`;
    - il repository si sceglie da `GET /api/github/repos`, filtrato su `repoMatchesSlug`;
    - con l'elenco vuoto compaiono «Usa il modello su GitHub» (link nuova scheda) e «Ricollega GitHub» (`/api/auth/github/link`);
    - c'è l'avviso «Nulla viene scritto prima dell'approvazione in Da confermare»;
    - dopo l'invio, toast «Voce n. <N> in Da confermare» e chiusura.
  - **Dettaglio della voce**: nomi, dominio, i quattro passi, stima dell'analisi, testo mensile e, se la voce è `failed`, il passo fallito con «Riprova».
  - **Carta «Primo deploy»**:
    - righe con `Led`, testo, dettaglio con «Copia» e casella solo per le voci manuali;
    - «Controlla ora» per `health`;
    - polling ogni 10 s finché `status` è `running`;
    - con tutte le voci fatte la carta si riduce a «Primo deploy completato il <data>».
- `templateRepo` e `baseDomain` arrivano da `GET /app-bootstraps/config` (Task 1 e 5).

- [ ] **Step 1: Write the failing test** `app-bootstrap.test.ts`:
  - `suggestedDomain("portfolio")` = `"portfolio.fantamister.cloud"`;
  - `domainFollowsSlug("portfolio.fantamister.cloud","portfolio")` = true;
  - `repoMatchesSlug("TwentIvan/Portfolio","portfolio")` = true;
  - `checklistLed` sui tre casi.
- [ ] **Step 2:** `corepack pnpm --filter @workspace/casello run test` → FAIL.
- [ ] **Step 3:** Implementare le funzioni e i componenti.
- [ ] **Step 4:** Test verdi, typecheck e `corepack pnpm run build` verdi.
- [ ] **Step 5:** Commit `feat(casello): nuova app da zero nella console`.

### Task 8: Documentazione

**Files:**
- Modify: `CLAUDE.md`:
  - riga in «Stato»;
  - righe in «Dove stanno le cose»;
  - sezione nuova «Nuova app da zero»: flusso, route, messaggi, migrazione, variabili `APP_TEMPLATE_REPO` e `APP_BASE_DOMAIN`, eccezione della scrittura su `main`, fuori ambito.
  - In «Deploy»: le due variabili facoltative.

- [ ] **Step 1:** Scrivere, tenendo il tono e la struttura delle sezioni vicine (es. «Riordino del plugin»).
- [ ] **Step 2:** Commit `docs(casello): nuova app da zero in CLAUDE.md`.

### Task 9: Contenuto del repository modello (repository a parte)

Parte solo dopo che Ivan ha creato vuoto `TwentIvan/botcave-modello-app`. Si lavora in un clone in `~/Projects/botcave-modello-app`, su un branch `feat/modello-iniziale`, con una PR verso il suo `main`. Questo repository non lo tocca.

**Files** (nel repository modello):
- `package.json`, `pnpm-workspace.yaml` (con `minimumReleaseAge`), `tsconfig.base.json` e `tsconfig.json`: ripresi da Botcave e ridotti.
- `artifacts/api-server/`: Express 5 con `GET /api/healthz` → `{status:"ok"}`, `src/lib/migrations/` copiato da Botcave senza le parti specifiche (`BASELINE_MIGRATIONS` vuoto), test Vitest di `healthz` e delle migrazioni.
- `artifacts/__SLUG__-web/`: Vite e React. In `index.html` il titolo `__APP_NAME__` e la riga del plugin con `data-app="__SLUG__"`. Una pagina che chiama `/api/healthz` con l'hook Orval.
- `lib/db` (Drizzle, schema vuoto), `lib/api-spec/openapi.yaml` (solo `healthz`), `lib/api-client-react` generato.
- `docs/migrations/2026-11-22-iniziale.sql`, idempotente e senza istruzioni.
- `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/nginx.conf.template`: proxy di `/api/` verso `__SLUG__-api:3000`, SPA, `X-Forwarded-Proto`. La CSP permette lo script e l'iframe di `https://casello.fantamister.cloud`.
- `.github/workflows/deploy.yml`:
  - typecheck e test su ogni push;
  - nome in minuscolo da `github.repository`;
  - build e push di `ghcr.io/<owner>/<repo>-api|web` con il tag `:<sha>`, e `:latest` solo su `main`;
  - deploy solo su `main`, con i webhook Coolify `force=true`, e solo se i tre segreti esistono, altrimenti un passo `echo "::warning::…"`;
  - sola build su `feat/**` e `botcave/**`.
- `CLAUDE.md` con `__APP_NAME__` e le regole (italiano, contract-first, migrazioni additive), `AGENT_BRIEF.md` segnaposto, `.botcave/modello.json` = `{"template":"botcave-modello-app","version":1}`, `README.md` («Nato dal modello di Botcave: usa Nuova app → Da zero»).

- [ ] **Step 1:** Ivan crea il repository vuoto e privato e lo aggiunge all'installazione «Casello». Ivan dà l'OK alla PR del contenuto.
- [ ] **Step 2:** Scrivere i file. Verificare, sostituendo i segnaposto in una copia temporanea con `portfolio`: `pnpm install`, typecheck, test, build. Verificare anche `docker build` dei due Dockerfile, se Docker è disponibile, altrimenti lo dice la CI della PR.
- [ ] **Step 3:** Verificare `grep -rn "__SLUG__" .github` → nessun risultato.
- [ ] **Step 4:** Commit e PR verso il `main` del modello. Il merge spetta a Ivan. Poi Ivan segna il repository come «Template repository».
- [ ] **Step 5:** Con il modello pronto, la verifica di `template_repository` (Task 3) si ricontrolla su un repository vero creato dal modello. Se GitHub non lo espone nella risposta, resta valido il solo marcatore: lo si annota nella PR di Botcave.
