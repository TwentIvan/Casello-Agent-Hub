# Botcave come plugin di The Hub Up — design

Data: 2026-11-06. Stato: da approvare. Sottoprogetto 5 («interfaccia in The Hub Up») delle squadre.

## Obiettivo

The Hub Up (repository `TwentIvan/AbapCRM`) è il primo servizio collegato a Botcave **come plugin**:

- The Hub Up espone un **server MCP** con le azioni sul suo dominio (progetti, task, messaggi), così gli agenti e le squadre di
  Botcave possono lavorarci con i livelli d'azione di sempre;
- l'esperienza resta **dentro The Hub Up**, con il suo aspetto: dall'interno di un task si avvia e si segue la squadra di
  agenti (piano, coda da confermare, bollettino, messaggi al capo). The Hub Up mostra, Botcave lavora;
- nell'esperienza Botcave (console, Alfred) l'utente continua a vedere **tutti** i suoi servizi e tutti i progetti.

Fuori ambito in questa prima versione: analisi di Lucius e chat del piano dentro The Hub Up (si fanno in Botcave), un
meccanismo generale di plugin in The Hub Up per altri prodotti, organizzazioni di Botcave (sottoprogetto 2), sostituzione
dell'esecutore AI interno di The Hub Up (`ai-task-executor`, `ai_pending_actions`), che resta com'è.

## Cosa c'è oggi (punti di partenza)

- **The Hub Up**: monolite Express + React (wouter, TanStack Query, shadcn, Tailwind 3), Postgres/Drizzle, login con sessione
  (locale o Google), multi-tenant per organizzazione (`X-Organization-Id`, ruoli owner/admin/member/viewer), tema per
  organizzazione. Unità di lavoro: `tasks` (con `externalWorkItemId/Url/System` per DevOps/Jira) dentro `projects` di un
  `partner`. Ha già una «MCP Library» (client MCP verso server esterni) e una sua coda di approvazioni per l'esecutore interno.
  Non espone un server MCP e non ha un meccanismo di plugin.
- **Botcave**: app con `mcp_url` e segreto di servizio, strumenti MCP con livelli (`_meta["casello/level"]`), squadre legate a un
  lavoro di riferimento (`ref_app_id`, `ref_type`, `ref_id`, `ref_title`), coda «Da confermare», bollettino, server OAuth 2.1
  (oggi solo per `/mcp` e solo client pubblici dell'app Claude o di Claude Code).

## 1. Collegamento (OAuth, una volta per utente)

In The Hub Up, Account → «Botcave» → «Collega Botcave».

- **Botcave**: nuovo tipo di client OAuth **di prima parte e confidenziale**, dichiarato nella configurazione (variabile
  `OAUTH_PLUGIN_CLIENTS`, JSON: `client_id`, nome, `redirect_uri` esatto, hash SHA-256 del segreto). Codice di autorizzazione con
  PKCE e segreto del client al token endpoint. Ambiti `api:read api:write` (oltre a `mcp` già esistente); consenso con la pagina di
  sempre, che elenca gli ambiti. Token d'accesso `cap_…` (1 ora) e rinnovo `car_…` a rotazione, come il connettore: valgono su
  `/api` con gli ambiti per metodo (`requireAuth` li accetta accanto a `cas_…`), mai su `/mcp`. Le route `sessionOnly` restano
  vietate (403). Revoca da Account → «App collegate» (già esistente).
- **The Hub Up**: tabella `botcave_links` (utente, `botcave_user` (email e nome da `/api/auth/me`), token d'accesso e di rinnovo
  cifrati AES-256-GCM con `BOTCAVE_TOKEN_KEY`, scadenza, stato). Il server di The Hub Up rinnova da solo; un rinnovo rifiutato
  segna il collegamento «da ricollegare». Variabili: `BOTCAVE_URL`, `BOTCAVE_CLIENT_ID`, `BOTCAVE_CLIENT_SECRET`,
  `BOTCAVE_TOKEN_KEY`. Il browser non vede mai i token: tutte le chiamate a Botcave partono dal server di The Hub Up.

## 2. The Hub Up come app di Botcave (provisioning automatico, per organizzazione)

Dopo il collegamento, per ogni organizzazione di The Hub Up in cui l'utente è owner o admin, «Collega questa organizzazione»:

- The Hub Up crea un **token di servizio** legato all'organizzazione (`hubup_service_tokens`: hash, organizzazione, creato da,
  revocato) e lo usa come segreto di servizio;
