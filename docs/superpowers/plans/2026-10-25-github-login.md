# Login con GitHub e collegamento ai repository — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** entrare in Casello con Google o GitHub, collegare GitHub da loggati e scegliere il repository di
un'app da un elenco, con l'architetto che scarica il codice tramite un token di installazione a scadenza.

**Architecture:** utenti e identità in tabelle proprie (`users`, `user_identities`) e sessione con
`userId`; una GitHub App (permessi in sola lettura) per login OAuth e accesso ai repo tramite token di
installazione firmati con la chiave privata (JWT RS256 con `node:crypto`). Un'unica callback GitHub
gestisce login, collegamento e ritorno dall'installazione, e a ogni passaggio risincronizza le
installazioni dell'utente leggendole con il token appena ottenuto.

**Tech Stack:** Express 5, express-session (Postgres), openid-client (solo Google), Drizzle, Zod/Orval,
Vitest + PGlite, React + React Query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-25-casello-github-design.md`

## Global Constraints

- Lingua: italiano per commenti, messaggi d'errore, testi della UI e commit; identificatori in inglese.
- Contract-first: ogni route nuova o cambiata passa da `lib/api-spec/openapi.yaml` + codegen
  (`pnpm --filter @workspace/api-spec run codegen`), file generati committati; route con `parseRequest`
  e `*Response.parse` come le esistenti.
- Schema DB: ogni modifica in `lib/db/src/schema/`, in `docs/schema-casello.sql` e nella migrazione
  `docs/migrations/2026-10-github.sql` (idempotente, una transazione, `psql -v ON_ERROR_STOP=1`).
- Nessuna nuova dipendenza npm: JWT RS256 con `node:crypto`, HTTP con `fetch`.
- Variabili GitHub tutte facoltative: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
  `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (PEM, a capo veri o `\n`); se ne manca una GitHub è
  disattivato e l'API parte comunque. Solo test: `GITHUB_API_BASE`, `GITHUB_WEB_BASE` (ignorate con
  `NODE_ENV=production`).
- Nessun token GitHub salvato: token utente usato e scartato; token di installazione solo in memoria
  (cache fino a 5 minuti prima della scadenza). Chiave privata, client secret e token mai in log, DB,
  risposte o messaggi d'errore; errori verso GitHub con testi fissi.
- Accesso: una sola funzione `isAllowed(emails: string[]): boolean` (oggi: un'email verificata in
  `ALLOWED_EMAILS`).
- Messaggi fissati dalla spec: "email GitHub non autorizzata", "account GitHub già collegato a un altro
  utente", "GitHub non configurato", "installazione non trovata o non tua", "l'App Casello non ha più
  accesso a questo repository: reinstallala o scegli un altro repo", "GitHub non risponde (riprova più
  tardi)".
- `pnpm run typecheck` e `pnpm --filter @workspace/api-server run test` verdi prima di ogni commit.

## Review Focus

1. Sessioni già aperte prima del rilascio (solo `user.email`): devono continuare a funzionare senza
   rifare il login → test in Task 2.
2. Codice OAuth che arriva alla callback senza il nostro `state` (installazione partita da GitHub, link
   forgiato): non va mai scambiato; si riparte con un flusso di collegamento nostro → test in Task 4.
3. Due utenti diversi che collegano la stessa identità GitHub, o un utente che scollega l'unica identità:
   rifiuto chiaro, nessuna modifica → test in Task 4.
4. Installazione revocata o repo tolto dall'installazione dopo aver salvato le sorgenti: elenco dei repo
   e analisi falliscono con il messaggio della spec, senza bloccare le altre installazioni → test in
   Task 5 e Task 6.
5. GitHub non configurato in produzione: login Google, sorgenti con token manuale e analisi devono
   funzionare come oggi → test in Task 3 e Task 6.

---

### Task 1: Schema e migrazione

**Files:**
- Create: `lib/db/src/schema/users.ts`, `lib/db/src/schema/user-identities.ts`,
  `lib/db/src/schema/github-installations.ts`, `docs/migrations/2026-10-github.sql`,
  `artifacts/api-server/test/migration-github.test.ts`
- Modify: `lib/db/src/schema/apps.ts`, `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`

