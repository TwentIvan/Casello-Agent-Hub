# Casello: Esecutore locale (l'architetto eseguito da un agente locale via connettore MCP)

Data: 28 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Contesto e obiettivo

Le analisi dell'architetto su Mister falliscono per esaurimento del budget di token con gli account AI
in cloud (il tentativo arrivato più lontano: Gemini, 200k di contesto). La causa principale è
architetturale: il ciclo a strumenti di lettura minuscoli ri-manda tutta la cronologia a ogni giro e ogni
fase ricomincia da zero (vedi la spec gemella `2026-10-28-casello-architetto-lettura-efficiente-design.md`,
che cura il percorso cloud). Questa spec apre il secondo percorso, già previsto dall'interfaccia
dell'esecutore (`ExecutorKind = "local_agent"`, dichiarato e vuoto in `lib/ai/executor.ts`).

Decisioni prese:
- **Direzione**: Casello **espone** un server MCP remoto; l'agente locale (Claude Desktop/Cowork, Claude
  Code) si collega come connettore. Non il contrario (Casello che chiama il Mac): niente tunnel, niente
  programma ponte, niente Mac da tenere esposto.
- **Chi esplora il codice è l'agente locale**, sul clone che ha già sul proprio computer, con i propri
  strumenti. Casello non trasferisce il codice all'agente: gli dà il compito, le istruzioni di fase, i
  risultati delle fasi precedenti e l'OpenAPI (se c'è), e riceve gli esiti.
- **Casello resta il giudice**: validazione Zod degli esiti, diff con lo stato dell'app, revisione e
  approvazione in console, issue. `schemas.ts`, `diff.ts`, `apply.ts`, `issues.ts` non cambiano.
- **I token dell'agente locale non sono misurati**: `tokens_used` resta 0 e `cost_usd` null (costo a
  carico dell'abbonamento dell'utente, non dell'API). La console lo mostra come "costo: abbonamento locale".
- **Autenticazione in due tappe** (vedi §6): prima token personale in header (collaudo da Claude Code e
  dalla scheda Code dell'app desktop), poi OAuth 2.1 con DCR/CIMD per il connettore custom di Claude
  Desktop/Cowork, che non accetta header statici (beta limitata).
- Avvio dell'analisi **dalla console** come oggi (scegliendo "Agente locale" tra i modelli); l'analisi
  resta in coda finché un agente locale la prende. Avviarla direttamente da Cowork è un passo successivo.

Obiettivo di questa spec: dalla console si lancia un'analisi di Mister con esecutore "Agente locale"; in
Cowork (o Claude Code) l'utente dice "esegui l'analisi in coda su Casello"; l'agente consegna le sei fasi;
in console compaiono gli elementi da approvare come per un'analisi cloud.

Fuori da questa spec: avvio dell'analisi da Cowork senza passare dalla console; run degli agenti operativi
(fase 1) su esecutore locale; più agenti locali in parallelo sulla stessa analisi; lettura efficiente del
percorso cloud (spec gemella).

## 2. Modello dei dati

- `providers`: nuova riga di registro `local_agent` (nome "Agente locale", protocollo `local_agent`,
  stato `managed`, origine `registry`, nessun indirizzo). `executorKindFor("local_agent")` restituisce
  `local_agent` invece di lanciare.
- `ai_accounts`: un account di sistema `user_id = null`, `provider = local_agent`, senza chiave, creato
  all'avvio da `ensureProviderRegistry` (come l'account di sistema del gateway); un solo `ai_models`
  collegato: `model_id = "local-agent"`, nome "Agente locale (connettore MCP)", prezzi null,
  `supports_tools = true`, `availability = available`. Così la tendina dei modelli della console lo offre
  senza una UI nuova e `analyses.ai_model_id` lo referenzia come ogni altro modello.
