# Casello: agenti operativi, catalogo MCP e agente architetto

- Data: 2026-10-25
- Stato: design approvato in conversazione, spec in revisione
- Ambito: primo sottoprogetto dell'evoluzione di Casello (agenti che agiscono davvero + architetto).
  Widget nelle app e interazione vocale sono progetti successivi con spec propria (vedi §11).

## 1. Obiettivo

Oggi gli agenti di Casello rispondono solo con il modello: gli "strumenti" sono testo nel prompt e
nessuno li chiama. La prova su Fantamister lo ha mostrato: l'agente non può leggere la rosa e quindi
non può consigliare una formazione.

Vogliamo che:

1. per ogni app esista un **catalogo di tool eseguibili** (un MCP) che Casello usa per agire sull'app,
   per conto dell'utente o con un account di servizio;
2. un **agente architetto** studi l'app (codice, API esposte, descrizione funzionale), proponga il
   catalogo, un **agente generale** che conosce tutta l'app, **agenti di area** per le diverse zone
   della UI, le loro **skill**, gli endpoint mancanti e, in un capitolo a parte, **miglioramenti
   dell'app stessa**;
3. gli agenti si usino in **conversazioni** con streaming, interruzione e integrazione di informazioni
   durante la risposta, conferme per le azioni importanti: la base per il widget nelle app e per la
   voce.

Criterio di successo complessivo: su Fantamister un utente chiede "suggerisci la formazione per
domenica" e l'agente legge i dati veri dell'app, risponde e, se richiesto, prepara la formazione
chiedendo conferma prima di salvarla.

## 2. Decisioni prese

| Tema | Decisione |
|---|---|
| Cosa studia l'architetto | Codice sorgente quando c'è; altrimenti API esposte (OpenAPI) e descrizione funzionale |
| Dove vive l'MCP | Sempre in Casello (catalogo dichiarativo + esecutore unico); l'app non ospita codice MCP |
| Endpoint mancanti | L'architetto li propone come patch nello stack dell'app; li applica Ivan, mai Casello |
| Identità delle chiamate | Per agente: per conto dell'utente (predefinita per gli agenti nelle app) o account di servizio |
| Approvazione | Tutto ciò che propone l'architetto nasce in bozza e diventa attivo solo se approvato |
| Azioni distruttive | Conferma esplicita dell'utente a runtime (tool con `requiresConfirmation`) |
| Modello dell'architetto | Scelto per ogni analisi tra i modelli configurati su LiteLLM |
| Accesso al codice | Repo GitHub con token di sola lettura (strada normale) o zip caricato; mai scrittura sul repo |
| Forma dei tool | Dichiarativi (`http`, `ui`, `composite`); `composite` modellato subito, eseguito in fase 5 |
| Rete | App sullo stesso server Coolify: chiamate sulla rete interna; URL pubblico come ripiego |
| Agenti "UI" | Assistente contestuale per area (subito) + azioni sulla UI come tool `ui` (con il widget) |

## 3. Architettura

```
                ┌──────────────────────── Casello API ────────────────────────┐
 console G ───► │  conversazioni ─► ciclo agente ─► esecutore tool ──────────────┼──► API dell'app
 widget (poi) ─►│        │              │   ▲            (http / composite)      │   (rete interna)
 client MCP ───►│  /mcp/<app> ──────────┼───┘                                    │
                │                       ▼                                        │
                │                  LiteLLM (modelli)                             │
                │  architetto ─► sorgenti (GitHub / zip / OpenAPI / descrizione) │
                └────────────────────────────────────────────────────────────────┘
```

Unità e responsabilità (in `artifacts/api-server/src/`):

- `lib/secrets.ts`: cifratura e decifratura dei segreti (token GitHub, credenziali di servizio).
- `lib/tools/catalog.ts`: lettura del catalogo attivo di un'app/agente e conversione nel formato
  *function calling* e nel formato MCP.
- `lib/tools/executor.ts`: esecuzione di una chiamata a un tool (`http` ora, `composite` in fase 5);
  unico punto con le regole di sicurezza.
