# Connettore OAuth per l'app Claude — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** l'app Claude (claude.ai, telefono) si collega a `/mcp` di Casello con OAuth 2.1 e il login di Casello, e usa il centralino.

**Architecture:** Casello fa da authorization server minimo: documenti well-known, registrazione dei client (DCR e documento
del client), consenso servito dall'API con la sessione esistente, codici con PKCE, token d'accesso `cao_` e di rinnovo `car_`
con rotazione. `/mcp` accetta i `cao_` accanto ai `cas_`. Account → «App collegate» elenca e revoca i collegamenti.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Vitest, OpenAPI + Orval, React/shadcn, nginx.

**Spec:** `docs/superpowers/specs/2026-11-05-casello-connettore-oauth-design.md` (leggerla: valori e messaggi esatti stanno lì).

## Global Constraints

- Italiano per commenti, messaggi d'errore, pagine e commit; identificatori in inglese. Commit `feat(casello): …` con la riga
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Indirizzi assoluti da `PUBLIC_APP_URL` (senza `/` finale); se manca (sviluppo e test) `http://localhost:${WEB_PORT ?? 5173}`.
  `resource` = `<base>/mcp`, `issuer` = `<base>`.
- Ritorni ammessi: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (uguali carattere per
  carattere), `http://localhost:<porta>/callback`, `http://127.0.0.1:<porta>/callback` (porta 1..65535 qualsiasi; nel
  confronto con quelli registrati la porta del loopback può cambiare, RFC 8252).
- Codice d'autorizzazione 10 min, una volta sola; accesso `cao_` 3600 s; rinnovo `car_` 30 giorni, ruotato a ogni uso, riuso →
  revoca del collegamento. Valori casuali 32 byte base64url; nel DB solo SHA-256 esadecimale.
- Ambiti del connettore: sempre `["mcp", "api:write"]`; `scope` OAuth unico `mcp`.
- Mai nei log token, codici, hash, `code_verifier`, header Authorization.
- Letture e validazioni dal pool, mai dentro una transazione di scrittura (PGlite si blocca). Consumo di codici e token di
  rinnovo con UPDATE condizionato (`used_at IS NULL`).
- Migrazione additiva e idempotente `docs/migrations/2026-11-connettore-oauth.sql`, riportata in `docs/schema-casello.sql`.
- Console: nessuno scorrimento orizzontale a 1280 px; solo hook generati da Orval.
- Comandi: `pnpm --filter @workspace/api-server run test`, `pnpm run typecheck`, `pnpm --filter @workspace/api-spec run codegen`
  (pnpm dalla shim del workspace se non è nel PATH).

## Review Focus

- Claude ritenta un rinnovo dopo un timeout di rete: il secondo uso dello stesso `car_` revoca il collegamento (scelta della
  spec); il messaggio in console dopo la revoca deve far capire di ricollegare. Test in Task 4.
- La sessione scade tra la pagina di consenso e «Consenti»: pagina d'errore «Richiesta scaduta: ricomincia dall'app Claude»,
  mai un 500. Test in Task 3.
- Claude Code registra `http://localhost:33418/callback` e poi autorizza con un'altra porta: deve funzionare. Test in Task 2.
- Un nuovo consenso dello stesso utente per lo stesso client revoca il collegamento precedente: i suoi `cao_` smettono di
  valere su `/mcp`. Test in Task 5.
- Un utente tolto da `ALLOWED_EMAILS` con un `cao_` valido: 401 su `/mcp`. Test in Task 5.

---

### Task 1: Tabelle OAuth e migrazione

**Files:**
- Create: `lib/db/src/schema/oauth.ts` (esportato da `lib/db/src/schema/index.ts`), `docs/migrations/2026-11-connettore-oauth.sql`,
  `artifacts/api-server/test/migration-connettore-oauth.test.ts`
- Modify: `docs/schema-casello.sql`

