# Casello: Account AI (centro di configurazione dei modelli, primo pezzo)

Data: 26 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Contesto e obiettivo

Casello deve essere l'**unico centro di configurazione** degli agenti e dei modelli: un portale, oggi
personale, pensato per essere usato da altri utenti. Oggi i modelli stanno in tre posti (config YAML di
AIGateway/LiteLLM, variabili di Coolify, elenco fisso `lib/models.ts`) e aggiungerne uno richiede lavoro
manuale; l'analisi di Mister è ferma perché il credito OpenRouter è finito.

Decisioni prese:
- **Strada B**: Casello parla direttamente con i provider (formato compatibile OpenAI), senza LiteLLM.
  LiteLLM richiede la licenza Enterprise per le chiavi dei provider per singolo team/utente; con la
  strada B le chiavi sono per utente senza licenze e c'è un servizio in meno. AIGateway verrà dismesso.
- I costi vanno sempre tenuti d'occhio: costo per chiamata, totale per run/analisi e stima prima di avviare.
- Ordine dei sottoprogetti: **Account AI** (questa spec) → Libreria di agenti (configurazioni versionate,
  istanze con knowledge, promozione) → catalogo aggiornato da un agente → agente locale via MCP → programma
  ponte locale → open weight/Hugging Face avanzato.

Obiettivo di questa spec: ogni utente aggiunge i propri account AI dalla console; i modelli di quegli
account diventano selezionabili (con prezzo) per agenti e analisi; ogni chiamata registra token e costo.
Pronto quando l'analisi di Mister gira con un account DeepSeek aggiunto dalla console, senza toccare
AIGateway, e mostra il costo.

Fuori da questa spec: configurazioni/istanze/knowledge (sottoprogetto successivo), aggiornamento
automatico del catalogo, agente locale, Anthropic/Google nativi, budget/tetti di spesa per utente.

## 2. Modello dei dati

