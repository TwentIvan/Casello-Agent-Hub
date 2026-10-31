# Casello: token personali su `/api` (design)

Data: 2026-10-31. Blocco 4 del piano di evoluzione di Casello.

## 1. Scopo

Oggi `/api` accetta solo il cookie di sessione (login Google o GitHub); i token personali `cas_…` valgono solo per
il server MCP `/mcp`. Il blocco permette di usare un token personale anche su `/api`, per:

- agenti di Casello che agiscono su Casello stesso (Casello registrato come app di sé stesso, tool con identità
  `user`: il token arriva all'esecutore come `X-App-User-Token` della run o come segreto di servizio dell'app);
- script e automazioni dell'utente (cron, GitHub Action, Claude Code che chiama l'API REST).

Fuori ambito (passo successivo): ambiti per area (`runs`, `plan`, `apps`…), da aggiungere sopra quelli di questo
blocco senza rompere i token esistenti.

## 2. Dati e gestione dei token

- Migrazione additiva `docs/migrations/2026-10-token-api.sql` (+ `docs/schema-casello.sql`, fixture, test):
  `api_tokens.scopes text[] NOT NULL DEFAULT '{mcp}'`. I token esistenti diventano `{mcp}`: nessun permesso nuovo.
- Ambiti: `mcp`, `api:read`, `api:write` (`api:write` include la lettura). Almeno uno, senza ripetizioni, solo
  valori ammessi (altrimenti 400). Un token può averne più d'uno.
- `POST /api/account/tokens`: `scopes` facoltativo, default `["mcp"]` (il flusso dell'agente locale non cambia).
  Scadenza 1-90 giorni come oggi. Gli ambiti non si modificano dopo la creazione.
- `GET /api/account/tokens`: ogni token espone anche `scopes` (mai valore né hash).
- `/mcp` richiede l'ambito `mcp`: un token senza riceve 401 con il messaggio fisso attuale («token non valido o
  scaduto»).
- Restano i controlli attuali di `authenticateApiToken`: token revocato, scaduto o di un utente non più ammesso
  (`ALLOWED_EMAILS`) non vale; `lastUsedAt` aggiornato al massimo una volta al minuto.

## 3. Regole di accesso su `/api`

Un solo punto: `requireAuth` in `lib/auth.ts`.

- Con l'header `Authorization` presente si usa solo il token, mai il cookie. Header non `Bearer cas_…`, token
  sconosciuto, revocato o scaduto → 401 «token non valido o scaduto» (nessun ripiego sulla sessione).
- Senza header: sessione come oggi (401 «Login richiesto»).
- Ambito per metodo: GET e HEAD → `api:read` o `api:write`; POST, PUT, PATCH, DELETE → `api:write`. Un token senza
  l'ambito richiesto (es. solo `mcp`) → 403 «il token non ha l'ambito per questa operazione».
- La richiesta ricorda come è autenticata: `req.userId` come oggi, più `req.auth = { kind: "session" } |
  { kind: "token"; tokenId; scopes }`. `currentUserId` non cambia.
- Operazioni solo con il login: middleware `sessionOnly` sulle route; con un token → 403 «operazione disponibile
  solo con il login». Elenco:
  - `GET|POST /account/tokens`, `DELETE /account/tokens/:id`;
  - `POST /ai/accounts`, `PATCH|DELETE /ai/accounts/:id`, `POST /ai/accounts/:id/verify`,
    `POST /ai/accounts/:id/default`, `POST /ai/accounts/:id/models`, `PATCH /ai/models/:id` (chiavi, indirizzi,
    prezzi a mano, tetti per account e modello);
  - `PUT /budget` (tetto dell'utente);
  - `DELETE /auth/github`.
  Tutto il resto (run, analisi, piano, chat, issue, app, agenti, tool, catalogo, prova di un modello) è
  disponibile con `api:write`.
- `GET /api/auth/me` (oggi pubblica e basata sulla sessione) accetta anche il token con le stesse regole e
  risponde con l'utente più `auth: { kind: "session" } | { kind: "token", scopes: string[] }`.
- Limite: 120 richieste al minuto per token su `/api` (chiave: id del token), in aggiunta ai limiti esistenti
  per utente o IP; superato → 429.
- Log: mai l'header `Authorization`, il token o il suo hash (pino-http registra solo metodo e URL; un test lo
  verifica).
- CORS invariato.

## 4. Console

- Pagina Account: la sezione «Agenti locali» diventa «Token personali».
- Creazione: caselle «Agente locale (MCP)» (preselezionata), «API: lettura», «API: scrittura» (scrittura implica
  lettura: selezionarla seleziona anche lettura); almeno una.
- Elenco: badge degli ambiti per token.
- Dopo la creazione, oltre al comando `claude mcp add …` (se il token ha `mcp`), un esempio
  `curl -H "Authorization: Bearer <token>" <origine>/api/auth/me` (se ha un ambito `api:*`).

## 5. Documentazione

- CLAUDE.md: sezione «Token personali» (ambiti, regole, operazioni solo con il login, limite, migrazione) e come
  registrare Casello come app di sé stesso (`internal_base_url` `http://casello-api:3000`, autenticazione utente
  `Authorization` + `Bearer`).
- La skill dell'agente locale resta valida (token creati senza ambiti = `mcp`); il passo che crea il token cita
  la casella «Agente locale (MCP)».

## 6. Test

- Migrazione: token esistenti → `{mcp}`, idempotente.
- Creazione: default `["mcp"]`; ambiti validi; vuoto, ripetuto o sconosciuto → 400; elenco con gli ambiti.
- `/mcp` con token solo `api:*` → 401.
- `/api`: token `api:read` su GET → 200, su POST → 403; `api:write` su POST → ok; solo `mcp` → 403; scaduto o
  revocato → 401; header non valido → 401 anche con un cookie di sessione valido.
- Ogni route `sessionOnly` dell'elenco → 403 con un token `api:write` e funzionante con la sessione.
- `GET /auth/me` con token e con sessione.
- Limite di 120/minuto per token → 429.
- Nessuna traccia del token nei log delle richieste.