**Interfaces:**
- Produces: `oauthClientsTable`, `oauthGrantsTable`, `oauthCodesTable`, `oauthTokensTable`; enum `oauth_client_kind`
  (`dcr`, `metadata`), `oauth_token_kind` (`access`, `refresh`); tipi `OAuthClient`, `OAuthGrant`, `OAuthCode`, `OAuthToken`.
  Colonne come spec §3 (camelCase in Drizzle: `clientId`, `redirectUris`, `metadataFetchedAt`, `userId`, `clientRowId` → colonna
  `client_id` di `oauth_grants` che punta a `oauth_clients.id`, `scopes`, `lastUsedAt`, `revokedAt`, `codeHash`, `grantId`,
  `redirectUri`, `codeChallenge`, `expiresAt`, `usedAt`, `tokenHash`, `kind`). Indice unico parziale
  `oauth_grants_active_unique` su (`user_id`, `client_id`) `WHERE revoked_at IS NULL`; indici su `oauth_tokens.grant_id` e
  `oauth_codes.grant_id`.

- [ ] **Step 1:** test della migrazione (modello: `test/migration-nodo-cartelle.test.ts`): parte da
  `fixtures/schema-pre-nodo-locale.sql` + `2026-11-nodo-locale.sql` + `2026-11-nodo-cartelle.sql`, applica la nuova due volte;
  `it("crea le quattro tabelle e gli enum")`; `it("un solo collegamento attivo per utente e client")` (seconda INSERT non
  revocata → violazione unique; con `revoked_at` valorizzato → ok); `it("eliminare un utente elimina collegamenti, codici e token")`.
- [ ] **Step 2:** FAIL → schema Drizzle, SQL della migrazione (stesso stile di `2026-11-nodo-locale.sql`: `DO $$` per enum e
  FK), riporto in `schema-casello.sql` → PASS; `pnpm run typecheck`.
- [ ] **Step 3: Commit** `feat(casello): tabelle del connettore OAuth`

### Task 2: Metadati e registrazione dei client

**Files:**
- Create: `artifacts/api-server/src/lib/oauth/config.ts`, `errors.ts`, `metadata.ts`, `clients.ts` (+ `clients.test.ts`),
  `artifacts/api-server/src/routes/oauth.ts` (+ `oauth.test.ts`)
- Modify: `src/app.ts` (monta `oauthRouter()` dopo `sessionMiddleware()`, prima di `/api`), `src/middlewares/rate-limit.ts`

**Interfaces:**
- Produces:
  - `oauthBase(): { issuer: string; resource: string }` (`config.ts`).
  - `class OAuthError extends Error { constructor(code: string, description: string, status = 400) }` (`errors.ts`), con
    `toJSON()` → `{ error, error_description }`.
  - `protectedResourceMetadata()`, `authorizationServerMetadata()` (`metadata.ts`) con i campi della spec §2.1.
  - `isAllowedRedirectUri(uri: string): boolean`; `redirectMatches(registered: string[], uri: string): boolean` (loopback a porta
    variabile); `registerClient(body: unknown): Promise<{ status: 201; body: object }>` (errori `OAuthError`
    `invalid_client_metadata` / `invalid_redirect_uri`, oltre 1 000 client → `OAuthError("temporarily_unavailable",
    "registrazioni temporaneamente sospese", 503)`); `resolveClient(clientId: string, fetchImpl = fetch): Promise<OAuthClient | null>`
    (riga `dcr`, oppure documento del client per `client_id` `https://…`: 10 s, ≤ 64 KB, `redirect: "error"`, host validato con
    `validateBaseUrl(url, false)` di `lib/ai/providers.ts`, `client_id` del documento uguale all'URL, `redirect_uris` tutti ammessi;
    salvato o aggiornato in `oauth_clients` `kind = metadata`, riscaricato dopo 24 h; qualsiasi errore → null).
  - Route: `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp`,
    `GET /.well-known/oauth-authorization-server`, `POST /oauth/register` (JSON; `oauthRegisterRateLimit` 10/min per IP).
  - `oauthRouter(): IRouter` esportata da `routes/oauth.ts` (i task 3 e 4 vi aggiungono le loro route).

