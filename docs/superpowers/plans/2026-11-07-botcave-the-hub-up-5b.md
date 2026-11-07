# The Hub Up in Botcave (5b): piano di implementazione

> **Per chi esegue con agenti:** sotto-skill RICHIESTA: superpowers:subagent-driven-development (consigliata) oppure
> superpowers:executing-plans, un task alla volta. I passi usano le caselle (`- [ ]`).

**Obiettivo.** Botcave entra in The Hub Up con un token API di servizio, l'App in Botcave è configurata e verificata, e una nuova
analisi di Lucius è completata e rivista.

**Architettura.**
- In AbapCrm un modulo puro (`server/api-tokens.ts`) genera e verifica i token e decide le route vietate. Un middleware, montato in
  `setupAuth` subito dopo `passport.session()`, sostituisce `req.user` e l'organizzazione quando arriva `Authorization: Bearer thu_…`.
- In Botcave non si scrive codice: si configura l'App dalla console (previa conferma di Ivan) e si esegue l'analisi locale.

**Stack.**
- AbapCrm: Express 4, passport 0.7, Drizzle e Neon, React con TanStack Query. Si aggiungono Vitest e supertest.
- Botcave: console in produzione e skill `casello-architetto-locale`.

**Spec:** `docs/superpowers/specs/2026-11-07-botcave-the-hub-up-5b-design.md` (repository Casello).

**Repository.**
- Task 1-5: `~/Projects/AbapCrm`, branch `feat/api-token` creato da `origin/main`. Il checkout attuale è su `feat/botcave-plugin`,
  già unito a `main`: si usa un worktree, per esempio `git -C ~/Projects/AbapCrm worktree add ../AbapCrm-api-token -b feat/api-token
  origin/main`.
- Task 6-7: Casello, branch `feat/botcave-the-hub-up-5b`.

## Vincoli globali

- Lingua:
  - italiano per commenti, messaggi d'errore e commit;
  - identificatori in inglese;
  - messaggi di commit tipo `feat(api-token): …` in AbapCrm e `docs(casello): …` in Casello, con la riga
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Il token ha formato `thu_` + 32 byte casuali in base64url (43 caratteri). Del token si salva solo l'hash SHA-256 esadecimale,
  insieme a `prefix` = i primi 8 caratteri dopo `thu_`. Il token in chiaro si mostra una volta sola.
- Scadenza predefinita 365 giorni. Nome 1..100 caratteri.
- Con l'header `Authorization: Bearer thu_…` conta solo il token, mai il cookie di sessione.
- Messaggi d'errore fissi:
  - 401 `{"message":"token non valido o scaduto"}`;
  - 403 `{"message":"operazione non disponibile con un token API"}`;
  - 429 `{"message":"Troppe richieste: riprova tra poco"}`.
- Limite di 120 richieste al minuto per token, in memoria. `last_used_at` si aggiorna al massimo una volta al minuto.
- Nei log mai token né hash: al massimo l'id del token.
- Schema: tabella in `shared/schema.ts` più `CREATE TABLE IF NOT EXISTS` in `runStartupMigrations` (`server/db.ts`, con `safeMigrate`),
  come per le altre tabelle di AbapCrm. L'SQL va mostrato a Ivan in chat prima del merge.
- Nessuna azione su servizi esterni (push, PR, merge, deploy, scritture nella console di Botcave in produzione) senza un sì esplicito
  di Ivan, chiesto al momento.

## Punti da controllare in revisione

1. **Cookie di sessione e token insieme:** vince il token. `req.user` è l'utente del token e l'organizzazione è quella del token, anche
   se il cookie appartiene a un altro utente. Test in Task 3.
2. **Header `x-organization-id` o `x-organization-scope: all` mandati insieme al token:** vengono ignorati. L'organizzazione resta quella
   del token, lo scope diventa `personal`. Test in Task 3.
3. **Utente tolto dall'organizzazione del token, o utente eliminato:** 401, non il ripiego sull'organizzazione «Personal». Test in Task 3.
4. **Prefissi delle route simili:** `/api/ai` è vietata, `/api/ai-learning-patterns` no; `/api/sap-systems/7/credentials` è vietata,
   `/api/sap-systems/7` no. Test in Task 1.
5. **Bearer non `thu_`** (token companion su `/api/hubup/jobs/*`): il middleware non lo tocca. Test in Task 3.

---

### Task 1: Modulo dei token (puro) e Vitest