- `lib/agent-loop.ts`: ciclo modello ↔ tool di un turno, con limiti, pausa/ripresa, interruzione.
- `lib/run-bus.ts`: eventi di un turno in corso (streaming verso i client, messaggi aggiunti, stop).
- `lib/architect/*`: sorgenti, tool di lettura del codice, fasi dell'analisi, validazione della proposta.
- `routes/mcp.ts`: server MCP per app.

## 4. Modello dei dati

Tutte le modifiche vanno in `lib/db/src/schema/` e in `docs/schema-casello.sql`, con lo SQL da
applicare in produzione indicato nella PR di ogni fase.

### App (estesa)

| Campo | Note |
|---|---|
| `slug` | identificativo per `/mcp/<slug>`, unico |
| `internalBaseUrl` | URL sulla rete Coolify; se vuoto si usa `baseUrl` |
| `sourceType` | `github` / `zip` / `none` |
| `sourceRepo`, `sourceBranch` | per `github` |
| `sourceTokenEnc` | token GitHub di sola lettura, cifrato |
| `openapiUrl` | facoltativo; se vuoto l'architetto prova i percorsi comuni |
| `functionalDescription` | testo libero di Ivan, sempre utilizzabile dall'architetto |
| `userAuth` | JSON: come inoltrare il token utente (es. header `Authorization`, schema `Bearer`) |
| `serviceAuth` | JSON + segreto cifrato: credenziale di servizio e come inviarla |

I segreti non vengono mai restituiti dalle API (solo "impostato sì/no").

### Tool dell'app (`app_tools`, sostituisce `tools`)

| Campo | Note |
|---|---|
| `appId`, `name` | `name` unico per app, `snake_case` |
| `description` | per il modello: cosa fa e quando usarlo |
| `kind` | `http` / `ui` / `composite` |
| `identity` | `user` / `service` |
| `requiresConfirmation` | se `true` la run si mette in pausa prima di eseguire |
| `readOnly` | i tool di sola lettura possono essere eseguiti in parallelo e ripetuti |
| `status` | `draft` / `active` / `disabled` |
| `paramsSchema` | JSON Schema dei parametri |
| `definition` | JSON per tipo (sotto) |
| `evidence` | prove dell'architetto (file:riga o operazione OpenAPI), facoltative |
| `needsVerification` | `true` se ipotizzato senza codice né OpenAPI |

`definition` per tipo:

- `http`: `method`, `path` con segnaposto (`/api/teams/{teamId}/lineup`), `paramLocations`
  (per ogni parametro: `path` / `query` / `body`), `responseFields` (campi da tenere, facoltativo).
- `ui`: `action` (es. `navigate`, `fill`, `highlight`) e i suoi argomenti; eseguito dal widget.
- `composite`: `steps` (ognuno: tool da chiamare e mappatura degli argomenti da input e risultati
  precedenti) e `output` (mappatura del risultato). Schema validato da subito; esecuzione in fase 5.

Migrazione: ogni riga di `tools` diventa un `app_tools` `http` in stato `draft` dell'app
dell'agente, collegato all'agente; `tools` viene rimossa. Il vecchio endpoint `/agents/:id/tools`
viene sostituito dalle route del catalogo.

### Agente (esteso)

| Campo | Note |
|---|---|
| `role` | `general` / `area`; ogni app ha esattamente un `general`, creato in automatico |
| `area` | etichetta dell'area per gli agenti `area` (es. "Formazioni") |
| `defaultIdentity` | `user` / `service`, predefinita `user` |
| `uiConfig` | JSON: configurazione G e V (§7) |
| tool | tabella `agent_tools` (agente ↔ tool del catalogo); il `general` usa tutto il catalogo attivo |

### Skill (`agent_skills`)

