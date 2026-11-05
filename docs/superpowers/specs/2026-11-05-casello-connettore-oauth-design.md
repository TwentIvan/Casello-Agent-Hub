# Casello come connettore dell'app Claude (OAuth 2.1 su `/mcp`)

Data: 2026-11-05. Sostituisce e aggiorna la «Tappa 2» di `2026-10-28-casello-esecutore-locale-design.md` (§6).

## 1. Obiettivo

Dall'app Claude (claude.ai, app per telefono, account Enterprise) l'utente aggiunge Casello come **connettore
personalizzato** e parla con le sue squadre attraverso il centralino già esposto su `/mcp` (`squadre_stato`,
`bollettino`, `squadra_dettaglio`, `invia_al_capo`, `coda_da_confermare`, `approva`, `rifiuta`, più gli strumenti
dell'architetto locale). Il collegamento si fa con il login di Casello (Google o GitHub), senza copiare token.

Riuscita: in claude.ai si aggiunge `https://casello.fantamister.cloud/mcp`, si fa login e si acconsente; dal telefono
«come vanno le mie squadre?» risponde con i dati di Casello; in console, Account → «App collegate», il collegamento si
vede e si revoca.

Vincoli:
- L'app Claude si collega ai server MCP remoti solo senza autenticazione o con OAuth 2.1 (registrazione dinamica o
  documento del client); non manda header statici. Le chiamate partono dalla rete di Anthropic, non dal telefono.
- In un'organizzazione Enterprise i connettori personalizzati li permette (o li aggiunge) un amministratore: fuori
  dal codice di Casello. Non è garantito che la modalità vocale dell'app usi i connettori personalizzati: si verifica
  nella prova finale.
- I token personali `cas_…` restano come sono (Claude Code, script, nodi).

Fuori ambito: uso dei token del connettore su `/api`, strumenti nuovi del centralino, capo delle squadre sul nodo
(sottoprogetto successivo), endpoint di revoca RFC 7009, scelta degli ambiti al consenso.

## 2. Flusso

1. **Scoperta.** `/mcp` senza token, con un token sconosciuto, scaduto o revocato risponde **401** con
   `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_APP_URL>/.well-known/oauth-protected-resource"` (oltre al corpo
   `{error}` di oggi).
   - `GET /.well-known/oauth-protected-resource` e `GET /.well-known/oauth-protected-resource/mcp` (stesso documento):
     `resource` = `<PUBLIC_APP_URL>/mcp`, `authorization_servers` = [`<PUBLIC_APP_URL>`], `scopes_supported` = [`mcp`],
     `bearer_methods_supported` = [`header`].
   - `GET /.well-known/oauth-authorization-server`: `issuer` = `<PUBLIC_APP_URL>`, `authorization_endpoint`
     `<PUBLIC_APP_URL>/oauth/authorize`, `token_endpoint` `<PUBLIC_APP_URL>/oauth/token`, `registration_endpoint`
     `<PUBLIC_APP_URL>/oauth/register`, `response_types_supported` [`code`], `grant_types_supported`
     [`authorization_code`, `refresh_token`], `code_challenge_methods_supported` [`S256`],
     `token_endpoint_auth_methods_supported` [`none`], `client_id_metadata_document_supported` true,
     `scopes_supported` [`mcp`].
2. **Client.** Solo client pubblici (nessun segreto, PKCE obbligatorio).
   - Registrazione dinamica (RFC 7591) `POST /oauth/register` (JSON): `redirect_uris` 1..5, `client_name` ≤ 100
     (default «Client MCP»), `token_endpoint_auth_method` assente o `none` (altrimenti `invalid_client_metadata`).
     Risponde 201 con `client_id` (`cac_` + 16 byte casuali in base64url), `client_id_issued_at`, `redirect_uris`,
     `client_name`, `token_endpoint_auth_method: "none"`, `grant_types`, `response_types`.
   - Documento del client: se `client_id` è un URL `https`, Casello lo scarica alla prima autorizzazione (10 s, ≤ 64 KB,
     JSON, nessun redirect, solo `https` verso indirizzi pubblici: niente reti private, loopback, link-local o metadata, come
     per gli indirizzi dei provider AI), verifica che il
     suo `client_id` sia lo stesso URL e usa `client_name` e `redirect_uris`; lo tiene in `oauth_clients` e lo riscarica
     dopo 24 ore.
   - **Indirizzi di ritorno ammessi**, uguali carattere per carattere: `https://claude.ai/api/mcp/auth_callback`,
     `https://claude.com/api/mcp/auth_callback`; loopback `http://localhost:<porta>/callback` e
     `http://127.0.0.1:<porta>/callback` (porta qualsiasi, per Claude Code). Altro → `invalid_redirect_uri`.