**File:**
- Create: `server/api-tokens.ts`, `server/api-tokens.test.ts`, `vitest.config.ts`
- Modify: `package.json` (devDependencies `vitest`, `supertest`, `@types/supertest`; script `"test": "vitest run"`)

**Interfacce prodotte** (`server/api-tokens.ts`):
- `TOKEN_PREFIX = "thu_"`, `TOKEN_TTL_DAYS = 365`, `TOKEN_RATE_PER_MIN = 120`
- `TOKEN_MESSAGES = { invalid: "token non valido o scaduto", denied: "operazione non disponibile con un token API", rate: "Troppe richieste: riprova tra poco" }`
- `generateApiToken(): { token: string; hash: string; prefix: string }`
- `hashApiToken(token: string): string`, cioè SHA-256 esadecimale
- `readBearerApiToken(authorization: string | undefined): string | null`: restituisce il token solo se l'header è `Bearer thu_<43 caratteri base64url>`, altrimenti null
- `isDeniedForToken(method: string, path: string): boolean`
- `createRateCounter(limit: number, windowMs: number): { consume(key: string, now?: number): boolean }`

**Route vietate con un token**, qualunque metodo salvo dove indicato. Il confronto è sul percorso esatto oppure sul prefisso seguito
da `/`:
- token, accesso e utenti: `/api/account/api-tokens`, `/api/login`, `/api/logout`, `/api/register`, `/api/auth`,
  `/api/password-reset`, `/api/verify-email`, `/api/users`, `/api/user-organizations`, `/api/invitations`, `/api/organization-domains`;
- `/api/organizations`, solo con POST, PUT, PATCH e DELETE;
- credenziali: `/api/sap-system-credentials`, `/api/system-credentials`, più il modello `^/api/sap-systems/[^/]+/credentials(/|$)`;
- VPN e connessioni: `/api/vpn`, `/api/vpn-connections`, `/api/vpn-credentials`, `/api/vpn-software`, `/api/vpn-systems`,
  `/api/discovered-vpn-software`, `/api/discovered-vpn-configurations`, `/api/connection`, `/api/connection-workflows`;
- posta: `/api/email`, `/api/email-accounts`;
- AI e MCP: `/api/ai`, `/api/ai-task-executor`, `/api/executions`, `/api/mcp/configs`, `/api/mcp/custom`;
- companion: `/api/hubup/companion`.

- [ ] **Passo 1: test che falliscono** in `server/api-tokens.test.ts`:
  - `generateApiToken`:
    - `token` corrisponde a `/^thu_[A-Za-z0-9_-]{43}$/`;
    - `hash === hashApiToken(token)` e misura 64 caratteri esadecimali;
    - `prefix === token.slice(4, 12)`;
    - due chiamate danno token diversi.
  - `readBearerApiToken`:
    - restituisce il token per `"Bearer " + token`;
    - restituisce null per `undefined`, `"Bearer abc"`, `"Basic " + token`, `"Bearer thu_short"` e `"bearer " + token`.
  - `isDeniedForToken` restituisce true per:
    - `("GET","/api/ai/models")`, `("GET","/api/ai")`, `("POST","/api/organizations")`;
    - `("GET","/api/sap-systems/abc/credentials/active")`, `("GET","/api/vpn-credentials/5")`;
    - `("DELETE","/api/account/api-tokens/3")`, `("POST","/api/logout")`.
  - `isDeniedForToken` restituisce false per:
    - `("GET","/api/ai-learning-patterns")`, `("GET","/api/organizations")`, `("GET","/api/sap-systems/abc")`;
    - `("GET","/api/projects")`, `("POST","/api/comments")`, `("GET","/api/email-training-selections")`, `("GET","/api/user")`.
  - `createRateCounter(2, 60000)`:
    - `consume("a", 0)` restituisce true due volte, poi false;
    - `consume("b", 0)` restituisce true;
    - `consume("a", 60001)` torna true.
- [ ] **Passo 2:** `npm test`. Esito atteso: FAIL, il modulo non esiste.
- [ ] **Passo 3:** implementare le funzioni. Usare `crypto.randomBytes(32).toString("base64url")` e
  `createHash("sha256")`. Il contatore lavora a finestra fissa per chiave.
- [ ] **Passo 4:** `npm test` e `npm run check`. Esito atteso: PASS.
- [ ] **Passo 5:** commit `feat(api-token): modulo dei token API e test con Vitest`.