`agentId`, `name`, `description`, `instructions`, `toolNames` (sottoinsieme dei tool dell'agente),
`paramsSchema` (parametri da chiedere all'utente, facoltativo), `status` (`draft`/`active`).

### Conversazioni e run

- `conversations`: `appId`, `agentId`, `title`, utente (email Casello o identificativo dell'utente
  dell'app passato dal client), `createdAt`.
- `messages`: `conversationId`, `role` (`user` / `assistant` / `tool`), contenuto, eventuale skill
  usata, `runId`, ordine.
- `runs` (esteso): diventa il **turno** di una conversazione (`conversationId`), nuovo stato
  `awaiting_client` e `cancelled`, `pendingAction` (JSON dell'azione in sospeso), token consumati.
  Le run esistenti diventano conversazioni di un solo turno.
- `run_steps`: `runId`, ordine, tipo (`model` / `tool`), nome tool, argomenti, esito, codice HTTP,
  durata, errore. Gli argomenti sensibili non si registrano (i parametri marcati `sensitive` nello
  schema vengono oscurati).

### Analisi dell'architetto

- `analyses`: `appId`, `model`, sorgenti usate, `status` (`queued` / `running` / `completed` /
  `failed` / `interrupted`), log di avanzamento, token consumati, `architectureMap` (mappa
  dell'architettura emersa), `createdAt`, `finishedAt`.
- `analysis_items`: `analysisId`, `chapter` (`tool` / `agent` / `skill` / `endpoint` /
  `improvement`), `payload` (JSON dell'elemento), `diff` rispetto a quanto esiste (`new` / `changed` /
  `removed` / `unchanged`), `evidence`, `status` (`pending` / `approved` / `discarded`; per
  `improvement` anche `postponed`), note di revisione.

## 5. Esecuzione: ciclo dell'agente ed esecutore

### Ciclo di un turno (`agent-loop.ts`)

1. Contesto: istruzioni dell'agente (ed eventuale skill), descrizione dell'app, contesto della
   pagina inviato dal client, storia della conversazione, tool dell'agente in formato *function
   calling*.
2. Chiamata al modello via LiteLLM in streaming; il testo esce come eventi `text.delta`.
3. Se il modello chiede tool: per ognuno si crea un `run_step` e lo si esegue (i `readOnly` in
   parallelo); i risultati tornano al modello. Si riparte dal punto 2.
4. Il turno finisce quando il modello risponde senza tool.

Limiti (configurabili, con default): 8 giri di tool, 120 s totali, tetto di token per turno. Al
superamento il turno si chiude come `failed` con un messaggio esplicito.

Prima di ogni nuova chiamata al modello il ciclo legge i **messaggi aggiunti** dall'utente durante
il turno e li inserisce nella storia. Una chiamata a un tool già partita termina comunque.

**Stop**: il turno si chiude come `cancelled` conservando il testo prodotto; la chiamata in corso al
modello viene interrotta, quella a un tool no.

### Pausa e ripresa (conferme e tool UI)

Un tool con `requiresConfirmation`, o di tipo `ui`, mette il turno in `awaiting_client` con
`pendingAction` (tool, argomenti, riepilogo leggibile). Il client risponde con
`POST /api/runs/:id/resume` (`approved`/`rejected` per le conferme, risultato per i tool UI).
Il rifiuto torna al modello come risultato del tool ("l'utente ha annullato"). Scadenza: 10 minuti,
poi il turno si chiude come `cancelled`.

### Esecutore HTTP (`executor.ts`)

- URL = `internalBaseUrl` (o `baseUrl`) + `path` del tool con i segnaposto sostituiti (codificati).
  **Nessun altro URL è raggiungibile**: niente host, schema o percorso dagli argomenti del modello.
- Argomenti validati contro `paramsSchema` prima della chiamata; se non validi l'errore torna al
  modello.
- Identità `user`: token dell'utente ricevuto all'avvio del turno, tenuto **solo in memoria** (per la
  durata del turno e della pausa), inoltrato come da `userAuth`. Identità `service`: credenziale
  decifrata al momento dell'uso.
- Timeout 15 s per chiamata, risposta massima 1 MB, `responseFields` applicati, testo troncato a un
  limite di caratteri per il modello.
- Nessun nuovo tentativo automatico se `readOnly` è falso.
- Errori HTTP, timeout e risposte non JSON tornano al modello come risultato del tool, con codice e
  messaggio sintetico.

### Server MCP (`/mcp/<slug>`)

Protocollo MCP standard (Streamable HTTP): `tools/list` e `tools/call` sui tool `active` dell'app,
eseguiti con lo **stesso esecutore**. Autenticazione: token dell'utente dell'app (abilita i tool
`user`) oppure chiave API Casello per l'app (abilita i tool `service`). I tool `ui` e quelli con
conferma non sono esposti via MCP (richiedono un client Casello). Chiavi API: tabella `api_keys`
(app, hash della chiave, nome, ultimo uso, revoca).

## 6. L'agente architetto

### Esecuzione

Lavoro in background nell'API (come le run, ma di minuti); all'avvio del server le analisi rimaste
`running` diventano `interrupted`. Avvio da console scegliendo il modello e le sorgenti.

### Sorgenti

- **GitHub**: download dell'archivio del branch con il token di sola lettura in una cartella
  temporanea, cancellata a fine analisi.
- **Zip**: caricato dalla console, stessa gestione.
- **OpenAPI**: `openapiUrl` o percorsi comuni (`/openapi.json`, `/api/openapi.json`,
  `/swagger.json`, `/api-docs`).
- **Descrizione funzionale**: sempre inclusa se presente.

L'architetto **non chiama le API dell'app** (a parte la lettura dell'OpenAPI).

### Ciclo e fasi

Ciclo con tool di sola lettura sul codice: `list_dir`, `read_file` (con limite di dimensione),
`search` (testo/regex), `read_openapi`. Fasi, ognuna con un output intermedio salvato nel log:

1. **Mappa**: stack, struttura, route, modelli dei dati, autenticazione (incluso come ottenere un
   token utente), aree della UI.
2. **Capacità**: cosa può fare un utente, per area.
3. **Catalogo**: tool "grossi" sugli endpoint esistenti; per le capacità importanti senza endpoint
   adatto, **proposte di endpoint** come patch nello stack e nelle convenzioni dell'app.
4. **Agenti e skill**: agente generale, agenti di area con istruzioni, tool e identità; skill per le
   procedure ricorrenti.
5. **Miglioramenti dell'app** (capitolo a parte): processi migliorabili e best practice non usate,
   nel backend o nel frontend. Per ciascuno: area, titolo, problema osservato con prove, beneficio,
   impatto, stima dello sforzo, traccia di implementazione (eventualmente patch).

Output finale: JSON validato contro uno schema; se non valido, richiesta di correzione al modello
(massimo 2 volte), poi `failed` con il log. Senza codice né OpenAPI i tool sono `needsVerification`.

### Rianalisi e differenze

Ogni elemento proposto è confrontato con l'esistente (tool per `name`; agenti per `role`+`area`;
skill per agente+`name`) e marcato `new` / `changed` / `removed` / `unchanged`.

### Revisione (console)

Pagina "Analisi" dell'app: mappa dell'architettura; elementi raggruppati per capitolo con prove e
differenze; per ciascuno modifica, approva, scarta (e rimanda per i miglioramenti). Approvare un tool
o un agente li crea/aggiorna nello stato `active`; approvare una skill la attiva. Patch e
miglioramenti accettati si copiano come testo pronto per una issue nel repo dell'app. Token
consumati visibili; tetto di token per analisi configurabile.

## 7. Conversazioni e interfaccia agentica

### API (nuove)

- `POST /api/conversations` (agente, contesto iniziale) e `GET` lista/dettaglio con i messaggi.
- `POST /api/conversations/:id/messages`: messaggio utente (ed eventuale skill con parametri),
  avvia un turno; risponde con il `runId`.
- `GET /api/runs/:id/events`: eventi in streaming (SSE): `text.delta`, `step.started`,
  `step.finished`, `awaiting_client`, `run.finished`, `run.failed`, `run.cancelled`.
- `POST /api/runs/:id/messages`: messaggio aggiunto durante il turno (interruzione senza stop).
- `POST /api/runs/:id/cancel`: stop.
- `POST /api/runs/:id/resume`: ripresa dopo conferma o azione UI.
- Token dell'utente dell'app: header `X-App-User-Token` sull'avvio del turno e sulla ripresa.

L'attuale `POST /api/agents/:id/runs` resta come scorciatoia (conversazione di un turno).

### Configurazione dell'interfaccia (`uiConfig` dell'agente)

- **G**: nome e avatar visibili, messaggio di benvenuto, domande suggerite, colore, funzioni attive
  (skill, allegati, passi visibili, voce).
- **V** (salvata ora, usata dal progetto voce): voce, lingua, velocità, modalità premi-per-parlare o
  mani libere, barge-in attivo.

### Chat nella console (fase 2)

Streaming con markdown e tabelle; passi visibili ed espandibili; schede di conferma; stop;
interruzione con messaggio aggiunto; combo delle skill (se l'agente ne ha) con i parametri; domande
suggerite; copia, rigenera, 👍/👎 (salvati sul messaggio); storico delle conversazioni; campo
"token di prova dell'app" per provare i tool `user`. Allegati e voce arrivano con il widget.

## 8. Sicurezza

- Esecutore: solo URL del catalogo, argomenti validati, nessun redirect seguito verso altri host.
- Token utente mai salvati nel DB né nei log; segreti cifrati (AES-256-GCM, chiave in
  `CASELLO_SECRET_KEY`, nuova variabile obbligatoria in produzione).
- Codice sorgente in cartelle temporanee cancellate a fine analisi; token GitHub di sola lettura.
- Nessuna scrittura sui repo delle app; nessuna azione automatica dalle proposte dell'architetto.
- Le chiamate dell'architetto e delle run restano soggette al login Google della console e al rate
  limit; il server MCP usa le proprie credenziali (token utente o chiave API).
- Prompt injection: i dati restituiti dall'app sono trattati come dati (nel messaggio `tool`), e le
  azioni che modificano dati importanti richiedono conferma.

## 9. Fasi di rilascio

Ogni fase: issue, branch `feat/…`, PR, merge (= produzione), SQL di produzione nella PR.

1. **Agenti che agiscono**: estensioni App (+ segreti cifrati), `app_tools` con migrazione, `agent_tools`,
   ruolo generale/area, esecutore `http`, ciclo dell'agente con tool, `run_steps` e timeline nella
   pagina run, pausa per conferma e ripresa, gestione del catalogo a mano nella console, campo
   facoltativo "token di prova dell'app" nel pannello Esegui (inviato come `X-App-User-Token`).
   Collaudo: Fantamister (`TwentIvan/Mister`) con 2-3 tool scritti a mano; "suggerisci la formazione"
   legge i dati veri.
2. **Conversazioni e chat**: conversazioni, messaggi, SSE, stop, messaggi aggiunti, skill a mano,
   `uiConfig`, chat completa nella console.
3. **Architetto**: sorgenti, analisi, proposta con capitoli (tool, agenti, skill, endpoint,
   miglioramenti), differenze, pagina di revisione. Collaudo: analisi di Mister confrontata con il
   catalogo della fase 1.
4. **Server MCP**: `/mcp/<slug>`, chiavi API. Collaudo: un client MCP esterno.
5. **Tool composti**: esecuzione dei `composite`.

## 10. Test

- Introduzione di **Vitest** in `artifacts/api-server` dalla fase 1 (script `test`, eseguito in CI).
- Unitari: costruzione delle richieste, validazione argomenti, rifiuto di URL fuori catalogo, token
  utente assente da DB e log, limiti del ciclo, pausa/ripresa, errori restituiti al modello,
  cifratura dei segreti, validazione della proposta dell'architetto, calcolo delle differenze.
- Integrazione: finto LiteLLM e finta app HTTP, Postgres in memoria (PGlite), come nei collaudi
  manuali fatti finora ma ripetibili.
- Ogni fase: prova nel browser e collaudo reale indicato in §9.

## 11. Fuori ambito (progetti successivi)

- **Widget nelle app**: componente da inserire nelle app (stessi componenti della chat della
  console), tool `ui`, autenticazione dei client delle app verso Casello, passaggio del token
  utente. Per le app che usano sessioni a cookie servirà un endpoint dell'app che rilasci un token di
  delega: l'architetto lo rileva in fase 1 della sua analisi e lo propone come endpoint mancante.
- **Voce**: riconoscimento e sintesi vocale, latenza, barge-in, costi.

## 12. Rischi noti

- Qualità dell'analisi legata al modello scelto: un modello debole aumenta il lavoro di revisione.
- Run e analisi girano nel processo dell'API: adatto a un'unica istanza; con più repliche servirà
  una coda.
- I tool rispecchiano le API dell'app: capacità senza endpoint richiedono le patch proposte (o i tool
  composti della fase 5).
