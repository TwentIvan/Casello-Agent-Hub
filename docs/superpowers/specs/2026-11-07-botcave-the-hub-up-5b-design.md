# Botcave · The Hub Up come App ben descritta (sottoprogetto 5b) e proposta per 5c

Data: 7 novembre 2026. Stato: bozza da approvare.

Fa seguito al sottoprogetto 5a (`2026-11-06-botcave-plugin-incorporabile-design.md`): The Hub Up incorpora già il pannello di
Botcave. Con 5b The Hub Up diventa un'App che gli agenti di Botcave possono davvero usare. 5c sostituisce gli agenti AI interni di
The Hub Up con agenti di Botcave.

## 1. Obiettivo e criteri di fine

- **5b è finito quando:**
  - l'App «The Hub Up» in Botcave ha sorgenti e connessione verificate, cioè una run reale legge e scrive su The Hub Up;
  - una nuova analisi di Lucius è stata completata e rivista con Ivan;
  - questo documento contiene l'inventario degli agenti AI di The Hub Up e la proposta per 5c, approvato da Ivan.
- **Obiettivo di 5c (deciso):** tutta l'AI di The Hub Up passa a Botcave, un agente alla volta. Alla fine The Hub Up non chiama
  modelli e non tiene chiavi AI: resta dati, interfaccia e strumenti. Agenti, modelli, costi, tetti e approvazioni stanno in Botcave.
- **Fuori ambito:**
  - organizzazioni e policy dei dati di Botcave (sottoprogetto 2);
  - altre app ospiti;
  - modifiche al pannello incorporabile.

## 2. Situazione al 7 novembre 2026

### 2.1 L'App in Botcave (produzione, id 3)

- **Identità e indirizzi:** nome «The Hub Up», slug `the-hub-up`, `base_url` `https://hubup.fantamister.cloud/`, `internal_base_url`
  null, stato `active`.
- **Sorgente:** GitHub tramite l'App sul repository `TwentIvan/AbapCrm` (installazione 175408251), ramo predefinito. Nessun OpenAPI,
  nessun `mcp_url`, nessuna descrizione funzionale.
- **Autenticazione:** utente `Authorization` + `Bearer`; di servizio assente (`serviceSecretSet: false`).
- **Tool:** 38 tool `http` attivi con identità `user`. Sono letture L0 e scritture L2 su progetti, milestone, commenti, task, partner,
  contatti, trattative, offerte e ordini, ore e timer, calendario, messaggi, proposte e resource planner.
- **Agente generale:** «The Hub Up – generale», in `draft`.
- **Analisi 21:** eseguita in locale il 28 ottobre e completata. Approvati solo i 38 tool. Restano in sospeso 4 endpoint, 4 agenti
  («Assistente The Hub Up», «Project manager», «Assistente commerciale», «Smistatore della posta»), 6 skill, 14 voci di
  completamento e 13 di evoluzione. Uno degli endpoint proposti era proprio «Token API personale per agenti».

### 2.2 Come si accede a The Hub Up (repository AbapCrm)

- **Server MCP:** **non esiste.** The Hub Up è soltanto *client* MCP (`server/mcp-client.ts`). L'unico server è quello finto di test
  in `scripts/test-mcp-server.ts`.
- **OpenAPI:** **non esiste.** Le route sono scritte a mano in `server/routes.ts`, circa 12 800 righe.
- **Autenticazione:**
  - sessione con cookie (passport-local e Google, `server/auth.ts`);
  - organizzazione indicata dall'header `x-organization-id`: il middleware di `routes.ts` (~500) la sostituisce con quella «Personal»
    se non appartiene all'utente;
  - token companion (`hubup_enroll_tokens`), valido solo su `/api/hubup/jobs/*`;
  - `x-api-key` uguale a `SAP_API_KEY`, valido solo su `POST /api/sap-transport`.
  - **Non c'è un token per client esterni:** i 38 tool di Botcave oggi non possono autenticarsi.
- **Integrazione Botcave (5a):**
  - lo script del pannello sta in `client/index.html`;
  - `client/src/lib/botcave.ts` imposta il contesto a ogni cambio di pagina e per progetti, task e messaggi (il work item viene da
    `externalMetadata.workItemId`).

## 3. Inventario degli agenti AI di The Hub Up

Infrastruttura comune: `server/ai-gateway.ts` (`aiGateway.complete`).