### Task 2: Tabella `api_tokens` e storage

**File:**
- Modify: `shared/schema.ts` (dopo `hubupEnrollTokens`, ~1297), `server/db.ts` (`runStartupMigrations`, con `safeMigrate`),
  `server/storage.ts` (interfaccia e implementazione)

**Interfacce prodotte:**
- tabella `apiTokens` (`api_tokens`):
  - `id` serial pk;
  - `user_id` uuid, FK `users.id` on delete cascade, not null;
  - `organization_id` uuid, FK `organizations.id` on delete cascade, not null;
  - `name` text not null;
  - `token_hash` text not null unique;
  - `prefix` text not null;
  - `created_at` timestamp default now();
  - `expires_at` timestamp not null;
  - `revoked_at` timestamp null;
  - `last_used_at` timestamp null;
  - indice su `user_id`.
- `ApiTokenRow` = `typeof apiTokens.$inferSelect`
- in `IStorage` e `DatabaseStorage`:
  - `createApiToken(input: { userId: string; organizationId: string; name: string; tokenHash: string; prefix: string; expiresAt: Date }): Promise<ApiTokenRow>`
  - `listApiTokens(userId: string): Promise<ApiTokenRow[]>`: non revocati, dal più recente
  - `revokeApiToken(userId: string, id: number): Promise<boolean>`: true solo se il token era dell'utente e non ancora revocato
  - `findActiveApiTokenByHash(hash: string, now: Date): Promise<ApiTokenRow | undefined>`: non revocato e non scaduto
  - `touchApiTokenLastUsed(id: number, now: Date): Promise<void>`

- [ ] **Passo 1:** aggiungere tabella, SQL idempotente in `runStartupMigrations` e metodi dello storage.
- [ ] **Passo 2:** `npm run check`. Esito atteso: nessun errore.
- [ ] **Passo 3:** prova su un DB di sviluppo, se Ivan ne indica uno. Avviare `npm run dev` e controllare nel log
  `[DB] ✓ api_tokens`. Senza DB di sviluppo, scrivere nel resoconto che la prova è saltata.
- [ ] **Passo 4:** commit `feat(api-token): tabella api_tokens e funzioni dello storage`.

### Task 3: Middleware di autenticazione con il token

**File:**
- Create: `server/api-token-auth.ts`, `server/api-token-auth.test.ts`
- Modify: `server/auth.ts` (in `setupAuth`, subito dopo `app.use(passport.session())`)

**Interfacce.**
- Usa da Task 1 `readBearerApiToken`, `hashApiToken`, `isDeniedForToken`, `createRateCounter` e `TOKEN_MESSAGES`; da Task 2 i
  metodi dello storage.
- Produce:
  - `createApiTokenAuth(deps: { findActive(hash: string, now: Date): Promise<ApiTokenRow | undefined>; touch(id: number, now: Date): Promise<void>; getUser(id: string): Promise<User | undefined>; getUserOrganizationIds(userId: string): Promise<string[]>; now?: () => Date }): RequestHandler`;
  - `req.apiToken = { id: number; organizationId: string }` sulle richieste autenticate col token;
  - `req.apiToken` è undefined per le richieste con sessione.

**Comportamento:**
- Senza `Authorization: Bearer thu_…` il middleware chiama `next()` e non tocca nulla.
- Con il token:
  1. Token sconosciuto, revocato o scaduto, utente mancante o utente non più membro dell'organizzazione del token → 401.
  2. Altrimenti:
     - `req.user = user`, sovrascrivendo l'eventuale utente della sessione;
     - `req.headers["x-organization-id"] = organizationId`;
     - `req.headers["x-organization-scope"] = "personal"`;
     - `req.apiToken = { id, organizationId }`.
  3. `isDeniedForToken(req.method, req.path)` → 403.
  4. Oltre il limite di 120 al minuto per id del token → 429.
  5. `touch` al più una volta al minuto per token (mappa in memoria); un errore di `touch` si ignora.
  6. Un errore del DB nella verifica → 500 `{"message":"errore interno"}`, con nel log solo il nome dell'errore.
- `req.isAuthenticated()` di passport 0.7 è vero perché `req.user` è valorizzato.