- `ai_accounts`: `id`, `user_id` → users (cascade; null solo per l'account di sistema), `name`,
  `provider` (enum `ai_provider`: `deepseek`, `openrouter`, `huggingface`, `mistral`, `groq`, `together`,
  `custom`, `system_gateway`), `base_url`, `api_key_enc` (cifrata con `CASELLO_SECRET_KEY`; null per
  `system_gateway`), `allow_private_network` (bool, solo `custom`), `is_default` (al massimo uno per
  utente: indice unico parziale), `status` (`unverified`, `ok`, `error`), `last_error` (testo fisso),
  `last_checked_at`, `created_at`, `updated_at`.
- `ai_models`: `id`, `account_id` → ai_accounts (cascade), `model_id` (id del provider, es.
  `deepseek-chat`), `display_name`, `context_tokens` (nullable), `price_input_per_mtok`,
  `price_output_per_mtok` (numeric USD, nullable), `price_source` (`provider`, `manual`, `seed`),
  `hidden` (bool), `discovered` (bool: arrivato da `/models` o aggiunto a mano), timestamps; unico
  (`account_id`, `model_id`).
- `agents`: nuove colonne `ai_model_id` → ai_models (nullable, `on delete restrict`). `model` (testo)
  resta per compatibilità durante la transizione.
- `analyses`: `ai_model_id` → ai_models (nullable, restrict), `cost_usd` (numeric, nullable).
- `runs`: `cost_usd` (numeric, nullable).
- `users`: `default_ai_account_id` non serve: il default è `ai_accounts.is_default`.

## 3. Provider

Tutti compatibili OpenAI (`/models`, `/chat/completions`), stesso client (`openai` SDK) con
`baseURL` e chiave dell'account:

| provider | base URL predefinito | note |
|---|---|---|
| deepseek | `https://api.deepseek.com/v1` | `/models` senza prezzi: prezzi da tabella seed (deepseek-chat, deepseek-reasoner) |
| openrouter | `https://openrouter.ai/api/v1` | `/models` con prezzi (USD per token → per milione) e contesto |
| huggingface | `https://router.huggingface.co/v1` | Inference Providers (open weight) |
| mistral | `https://api.mistral.ai/v1` | |
| groq | `https://api.groq.com/openai/v1` | |
| together | `https://api.together.xyz/v1` | |
| custom | inserito dall'utente | qualsiasi endpoint compatibile (Ollama/LM Studio esposti, vLLM…) |
| system_gateway | `AI_GATEWAY_BASE_URL` | account di sistema della transizione (§6) |

Base URL: solo `https`, tranne `custom` con `allow_private_network` (consente anche `http` e indirizzi
privati). Nessun redirect seguito. La tabella dei prezzi seed sta nel codice (`lib/ai/price-seed.ts`)
con data di aggiornamento; il catalogo automatico la sostituirà.

## 4. Esecutore unico dei modelli

`lib/ai/executor.ts`: `ModelExecutor` con `chat(opts)` / `complete(opts)` come oggi `ai-gateway.ts`
(stessi messaggi, tool, timeout, retry, signal) più `resolveModel(aiModelId, userId?)` che restituisce
account, modello, chiave in chiaro (solo in memoria) e prezzi. Implementazione `openaiCompatible`; il
tipo dell'interfaccia prevede già un secondo esecutore (`localAgent`) per il sottoprogetto MCP, senza
implementarlo. `ai-gateway.ts` diventa un adattatore sottile o viene assorbito.

Ogni chiamata restituisce `usage` (prompt/completion token); il costo è
`prompt × price_input / 1e6 + completion × price_output / 1e6` se i prezzi sono noti, altrimenti null.
Run e analisi sommano i costi in `cost_usd` (null se almeno un prezzo manca, con indicazione "costo
parziale" nella UI).

Autorizzazione: un utente può usare solo i propri account e l'account di sistema. Le run di un agente usano
l'account scelto nell'agente (chi configura paga), anche se la run è avviata da altri o da un'app.

## 5. API e console

API (contract-first, `openapi.yaml` + codegen):
- `GET /ai/accounts`, `POST /ai/accounts` (crea e verifica), `PATCH /ai/accounts/:id` (nome, chiave
  nuova, base URL per custom, `allow_private_network`), `DELETE /ai/accounts/:id` (409 con elenco degli
  agenti/analisi che lo usano), `POST /ai/accounts/:id/verify` (rilegge `/models`), `POST
  /ai/accounts/:id/default`.
- `GET /ai/accounts/:id/models`, `POST /ai/accounts/:id/models` (aggiunta manuale), `PATCH
  /ai/models/:id` (nome, prezzi, `hidden`).
- `GET /ai/models` → modelli selezionabili dall'utente (propri account + sistema, non nascosti), raggruppati
  per account con prezzi: sostituisce `GET /models` (che resta come alias per la transizione).
- `GET /ai/estimate?aiModelId=&maxTokens=` → stima del costo di un'analisi: massimo (tetto × prezzo,
  ipotizzando il 95% di token di input) e tipico (60% del tetto).
- Agenti e analisi accettano `aiModelId` al posto di `model`.

Console:
- Pagina Account, nuova sezione **Account AI**: elenco (nome, provider, stato e motivo, n. modelli, ultima
  verifica, stella del predefinito), "Aggiungi account" (tipo → base URL precompilato, nome, chiave in
  campo password mai riempito, "Salva e verifica"), azioni per account (Aggiorna modelli, Predefinito,
  Modifica, Elimina), tabella dei modelli con prezzi modificabili e "nascondi".
- Tendina unica "Modello" negli agenti e nell'analisi: raggruppata per account, con prezzo; preselezione
  dal predefinito.
- Analisi: stima del costo accanto al pulsante "Avvia analisi"; costo totale nell'elenco e nel dettaglio.
- Run: costo nel dettaglio.

## 6. Transizione dal gateway

- Se `AI_GATEWAY_BASE_URL` e `AI_GATEWAY_API_KEY` sono impostate, all'avvio Casello crea/aggiorna l'account
  di sistema "Gateway Casello" (`provider: system_gateway`, `user_id` null, chiave dalla variabile, non
  salvata) con i modelli dell'elenco attuale (`lib/models.ts`) e i loro prezzi seed se noti. Usabile da tutti
  gli utenti ammessi, non modificabile né eliminabile dalla console.
- Migrazione: gli agenti e le analisi esistenti vengono collegati al modello corrispondente dell'account di
  sistema (stesso `model`). Nulla smette di funzionare al rilascio.
- Dismissione (passo separato, con conferma di Ivan): quando gli agenti usano account propri, si tolgono le
  variabili; l'account di sistema scompare dalle tendine e i riferimenti residui mostrano "account di sistema
  non più disponibile".
- Il messaggio per l'errore 402 già preparato sul branch `feat/deepseek-diretto` ("credito del provider
  esaurito…") entra in questa spec; il modello DeepSeek scritto a mano in `lib/models.ts` no.

## 7. Errori (in italiano, senza chiave né risposta grezza del provider)

"chiave non valida o senza permessi" (401/403), "credito del provider esaurito: ricarica il conto o
scegli un altro modello" (402), "limite di richieste del provider: riprova più tardi" (429), "provider non
raggiungibile" (rete/timeout), "il provider non fornisce l'elenco dei modelli: aggiungili a mano", "indirizzo
non consentito" (base URL non https o privato senza consenso), "account usato da: …" (eliminazione).

## 8. Sicurezza

Chiavi cifrate a riposo, decifrate solo al momento della chiamata, mai in log, risposte, errori o DB in
chiaro; isolamento per utente su ogni route; base URL validato al salvataggio e alla chiamata; nessun
redirect; risposte di `/models` limitate in dimensione e numero (max 2 000 modelli).

## 9. Migrazione DB

`docs/migrations/2026-10-account-ai.sql`, idempotente: enum, tabelle `ai_accounts` e `ai_models`, colonne
nuove su `agents`, `analyses`, `runs`. Il collegamento degli agenti/analisi esistenti all'account di sistema
lo fa l'API all'avvio (dipende dalle variabili d'ambiente), non lo script SQL. Da applicare prima del merge.

## 10. Prove

Finto provider compatibile OpenAI (server HTTP locale): `/models` con e senza prezzi, `/chat/completions`
con `usage`, errori 401/402/429, risposte lente. Test: creazione e verifica dell'account, prezzi da provider
e da seed, aggiunta manuale, isolamento tra utenti, eliminazione bloccata se in uso, run e analisi con
l'account scelto e costo calcolato, costo parziale senza prezzi, stima, account di sistema e migrazione dei
riferimenti, nessuna chiave in log/risposte. Prova nel browser; collaudo: account DeepSeek dalla console e
analisi di Mister completata con il costo mostrato.
