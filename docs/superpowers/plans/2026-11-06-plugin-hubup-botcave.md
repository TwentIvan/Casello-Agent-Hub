# Botcave come plugin di The Hub Up — PR 1 (Botcave) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Botcave accetta applicazioni di prima parte (The Hub Up) come client OAuth confidenziali i cui token `cap_…` valgono su `/api`, e la scheda squadra porta il link «Apri in …» verso il servizio.

**Architecture:** I client «plugin» sono dichiarati nella variabile `OAUTH_PLUGIN_CLIENTS` (letta a ogni uso, come `PUBLIC_APP_URL`) e hanno una riga in `oauth_clients` con `kind = 'plugin'`, creata o aggiornata al primo uso, così collegamenti, codici e token riusano le tabelle del connettore. Autorizzazione con PKCE e consenso di sempre; il token endpoint vuole anche `client_secret` (hash SHA-256 nella variabile). `requireAuth` riconosce `cap_…` accanto a `cas_…` con un nuovo `req.auth.kind = "oauth"`; `/mcp` non lo accetta. `apps.plugin_url_template` dà alla squadra il link nel servizio.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React.

**Spec:** `docs/superpowers/specs/2026-11-06-botcave-plugin-hubup-design.md` (§1, §5, §6, §7 «Botcave»). La PR 2 (The Hub Up, repository `TwentIvan/AbapCRM`) ha un piano a parte, dopo il deploy di questa.

## Global Constraints

- Italiano per commenti, documentazione, messaggi d'errore e commit; codice e identificatori in inglese. Nei testi visibili «Botcave», mai «Casello».
- Token d'accesso del plugin: prefisso `cap_`, 32 byte casuali base64url, durata 3 600 s; token di rinnovo `car_…` 30 giorni, a rotazione con le stesse regole del connettore (`REFRESH_REUSE_GRACE_MS` 60 s). Nel DB solo hash SHA-256.
- Ambiti di un collegamento plugin: esattamente `["api:read", "api:write"]` (`PLUGIN_SCOPES`); mai `mcp`. `cap_…` su `/mcp` → 401; `cao_…` e `car_…` su `/api` → 401 «token non valido o scaduto» come oggi.
- Route `sessionOnly` con `cap_…` → 403 «operazione disponibile solo con il login» (`TOKEN_MESSAGES.sessionOnly`).
- Limite: 120 richieste/min per collegamento (`tokenRateLimit`, chiave `oauth:<grantId>`).
- Log: mai token, codici, segreti del client, hash, `code_verifier` né Authorization.
- Errori OAuth con `error_description` fissa in italiano (`OAuthError`); client sconosciuto o segreto errato → 401 `invalid_client` «applicazione non riconosciuta».
- Schema DB: solo migrazione additiva e idempotente `docs/migrations/2026-11-plugin-hubup.sql`, riportata in `docs/schema-casello.sql`; da applicare su Neon PRIMA del merge, SQL completo in chat prima del push.
- `pnpm run typecheck` verde prima di ogni commit; dopo `openapi.yaml` rieseguire il codegen e committare i file generati.
- Console: niente colori esadecimali né classi di palette (solo token), niente scorrimento orizzontale a 1280 px.
- Test dell'API da `artifacts/api-server`: `pnpm exec vitest run <file>` (il filtro dopo `run test --` non funziona).

## Review Focus

- Plugin tolto da `OAUTH_PLUGIN_CLIENTS` dopo aver emesso token: i suoi `cap_…` smettono di valere su `/api` (401) e il rinnovo risponde `invalid_client` — test in Task 3 e Task 4.
- Rinnovo con `client_secret` mancante o sbagliato: 401 `invalid_client` e il token di rinnovo resta valido (nessuna rotazione, nessuna revoca) — test in Task 3.
- Token incrociati: `cap_…` su `/mcp` → 401, `cao_…` su `/api` → 401 — test in Task 4.
- `cap_…` su una route solo-login (`PUT /api/budget`, `POST /api/account/tokens`) → 403 — test in Task 4.
- `ref.id` con `/`, `?` o `#` nel link «Apri in …»: codificato con `encodeURIComponent`, mai un indirizzo diverso — test in Task 5.

---

## File Structure