- [ ] **Passo 1: test che falliscono** con supertest su una piccola app Express. Il gestore di prova restituisce
  `{ user: req.user?.id, org: req.headers["x-organization-id"], scope: req.headers["x-organization-scope"], auth: req.isAuthenticated?.() ?? !!req.user }`,
  con dipendenze finte:
  - token valido su `GET /api/projects` → 200, `user` dell'utente del token, `org` del token, `scope` `"personal"`;
  - token valido con header `x-organization-id: altra` e `x-organization-scope: all` → `org` del token e `scope` `"personal"`;
  - richiesta con un utente di sessione simulato (middleware precedente che imposta `req.user = {id:"sess"}`) più il token →
    `user` del token;
  - token sconosciuto → 401 con `TOKEN_MESSAGES.invalid`;
  - utente non più membro dell'organizzazione → 401;
  - utente inesistente → 401;
  - `GET /api/ai/models` con il token valido → 403 con `TOKEN_MESSAGES.denied`;
  - 121ª richiesta nello stesso minuto → 429;
  - `Authorization: Bearer abc` (companion) → passa intatto (`user` undefined, 200);
  - due richieste a distanza di meno di 60 s chiamano `touch` una volta sola;
  - `findActive` che lancia un'eccezione → 500.
- [ ] **Passo 2:** `npm test`. Esito atteso: FAIL.
- [ ] **Passo 3:** implementare `createApiTokenAuth` e montarlo in `setupAuth` con le funzioni di `storage`
  (`getUserOrganizationIds` = `(await storage.getUserOrganizations(id)).map(o => o.id)`).
- [ ] **Passo 4:** `npm test` e `npm run check`. Esito atteso: PASS.
- [ ] **Passo 5:** commit `feat(api-token): autenticazione con Bearer thu_ su /api`.

### Task 4: Route di gestione e scheda «Token API» nell'account

**File:**
- Create: `server/api-token-routes.ts`, `server/api-token-routes.test.ts`, `client/src/components/account/api-tokens-card.tsx`
- Modify: `server/routes.ts` (registrazione in `registerRoutes`, dopo `setupAuth`), `client/src/pages/account-page.tsx`
  (nuova `TabsTrigger value="api-tokens"` «Token API», ~riga 325)

**Interfacce.**
- Produce `registerApiTokenRoutes(app: Express, deps)` con:
  - `GET /api/account/api-tokens` → `[{ id, name, prefix, organizationId, createdAt, expiresAt, lastUsedAt }]`;
  - `POST /api/account/api-tokens` `{ name }` → 201 `{ id, name, prefix, organizationId, expiresAt, token }`:
    - organizzazione = `x-organization-id` della richiesta, già risolto dal middleware dell'organizzazione;
    - nome vuoto o oltre 100 caratteri → 400 `{"message":"nome obbligatorio, al massimo 100 caratteri"}`;
  - `DELETE /api/account/api-tokens/:id` → 204, oppure 404 `{"message":"token non trovato"}`.
- Senza sessione → 401. Con un token le blocca già il Task 3 (403).

- [ ] **Passo 1: test che falliscono** con supertest e storage finto:
  - POST con utente di sessione → 201;
  - il token restituito corrisponde a `/^thu_/`;
  - lo storage riceve l'hash e non il token, con `expiresAt` a 365 giorni ±1 minuto;
  - POST con `name: ""` → 400;
  - GET non contiene mai `token` né `tokenHash`;
  - DELETE di un id di un altro utente → 404;
  - senza utente → 401.
- [ ] **Passo 2:** `npm test`. Esito atteso: FAIL.
- [ ] **Passo 3:** implementare le route e la carta della console:
  - elenco con nome, prefisso `thu_<prefix>…`, organizzazione, creato il, scade il, ultimo uso, pulsante «Revoca» con conferma;
  - modulo «Nuovo token» con il nome;
  - dopo la creazione, riquadro con il token, «Copia» e il testo «Copialo ora: non lo vedrai più»;
  - `apiRequest` e `useQuery` come nel resto della pagina.
- [ ] **Passo 4:** `npm test`, `npm run check` e `npm run build`. Esito atteso: PASS.
- [ ] **Passo 5:** prova manuale con `npm run dev`, se c'è un DB di sviluppo:
  - creare un token dalla pagina;
  - `curl -H "Authorization: Bearer thu_…" localhost:5000/api/projects` → 200;
  - `…/api/ai/models` → 403;
  - revocare il token, poi di nuovo `/api/projects` → 401.
- [ ] **Passo 6:** commit `feat(api-token): gestione dei token API nell'account`.

### Task 5: PR, merge e deploy di AbapCrm (con conferma di Ivan)