- **Provider:**
  - `openai/` usa `OPENAI_API_KEY`;
  - `anthropic/` usa `ANTHROPIC_API_KEY`, ma in questo ramo gli strumenti vengono scartati;
  - `google/` e `deepseek/` passano solo dal proxy `AI_GATEWAY_BASE_URL`.
- **Modello predefinito**, nell'ordine: `organizations.settings.aiDefaultModelKey` → `AI_DEFAULT_MODEL_KEY` → `openai/gpt-5`.
- **Costi:** dalle tabelle `ai_models` e `ai_providers`. Non ci sono embedding.

| # | Agente | Dove | Avvio | Input | Output | Conferma umana | Stato |
|---|---|---|---|---|---|---|---|
| 1 | **Classificazione email** (`AIService.analyzeMessage`) | `server/ai-service.ts:50`; `POST /api/messages/:id/analyze`, `…/apply-suggestion` | Sincronizzazione IMAP (`imap-service.ts:499`) | Email, progetti, task, partner | `messages.projectId/taskId/partnerId`, `confidenceScore` | Nessuna: con confidenza ≥ 0,7 collega da sola | Attiva solo da IMAP. Le route manuali non passano l'organizzazione e restituiscono `[]` (in pratica codice morto) |
| 2 | **Agente di progetto da email** (`analyzeMessageForProject`) | `server/ai-project-agent.ts:257`; `POST /api/messages/:id/analyze-project`, `/api/proposals*` | Pulsante «Analizza progetto» con scelta del modello | Email con allegati Excel/CSV/TXT, entità CRM, `ai_learning_patterns`, calendari, sistemi SAP, VPN, catalogo MCP | `proposals` (pending): partner, contatti, progetto e sottoprogetti, task con `aiSpec`, sistemi SAP, VPN, workflow | «Applica» (`POST /api/proposals/:id/apply`) crea le entità e scrive `ai_learning_patterns`; «Rifiuta» | **Attiva**: è la funzione centrale |
| 3 | **Discussione della proposta** e sintesi della decisione | `routes.ts:5460-5658`; `/api/proposals/:id/discussions`, `…/finalize-decision` | Chat nella pagina Proposte | Proposta e cronologia | `proposal_discussions`, eventuale `<updated_proposal>` | Resta «Applica» | **Attiva** |
| 4 | **THU AI**, esecutore dei task (`executeTaskWithAI`) | `server/ai-task-executor.ts:937` (ciclo MCP 1348-1600, `MCP_MAX_ITER=8`); `/api/ai-task-executor/*`, `/api/executions/:id/*` | Dialogo THU AI su un task | Task, progetto, work item DevOps con immagini, messaggi, commenti, trasporti SAP, `ai_abap_patterns`, context pack | `ai_task_executions` (analisi e file generati), `ai_abap_patterns`, `audit_logs` | Le scritture MCP vanno in `ai_pending_actions` (`awaiting_approval`). Niente scritture su PRD né con readOnly. Tetto `budgetCapEur` | **Attiva**. Agisce su **SAP** tramite i server MCP configurati (credenziali da `sap_systems`, `system_credentials`, `vpn_systems`). Lettura o scrittura decisa con una regex su nome e descrizione, ignorando `readOnlyHint` |
| 5 | **Chat THU AI** con immagini | `POST /api/ai-task-executor/chat` (`routes.ts:10548`) | Dialogo THU AI | Esecuzione e fino a 5 immagini del work item | Solo testo | — | **Attiva**. Modello con visione, ripiego `openai/gpt-4o` |
| 6 | **Aggiornamento del brief** (context maintainer) | `server/context-maintainer.ts` | Dopo ogni esecuzione di THU AI, al massimo una volta ogni 10 minuti per progetto | Esecuzione e brief attuale | `context_packs` | Nessuna | **Attivo** in background, modello `gpt-4o-mini` |
| 7 | **Documentazione dei trasporti** (`generateDocumentation`) | `ai-service.ts:236`; `POST /api/intervention-documents/generate` | — | Cofile del trasporto | `intervention_documents` | — | **Codice morto**: nessun chiamante |

**Non sono AI**, anche se i nomi lo fanno pensare:
- catalogo delle skill e planner (`skill-engine.ts`);
- workflow: solo definizioni, nessun motore; `EventBus` senza sottoscrittori;
- mappatura MCP «risolte via AI»: è deterministica;
- stima dei costi dei task;
- pagine «Modelli AI», «AI Analytics» e «Libreria MCP», che sono configurazione.