- Create `artifacts/api-server/src/lib/oauth/plugins.ts` — lettura e validazione di `OAUTH_PLUGIN_CLIENTS`, verifica del segreto, riga in `oauth_clients`.
- Modify `lib/db/src/schema/oauth.ts` (enum `plugin`), `lib/db/src/schema/apps.ts` (`pluginUrlTemplate`), `docs/schema-casello.sql`; create `docs/migrations/2026-11-plugin-hubup.sql`.
- Modify `artifacts/api-server/src/lib/oauth/{config,clients,authorize,pages,tokens,metadata,grants}.ts`, `src/routes/oauth.ts`.
- Modify `artifacts/api-server/src/lib/auth.ts`, `src/middlewares/rate-limit.ts`, `src/index.ts`.
- Modify `lib/api-spec/openapi.yaml` (+ codegen), `src/routes/apps.ts`, `src/lib/teams/instances.ts`.
- Modify `artifacts/casello/src/components/apps/app-form-dialog.tsx`, `artifacts/casello/src/pages/team-detail.tsx`.
- Modify `CLAUDE.md`, la spec (sezione finale «Differenze dal codice»).

---

### Task 1: Configurazione dei client plugin e migrazione

**Files:**
- Create: `artifacts/api-server/src/lib/oauth/plugins.ts`, `artifacts/api-server/src/lib/oauth/plugins.test.ts`, `docs/migrations/2026-11-plugin-hubup.sql`, `artifacts/api-server/test/migration-plugin-hubup.test.ts`
- Modify: `lib/db/src/schema/oauth.ts`, `lib/db/src/schema/apps.ts`, `docs/schema-casello.sql`, `artifacts/api-server/src/index.ts`

**Interfaces:**
- Produces:
  - `export type PluginClient = { clientId: string; name: string; redirectUri: string; secretSha256: string }`
  - `export const PLUGIN_SCOPES = ["api:read", "api:write"] as const`
  - `export class PluginConfigError extends Error` (messaggio che nomina `OAUTH_PLUGIN_CLIENTS` e il motivo, mai il valore)
  - `export function pluginClients(): PluginClient[]` — legge `process.env.OAUTH_PLUGIN_CLIENTS` a ogni chiamata; assente o vuota → `[]`; non valida → `PluginConfigError`
  - `export function pluginClient(clientId: string): PluginClient | null`
  - `export function pluginSecretMatches(client: PluginClient, secret: string): boolean` — `sha256Hex(secret)` confrontato con `timingSafeEqual`
  - `export async function ensurePluginClientRow(client: PluginClient): Promise<OAuthClient>` — `INSERT … ON CONFLICT (client_id) DO UPDATE SET name, redirect_uris, kind = 'plugin'`
  - colonna `apps.plugin_url_template` (`pluginUrlTemplate: text | null`), valore `plugin` in `oauth_client_kind`

Formato della variabile (array JSON, massimo 10 voci): `[{"clientId":"hubup","name":"The Hub Up","redirectUri":"https://hubup.example/api/botcave/callback","secretSha256":"<64 esadecimali minuscoli>"}]`. Regole: `clientId` `^[a-z][a-z0-9-]{1,39}$` e unico; `name` 1..100; `redirectUri` URL `https:` senza credenziali né frammento, oppure `http://localhost:<porta>/…` / `http://127.0.0.1:<porta>/…` solo con `NODE_ENV !== "production"`; `secretSha256` `^[0-9a-f]{64}$`.

- [ ] **Step 1: Test di `plugins.ts`** in `plugins.test.ts`:
  - `pluginClients()` con variabile assente → `[]`;
  - voce valida → un `PluginClient` con i campi dati; `pluginClient("hubup")` la trova, `pluginClient("altro")` → `null`;
  - `PluginConfigError` per: JSON non valido, non array, 11 voci, `clientId` `"Hub_Up"`, `clientId` ripetuto, `redirectUri` `http://hubup.example/cb`, `redirectUri` `http://localhost:5000/cb` con `NODE_ENV=production`, `secretSha256` di 63 caratteri; il messaggio contiene `OAUTH_PLUGIN_CLIENTS` e non contiene l'hash;
  - `pluginSecretMatches` vero col segreto giusto, falso con uno sbagliato e con la stringa vuota;
  - `ensurePluginClientRow` due volte con nome cambiato → una sola riga, `kind = "plugin"`, nome e `redirectUris` aggiornati.