**Interfaces:**
- Produces: `usersTable` (`id` serial, `email` text unique not null, `name` text, `picture` text,
  `createdAt`, `lastLoginAt` timestamp), `userIdentitiesTable` (`id`, `userId` → users cascade,
  `provider` enum `identity_provider` (`google`, `github`), `providerUserId` text, `email` text,
  `username` text, `createdAt`; unique (`provider`, `providerUserId`) nome
  `user_identities_provider_user_unique`, unique (`userId`, `provider`) nome
  `user_identities_user_provider_unique`), `githubInstallationsTable` (`id`, `userId` → users cascade,
  `installationId` bigint mode number, `accountLogin` text, `accountType` text, `repositorySelection`
  text, `createdAt`, `updatedAt`; unique (`userId`, `installationId`) nome
  `github_installations_user_installation_unique`), `apps.sourceInstallationId` bigint mode number
  nullable; tipi `User`, `UserIdentity`, `GithubInstallation`.

- [ ] **Step 1: Test** `migration-github.test.ts` sul modello di `migration-fase-3.test.ts` (fixture dello
  schema prima della migrazione = `docs/schema-casello.sql` attuale copiato in
  `test/fixtures/schema-pre-github.sql`): la migrazione crea le tre tabelle e la colonna; seconda
  esecuzione senza errori; un'app esistente ha `source_installation_id` null; i vincoli unici rifiutano
  identità duplicate.
- [ ] **Step 2:** FAIL. **Step 3:** schema Drizzle, migrazione, `schema-casello.sql`. **Step 4:** PASS e
  typecheck.
- [ ] **Step 5: Commit** `feat(db): utenti, identità e installazioni GitHub`

### Task 2: Utenti e sessione

**Files:**
- Create: `artifacts/api-server/src/lib/users.ts`, `artifacts/api-server/src/lib/users.test.ts`
- Modify: `artifacts/api-server/src/lib/auth.ts`, `lib/api-spec/openapi.yaml` (`CurrentUser`) + codegen

**Interfaces:**
- Consumes: Task 1 tabelle.
- Produces (in `users.ts`):
  - `isAllowed(emails: string[]): boolean` — vero se una email (minuscola) è in `ALLOWED_EMAILS`.
  - `resolveLogin(identity: { provider: "google" | "github"; providerUserId: string; emails: string[]; primaryEmail: string; username: string | null; name: string | null; picture: string | null }): Promise<User>` —
    identità esistente → suo utente; altrimenti utente con una delle `emails` (primaria prima) a cui
    collega l'identità; altrimenti crea l'utente con `primaryEmail`. Aggiorna `lastLoginAt`. In una
    transazione.
  - `class IdentityConflictError extends Error` e `linkIdentity(userId: number, identity: …stessa forma…): Promise<void>` — identità già di un altro utente → `IdentityConflictError`; stesso utente → aggiorna
    `username`/`email`.
  - `unlinkIdentity(userId: number, provider: "github"): Promise<void>` — rifiuta (`IdentityConflictError`
    con "non puoi scollegare l'unico accesso del tuo account") se è l'unica identità; elimina anche le
    `github_installations` dell'utente.
  - `ensureUserByEmail(email: string, name?: string | null, picture?: string | null): Promise<User>` — per
    le sessioni vecchie e l'utente di sviluppo.
  - `listIdentities(userId: number): Promise<{ provider: string; username: string | null; email: string | null }[]>`.
- Produces (in `auth.ts`): `SessionData` con `userId?: number`, `user?: SessionUser`,
  `github?: { state: string; codeVerifier: string; mode: "login" | "link"; returnTo: string }`;
  `requireAuth` diventa async: con `AUTH_DISABLED` usa `ensureUserByEmail("dev@localhost")`; con una
  sessione vecchia (solo `user.email`) chiama `ensureUserByEmail` e salva `userId`; imposta
  `req.userId` (dichiarazione su `express-serve-static-core` `Request`); helper
  `currentUserId(req: Request): number` (lancia se assente). Il callback Google usa `resolveLogin` e
  `isAllowed`. `GET /auth/me` → `CurrentUser` = `{ email, name, picture, identities: { provider, username, email }[], githubEnabled: boolean }`
  (`githubEnabled` da Task 3: in questo task `false` fisso con commento).