- [ ] **Step 1: test** (`clients.test.ts`, `oauth.test.ts` sull'app completa a porta 0 come `routes/nodes.test.ts`):
  - `it("metadati: resource <base>/mcp, issuer, endpoint, S256, none, client_id_metadata_document_supported")` (entrambi i path).
  - `it("registra un client claude.ai: 201 con client_id cac_…")`; `it("redirect estraneo → 400 invalid_redirect_uri")`
    (`https://evil.example/cb`, `https://claude.ai/api/mcp/auth_callback/x`, `http://localhost/altro`);
    `it("token_endpoint_auth_method client_secret_post → 400 invalid_client_metadata")`; `it("più di 5 redirect → 400")`.
  - `it("loopback: registrato :33418, ammesso anche :51000; https://claude.ai mai a porta diversa")` (`redirectMatches`).
  - `it("documento del client: scaricato, client_id coerente, redirect ammessi; redirect HTTP, oltre 64 KB o host privato → null")`
    con `fetchImpl` finto.
  - `it("oltre 1 000 client → 503")` (inserire 1 000 righe direttamente); `it("11ª registrazione nel minuto → 429")`.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): metadati OAuth e registrazione dei client`

### Task 3: Autorizzazione e consenso

**Files:**
- Create: `artifacts/api-server/src/lib/oauth/pages.ts`, `authorize.ts` (+ `authorize.test.ts`)
- Modify: `src/routes/oauth.ts` (+ test), `src/lib/auth.ts` (`SessionData.oauthPending`), `src/middlewares/rate-limit.ts`

**Interfaces:**
- Consumes: `resolveClient`, `redirectMatches`, `OAuthError`, `oauthBase` (Task 2); `sessionUserId(req)` di `lib/auth.ts`.
- Produces:
  - `type AuthorizeParams = { clientId: string; clientRowId: number; clientName: string; redirectUri: string; codeChallenge: string; state: string | null }`.
  - `validateAuthorizeRequest(query: Record<string, unknown>): Promise<AuthorizeParams>`: lancia `AuthorizePageError(message)` per
    client sconosciuto o ritorno non valido (pagina, mai redirect) e `AuthorizeRedirectError(code, redirectUri, state)` per
    `invalid_request` (manca `code_challenge`, metodo ≠ `S256`), `unsupported_response_type`, `invalid_scope` (≠ `mcp`),
    `invalid_target` (`resource` ≠ `<base>/mcp`).
  - `approve(userId: number, p: AuthorizeParams): Promise<string>`: in una transazione revoca il collegamento attivo dello
    stesso utente e client (`revoked_at = now`), crea il nuovo (`scopes ["mcp","api:write"]`) e il codice (hash, 10 min);
    restituisce l'URL di ritorno con `code` e `state`.
  - `consentPage({ clientName, redirectHost, userEmail, csrf }): string`, `errorPage(message: string): string`,
    `sendPage(res, status, html)` (imposta `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`,
    `X-Frame-Options: DENY`, `Cache-Control: no-store`); testo escapato. Testi esatti dalla spec §2.3.
  - Route `GET /oauth/authorize` e `POST /oauth/authorize` (form: `csrf`, `decision`), `oauthAuthorizeRateLimit` 20/min per
    utente (IP senza sessione). Senza utente: 302 a `/api/auth/login?returnTo=<encodeURIComponent(path+query)>`.
  - Sessione: `oauthPending?: { params: AuthorizeParams; csrf: string }`, tolta dopo la decisione.
- [ ] **Step 1: test** (con `AUTH_DISABLED=true` l'utente è quello di sviluppo; il caso «senza sessione» con
  `vi.mock` di `sessionUserId` che restituisce null):
  - `it("senza sessione → 302 al login con returnTo che riporta qui")`.
  - `it("consenso: 200 con nome del client, host claude.ai, email; CSP e X-Frame-Options DENY")`.
  - `it("Consenti → 302 al ritorno con code e state; collegamento e codice creati")`; `it("Annulla → access_denied con state, nessun collegamento")`.
  - `it("client sconosciuto o redirect non registrato → pagina 400, nessuna Location")`.
  - `it("resource diversa → 302 con error=invalid_target")`; `it("senza code_challenge o metodo plain → invalid_request")`.
  - `it("POST con csrf sbagliato o senza richiesta in attesa → pagina «Richiesta scaduta: ricomincia dall'app Claude»")`.
  - `it("client_name con <script> è escapato nella pagina")`.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): autorizzazione OAuth con pagina di consenso`

