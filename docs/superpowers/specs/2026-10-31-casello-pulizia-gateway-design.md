# Casello: pulizia del gateway e modelli degli agenti per app (design)

Data: 2026-10-31. Fase 2 della dismissione del gateway LiteLLM (blocco 5 del piano di evoluzione).

## 1. Contesto e scopo

Il gateway LiteLLM è spento: in produzione le variabili `AI_GATEWAY_*` sono state tolte e tutti gli agenti usano
modelli degli account AI dell'utente. Restano nel codice il vecchio percorso del gateway, l'account di sistema e
l'elenco fisso dei modelli LiteLLM. Inoltre due punti di Casello creano agenti da soli (agente generale di un'app
nuova, agenti approvati dall'architetto) e assegnano il modello predefinito del gateway, che non esiste più: quegli
agenti nascerebbero senza modello.

Scopo:
- l'utente sceglie il modello per ogni app («servizio») e per ogni agente, con il proprio modello predefinito come
  valore proposto;
- si toglie tutto ciò che serviva solo al gateway.

## 2. Modello predefinito e scelta per agente

- `users.default_ai_model_id` (integer, FK `ai_models.id` `ON DELETE SET NULL`), migrazione additiva. Si sceglie
  nella pagina Account tra i modelli dei propri account (prima quelli con strumenti); serve solo a precompilare.
  API: `GET /api/account/default-model` → `{ aiModelId: number | null }`, `PUT /api/account/default-model` con
  `{ aiModelId: number | null }` (modello proprio, altrimenti 400 «modello non disponibile»; `sessionOnly`).
- Ripiego comune («scelto → predefinito → nessuno»), usato ovunque Casello crea un agente:
  - creazione di un'app: `generalAgentAiModelId` facoltativo nel corpo; il modulo della console lo propone
    precompilato col predefinito;
  - approvazione di un agente proposto dall'architetto: `aiModelId` facoltativo in `PATCH /analysis-items/:id`
    (insieme a `status: approved`), solo per gli agenti nuovi: un agente esistente aggiornato dall'architetto
    mantiene il suo modello. La scheda «agente» della revisione mostra la scelta precompilata;
  - `POST /agents`: `aiModelId` facoltativo; il campo `model` di compatibilità sparisce.
- Ogni `aiModelId` esplicito deve essere un modello di un account dell'utente (regola attuale di
  `chooseOwnModel`), altrimenti 400. Il predefinito si usa solo se è ancora un modello dell'utente.

## 3. Mappa dei modelli dell'app

- Pagina dell'app, sezione «Modelli degli agenti»: tabella agente, ruolo, stato, modello (tendina dei propri
  modelli, prima quelli con strumenti; segnalazione di ritirato / in dismissione / non disponibile come altrove),
  «Applica a tutti» (stesso modello su tutte le righe), «Salva».
- API: `PUT /api/apps/:id/agent-models` con `{ assignments: [{ agentId, aiModelId: number | null }] }`; tutto o
  niente in una transazione; ogni agente deve appartenere all'app (altrimenti 400) e ogni modello all'utente
  (altrimenti 400); risposta: gli agenti aggiornati.
- Agenti senza modello evidenziati: «nessun modello: le run non partono».

## 4. Pulizia

- Si tolgono: `lib/ai-gateway.ts` (i tipi condivisi — messaggi, tool call, `ChatResult`, `assistantToolCalls` —
  si spostano in `lib/ai/chat-types.ts` senza cambiare comportamento), `lib/ai/system-account.ts`,
  `lib/models.ts`, `routes/models.ts` (`GET /api/models` e lo schema OpenAPI relativo), `chooseByName` e
  `findUsableSystemModelId`, il campo `model` in `AnalysisStart`/query dello zip e in `AgentInput`/`AgentUpdate`,
  i rami `system_gateway` di esecutore, account, catalogo, route AI e console, i metadati LiteLLM
  (`buildProxyParams`), il messaggio `SYSTEM_UNAVAILABLE`.
- Run: un agente senza modello → `POST /agents/:id/runs` risponde 409 «scegli un modello per l'agente» (nessuna run
  creata); una ripresa di una run senza modello fallisce con lo stesso messaggio. Analisi cloud: `aiModelId`
  obbligatorio (400 «scegli un modello»).
- I campi testuali storici restano: `agents.model`, `analyses.model`, `runs` senza modello mostrano il nome
  salvato; i costi già registrati non cambiano.

## 5. Dati di produzione

- Prima del merge: `docs/migrations/2026-10-pulizia-gateway.sql` (additiva, idempotente): colonna
  `users.default_ai_model_id`.
- Dopo il deploy: `docs/migrations/2026-10-pulizia-gateway-post.sql` (distruttiva, idempotente, in transazione):
  - controllo preliminare: nessun agente su un modello dell'account di sistema (altrimenti l'FK `restrict`
    blocca e lo script fallisce senza modifiche);
  - elimina i modelli e l'account di sistema (`provider = 'system_gateway'` e `user_id IS NULL`): analisi, run e
    conversazioni perdono solo il collegamento (`SET NULL`), tengono nome e costo;
  - elimina il provider `system_gateway` dalla tabella `providers` (e dal registro nel codice);
  - `DROP TYPE IF EXISTS ai_provider` (inutilizzato).
- Il registro dei provider (`ensureProviderRegistry`) non deve ricreare `system_gateway` all'avvio.

## 6. Test

- Modello predefinito: impostazione, modello altrui → 400, azzeramento quando il modello viene eliminato.
- Ripiego scelto → predefinito → nessuno: creazione app, approvazione di un agente nuovo dell'architetto (e agente
  esistente aggiornato che conserva il modello), `POST /agents`.
- Mappa: aggiornamento di più agenti, agente di un'altra app o modello altrui → 400 senza modifiche parziali.
- Run di un agente senza modello → 409 senza run; analisi cloud senza `aiModelId` → 400.
- Nessun riferimento residuo: `/api/models` → 404; avvio dell'API senza variabili `AI_GATEWAY_*` senza account di
  sistema.
- Migrazioni: additiva idempotente; `-post` idempotente, che elimina account e modelli di sistema lasciando analisi
  e run con `ai_model_id` nullo e nome e costo intatti, e che fallisce senza modifiche se un agente usa ancora un
  modello di sistema.
- Console: modello predefinito in Account, modulo app, scheda agente della revisione, mappa (prova nel browser).