- [ ] **Step 2:** `cd artifacts/api-server && pnpm exec vitest run src/lib/oauth/plugins.test.ts` → FAIL (modulo mancante).
- [ ] **Step 3: Schema e migrazione.** In `oauth.ts` l'enum diventa `["dcr", "metadata", "plugin"]`; in `apps.ts` `pluginUrlTemplate: text("plugin_url_template")`. `docs/migrations/2026-11-plugin-hubup.sql` (intestazione: «additiva e idempotente, PRIMA del merge»):
  ```sql
  ALTER TYPE oauth_client_kind ADD VALUE IF NOT EXISTS 'plugin';
  ALTER TABLE apps ADD COLUMN IF NOT EXISTS plugin_url_template text;
  ```
  Stesse modifiche in `docs/schema-casello.sql`. Test `test/migration-plugin-hubup.test.ts` sul modello di `test/migration-connettore-oauth.test.ts`: lo script applicato due volte non fallisce e dopo esistono valore e colonna.
- [ ] **Step 4: Implementare `plugins.ts`.** In `src/index.ts`, all'avvio prima di `listen`, chiamare `pluginClients()`: una `PluginConfigError` ferma il processo come le variabili di login mancanti, e il log registra solo il messaggio.
- [ ] **Step 5:** i due test passano; `pnpm run typecheck` verde.
- [ ] **Step 6: Commit** `feat(casello): client OAuth plugin dalla configurazione e migrazione`.

---

### Task 2: Autorizzazione e consenso per i plugin

**Files:**
- Modify: `artifacts/api-server/src/lib/oauth/{clients,authorize,pages,config}.ts`, `src/routes/oauth.ts`
- Test: `artifacts/api-server/src/routes/oauth-authorize-plugin.test.ts`

**Interfaces:**
- Consumes: `pluginClient`, `ensurePluginClientRow`, `PLUGIN_SCOPES` (Task 1).
- Produces:
  - `AuthorizeParams` con un campo nuovo `kind: "connector" | "plugin"`;
  - `approve(userId, p)` salva `scopes` = `PLUGIN_SCOPES` se `p.kind === "plugin"`, altrimenti `CONNECTOR_SCOPES`;
  - `consentPage({ clientName, redirectHost, userEmail, csrf, kind })`.

Regole per un `client_id` che è un plugin configurato (controllato PRIMA del documento o della registrazione dinamica):
- `resolveClient` restituisce la riga di `ensurePluginClientRow`; un `client_id` plugin non più configurato → client sconosciuto (pagina «Applicazione non riconosciuta.»), anche se la riga esiste ancora.
- `redirect_uri` uguale carattere per carattere a `redirectUri` della configurazione, altrimenti pagina «Indirizzo di ritorno non valido.».
- `scope`: facoltativo; se presente, lista separata da spazi i cui valori stanno tutti in `api:read api:write` e almeno uno c'è, altrimenti redirect `invalid_scope`. Il collegamento ha sempre entrambi gli ambiti.
- `resource`: facoltativo; se presente deve essere `<issuer>/api` (un `/` finale si ignora), altrimenti `invalid_target`. Aggiungere `sameApiResource(value)` in `config.ts`.
- PKCE `S256` e `state` come per il connettore.
- Pagina di consenso per `kind: "plugin"`: titolo «Collegare <nome> a Botcave?»; testo: «<nome> potrà usare Botcave per tuo conto: vedere e gestire app, squadre, modelli e skill, scrivere ai capi, approvare e rifiutare le voci da confermare. Non potrà cambiare chiavi, tetti di spesa, token né account collegati.»; il connettore resta com'è.

- [ ] **Step 1: Test** in `oauth-authorize-plugin.test.ts` (stile di `oauth-authorize.test.ts`, `OAUTH_PLUGIN_CLIENTS` impostata nel test):
  - GET con sessione e parametri giusti → 200 e pagina che contiene «Collegare The Hub Up a Botcave?» e «Non potrà cambiare chiavi»;
  - `redirect_uri` diverso → 400, pagina «Indirizzo di ritorno non valido.»;
  - `scope=mcp` → redirect con `error=invalid_scope`; `scope=api:read` → 200;
  - `resource=<issuer>/mcp` → `invalid_target`; `resource=<issuer>/api/` → 200;
  - POST `allow` → redirect con `code`; il collegamento creato ha `scopes` `["api:read","api:write"]`;
  - plugin tolto dalla variabile dopo il primo consenso → GET risponde 400 «Applicazione non riconosciuta.».