### Task 4: Endpoint dei token e rotazione

**Files:**
- Create: `artifacts/api-server/src/lib/oauth/tokens.ts` (+ `tokens.test.ts`)
- Modify: `src/routes/oauth.ts` (+ test), `src/middlewares/rate-limit.ts`

**Interfaces:**
- Consumes: righe di Task 1, `approve` (Task 3) nei test per ottenere un codice.
- Produces:
  - `type TokenResponse = { access_token: string; token_type: "Bearer"; expires_in: 3600; refresh_token: string; scope: "mcp" }`.
  - `exchangeCode(form: Record<string, unknown>): Promise<TokenResponse>` (spec §2.4; codice consumato con UPDATE condizionato;
    `code_verifier` 43..128 `[A-Za-z0-9-._~]`, `BASE64URL(SHA256(verifier)) === code_challenge`).
  - `refreshTokens(form: Record<string, unknown>): Promise<TokenResponse>` (rotazione; `car_` già usato → revoca del
    collegamento e `invalid_grant`; collegamento revocato o scaduto → `invalid_grant`).
  - `verifyAccessToken(raw: string): Promise<{ userId: number; grantId: number; scopes: TokenScope[] } | null>`: `cao_` valido,
    collegamento non revocato, `isAllowed` dell'utente; aggiorna `last_used_at` al massimo una volta al minuto.
  - Route `POST /oauth/token` (urlencoded), `Cache-Control: no-store`, `oauthTokenRateLimit` 30/min per `client_id`
    (429 `slow_down`); errori `OAuthError` → JSON RFC 6749.
- [ ] **Step 1: test:**
  - `it("codice + verifier giusto → token cao_/car_, expires_in 3600, scope mcp")`.
  - `it("verifier sbagliato, codice scaduto, altro client o altro redirect → invalid_grant")`.
  - `it("due scambi concorrenti dello stesso codice: uno solo riesce")` (`Promise.all`).
  - `it("rinnovo: coppia nuova, il car_ vecchio non vale più")`; `it("car_ riusato → invalid_grant e collegamento revocato: anche il cao_ nuovo non vale")`.
  - `it("grant_type sconosciuto → unsupported_grant_type")`; `it("risposte con Cache-Control no-store")`.
  - `it("verifyAccessToken: scaduto, revocato o utente fuori da ALLOWED_EMAILS → null")`.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): token OAuth con rotazione del rinnovo`

### Task 5: `/mcp` con i token del connettore

**Files:**
- Modify: `artifacts/api-server/src/lib/mcp/auth.ts`, `src/lib/mcp/server.ts` (descrizioni di `approva`/`rifiuta`),
  `src/lib/mcp/server.test.ts`
- Create: `artifacts/api-server/test/oauth-flow.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken` (Task 4), `oauthBase` (Task 2).
- Produces: `requireApiToken()` accetta `cao_…` (`mcpScopes = ["mcp","api:write"]`); ogni 401 di `/mcp` ha
  `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"`. Descrizioni di `approva` e
  `rifiuta` con la frase della spec §5. Su `/api` un `cao_` resta un token sconosciuto (401).