- [ ] **Passo 1:** mostrare a Ivan in chat l'SQL completo della tabella. Si applica da solo all'avvio con `runStartupMigrations`,
  ma va comunque visto prima.
- [ ] **Passo 2:** con il suo sì, push di `feat/api-token` e PR verso `main`. La PR riporta: cosa cambia, test, SQL, route vietate,
  nessuna variabile nuova. Senza `gh`, dare il link «compare» di GitHub con titolo e corpo già compilati.
- [ ] **Passo 3:** merge solo su sì esplicito di Ivan (il merge deploya da solo con GitHub Actions e Coolify).
- [ ] **Passo 4:** verifica in produzione:
  - Ivan crea un token su https://hubup.fantamister.cloud (Account → «Token API»), nell'organizzazione di lavoro;
  - `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $THU_TOKEN" https://hubup.fantamister.cloud/api/projects`
    → `200`;
  - lo stesso su `/api/ai/models` → `403`.

### Task 6: Configurazione dell'App «The Hub Up» in Botcave (con conferma di Ivan)

Si fa dalla console di Botcave in produzione (App id 3). Ogni scrittura si mostra prima a Ivan.

- [ ] **Passo 1:** scrivere la descrizione funzionale in `docs/the-hub-up/descrizione-funzionale.md` (repository Casello):
  - dominio ed entità;
  - autenticazione `thu_…`;
  - l'inventario della §3 della spec in forma compatta;
  - la richiesta a Lucius della §4.3: un agente per ciascuna funzione 1-6 e i tool mancanti della §5.2.
  
  Ivan la approva in chat.
- [ ] **Passo 2:** con il sì di Ivan, nella scheda dell'App:
  - autenticazione di servizio `Authorization` + `Bearer`;
  - segreto di servizio = il token `thu_…` del Task 5, inserito da Ivan stesso perché è una credenziale;
  - descrizione funzionale incollata.
- [ ] **Passo 3:** con il sì di Ivan, i 38 tool passano all'identità `service`, dalla console oppure con
  `PATCH /api/apps/3/tools/:toolId` `{identity:"service"}` dal browser con la sessione di Ivan.
  Verifica: `GET /api/apps/3/tools` → tutti `identity: "service"`.
- [ ] **Passo 4:** prova.
  - L'agente generale (id 4) ha un modello: va attivato con il sì di Ivan, perché la run costa.
  - Run «Elenca i progetti attivi» → `succeeded`, con un passo `list_projects` riuscito.
  - Run «Aggiungi al progetto <id scelto da Ivan> il commento "Prova Botcave 5b"» → voce `action` in «Da confermare».
    Ivan approva → commento visibile in The Hub Up una volta sola.
- [ ] **Passo 5:** commit `docs(casello): descrizione funzionale di The Hub Up per Botcave`.

### Task 7: Analisi locale, revisione e chiusura della spec

- [ ] **Passo 1:** Ivan avvia dalla scheda dell'App «Analizza» con esecutore locale, sorgenti GitHub e descrizione.
  Verifica: `list_analyses` (MCP `casello`) mostra la nuova analisi in coda.
- [ ] **Passo 2:** eseguire l'analisi con la skill `casello-architetto-locale` fino a `completed`.
- [ ] **Passo 3:** revisione con Ivan, un capitolo per messaggio:
  1. tool;
  2. agenti e skill (quale funzione 1-6 copre ciascuno);
  3. endpoint mancanti;
  4. completamento ed evoluzione.
  
  Approvazioni e rifiuti li decide Ivan, con `PATCH /api/analysis-items/:id` o dalla console. Le issue su AbapCrm si creano solo con
  il suo sì.
- [ ] **Passo 4:** compilare la §6 della spec:
  - tool approvati e modificati;
  - agenti e skill con la funzione coperta;
  - endpoint e issue;
  - voci scartate e perché.
  
  Aggiornare la §5.2 se l'analisi cambia gli agenti o i tool. Aggiungere una riga allo «Stato» di `CLAUDE.md`: «The Hub Up
  collegata con token di servizio e analizzata (5b), vedi spec 2026-11-07».
- [ ] **Passo 5:** commit `docs(casello): esito dell'analisi di The Hub Up e chiusura di 5b`.
- [ ] **Passo 6:** con il sì di Ivan, push e PR di `feat/botcave-the-hub-up-5b` su Casello. Solo documenti: nessuna migrazione né
  variabile.