- [ ] **Step 2:** `pnpm exec vitest run src/routes/oauth-authorize-plugin.test.ts` → FAIL.
- [ ] **Step 3: Implementare** le regole sopra. Non cambia nulla per i client `dcr`/`metadata`, che restano coperti da `oauth-authorize.test.ts`.
- [ ] **Step 4:** i test nuovi e `oauth-authorize.test.ts` passano.
- [ ] **Step 5: Commit** `feat(casello): consenso OAuth per le applicazioni plugin`.

---

### Task 3: Token endpoint con segreto del client e token `cap_`

**Files:**
- Modify: `artifacts/api-server/src/lib/oauth/{tokens,metadata,grants,clients}.ts`, `src/routes/oauth.ts`
- Test: `artifacts/api-server/src/lib/oauth/tokens-plugin.test.ts`

**Interfaces:**
- Consumes: Task 1 e Task 2 (collegamenti con `PLUGIN_SCOPES`).
- Produces:
  - `TokenResponse.scope` diventa `string` (`"mcp"` per il connettore, `"api:read api:write"` per i plugin);
  - `export async function verifyPluginAccessToken(raw: string): Promise<{ userId: number; grantId: number; scopes: TokenScope[] } | null>` — solo `cap_…`, non scaduto, collegamento non revocato, client con `kind = 'plugin'` e `client_id` ancora in `pluginClients()`, utente ancora ammesso (`isAllowed`); aggiorna `last_used_at` al più una volta al minuto come `verifyAccessToken`;
  - `verifyAccessToken` (connettore) rifiuta i collegamenti di un client `plugin`.

Regole:
- Autenticazione del client al token endpoint (`authorization_code` e `refresh_token`): se `client_id` è un plugin configurato serve `client_secret` nel form (solo `client_secret_post`) e deve corrispondere (`pluginSecretMatches`), altrimenti 401 `invalid_client` «applicazione non riconosciuta». Il controllo del segreto avviene PRIMA di leggere codice o token di rinnovo: un segreto sbagliato non consuma, non ruota e non revoca nulla. Un `client_id` plugin non più configurato → 401 `invalid_client`. Per i client pubblici un `client_secret` eventuale si ignora (come oggi).
- `issuePair` emette `cap_…` invece di `cao_…` quando il collegamento è di un plugin (il prefisso del rinnovo resta `car_`).
- `checkResource` nel token endpoint: per i plugin vale `sameApiResource`.
- Metadati dell'authorization server: `token_endpoint_auth_methods_supported: ["none", "client_secret_post"]`, `scopes_supported: ["mcp", "api:read", "api:write"]`. Il documento della risorsa protetta (`/mcp`) non cambia.
- `sweepOAuth` non cancella mai righe `kind = 'plugin'`; `countClients` (tetto di 1 000) non le conta.

- [ ] **Step 1: Test** in `tokens-plugin.test.ts` (collegamento e codice creati come in `tokens.test.ts`, con un client plugin):
  - scambio con segreto giusto → `access_token` che inizia con `cap_`, `refresh_token` `car_`, `scope` `"api:read api:write"`;
  - scambio senza `client_secret` o con quello sbagliato → `OAuthError` `invalid_client` status 401, e lo stesso codice si può poi scambiare col segreto giusto;
  - rinnovo con segreto sbagliato → 401 `invalid_client`; subito dopo il rinnovo col segreto giusto riesce (il token non è stato toccato);
  - rinnovo riuscito → nuova coppia `cap_`/`car_`; il vecchio `car_` riusato dopo 61 s revoca il collegamento (stessa regola del connettore);
  - `verifyPluginAccessToken`: valido → userId e ambiti; `cao_…` → `null`; collegamento revocato → `null`; plugin tolto dalla variabile → `null`, e il rinnovo risponde `invalid_client`;
  - `verifyAccessToken` di un `cap_…` → `null`;
  - `sweepOAuth` con un client plugin senza collegamenti creato 2 giorni prima → la riga resta;
  - `authorizationServerMetadata()` contiene `client_secret_post` e `api:write`.
