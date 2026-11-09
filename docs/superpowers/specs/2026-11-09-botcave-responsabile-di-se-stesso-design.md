# Botcave · Responsabile di prodotto di Botcave stesso

Data: 9 novembre 2026. Stato: in revisione.

Botcave tratta sé stesso come una delle sue app: l'agente `general` dell'App «Casello» (id 4) diventa il Responsabile di prodotto
di Botcave, legge e propone modifiche su Botcave partendo da richieste in linguaggio naturale, con ogni scrittura in «Da confermare».

## 1. Stato attuale (letto in produzione il 9 novembre 2026)

- App 4 «Casello» (slug `casello`), creata il 28 ottobre, `base_url` `https://casello.fantamister.cloud/`, nessun `internal_base_url`,
  autenticazione utente `Authorization` `Bearer`, **nessuna autenticazione di servizio né segreto**, descrizione funzionale vuota,
  sorgente GitHub `TwentIvan/Casello-Agent-Hub`, un'analisi (22, completata).
- Agenti: 5 «Casello – generale» (`general`, `confirm_writes` vero), 6 «Supervisore delle run», 7 «Revisore dell'architetto»,
  8 «Configuratore degli agenti» (`area`, `confirm_writes` falso); tutti con il modello 85 (`gemini-3.1-flash-lite`). Nessuna run, mai.
- 23 tool, tutti `http`, identità `user`, attivi: 14 L0 e 9 L2 su app, agenti, run, analisi e modelli AI.
- Problemi:
  1. identità `user` senza segreto di servizio: una run funziona solo con un «Token di prova» incollato a mano; inneschi e `proponi`
     accettano solo tool `service`;
  2. catalogo fermo al 28 ottobre: mancano squadre, coda, skill, modelli di squadra, inneschi; `resume_run` punta a
     `POST /api/runs/{id}/resume`, che non esiste più;
  3. prompt con il nome «Casello» e senza descrizione funzionale;
  4. **lacuna di sicurezza**: un segreto di servizio con `api:write` permette anche le route che decidono al posto dell'utente
     (per esempio `POST /api/pending-actions/{n}/approve`). Basta un tool definito per sbaglio, o un agente di area con un tool L1 e la
     conferma delle scritture spenta, perché un agente approvi da solo le azioni in coda.

## 2. Decisioni prese con Ivan

| Tema | Decisione |
|------|-----------|
| Credenziale degli agenti | Token personale `cas_…` con un ambito nuovo `agent`, inserito da Ivan come segreto di servizio dell'App 4 |
| Decisioni dell'utente | L'ambito `agent` non le può prendere: il server lo rifiuta, qualunque sia il tool |
| Catalogo | Scritto a mano da `openapi.yaml`, in un file JSON del repository rivisto da Ivan; niente nuova analisi dell'architetto |
| Identità dei tool | Tutti `service` |
| Configurazione in produzione | Dopo il merge, un passo alla volta con la conferma di Ivan |

## 3. Obiettivo, ambito e criteri di fine