- [ ] **Step 1: Test** `users.test.ts` (DB del global setup): `resolveLogin` crea l'utente la prima volta e
  lo ritrova la seconda; identità GitHub nuova con email uguale a un utente Google → stesso utente con
  due identità; `linkIdentity` di un'identità di un altro utente → `IdentityConflictError` e nessuna
  modifica; `unlinkIdentity` dell'unica identità → errore; `isAllowed` con maiuscole e lista vuota. In
  `routes.test.ts` (o nuovo `auth.test.ts` con app Express minima su `sessionMiddleware` + `requireAuth`):
  una sessione scritta a mano nella tabella `sessions` con solo `user.email` → la richiesta passa e la
  sessione ottiene `userId` (Review Focus 1).
- [ ] **Step 2:** FAIL. **Step 3:** implementare; codegen dopo `openapi.yaml`. **Step 4:** PASS, typecheck
  (la console usa `CurrentUser`: adeguare solo i tipi se servono).
- [ ] **Step 5: Commit** `feat(api-server): utenti e identità nella sessione`

### Task 3: Client della GitHub App e finto GitHub

**Files:**
- Create: `artifacts/api-server/src/lib/github/config.ts`, `artifacts/api-server/src/lib/github/app.ts`,
  `artifacts/api-server/src/lib/github/app.test.ts`, `artifacts/api-server/test/fake-github.ts`
- Modify: `artifacts/api-server/src/lib/auth.ts` (`githubEnabled` vero quando configurato)

**Interfaces:**
- Produces (`config.ts`): `interface GithubConfig { appId: string; slug: string; clientId: string; clientSecret: string; privateKey: string; apiBase: string; webBase: string }`;
  `loadGithubConfig(env = process.env): GithubConfig | null` (null se manca una variabile; `\n` letterali
  → a capo; `GITHUB_API_BASE`/`GITHUB_WEB_BASE` solo se `NODE_ENV !== "production"`, default
  `https://api.github.com` e `https://github.com`); `githubConfig(): GithubConfig | null` (letta una volta).
- Produces (`app.ts`):
  - `class GithubError extends Error { status: number | null }` con i messaggi fissi della spec.
  - `appJwt(cfg: GithubConfig, now?: () => number): string` — RS256, `iat` = ora − 60 s, `exp` = ora +
    540 s, `iss` = `appId`.
  - `installationToken(cfg, installationId: number, scope?: { repo: string }): Promise<string>` —
    `POST /app/installations/{id}/access_tokens`; con `scope` il corpo ha
    `{ repositories: [nomeSenzaOwner], permissions: { contents: "read" } }`; cache in memoria per
    (installazione, repo) fino a 5 minuti prima di `expires_at`; 401/404 → `GithubError` "l'App Casello
    non ha più accesso a questo repository: reinstallala o scegli un altro repo".
  - `exchangeCode(cfg, code: string, codeVerifier: string | null): Promise<string>` — `POST {webBase}/login/oauth/access_token` (JSON), restituisce il token utente.
  - `getGithubUser(cfg, userToken)`: `{ id: string; login: string; name: string | null; avatarUrl: string | null }`;
    `getVerifiedEmails(cfg, userToken)`: `{ primary: string | null; all: string[] }` (solo `verified`, minuscole);
    `listUserInstallations(cfg, userToken)`: `{ installationId: number; accountLogin: string; accountType: string; repositorySelection: string }[]`
    (solo quelle con `app_id` = `appId`);
    `listInstallationRepos(cfg, installationId: number)`: `{ fullName: string; defaultBranch: string; private: boolean }[]`
    (paginazione `per_page=100`, al massimo 1000);
    `repoInstallationId(cfg, repo: string): Promise<number | null>` — `GET /repos/{owner}/{repo}/installation` con JWT; 404 → null.
  - Tutte le chiamate: timeout 15 s, header `Accept: application/vnd.github+json`,
    `X-GitHub-Api-Version: 2022-11-28`, errori di rete → `GithubError` "GitHub non risponde (riprova più
    tardi)", mai URL o token nel messaggio.