## 4. Sottoprogetto 5b

### 4.1 Tappa 1: token API in The Hub Up (repository AbapCrm)

- **Tabella `api_tokens`:**
  - colonne `id`, `user_id`, `organization_id`, `name`, `token_hash` (SHA-256), `prefix`, `created_at`, `expires_at`, `revoked_at`,
    `last_used_at`;
  - token con prefisso `thu_`, mostrato una volta sola;
  - scadenza predefinita 365 giorni.
- **Gestione:** creazione, elenco e revoca dalla pagina account di The Hub Up, **solo con la sessione**. Con un token queste route
  rispondono 403.
- **Middleware**, prima dei controlli `req.isAuthenticated()` e del middleware dell'organizzazione:
  - con `Authorization: Bearer thu_…`:
    - conta solo il token, mai il cookie;
    - imposta utente e organizzazione del token (ignora `x-organization-id`);
    - verifica che l'utente appartenga ancora all'organizzazione;
  - token sconosciuto, revocato o scaduto → 401;
  - con un header `Authorization` che non è `Bearer thu_…` resta il comportamento attuale (il token companion continua a funzionare
    sulle sue route).
- **Route escluse con un token** (403), elenco preciso nel piano:
  - gestione dei token;
  - login e utenti;
  - organizzazioni e appartenenze;
  - credenziali e connessioni: `/api/sap-systems/:id/credentials*`, `/api/vpn*`, `/api/vpn-credentials*`, credenziali di sistema;
  - configurazione AI e MCP: `/api/ai/*`, `/api/mcp/configs*`;
  - enroll del companion.
- **Limiti e log:** 120 richieste al minuto per token. Nei log mai token né hash.
- **Migrazione:** additiva, secondo le regole del repository AbapCrm.

### 4.2 Configurazione dell'App in Botcave

Si fa dalla console, previa conferma di Ivan:
- `serviceAuth` = `Authorization` + `Bearer`;
- come segreto di servizio, un token `thu_…` di Ivan sull'organizzazione di lavoro;
- i 38 tool passano all'identità `service`, così li possono usare anche i ruoli delle squadre, che accettano solo l'identità di servizio;
- descrizione funzionale come in 4.3.

**Prova:**
- una run dell'agente generale che elenca i progetti (L0);
- una scrittura L2, per esempio un commento, che deve finire in «Da confermare» ed essere eseguita una volta sola all'approvazione.

### 4.3 Descrizione funzionale e nuova analisi

- **Descrizione funzionale** (`functionalDescription`, testo approvato da Ivan prima del salvataggio):
  - dominio ed entità di The Hub Up;
  - autenticazione con `thu_…`;
  - l'inventario della §3;
  - la richiesta a Lucius di proporre:
    - **un agente Botcave per ciascuna funzione 1-6**, non agenti generici;
    - **i tool che mancano** perché quegli agenti lavorino da fuori (vedi §5.2).
- **Analisi nuova:** eseguita in locale da Claude Code con la skill `casello-architetto-locale`, quindi senza costo AI in Botcave.
  Sorgenti: GitHub più descrizione. Parte **dopo** le tappe 4.1 e 4.2, così Lucius trova la connessione funzionante. Le voci in
  sospeso dell'analisi 21 vengono superate da questa.
- **Revisione con Ivan**, a capitoli:
  1. tool: livello, identità, tool da disattivare;
  2. agenti e skill: il criterio è la copertura delle funzioni 1-6;
  3. endpoint mancanti: diventano issue su AbapCrm solo su decisione di Ivan;
  4. completamento ed evoluzione: le voci non pertinenti a 5c si scartano.
- L'esito si riporta nella §6.

## 5. Proposta per 5c

### 5.1 Collegamento

- **The Hub Up → Botcave:**
  - The Hub Up ha `BOTCAVE_URL` e un token Botcave `cas_…` con ambito `api:write` (variabili d'ambiente del server);
  - una configurazione per funzione indica l'id dell'agente Botcave che la svolge;
  - l'avvio è `POST /api/agents/:id/runs` con un input testuale (tipo e id dell'oggetto, istruzione);
  - The Hub Up interroga `GET /api/runs/:id` fino alla fine e mostra l'avanzamento nella sua pagina.