- `analyses`: nuove colonne
  - `executor` (`cloud` | `local`, not null, default `cloud`; derivato dal modello scelto all'avvio);
  - `lease_token_hash` (text, null), `lease_until` (timestamp, null), `lease_label` (text, null: nome
    dell'agente che l'ha presa, es. "Cowork sul Mac di Ivan");
  - `source_commit` (text, null): sha dichiarato dall'agente locale (vedi §4).
- `analysis_phase_results` (nuova): `analysis_id` → analyses (cascade), `phase` (text), `result`
  (jsonb, esito validato), `submitted_at`; unico (`analysis_id`, `phase`). Oggi l'esito di fase vive solo
  in memoria (`previous`) finché l'analisi finisce; con un agente esterno che consegna una fase alla
  volta, l'esito va persistito: è anche ciò che permette di riprendere dopo un riavvio dell'API.
- Tappa OAuth (§6): `oauth_clients` (`client_id`, `client_secret_hash` null per client pubblici,
  `redirect_uris` jsonb, `client_name`, `created_at`), `oauth_codes` (`code_hash`, `client_id`, `user_id`,
  `redirect_uri`, `code_challenge`, `scope`, `expires_at`, `used_at`), `oauth_tokens` (`access_hash`,
  `refresh_hash`, `client_id`, `user_id`, `scope`, `access_expires_at`, `refresh_expires_at`,
  `revoked_at`). Solo hash (SHA-256) a riposo: il valore in chiaro esiste solo nella risposta al client.

## 3. Stati e ciclo di vita

```
queued (executor=local) ──claim──▶ running (lease) ──6 esiti validi──▶ completed
   ▲                                   │
   └── lease scaduta (nessun heartbeat)─┘      abandon / errore irrecuperabile ──▶ failed
```

- `queued`: nessun processo server lavora sull'analisi; `run-analysis.ts` la salta (`executor = local`).
- **claim**: l'agente chiede il compito in coda; Casello imposta `running`, `phase = "map"` (o la prima
  fase senza esito), `lease_until = now + 15 min`, genera un `lease_token` (casuale, 32 byte) che l'agente
  deve ripresentare a ogni consegna e heartbeat. Una sola lease per analisi; una seconda richiesta di
  claim risponde "analisi già presa da <lease_label> fino alle <ora>".
- **heartbeat**: ogni consegna o `ping` rinnova `lease_until`. Un job (riusa lo scheduler già presente
  per il catalogo) riporta a `queued` le analisi locali con lease scaduta: la fase in corso si rifà, gli
  esiti già consegnati restano in `analysis_phase_results`.
- **submit**: esito della fase validato con `PHASE_SCHEMAS[phase]`; se non valido, risponde con le
  stesse `issues` Zod che oggi tornano al modello cloud (`MAX_ISSUES`, `MAX_ISSUE_CHARS`) e la fase resta
  aperta; non c'è limite di correzioni (il tetto è la durata dell'analisi, `maxMs`, come oggi). Se valido:
  salvataggio, `phaseItems` + INSERT in `analysis_items` con `diff` come oggi, `phase` avanza; dopo
  `evolution` → `completed`, `finished_at`.
- **abandon**: l'agente dichiara di non poter continuare (messaggio ≤ 300 caratteri) → `failed`, `error`.
- All'avvio dell'API: le analisi locali `running` NON vengono chiuse come fallite (differenza voluta
  rispetto alle cloud, che oggi diventano `interrupted`): tornano `queued` se la lease è scaduta, altrimenti
  restano `running` e l'agente continua.
- Una analisi attiva per app: l'indice unico parziale esistente vale anche qui.

## 4. Il server MCP

Trasporto **Streamable HTTP** sul percorso `/mcp` dell'API (dietro nginx come `/api`; nginx inoltra
anche `/mcp/` a `casello-api:3000`). Dipendenza nuova e giustificata: `@modelcontextprotocol/sdk`
(server + `StreamableHTTPServerTransport`; nella tappa 2 anche gli helper OAuth). Versione fissata e
più vecchia di `minimumReleaseAge`.