3. **Autorizzazione.** `GET /oauth/authorize` con `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
   `code_challenge_method=S256`, `state` (facoltativo, restituito com'è), `scope` (facoltativo, solo `mcp`), `resource`
   (facoltativo, se presente uguale a `<PUBLIC_APP_URL>/mcp`).
   - Client sconosciuto, `redirect_uri` non registrato o non ammesso: pagina d'errore, **mai** un redirect.
   - Altri parametri sbagliati con un `redirect_uri` valido: redirect con `error` (`invalid_request`,
     `unsupported_response_type`, `invalid_scope`, `invalid_target`) e `state`.
   - Senza sessione: redirect a `/api/auth/login?returnTo=<percorso /oauth/authorize con la query>` (`safeReturnTo`);
     dopo il login si torna qui. Utente fuori da `ALLOWED_EMAILS` → la pagina di login lo rifiuta come oggi.
   - Pagina di consenso (HTML servito dall'API, stile della console): nome del client **e** host dell'indirizzo di ritorno
     (es. «Claude · claude.ai»: un `client_name` falso non basta a ingannare), testo «Potrà vedere le tue squadre e il
     bollettino, scrivere ai capi, approvare e rifiutare le voci da confermare ed eseguire le analisi dell'architetto»,
     account con cui si è entrati, pulsanti «Consenti» e «Annulla».
   - La richiesta in attesa sta nella sessione (`oauthPending`: parametri validati + token CSRF casuale); la decisione è
     `POST /oauth/authorize` (form) con il token CSRF e `decision=allow|deny`. Token CSRF diverso o richiesta in attesa
     assente → pagina d'errore. `deny` → redirect con `error=access_denied` e `state`.
   - `allow` → collegamento (§3) e codice d'autorizzazione: valore casuale di 32 byte in base64url, valido **10 minuti**,
     una sola volta, legato a client, `redirect_uri`, `code_challenge` e collegamento; redirect con `code` e `state`.
4. **Token.** `POST /oauth/token` (`application/x-www-form-urlencoded`), risposta JSON con `Cache-Control: no-store`.
   - `grant_type=authorization_code`: `code`, `redirect_uri`, `client_id`, `code_verifier` (43..128 caratteri);
     `resource` facoltativo come sopra. Codice sconosciuto, scaduto, già usato, di un altro client o redirect diverso, o
     PKCE che non torna → `invalid_grant`; il codice si consuma con un UPDATE condizionato (una sola volta anche con
     richieste concorrenti).
   - `grant_type=refresh_token`: `refresh_token`, `client_id`.
   - Risposta: `access_token` (`cao_` + 32 byte), `token_type: "Bearer"`, `expires_in: 3600`, `refresh_token` (`car_` +
     32 byte, valido **30 giorni**), `scope: "mcp"`.
   - **Rotazione**: ogni rinnovo segna il token di rinnovo come usato ed emette una coppia nuova; un token di rinnovo già
     usato che si ripresenta → `invalid_grant` **e revoca dell'intero collegamento** (probabile furto).
   - Errori RFC 6749 (`invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`) con
     `error_description` fissa in italiano; 400 (401 solo per `invalid_client`).
5. **Uso su `/mcp`.** `requireApiToken` riconosce il prefisso: `cas_…` come oggi; `cao_…` = token d'accesso del
   connettore: valido se non scaduto, il collegamento non è revocato e l'utente è ancora in `ALLOWED_EMAILS` (`isAllowed`).
   Imposta `mcpUserId` e `mcpScopes = ["mcp", "api:write"]`: tutti gli strumenti, approva e rifiuta compresi (scelta
   dell'utente: il connettore approva sempre). Aggiorna `last_used_at` del collegamento al massimo una volta al minuto.
   Su `/api` un `cao_…`/`car_…` è un token sconosciuto: 401 «token non valido o scaduto».

## 3. Dati (migrazione `docs/migrations/2026-11-connettore-oauth.sql`, additiva e idempotente, PRIMA del merge)

- `oauth_clients`: `id` serial, `client_id` text unico, `kind` (`dcr` | `metadata`), `name`, `redirect_uris` jsonb,
  `metadata_fetched_at` (solo `metadata`), `created_at`.
- `oauth_grants` (il **collegamento**): `id`, `user_id` → users (cascade), `client_id` → oauth_clients (cascade),
  `scopes` jsonb (`["mcp","api:write"]`), `created_at`, `last_used_at`, `revoked_at`. Al più un collegamento non revocato
  per utente e client (indice unico parziale): un nuovo consenso revoca il precedente nella stessa transazione.
- `oauth_codes`: `id`, `code_hash` unico, `grant_id` → oauth_grants (cascade), `redirect_uri`, `code_challenge`,
  `expires_at`, `used_at`.
- `oauth_tokens`: `id`, `token_hash` unico, `grant_id` → oauth_grants (cascade), `kind` (`access` | `refresh`),
  `expires_at`, `used_at` (solo refresh: già ruotato), `created_at`.
- Di codici e token si salva solo l'hash SHA-256; il valore esce solo nella risposta.
- Pulizia (all'avvio e ogni ora): codici scaduti da più di un giorno, token scaduti da più di un giorno, collegamenti
  revocati da più di 30 giorni, client senza collegamenti creati da più di 24 ore.
- Riportata in `docs/schema-casello.sql`; schema Drizzle in `lib/db/src/schema/oauth.ts`.

## 4. Console

- Account → carta **«App collegate»** (`components/account/oauth-grants-section.tsx`): per ogni collegamento non
  revocato il nome del client e l'host del ritorno, collegato il, ultimo uso, «Può approvare e rifiutare»; «Revoca»
  con conferma. Vuota: «Nessuna app collegata. In claude.ai aggiungi il connettore `<PUBLIC_APP_URL>/mcp`.» con il
  pulsante «Copia indirizzo».
- Route (solo login, `sessionOnly`, contratto in `openapi.yaml`): `GET /api/account/oauth-grants`,
  `DELETE /api/account/oauth-grants/:id` (204; altrui o già revocato → 404 «collegamento non trovato»). La revoca vale
  subito: i token del collegamento smettono di valere alla richiesta successiva.
- Niente scorrimento orizzontale a 1280 px.

## 5. Limiti, sicurezza, log

- Limiti in memoria: `POST /oauth/register` 10/min per IP; `POST /oauth/token` 30/min per `client_id`;
  `/oauth/authorize` (GET e POST) 20/min per utente (per IP senza sessione). Oltre → 429 (`slow_down` sul token).
  Restano i limiti di `/mcp` (60/min per utente) e il contatore delle decisioni per approva/rifiuta.
- Massimo 1 000 client registrati: oltre, `POST /oauth/register` → 503 «registrazioni temporaneamente sospese» (la
  pulizia libera quelli inutilizzati).
- Pagine di consenso ed errore: `Content-Security-Policy` restrittiva, `X-Frame-Options: DENY` (niente clickjacking),
  testo escapato.
- Descrizioni di `approva` e `rifiuta`: si aggiunge «Prima di chiamarlo ripeti all'utente numero e sintesi della voce e
  chiedi conferma». Restano `destructiveHint`.
- Log: mai token, codici, hash, `code_verifier` né header Authorization; si registrano client, utente ed esito.
- nginx di `casello-web`: `location /.well-known/oauth-` e `location /oauth/` inoltrati a `casello-api:3000` come `/api/`
  (stesso `X-Forwarded-Proto`). `client_max_body_size` di default.
- Indirizzi assoluti costruiti da `PUBLIC_APP_URL` (in sviluppo `http://localhost:<WEB_PORT>`).