- Produces (`test/fake-github.ts`): `startFakeGithub(): Promise<FakeGithub>` con chiave RSA generata
  (`publicKey` per verificare il JWT, `privateKeyPem` da passare alla config), stato modificabile
  (`users`, `emails`, `installations`, `repos`, codici OAuth validi → utente, installazioni revocate),
  registro delle richieste (`requests: { method, path, body, auth }[]`), `apiBase`, `webBase`, `close()`.
  Verifica la firma RS256 del JWT su `/app/...` (401 se non valida).

- [ ] **Step 1: Test** `app.test.ts` contro il finto GitHub: `loadGithubConfig` null se manca una
  variabile e con `\n` letterali produce una PEM valida; `appJwt` verificabile con la chiave pubblica e
  con `exp - iat = 600`; `installationToken` con `scope` invia esattamente `repositories: ["mister"]` e
  `permissions: { contents: "read" }` e la seconda chiamata usa la cache (una sola richiesta);
  installazione revocata → `GithubError` con il messaggio della spec; `getVerifiedEmails` scarta le email
  non verificate; `listUserInstallations` filtra un `app_id` diverso; `listInstallationRepos` pagina oltre
  100; server irraggiungibile → "GitHub non risponde (riprova più tardi)" senza URL; nessun messaggio
  contiene il token né la chiave. GitHub non configurato → `githubEnabled: false` in `/auth/me`
  (Review Focus 5).
- [ ] **Step 2:** FAIL. **Step 3:** implementare. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): client della GitHub App`

### Task 4: Login, collegamento e callback GitHub

**Files:**
- Create: `artifacts/api-server/src/lib/github/oauth-routes.ts`,
  `artifacts/api-server/src/lib/github/oauth-routes.test.ts`, `artifacts/api-server/src/lib/github/installations.ts`
- Modify: `artifacts/api-server/src/lib/auth.ts` (monta il router GitHub se configurato),
  `lib/api-spec/openapi.yaml` (`DELETE /auth/github` → 204, `unlinkGithub`) + codegen

**Interfaces:**
- Consumes: Task 2 (`resolveLogin`, `linkIdentity`, `unlinkIdentity`, `isAllowed`, sessione), Task 3.
- Produces:
  - `syncInstallations(cfg: GithubConfig, userId: number, userToken: string): Promise<void>` in
    `installations.ts` — sostituisce le righe dell'utente con quelle di `listUserInstallations`
    (inserisce, aggiorna, elimina quelle non più visibili) in una transazione.
  - Route: `GET /auth/github/login?returnTo=` (pubblica), `GET /auth/github/link?returnTo=` (richiede
    sessione), `GET /auth/github/callback`, `DELETE /auth/github` (richiede sessione). Autorize URL:
    `{webBase}/login/oauth/authorize?client_id&redirect_uri={PUBLIC_APP_URL}/api/auth/github/callback&state&code_challenge&code_challenge_method=S256`.
  - Callback: se `req.session.github` manca o `state` non coincide → non scambia il codice; se la sessione
    Casello c'è redirect a `/api/auth/github/link?returnTo=/account`, altrimenti a `/?auth=error`
    (Review Focus 2). Con `state` valido: `exchangeCode` → utente ed email → modalità `login`:
    `isAllowed` falso → `/?auth=denied`; altrimenti `resolveLogin`, `session.regenerate`, `userId` e
    `user` in sessione; modalità `link`: `linkIdentity` sull'utente corrente (`IdentityConflictError` →
    `/account?github=conflict`). In entrambe `syncInstallations`, poi redirect a `returnTo`. Il token
    utente non esce dalla funzione.
  - Redirect di ritorno: solo percorsi interni (`safeReturnTo` già in `auth.ts`, da esportare).

- [ ] **Step 1: Test** `oauth-routes.test.ts` (app Express con `sessionMiddleware` + router, client con
  cookie, finto GitHub; config passata alla factory `githubAuthRouter(cfg)`): login con email ammessa →
  sessione con `userId`, identità GitHub salvata, installazioni sincronizzate; email non verificata o
  non ammessa → redirect `/?auth=denied` e nessun utente creato; utente Google esistente con stessa email
  → stessa riga `users`; `link` da loggato con identità di un altro utente → `/account?github=conflict` e
  nessuna modifica; callback con `code` ma `state` assente o diverso → nessuna richiesta a
  `/login/oauth/access_token` nel registro del finto GitHub; `DELETE /auth/github` sull'unica identità →
  409 con messaggio italiano; `DELETE` con anche Google → 204 e installazioni dell'utente eliminate;
  installazione non più visibile al secondo login → rimossa.
- [ ] **Step 2:** FAIL. **Step 3:** implementare; codegen. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): login e collegamento con GitHub`