Strumenti (nomi in inglese, descrizioni in italiano, perché il modello le legge):

| strumento | input | output |
|---|---|---|
| `list_analyses` | — | analisi dell'utente in `queued`/`running` con esecutore locale: id, app, fasi consegnate, lease |
| `claim_analysis` | `analysisId`, `label` | `leaseToken`, `phase` corrente, scheda dell'app (nome, descrizione funzionale, `base_url`, repo GitHub e branch se `source_*` è GitHub, `openapi` presente sì/no), `expectedCommit` (null se ignoto) |
| `get_phase_instructions` | `analysisId`, `leaseToken` | per la fase corrente: `system` (= `SYSTEM_BASE`), `user` (= `phasePrompt(...)`, con esempio JSON e blocco `previous` come oggi), `schema` (JSON Schema derivato dallo Zod della fase, per correzioni locali), più il **dossier** e la **mappa** della spec gemella quando esistono |
| `read_openapi` | `analysisId`, `leaseToken`, `prefix?`, `offset?` | come `list_operations`/`read_operation` di oggi, perché l'OpenAPI può non stare nel clone |
| `submit_phase` | `analysisId`, `leaseToken`, `phase`, `result`, `sourceCommit?` | `{ ok: true, nextPhase }` oppure `{ ok: false, issues }` |
| `ping_analysis` | `analysisId`, `leaseToken` | rinnova la lease |
| `abandon_analysis` | `analysisId`, `leaseToken`, `reason` | — |

Regole:
- Ogni chiamata agisce **come l'utente autenticato** (§6) e passa da `isAllowed`; vede solo le analisi
  delle app che oggi può vedere dalla console.
- `phase` in `submit_phase` deve coincidere con la fase corrente (altrimenti 409 "fase attesa: X").
- `sourceCommit`: se l'app ha `source_*` GitHub e Casello conosce lo sha del branch (lo chiede a GitHub
  con il token di installazione, solo `metadata`), un commit diverso non blocca ma viene annotato nel log
  dell'analisi ("analizzato il commit X, atteso Y").
- Tutto ciò che arriva dall'agente è dato non attendibile: validato con Zod, mai interpretato come
  istruzione, mai in log oltre ai conteggi; stesse regole del contenuto del repository di oggi.
- Risposte in italiano, messaggi fissi (§8).

## 5. Skill per l'agente locale