- [ ] **Step 1: test:**
  - `server.test.ts`: `it("401 con WWW-Authenticate senza token e con token sconosciuto")`.
  - `oauth-flow.test.ts`: `it("flusso completo: metadati, register, authorize, Consenti, token, tools/list, approva, refresh")`
    (client MCP SDK come in `server.test.ts`, voce in coda creata come nei test del centralino).
  - `it("cao_ su /api/team-instances → 401")`; `it("collegamento revocato → 401 su /mcp")`;
    `it("nuovo consenso dello stesso client: il cao_ del collegamento precedente → 401")`;
    `it("utente tolto da ALLOWED_EMAILS → 401")`.
- [ ] **Step 2:** FAIL → implementare → PASS; tutti i test dell'API; typecheck.
- [ ] **Step 3: Commit** `feat(casello): /mcp accetta i token del connettore OAuth`

### Task 6: «App collegate» in console e pulizia

**Files:**
- Create: `artifacts/api-server/src/lib/oauth/grants.ts` (+ test), `src/routes/oauth-grants.ts` (+ test),
  `artifacts/casello/src/components/account/oauth-grants-section.tsx`
- Modify: `lib/api-spec/openapi.yaml` (+ codegen), `src/routes/index.ts`, `src/index.ts` (pulizia all'avvio e ogni ora,
  come `lease-sweeper`), la pagina Account della console

**Interfaces:**
- Produces:
  - `listGrants(userId: number): Promise<OAuthGrantView[]>`, `OAuthGrantView = { id; clientName; redirectHost; createdAt; lastUsedAt; canDecide: boolean }`
    (solo non revocati, dal più recente); `revokeGrant(userId: number, id: number): Promise<boolean>`;
    `sweepOAuth(now = new Date()): Promise<void>` (regole della spec §3).
  - OpenAPI: `GET /account/oauth-grants` (`listOAuthGrants`, schema `OAuthGrant`), `DELETE /account/oauth-grants/{id}`
    (`revokeOAuthGrant`, 204, 404 «collegamento non trovato»), tag `account`, `sessionOnly`.
  - Carta «App collegate» con i testi della spec §4, «Revoca» con `ConfirmDialog`, «Copia indirizzo» di `<origine>/mcp`.
- [ ] **Step 1: test:** `it("elenca i collegamenti attivi dell'utente, non quelli revocati né altrui")`;
  `it("DELETE revoca: 204, poi il cao_ → 401 su /mcp; altrui o già revocato → 404")`; `it("con un token personale → 403")`;
  `it("sweep: toglie codici e token scaduti da oltre un giorno, collegamenti revocati da oltre 30 giorni, client inutilizzati da oltre 24 h; tiene il resto")`.
- [ ] **Step 2:** FAIL → implementare (API, codegen, console) → PASS; typecheck; console provata nel browser a 1280 px con DB in
  memoria (carta vuota e con un collegamento, revoca).
- [ ] **Step 3: Commit** `feat(casello): app collegate in console e pulizia OAuth`

### Task 7: nginx e documentazione

**Files:**
- Modify: `docker/nginx.conf`, `CLAUDE.md`

- [ ] **Step 1:** in `docker/nginx.conf` due `location` (`^~ /.well-known/oauth-` e `^~ /oauth/`) con lo stesso `proxy_pass` e
  gli stessi header di `location /api/`; verificare con `docker run --rm -v $PWD/docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro nginx:stable nginx -t`
  se Docker è disponibile, altrimenti confronto a vista con il blocco `/api/`.
- [ ] **Step 2:** `CLAUDE.md`: sezione «Connettore OAuth (app Claude)» (flusso, token, limiti, route, tabelle, migrazione da
  applicare PRIMA del merge), aggiornare «Esecutore locale» e «Token personali» dove dicono che `/mcp` accetta solo `cas_`;
  «Dove stanno le cose»: `lib/oauth/`, `routes/oauth.ts`, `routes/oauth-grants.ts`.
- [ ] **Step 3: Commit** `docs(casello): connettore OAuth nel CLAUDE.md e proxy nginx`