- [ ] **Step 2:** `pnpm exec vitest run src/lib/oauth/tokens-plugin.test.ts` → FAIL.
- [ ] **Step 3: Implementare** le regole sopra.
- [ ] **Step 4:** passano `tokens-plugin.test.ts`, `tokens.test.ts`, `grants.test.ts`, `clients.test.ts`, `src/routes/oauth*.test.ts`.
- [ ] **Step 5: Commit** `feat(casello): token cap_ per i plugin con segreto del client`.

---

### Task 4: `cap_` su `/api`, flusso completo

**Files:**
- Modify: `artifacts/api-server/src/lib/auth.ts`, `src/middlewares/rate-limit.ts`
- Test: `artifacts/api-server/test/oauth-plugin-flow.test.ts`

**Interfaces:**
- Consumes: `verifyPluginAccessToken` (Task 3).
- Produces: `req.auth` è `{kind:"session"} | {kind:"token", tokenId, scopes} | {kind:"oauth", grantId: number, scopes: TokenScope[]}`.

Regole:
- In `requireAuth`, con l'header `Authorization`: un bearer che inizia con `cap_` si verifica con `verifyPluginAccessToken`; `null` → 401 `TOKEN_MESSAGES.invalid`; altrimenti `req.userId`, `req.auth = {kind:"oauth", …}`, poi `tokenRateLimit` e `hasScopeFor` come per i token personali. Ogni altro bearer segue la strada di oggi. Errore del DB → 500 «errore interno», nel log solo il nome dell'errore.
- `sessionOnly` rifiuta ogni `req.auth.kind !== "session"`.
- `tokenRateLimit`: chiave `oauth:<grantId>` per `kind: "oauth"`, `token:<tokenId>` per i token personali.
- `GET /api/auth/me` con un `cap_…` risponde `auth: {kind:"token", scopes}`: nessun cambio all'OpenAPI.
- `/mcp` non cambia: `requireApiToken` non conosce `cap_` e risponde 401.

- [ ] **Step 1: Test** `test/oauth-plugin-flow.test.ts` sull'app vera (modello `test/oauth-flow.test.ts`, `OAUTH_PLUGIN_CLIENTS` con il plugin di prova):
  - metadati → consenso con la sessione → scambio col segreto → `GET /api/auth/me` con `cap_` 200 (email dell'utente);
  - `POST /api/apps` con `cap_` → 201 (scrittura ammessa);
  - `PUT /api/budget` e `POST /api/account/tokens` con `cap_` → 403 «operazione disponibile solo con il login»;
  - `cap_` su `/mcp` (`initialize`) → 401; il `cao_` di un connettore su `GET /api/apps` → 401;
  - rinnovo → il nuovo `cap_` vale e il vecchio continua a valere fino alla scadenza (come il connettore);
  - `DELETE /api/account/oauth-grants/:id` con la sessione → il `cap_` risponde 401;
  - nuovo consenso, poi il plugin viene tolto dalla variabile → il `cap_` risponde 401.
- [ ] **Step 2:** `pnpm exec vitest run test/oauth-plugin-flow.test.ts` → FAIL.
- [ ] **Step 3: Implementare** le regole sopra.
- [ ] **Step 4:** tutti i test dell'API (`pnpm --filter @workspace/api-server run test`) e `pnpm run typecheck` verdi.
- [ ] **Step 5: Commit** `feat(casello): i token cap_ dei plugin valgono su /api`.

---

### Task 5: Link della squadra nel servizio (`plugin_url_template`)

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (+ codegen), `artifacts/api-server/src/routes/apps.ts`, `src/lib/teams/instances.ts`, `artifacts/casello/src/components/apps/app-form-dialog.tsx`, `artifacts/casello/src/pages/team-detail.tsx`
- Test: `artifacts/api-server/src/routes/apps-plugin-url.test.ts`, `artifacts/api-server/src/lib/teams/instances.test.ts` (casi nuovi)

**Interfaces:**
- Consumes: colonna `apps.plugin_url_template` (Task 1).
- Produces:
  - `App.pluginUrlTemplate: string | null`, campo facoltativo e nullable in `AppInput` e nel corpo dell'aggiornamento;
  - `TeamInstance.ref.url: string | null` (in `required`);
  - `export function pluginUrlTemplateError(value: string): string | null` in `apps.ts` (o in un modulo vicino, se `apps.ts` non lo esporta già per i test).

Regole:
- Template: 1..500 caratteri; `{refId}` presente esattamente una volta; sostituito `{refId}` con `1` deve essere un URL `https:` senza credenziali, oppure `http:` verso `localhost`/`127.0.0.1` solo con `NODE_ENV !== "production"`. Violazione → 400 `pluginUrlTemplate: indirizzo non valido: serve https e {refId} una sola volta`. Stringa vuota → null.
- `ref.url` = template con `{refId}` → `encodeURIComponent(ref.id)`, solo se l'app del lavoro ha un template e `ref.type === "task"`; altrimenti null.
- Console:
  - nel form dell'app, campo facoltativo «Link alle squadre nel servizio», con l'aiuto «Indirizzo della pagina del lavoro nel servizio, con {refId} al posto dell'identificativo. Esempio: https://hub.example/tasks/{refId}/edit»;
  - nella scheda squadra, accanto al nome dell'app di riferimento, il link «Apri in <nome>» (`<nome>` = nome dell'app fino al primo « · »), con `target="_blank"` e `rel="noopener noreferrer"`, mostrato solo se `ref.url` non è null.