Un file `docs/skills/casello-architetto-locale/SKILL.md` (da installare in Cowork/Claude Code come skill
dell'utente) con il procedimento: (1) `list_analyses` → scegli; (2) `claim_analysis` con un'etichetta;
(3) verifica di essere nel clone giusto e sul branch/commit atteso (`git rev-parse HEAD`); (4) per ogni
fase: `get_phase_instructions`, esplora con i propri strumenti (grep, lettura file, albero), scrivi
l'esito nel formato richiesto, `submit_phase`; se tornano `issues`, correggi e riconsegna; (5) `ping`
almeno ogni 10 minuti durante esplorazioni lunghe; (6) al termine riferisci all'utente il riepilogo che
Casello restituisce all'ultima consegna (conteggio tool/agenti/skill/issue proposti).
Raccomandazioni nella skill: non inventare endpoint non presenti nel codice; citare `evidence` con
percorso e riga come richiesto dagli schemi; non consegnare prima di aver letto davvero i file citati.

## 6. Autenticazione (due tappe)

**Tappa 1 — token personale (collaudo).** Pagina Account della console: "Token per agenti locali":
crea (nome, scadenza ≤ 90 giorni), mostra una volta sola, revoca. Tabella `api_tokens` (`user_id`,
`token_hash`, `name`, `expires_at`, `last_used_at`, `revoked_at`). Il middleware di `/mcp` accetta
`Authorization: Bearer <token>` e risolve l'utente. Claude Code lo usa con
`claude mcp add --transport http casello https://casello.fantamister.cloud/mcp --header "Authorization: Bearer …"`
(o `.mcp.json` nel progetto con `headers`); vale anche per la scheda Code dell'app desktop.

**Tappa 2 — OAuth 2.1 per il connettore custom.** Claude Desktop/Cowork/claude.ai si collegano ai
server MCP remoti solo senza autenticazione oppure con OAuth (DCR o CIMD); gli header statici sono in
beta per poche organizzazioni. Casello diventa authorization server minimo, riusando il login Google:
- `GET /.well-known/oauth-protected-resource` (`resource` = `https://casello.fantamister.cloud/mcp`,
  `authorization_servers` = [`https://casello.fantamister.cloud`]) e
  `GET /.well-known/oauth-authorization-server` (issuer, `authorization_endpoint`, `token_endpoint`,
  `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`,
  `token_endpoint_auth_methods_supported: ["none", "client_secret_post"]`,
  `client_id_metadata_document_supported: true`, `scopes_supported: ["architect", "offline_access"]`).
- `/mcp` senza token valido risponde **401** con
  `WWW-Authenticate: Bearer resource_metadata="https://casello.fantamister.cloud/.well-known/oauth-protected-resource"`.
- `POST /oauth/register` (DCR, RFC 7591, JSON): accetta solo `redirect_uris` tra
  `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` e loopback
  `http://localhost/callback` / `http://127.0.0.1/callback` con porta qualsiasi (Claude Code). CIMD:
  se `client_id` è un URL `https`, Casello scarica il documento (10 s, ≤ 64 KB, niente redirect) e usa i
  suoi `redirect_uris`.
- `GET /oauth/authorize`: richiede la sessione Google (altrimenti redirige al login con `next` =
  path interno validato, lo stesso meccanismo di T172b di Mister); pagina di consenso ("Claude vuole
  eseguire analisi dell'architetto per conto tuo"); emette un `code` (10 min, monouso) legato a
  `code_challenge` S256 e `redirect_uri`.
- `POST /oauth/token` (`application/x-www-form-urlencoded`): `authorization_code` con `code_verifier`;
  `refresh_token` con **rotazione** (il vecchio refresh è invalidato nella stessa risposta); errori RFC 6749
  (`invalid_grant` quando il refresh non vale più). Access token 1 ora, refresh 30 giorni. Risposta entro
  pochi secondi (Claude aspetta 10 s).
- Le chiamate di Claude arrivano dalla rete di Anthropic (`160.79.104.0/21`), non dal Mac dell'utente:
  nessuna regola di firewall da aggiungere (80/443 già aperte), ma nessuna assunzione sull'IP.
- Scope `architect` è l'unico; i token OAuth e i token personali passano dallo stesso middleware e
  producono lo stesso `userId`.

## 7. Console

- Tendina dei modelli dell'analisi: "Agente locale (connettore MCP)" sempre disponibile; avviandola, la
  stima dei costi dice "nessun costo API: l'analisi la esegue un agente sul tuo computer".
- Scheda analisi: stato "in attesa di un agente locale" / "in corso: <label>, lease fino alle <ora>" /
  fasi consegnate con data; pulsante "Rilascia" (azzera la lease, torna `queued`) e "Annulla" (→ `failed`).
- Pagina Account: sezione "Agenti locali" con i token personali (tappa 1) e le connessioni OAuth attive
  (tappa 2, con revoca). Istruzioni in pagina: come aggiungere il connettore in Claude Desktop
  (Settings → Connectors → Add custom connector → URL `https://casello.fantamister.cloud/mcp`) e in Claude
  Code.

## 8. Errori (in italiano, fissi)

"analisi non trovata o non tua", "analisi già presa da …", "lease scaduta: chiedi di nuovo il compito",
"fase attesa: …", "esito non valido: …" (seguito dalle issue), "token non valido o scaduto",
"consenso negato", "client OAuth non ammesso" (redirect URI fuori elenco).

## 9. Sicurezza

- Solo hash dei token a riposo; token personali mostrati una sola volta; nessun token in log.
- L'agente locale non ottiene mai segreti di servizio delle app, chiavi dei provider né il token di
  installazione GitHub: i suoi strumenti leggono solo analisi, istruzioni e OpenAPI.
- Rate limit su `/mcp`: 60 chiamate/minuto per utente; su `/oauth/token` 10/minuto per IP.
- Approvazione in console resta l'unico modo per rendere attivo un tool/agente/skill: l'esecutore
  locale non cambia il perimetro di "nulla si attiva senza approvazione".
- CORS: `/mcp` e `/oauth/*` non sono chiamati dal browser; nessuna origine ammessa.

## 10. Migrazione DB

`docs/migrations/2026-10-esecutore-locale.sql` (idempotente, una transazione): riga `local_agent` in
`providers`; colonne su `analyses`; tabelle `analysis_phase_results`, `api_tokens`; tabelle `oauth_*`
possono stare nella stessa migrazione (sono additive) anche se la tappa 2 arriva dopo. Nessuna parte
distruttiva.

## 11. Prove

- Unit: claim/lease/heartbeat/scadenza (orologio finto); `submit_phase` con esiti validi e non validi per
  tutte e sei le fasi (riuso degli esempi di `prompts.ts`); persistenza di `analysis_phase_results` e
  ripresa dopo riavvio.
- Integrazione: client MCP di prova (lo stesso SDK) che percorre list → claim → instructions → submit × 6;
  verifica che `analysis_items` e il diff coincidano con quelli di un'analisi cloud a parità di esiti.
- OAuth: discovery, DCR con redirect ammessi/non ammessi, PKCE S256 giusto/sbagliato, codice monouso,
  rotazione del refresh, 401 con `WWW-Authenticate` corretto.
- Collaudo reale: analisi di Mister da Claude Code con token personale (tappa 1); poi la stessa da Cowork
  con il connettore (tappa 2). Pronto quando entrambe arrivano a `completed` e la revisione in console
  mostra elementi sensati con `evidence` verificabili.

## 12. Ordine di consegna

1. Registro `local_agent`, colonne/tabelle, coda e lease, strumenti MCP con token personale (tappa 1),
   console minima (stato e token). → collaudo da Claude Code su Mister.
2. Skill per l'agente locale, rifinita sul collaudo.
3. OAuth 2.1 (tappa 2) e connettore custom in Claude Desktop/Cowork.
4. (dopo) avvio da Cowork senza console; agenti operativi su esecutore locale.

## 13. Note di verifica sul codice (28 ottobre 2026, `main` a 9958ea2)

- `ExecutorKind = "openai_compatible" | "local_agent"` ed `executorKindFor` stanno in
  `artifacts/api-server/src/lib/ai/executor.ts` (il percorso in §1 è abbreviato); `modelChat` rifiuta
  ogni `kind` diverso da `openai_compatible`, quindi il ramo locale non passa da lì.
- `MAX_ISSUES` 30 e `MAX_ISSUE_CHARS` 300 sono in `architect/phase-loop.ts`: oggi privati, vanno esportati
  per riusarli in `submit_phase`.
- Lo scheduler da riusare per la scadenza delle lease è `lib/catalog/scheduler.ts`.
- La tabella `api_tokens` non esiste: `lib/user-tokens.ts` è un'altra cosa (token GitHub dell'utente per
  le run in pausa, solo in memoria) e non va confuso con i token personali di §6.
- Dipendenza dalla spec gemella: `get_phase_instructions` usa mappa e dossier "quando esistono", quindi
  le due spec si possono consegnare in qualsiasi ordine.