### Task 5: Installazioni e repository

**Files:**
- Create: `artifacts/api-server/src/routes/github.ts`, `artifacts/api-server/src/routes/github.test.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`, `lib/api-spec/openapi.yaml` + codegen

**Interfaces:**
- Consumes: Task 3, Task 4 (`syncInstallations`), `currentUserId`.
- Produces: `GET /github/installations` (`listGithubInstallations`) →
  `{ installationId, accountLogin, accountType, repositorySelection, manageUrl }[]` dove
  `manageUrl` = `{webBase}/settings/installations/{id}` per `User` e
  `{webBase}/organizations/{login}/settings/installations/{id}` per `Organization`, più
  `installUrl` = `{webBase}/apps/{slug}/installations/new` in un oggetto `{ installUrl, installations }`;
  `GET /github/repos` (`listGithubRepos`) → `{ installationId, fullName, defaultBranch, private }[]`
  ordinati per `fullName`; un'installazione che risponde 401/404 viene eliminata per l'utente e
  saltata (Review Focus 4); tutte le altre errori → 502 "GitHub non risponde (riprova più tardi)".
  GitHub non configurato → 404 "GitHub non configurato".

- [ ] **Step 1: Test** `github.test.ts` (`AUTH_DISABLED=true`, utente di sviluppo, righe di installazione
  inserite a mano, finto GitHub): elenco installazioni con `manageUrl` corretti per utente e
  organizzazione; repos di due installazioni uniti e ordinati; un'installazione revocata sparisce dalla
  tabella e gli altri repo arrivano; GitHub non configurato → 404 con messaggio; nessuna risposta contiene
  token.
- [ ] **Step 2:** FAIL. **Step 3:** implementare; codegen. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): installazioni e repository GitHub`

### Task 6: Sorgenti con installazione e analisi

**Files:**
- Modify: `artifacts/api-server/src/routes/apps.ts`, `artifacts/api-server/src/routes/serializers.ts`,
  `artifacts/api-server/src/routes/analyses.ts`, `artifacts/api-server/src/lib/architect/run-analysis.ts`,
  `lib/api-spec/openapi.yaml` (`sourceInstallationId` in App, AppInput, AppUpdate) + codegen
- Test: `artifacts/api-server/src/routes/analyses.test.ts`, `artifacts/api-server/src/lib/architect/run-analysis.test.ts`

**Interfaces:**
- Consumes: Task 3 (`repoInstallationId`, `installationToken`, `GithubError`), Task 5 tabella installazioni,
  `currentUserId`.
- Produces:
  - Salvataggio app: `sourceInstallationId` (numero o null). Se non null: `sourceType` deve essere
    `github`, l'utente deve avere quella installazione in `github_installations`, e
    `repoInstallationId(sourceRepo)` deve restituire lo stesso id; altrimenti 400 "installazione non
    trovata o non tua". GitHub non configurato e `sourceInstallationId` non null → 400 "GitHub non
    configurato".
  - Avvio analisi (`POST /apps/:id/analyses`): con `sourceInstallationId` non serve il token manuale;
    l'utente corrente deve avere l'installazione, altrimenti 403 "installazione non trovata o non tua".
  - `loadSources` in `run-analysis.ts`: con `app.sourceInstallationId` →
    `installationToken(cfg, id, { repo: app.sourceRepo })` e poi `fetchGithubTree` con quel token;
    `GithubError` → `AnalysisError` con lo stesso messaggio; il log dice
    `codice: GitHub owner/nome tramite l'App (N file)`; GitHub non configurato → `AnalysisError`
    "GitHub non configurato". Senza installazione: comportamento della fase 3 invariato.