- [ ] **Step 1: Test.**
  - `apps-plugin-url.test.ts`: `POST /api/apps` con `pluginUrlTemplate` `https://hub.example/tasks/{refId}/edit` → 201 e il valore torna nel GET; 400 con il messaggio fisso per `http://hub.example/{refId}`, `https://hub.example/tasks/edit` (senza segnaposto), `https://hub.example/{refId}/{refId}` e 501 caratteri; `""` → null.
  - `instances.test.ts`: squadra su un'app con template e `ref.type` `task`, `ref.id` `"12/a?b#c"` → `ref.url` `https://hub.example/tasks/12%2Fa%3Fb%23c/edit`; con `ref.type` `wi` → null; app senza template → null.
- [ ] **Step 2:** `pnpm exec vitest run src/routes/apps-plugin-url.test.ts src/lib/teams/instances.test.ts` → FAIL.
- [ ] **Step 3: Implementare** OpenAPI, codegen (`pnpm --filter @workspace/api-spec run codegen`), route, `toView` e console.
- [ ] **Step 4:** test verdi, `pnpm run typecheck` verde; nel browser (`AUTH_DISABLED=true pnpm run dev`) il form dell'app salva il campo e la scheda squadra mostra il link, a 1280 px senza scorrimento orizzontale.
- [ ] **Step 5: Commit** `feat(casello): link della squadra nel servizio collegato`.

---

### Task 6: Documentazione

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-11-06-botcave-plugin-hubup-design.md`

- [ ] **Step 1: `CLAUDE.md`.**
  - Sezione «Connettore OAuth (app Claude)»: paragrafo **Plugin** (variabile, formato, `cap_`, ambiti, segreto, consenso, `sessionOnly`, rimozione dalla variabile = token non più validi, righe `plugin` escluse dalla pulizia e dal tetto).
  - «Token personali su `/api`»: anche `cap_…` vale su `/api`.
  - «Deploy»: aggiungere `OAUTH_PLUGIN_CLIENTS` all'elenco delle variabili (facoltativa; non valida → l'API non parte).
  - «Modello di dominio»: `plugin_url_template` su App.
- [ ] **Step 2: spec.** Sezione finale «Differenze dal codice»: l'hash del segreto sta nella variabile e non in `oauth_clients`; `oauth_grants.scopes` esisteva già; il tipo di client è `plugin`, non `confidential`; il link vale solo per `ref.type = task`.
- [ ] **Step 3: Commit** `docs(casello): plugin OAuth e link al servizio`.

---

## Note per la PR

- Migrazione `docs/migrations/2026-11-plugin-hubup.sql`, da applicare su Neon PRIMA del merge (SQL completo in chat prima del push).
- Variabile nuova `OAUTH_PLUGIN_CLIENTS` su Coolify (facoltativa): finché manca nessun plugin è attivo. Il segreto lo genera chi configura The Hub Up (`openssl rand -base64 32`); in Botcave va solo il suo SHA-256 (`printf %s "$SEGRETO" | shasum -a 256`). The Hub Up riceverà `BOTCAVE_CLIENT_ID` e `BOTCAVE_CLIENT_SECRET` nella PR 2.