- **Obiettivo:** dalla console (lancio di una run dell'agente 5) Ivan chiede in italiano «quali run sono fallite oggi e perché»,
  «crea un agente di area per X», «prepara una squadra per il WI 1174»; il Responsabile legge con i tool L0 e propone le scritture,
  anche come proposta multipla (`proponi`), in «Da confermare».
- **Fuori ambito:** Alfred o Lucius che avviano run del Responsabile; tool sulle route riservate al login, sulle chiavi AI, sui token,
  su Alfred, memorie e chat dei personaggi; eliminazioni; modifica delle app (PATCH porta indirizzi e segreti); allegati (corpo binario);
  importazione automatica dei tool da OpenAPI; un server MCP di Botcave per l'App 4.
- **Fatto quando:** codice in produzione, App 4 configurata (§6), prova reale riuscita (§7.3).

## 4. Ambito `agent` dei token personali

- `TOKEN_SCOPES` e `PERSONAL_TOKEN_SCOPES` (`lib/api-tokens.ts`) guadagnano `agent`. È **esclusivo**: un token con `agent` e un altro
  ambito → 400 «l'ambito agent non si combina con altri ambiti». Nessuna migrazione (`api_tokens.scopes` è `text[]`).
- `hasScopeFor` (`lib/auth.ts`): con `agent`
  - GET e HEAD: ammessi;
  - gli altri metodi: ammessi, salvo le **route di decisione** (`AGENT_DENIED_ROUTES`, metodo + percorso relativo a `/api`):
    - `POST /pending-actions/:number/approve`, `POST /pending-actions/:number/reject` (coda delle conferme);
    - `POST /plan-proposals/:id/decision`, `POST /team-chat-proposals/:id/decision`, `POST /character-proposals/:id/decision` (schede);
    - `PATCH /analysis-items/:id` (revisione dell'architetto: «nulla si attiva senza approvazione nella console»);
    - `PUT /team-instances/:id/plan` (la correzione dell'utente scrive un PLAN già approvato);
    - `POST /team-instances/:id/plan/manual-actions/:actionId/done` (segnare «Fatto» un'azione manuale è una dichiarazione dell'utente).

    Il confronto dei percorsi non distingue le maiuscole (i router di Express non le distinguono).

    Su queste → 403 «il token non ha l'ambito per questa operazione» (`TOKEN_MESSAGES.scope`).
- Le route `sessionOnly` restano 403 come per ogni token. Su `/mcp` `agent` non vale (401, manca `mcp`): gli strumenti `approva` e
  `rifiuta` del centralino restano fuori. Limite: lo stesso di ogni token personale (120/min per token; 60/min per le run).
- OpenAPI: `ApiTokenScope` con `agent`, codegen. Console (Account → «Token personali»): casella «Agente di Botcave (segreto di servizio)»
  con la spiegazione «legge e scrive su Botcave, ma non approva né rifiuta nulla»; selezionarla toglie le altre e viceversa.
- CLAUDE.md, sezione "Token personali su `/api`": l'ambito nuovo e la registrazione di Botcave come App di sé stesso aggiornata.

## 5. Catalogo dei tool

File `docs/botcave-self/catalogo-tool.json`: un elenco nella forma di `POST /api/apps/:id/tools` (name, description, kind `http`,
identity `service`, level, status, paramsSchema, definition con `method`, `path`, `paramLocations`, `responseFields` dove servono a
contenere la risposta), più `replaces` facoltativo con il nome di un tool esistente dell'App 4 da aggiornare al posto di crearne uno.

### 5.1 Letture (L0)

App e agenti: `list_apps`, `get_app_overview`, `list_app_tools`, `list_agents`, `get_agent`, `list_agent_skills`.
Inneschi: `list_agent_triggers`, `get_trigger`, `list_trigger_runs`, `test_trigger` (`POST /triggers/:id/test`: non scrive nulla).
Run: `list_runs`, `get_run`, `get_run_steps`. Cruscotto e spesa: `get_dashboard_stats`, `get_budget`.
Architetto e piano: `list_app_analyses`, `get_analysis`, `get_analysis_issues`, `get_app_plan`.
Skill: `list_skills`, `get_skill`, `list_skill_versions`, `get_skill_version`.
Modelli di squadra: `list_team_templates`, `get_team_template`.
Squadre: `list_team_instances`, `get_team_instance`, `get_team_plan`, `list_team_tasks`, `get_team_task`, `list_team_turns`,
`list_team_events`, `get_team_updates`.
Coda: `list_pending_actions`, `get_pending_action`.
Modelli AI: `list_ai_models`, `search_model_catalog`, `get_catalog_status`.

### 5.2 Scritture

| Tool | Route | Livello |
|------|-------|---------|
| `create_area_agent` | `POST /agents` | L2 |
| `update_agent` | `PATCH /agents/:id` | L2 |
| `set_agent_tools` | `PUT /agents/:id/tools` | L2 |
| `trigger_run` | `POST /agents/:id/runs` | L2 |
| `cancel_run` | `POST /runs/:id/cancel` | L1 |
| `create_app_tool` | `POST /apps/:id/tools` (nasce `draft`) | L2 |
| `update_app_tool` | `PATCH /apps/:id/tools/:toolId` | L2 |
| `refresh_mcp_tools` | `POST /apps/:id/mcp-tools/refresh` | L2 |
| `create_trigger` | `POST /agents/:id/triggers` (nasce in pausa) | L1 |
| `pause_trigger` | `POST /triggers/:id/pause` | L1 |
| `resume_trigger` | `POST /triggers/:id/resume` | L2 |
| `start_analysis` | `POST /apps/:id/analyses` | L2 |
| `cancel_analysis` | `POST /analyses/:id/cancel` | L1 |
| `create_plan_issues` | `POST /apps/:id/plan/issues` | L2 |
| `create_skill` | `POST /skills` | L2 |
| `update_skill` | `PATCH /skills/:code` | L2 |
| `deprecate_skill` | `POST /skills/:code/deprecate` | L2 |
| `create_team_template` | `POST /team-templates` | L2 |
| `update_team_template` | `PUT /team-templates/:id` | L2 |
| `create_team_instance` | `POST /team-instances` | L2 |
| `update_team_instance` | `PUT /team-instances/:id` | L2 |
| `apply_team_updates` | `POST /team-instances/:id/updates/apply` | L2 |
| `activate_team` | `POST /team-instances/:id/activate` | L2 |
| `close_team` | `POST /team-instances/:id/close` | L2 |
| `send_message_to_lead` | `POST /team-instances/:id/messages` | L2 |
| `set_team_budget` | `PUT /team-instances/:id/budget` | L2 |
| `refresh_model_catalog` | `POST /catalog/refresh` | L2 |

Per il Responsabile le L1 vanno comunque in coda (`confirm_writes`); per gli agenti di area sono le sole scritture eseguite senza
conferma, scelte perché fermano qualcosa o creano qualcosa di spento.

### 5.3 Esclusi

Route `sessionOnly` (token, account AI, prezzi e tetti personali, OAuth, nodi, impostazioni dei personaggi e di Alfred, segreti dei
webhook); route di decisione (§4); `/node/*`, `/alfred/*`, `/embed/*`, `/hooks/*`; chat del piano, di squadra e dei personaggi e
memorie (avvierebbero chiamate a modelli dentro una run); allegati; `DELETE` di ogni tipo; `POST|PATCH /apps`; `PUT /apps/:id/agent-models`;
`/github/*`; stima dei costi.

### 5.4 Tool esistenti

I 23 tool restano (id stabili, collegamenti degli agenti di area intatti): quelli con lo stesso nome nel catalogo si aggiornano
(identità `service`, descrizione, schema, livello); `resume_run` (route sparita) e `review_analysis_item` (route di decisione) diventano
`disabled`, mai eliminati.

### 5.5 Controllo automatico del catalogo

Test dell'API (`test/botcave-self-catalog.test.ts`) che legge il file e verifica, per ogni tool:
- nome, definizione e schema validi con le funzioni di `lib/tools/definition.ts` (`TOOL_NAME`, `parseDefinition`, `checkParamsSchema`, `checkPathPlaceholders`);
- metodo e percorso presenti in `openapi.yaml`;
- identità `service`, nessun livello L0 su un metodo diverso da GET salvo `test_trigger`;
- la route non è tra quelle di decisione (`AGENT_DENIED_ROUTES`) né tra quelle `sessionOnly` né tra gli esclusi della §5.3;
- nomi unici.

## 6. Configurazione in produzione (dopo il merge, un passo alla volta con la conferma di Ivan)

1. Ivan crea in Account il token «Botcave · Responsabile» con l'ambito `agent` (scadenza 90 giorni, il massimo dei token personali).
2. App 4: `internal_base_url` `http://localhost:3000` (l'API chiama sé stessa nello stesso container, senza passare da Traefik e nginx;
   ripiego `http://casello-api:3000`), autenticazione di servizio `Authorization` `Bearer`; Ivan incolla il token come segreto.
3. Catalogo: creazione e aggiornamento dei tool dalla console, con `fetch` nella pagina e la sessione di Ivan, dopo aver mostrato il
   diff rispetto ai 23 tool attuali.
4. Descrizione funzionale (≤ 12 000 caratteri), scritta da Ivan o proposta in chat: cosa è Botcave, oggetti (App, agenti, tool e livelli,
   run, coda, squadre e PLAN, skill, modelli di squadra, inneschi, analisi e piano, modelli AI e tetti), regole (non decide mai al posto
   dell'utente, scritture in coda, proposte multiple per azioni collegate, nessun segreto).
5. Agente 5: nome «Responsabile di prodotto», prompt nuovo nello stile di quello di The Hub Up (agente 4). Agenti 6, 7, 8: `confirm_writes`
   acceso, collegamenti ai tool rivisti.

## 7. Prove

1. Test dell'API: `hasScopeFor` con `agent` su GET, POST qualsiasi e su ognuna delle route di decisione; creazione del token (esclusività,
   400); una route di decisione vera chiamata con un token `agent` → 403; `approva` su `/mcp` con un token `agent` → 401.
2. Test del catalogo (§5.5). Typecheck e test di API e console verdi.
3. Prova reale dopo la configurazione: una run dell'agente 5 «quali run sono fallite questa settimana?» (solo letture); una run
   «crea un agente di area Revisore dei costi per l'App 4 in bozza» → una voce in «Da confermare», approvata da Ivan, agente creato.