- [ ] **Step 1: Test** in `analyses.test.ts`: salvataggio con installazione dell'utente e repo giusto →
  200 e `sourceInstallationId` nella risposta; installazione non dell'utente → 400; repo di un'altra
  installazione → 400; avvio senza token manuale con installazione → 202; con installazione di un altro
  utente (riga inserita per un altro `user_id`) → 403. In `run-analysis.test.ts`: analisi con installazione
  → il finto GitHub riceve il token di installazione sul download e la richiesta di token ha
  `repositories: [nome]`; il log e `error` non contengono il token; installazione revocata → `failed` con
  il messaggio della spec (Review Focus 4); GitHub non configurato e app senza installazione → analisi
  con token manuale come prima (Review Focus 5).
- [ ] **Step 2:** FAIL. **Step 3:** implementare; codegen. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api-server): sorgenti GitHub tramite l'App per l'architetto`

### Task 7: Console

**Files:**
- Create: `artifacts/casello/src/pages/account.tsx`
- Modify: `artifacts/casello/src/pages/login.tsx`, `artifacts/casello/src/lib/auth.ts`,
  `artifacts/casello/src/components/layout/user-menu.tsx`, `artifacts/casello/src/App.tsx` (route
  `/account`), `artifacts/casello/src/components/apps/app-sources-card.tsx`

**Comportamento:**
- Login: "Accedi con Google" e, se `githubEnabled` (da una chiamata pubblica: aggiungere
  `GET /auth/providers` → `{ google: true, github: boolean }` in openapi, pubblica come `/auth/me`),
  "Accedi con GitHub" → `/api/auth/github/login?returnTo=`; messaggi per `?auth=denied`
  ("email GitHub non autorizzata" quando arriva da GitHub, testo attuale per Google) e `?auth=error`.
- Menu utente: voce "Account" → `/account`.
- Pagina Account: identità collegate (Google con email, GitHub con username); "Collega GitHub" →
  `/api/auth/github/link?returnTo=/account`; "Scollega GitHub" con conferma (`unlinkGithub`; 409 → toast);
  messaggio per `?github=conflict` ("account GitHub già collegato a un altro utente"); elenco installazioni
  (`listGithubInstallations`) con "Gestisci su GitHub" (`manageUrl`) e "Installa Casello su GitHub"
  (`installUrl`). Se GitHub non è configurato la sezione GitHub mostra "GitHub non configurato".
- Scheda Sorgenti con tipo GitHub: se l'utente ha GitHub collegato, combo "Repository" con
  `listGithubRepos` (valore = installazione + repo; branch predefinito come placeholder del branch) che
  salva `sourceInstallationId` + `sourceRepo` e azzera il token manuale non necessario (non lo invia);
  link "usa un token manuale" che mostra i campi della fase 3 e salva `sourceInstallationId: null`;
  senza GitHub collegato: invito "Collega GitHub" (link alla pagina Account) e campi manuali.
- [ ] **Step 1:** implementare (con codegen per `/auth/providers`, test API di una riga per la route);
  typecheck e build della console verdi.
- [ ] **Step 2: Commit** `feat(casello): accesso con GitHub, account e repository nelle sorgenti`

### Task 8: Rilascio e collaudo (controller con Ivan)

**Files:** Modify `CLAUDE.md` (Autenticazione: utenti, identità, GitHub; variabili; migrazione).

- [ ] **Step 1:** verifica nel browser con il finto GitHub (`GITHUB_API_BASE`/`GITHUB_WEB_BASE`): login
  GitHub, collegamento da Google, conflitto, installazione, combo dei repo, analisi con installazione.
- [ ] **Step 2:** `CLAUDE.md`; PR con migrazione `docs/migrations/2026-10-github.sql` da applicare sul
  branch `production` di Neon **prima del merge**, nuove variabili e configurazione dell'App GitHub:
  permessi Contents read, Metadata read, Email addresses read; "Request user authorization (OAuth)
  during installation" attivo; Callback URL `https://casello.fantamister.cloud/api/auth/github/callback`;
  nessun webhook; chiave privata generata e incollata in `GITHUB_APP_PRIVATE_KEY` su Coolify.
- [ ] **Step 3:** collaudo con Ivan: creazione dell'App, installazione su `TwentIvan/Mister`, login con
  GitHub, scelta del repo nelle sorgenti di Mister, analisi.
- [ ] **Step 4: Commit** `docs: CLAUDE.md aggiornato per l'accesso con GitHub`