- con il token OAuth dell'utente, The Hub Up crea (o aggiorna) in Botcave l'app «The Hub Up · <organizzazione>» con
  `mcp_url` = `<HUBUP_PUBLIC_URL>/mcp`, autenticazione di servizio `Authorization: Bearer`, segreto = token di servizio, slug
  `hubup-<orgId>`; poi chiama «Aggiorna strumenti» (`POST /api/apps/:id/mcp-tools/refresh`). Gli strumenti nuovi nascono `draft`:
  si attivano in Botcave (Officina) come sempre, oppure dal pulsante «Attiva gli strumenti di lettura» di The Hub Up (solo L0).
- `botcave_org_links` in The Hub Up ricorda organizzazione → `app_id` di Botcave. Scollegare revoca il token di servizio e
  disattiva l'app in Botcave (non la elimina: lo storico resta).

## 3. Server MCP di The Hub Up

Endpoint `POST /mcp` (Streamable HTTP stateless, solo POST, come quello di Botcave), autenticato dal token di servizio
dell'organizzazione: ogni chiamata lavora solo sui dati di quell'organizzazione (stesso filtro di `X-Organization-Id`).
Limiti: 60 chiamate/min per token, risposte ≤ 1 MiB, nessun dato di altre organizzazioni, nessun segreto (credenziali di
sistema, VPN, SAP) nei risultati. Livelli dichiarati con `_meta["casello/level"]` e `readOnlyHint`:

| Strumento | Livello | Cosa fa |
|---|---|---|
| `elenca_progetti` | L0 | progetti dell'organizzazione (id, nome, cliente, stato) |
| `leggi_progetto` | L0 | progetto con milestone e task aperti |
| `cerca_task` | L0 | task per testo, progetto, stato, assegnatario, work item esterno |
| `leggi_task` | L0 | task completo con commenti e messaggi collegati |
| `elenca_messaggi_task` | L0 | messaggi (email, chat, work item DevOps) legati a un task |
| `aggiungi_nota_interna` | L1 | nota interna sul task (non visibile al cliente) |
| `aggiorna_stato_task` | L1 | cambia lo stato del task |
| `registra_tempo` | L1 | voce di timesheet sul task per l'utente collegato |
| `crea_task` | L2 | nuovo task in un progetto |
| `commenta_cliente` | L2 | commento visibile al cliente o sul work item esterno (`destinatario`, `sintesi`) |

Gli L2 non si eseguono mai da soli: Botcave li mette in coda e li decide l'utente (anche da The Hub Up, §4).

## 4. L'esperienza dentro The Hub Up (modulo «Agenti»)

Voce di menu nella sezione «AI Tools»: **Agenti** (`/agents`), con lo stile di The Hub Up (shadcn, colori dell'organizzazione,
layout Sidebar + Header, testi tradotti con `t()`), non quello di Botcave. Visibile solo se l'organizzazione è collegata.

- **Nel task** (`/tasks/:id/edit`): riquadro «Squadra di agenti».
  - Senza squadra: «Avvia una squadra» con la scelta di un modello di squadra di Botcave (`GET /api/team-templates`) → crea
    l'istanza con `ref_app_id` = app dell'organizzazione, `ref_type` = `task`, `ref_id` = id del task, `ref_title` =
    «<progetto> · <titolo del task>» (`POST /api/team-instances`), poi «Attiva» (`POST …/activate`).
  - Con squadra: stato (LED dei colori di The Hub Up), piano con compiti ed esiti, «Scrivi al capo», voci in coda della
    squadra con Approva/Rifiuta (stesse route di Botcave; le voci che richiedono il token utente rimandano a Botcave), bollettino.
    Polling come la scheda squadra di Botcave.
- **Pagina Agenti**: tutte le squadre dell'organizzazione (istanze con `appId` dell'organizzazione), coda «Da confermare» filtrata
  sulle squadre dell'organizzazione, link «Apri in Botcave» per Lucius, modelli e skill.
- **Account → Botcave**: stato del collegamento, organizzazioni collegate, «Scollega».