## 6. Codice

- `artifacts/api-server/src/lib/oauth/`: `metadata.ts` (documenti well-known), `clients.ts` (registrazione, documento del
  client, indirizzi ammessi), `authorize.ts` (validazione, consenso, codici), `tokens.ts` (scambio, rotazione,
  verifica dei `cao_`), `grants.ts` (elenco, revoca, pulizia), `pages.ts` (HTML di consenso ed errore).
- `src/routes/oauth.ts` montata alla radice dell'app (`/.well-known/…`, `/oauth/…`), fuori da `/api`; `src/routes/oauth-grants.ts`
  sotto `/api/account`.
- `lib/mcp/auth.ts`: ramo `cao_` e header `WWW-Authenticate`.

## 7. Test

- Flusso completo con un client finto: metadati, registrazione, `/oauth/authorize` senza sessione (redirect al login),
  con sessione (consenso), «Consenti», codice, token con PKCE, `tools/list` e `approva` su `/mcp`, rinnovo.
- Negativi: `redirect_uri` estraneo (pagina d'errore, nessun redirect), PKCE sbagliato, codice scaduto o riusato
  (anche due scambi concorrenti: uno solo riesce), token di rinnovo riusato (collegamento revocato), `cao_` su `/api` (401),
  collegamento revocato (401 su `/mcp` con `WWW-Authenticate`), utente tolto da `ALLOWED_EMAILS` (401), `resource`
  diversa, CSRF mancante, documento del client con redirect o oltre 64 KB, limite dei client.
- Migrazione applicata due volte; route della console (404 per collegamenti altrui); console nel browser a 1280 px.
- Prova finale reale dopo il deploy: connettore in claude.ai, poi dall'app del telefono (chat scritta e vocale).