- **Botcave → The Hub Up:** l'agente legge e scrive con i tool dell'App (identità `service`). Le azioni L2 vanno in «Da confermare»,
  visibile anche dal pannello incorporato.
- **SAP:** passa dal **server MCP di The Hub Up** (`/mcp`, tappa 2, dentro 5c):
  - espone gli strumenti del CRM e rilancia gli strumenti SAP dei server configurati, con credenziali e regole che restano in The Hub Up;
  - livelli dichiarati con `_meta["casello/level"]`: scritture SAP = L2, scritture su PRD o su sistemi readOnly = L3 (mai offerte al
    modello);
  - in Botcave l'App riceve `mcp_url` e «Aggiorna strumenti».
- **Costi:** stanno in Botcave (paga il proprietario dell'account del modello), con i tetti per agente, modello, account e utente.

### 5.2 Migrazione agente per agente

Ogni funzione ha in The Hub Up un interruttore «interno | Botcave». Si prova, si confrontano i risultati, poi si toglie il codice
interno.

| Ordine | Funzione | Agente Botcave | Tool o endpoint nuovi in The Hub Up |
|---|---|---|---|
| 1 | 6 · Brief | «Curatore del brief», avviato dopo ogni esecuzione (il limite di 10 minuti resta in The Hub Up) | leggi/scrivi `context_pack` (L1) |
| 2 | 1 · Classificazione email | «Smistatore della posta», avviato dalla sincronizzazione IMAP. Il collegamento automatico è reversibile: L1 | `suggest_message_link`, `link_message` (L1) |
| 3 | 2 · Agente di progetto | «Analista di progetto» sul pulsante «Analizza progetto»: crea la proposta senza applicarla. La decisione resta nella pagina Proposte; `apply_proposal` (L2) permette di approvarla anche da «Da confermare» | `create_proposal` (L1), lettura degli allegati del messaggio |
| 3 | 3 · Discussione | Ogni messaggio della chat avvia una run dello stesso agente con la cronologia nell'input | `update_proposal` (L1) |
| 4 | — | Server MCP di The Hub Up (tappa 2) | `/mcp` |
| 5 | 4/5 · THU AI | «Esecutore ABAP» con gli strumenti MCP di The Hub Up. Le approvazioni passano da `ai_pending_actions` alla coda di Botcave | `record_execution` (analisi e file generati) |
| — | 7 · Documentazione dei trasporti | Nessuno: codice morto da togliere | — |

**Alla fine** si tolgono da The Hub Up:
- gateway AI, chiavi e proxy;
- pagine «Modelli AI» e «AI Analytics», perché la spesa si vede in Botcave;
- `ai_pending_actions`;
- i dialoghi THU AI, sostituiti dall'avvio e dalla visione della run.

`ai_learning_patterns` e `ai_abap_patterns` diventano skill o memoria in Botcave: da decidere nella spec di 5c.

### 5.3 Lacune di Botcave da verificare nella spec di 5c

1. **Input con immagini:** le run accettano solo testo; la chat di THU AI usa le immagini dei work item.
2. **Limite delle run:** `POST /api/agents/:id/runs` ha 10 run al minuto per IP, che una sincronizzazione IMAP con molte email supera.
   Servono un limite per token oppure una coda lato The Hub Up.
3. **Limiti di una run:** 8 giri e 120 s possono non bastare per generare codice ABAP. Le alternative sono limiti per agente o un
   compito di squadra.
4. **Risultato strutturato:** l'output di una run è testo. Le funzioni che devono restituire dati (classificazione, proposta) li
   scrivono con i tool in The Hub Up, non nell'output.

## 6. Esito della revisione dell'analisi

Da compilare dopo la revisione (§4.3): tool approvati e modificati, agenti e skill approvati con la funzione che coprono, endpoint
mancanti con le eventuali issue.

## 7. Rischi

- **Un token di servizio con i permessi di Ivan:** tutte le azioni degli agenti risultano fatte da lui in The Hub Up. Si mitiga con
  l'esclusione delle route sensibili, il limite per token e le scritture L2 in coda. La proprietà per organizzazione è nel
  sottoprogetto 2.
- **`routes.ts` molto grande e controlli di autenticazione ripetuti route per route:** il middleware deve agire prima di tutti, senza
  toccare le singole route.
- **Doppia superficie di approvazione durante la migrazione** (pagina Proposte e «Da confermare»): l'interruttore per funzione evita
  di averle attive tutte e due sulla stessa funzione.