Chiamate del server di The Hub Up verso Botcave: un client (`server/botcave-client.ts`) con timeout 15 s, nessun redirect,
errori di Botcave mostrati con il loro messaggio italiano, 401 → rinnovo, poi «ricollega Botcave».

## 5. L'esperienza in Botcave

Nessun cambio di interfaccia necessario: le app «The Hub Up · <org>» compaiono tra le App, le squadre tra le Squadre, le voci
nella coda, e Alfred le vede con tutti gli altri servizi (`squadre_stato`, `bollettino`, `coda_da_confermare`). Unica aggiunta:
nella scheda squadra, se `ref_type = task` e l'app è un plugin, il link «Apri in The Hub Up»
(`<HUBUP_PUBLIC_URL>/tasks/<ref_id>/edit`, salvato nell'app come `plugin_url_template`).

## 6. Sicurezza

- Token OAuth `cap_…` solo lato server di The Hub Up, cifrati; mai nei log; revocabili da entrambe le parti.
- Il token di servizio dell'organizzazione vale solo su `/mcp` di The Hub Up e solo per quell'organizzazione; in Botcave è il
  segreto di servizio cifrato dell'app (mai restituito).
- Gli strumenti MCP non restituiscono credenziali, password VPN/SAP né dati di altre organizzazioni.
- `commenta_cliente` e `crea_task` sono L2 e passano dalla coda.

## 7. Modifiche per repository

**Botcave** (PR 1, prima): client OAuth confidenziali di prima parte (`OAUTH_PLUGIN_CLIENTS`, segreto al token endpoint,
ambiti `api:read`/`api:write`), token `cap_…` accettati da `requireAuth` su `/api`, colonna `apps.plugin_url_template` e link
nella scheda squadra; migrazione additiva `docs/migrations/2026-11-plugin-hubup.sql` (colonne su `oauth_clients` per `kind
confidential` e hash del segreto, `oauth_grants.scopes`, `apps.plugin_url_template`). Test: flusso completo con un client
confidenziale finto, ambiti per metodo, `sessionOnly` rifiutato, revoca.

**The Hub Up** (PR 2, dopo il deploy di Botcave): server MCP (`server/mcp/`), token di servizio per organizzazione, client Botcave
e collegamento OAuth, provisioning dell'app, modulo «Agenti» (pagina, riquadro nel task, Account), tabelle `botcave_links`,
`botcave_org_links`, `hubup_service_tokens` con la sua migrazione in `migrations/`. Test con un Botcave finto.

## 8. Decisioni da confermare

1. Provisioning automatico dell'app per organizzazione (§2) invece di una configurazione a mano in Botcave.
2. Strumenti e livelli della tabella in §3 (in particolare `registra_tempo` L1 e `aggiorna_stato_task` L1).
3. Squadre solo sui task (`ref_type = task`); i progetti in una versione successiva.
4. Esecutore AI interno di The Hub Up lasciato com'è (nessuna fusione con Botcave in questa versione).

## Differenze dal codice

Dove il codice differisce da questa spec vale il codice.

- L'hash del segreto del client sta nella variabile `OAUTH_PLUGIN_CLIENTS` (`secretSha256`), non in colonne di `oauth_clients`: la
  migrazione non aggiunge colonne a quella tabella.
- `oauth_grants.scopes` esisteva già: la migrazione non lo tocca. Aggiunge solo il valore `plugin` all'enum `oauth_client_kind` e
  `apps.plugin_url_template`.
- Il tipo di client è `plugin`, non `confidential`.
- Il link al servizio (`ref.url`) vale solo per `ref.type = task`; per gli altri tipi è null.
- La CSP `form-action` della pagina di consenso include le origini di ritorno dei plugin configurati, perché Chrome controlla anche i
  redirect che seguono l'invio del form.
- Un plugin tolto dalla configurazione resta come riga in `oauth_clients` ma non vale più: niente consenso, niente scambio o rinnovo di
  token, i `cap_…` già emessi sono rifiutati.
- La pagina di consenso del plugin ha un testo dedicato che descrive i permessi a parole (non elenca gli ambiti) e non mostra l'host
  del ritorno.
- Il link «Apri in …» compare per qualunque app che abbia `plugin_url_template` (non solo per le app plugin), sempre solo con
  `ref.type = task`.
