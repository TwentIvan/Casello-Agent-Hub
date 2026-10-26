# Casello: agente del catalogo dei modelli

Data: 26 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Obiettivo

Casello deve sapere, per ogni provider degli account AI, quali modelli esistono, le versioni, i prezzi,
se supportano gli strumenti (function calling, indispensabile ad agenti e architetto) e quali sono ritirati.
Si aggiorna da solo ogni settimana e a richiesta, quasi senza costi.

Casi reali che hanno motivato la spec (collaudo del 26/10): `deepseek-v4-pro` con "prezzo sconosciuto"
(il seed conosceva solo `deepseek-chat`/`deepseek-reasoner`); `models/antigravity-preview-latest` proposto
per primo e rifiutato (HTTP 400: non è un modello per chat con strumenti); `gemini-2.5-flash` ancora
elencato da Google ma ritirato (HTTP 404); `openrouter/qwen3-235b` del vecchio gateway non più valido (404).

Pronto quando: dopo "Aggiorna catalogo" la tendina non propone modelli ritirati o senza strumenti, i
prezzi dei modelli DeepSeek e Gemini sono noti, il modello proposto per primo è disponibile, con strumenti
ed economico, e la pagina "Modelli" mostra versioni e novità.

Decisione: **approccio A** — aggiornamento deterministico da fonti pubbliche gratuite; nessuna chiamata
ai modelli nell'aggiornamento automatico. Un riassunto AI delle novità e la copertura dei modelli che
nessuna fonte conosce (approccio C) potranno arrivare dopo.

Fuori da questa spec: budget e tetti di spesa per utente, Anthropic nativo, agente locale.

## 2. Fonti

Indirizzi fissi nel codice, mai forniti dagli utenti; timeout 30 s; nessun redirect; risposta massima
20 MB; valori ripuliti come in `lib/ai/discovery.ts` (prezzi non finiti, negativi o ≥ 1e6 per Mtok → null;
id con caratteri di controllo scartati; nomi ≤ 256 caratteri).

1. **OpenRouter** — `GET https://openrouter.ai/api/v1/models` (pubblico, senza chiave): `id`
   (`provider/modello`), `name`, `created` (data), `context_length`, `pricing.prompt`/`pricing.completion`
   (USD per token), `supported_parameters` (contiene `tools` se supporta gli strumenti).
2. **Listino LiteLLM** — `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
   (licenza MIT): per chiave di modello `input_cost_per_token`, `output_cost_per_token`, `max_input_tokens`,
   `supports_function_calling`, `deprecation_date`, `litellm_provider`.
3. **Elenco modelli degli account** — la verifica esistente (`/models` del provider con la chiave
   dell'utente): dice cosa è davvero disponibile.

Se una fonte fallisce si usano le altre; l'esecuzione è "parziale" e i dati precedenti restano validi.

## 3. Dati

- `model_catalog` (comune, dati pubblici): `id`, `provider` (`ai_provider`), `model_id` (normalizzato),
  `family` (es. "Gemini"), `version` (es. "3.5 Flash"), `released_at` (nullable), `price_input_per_mtok`,
  `price_output_per_mtok`, `context_tokens`, `supports_tools` (bool nullable), `status`
  (`available` | `deprecated` | `retired`), `deprecation_date` (nullable), `sources` (jsonb: quale fonte ha
  dato quale campo), `updated_at`; unico (`provider`, `model_id`).
- `catalog_runs`: `id`, `trigger` (`scheduled` | `manual`), `user_id` (chi l'ha chiesto, nullable),
  `status` (`running` | `completed` | `partial` | `failed`), `started_at`, `finished_at`, `summary`
  (jsonb: nuovi, ritirati, in dismissione, prezzi cambiati con vecchio/nuovo, spariti dagli account per
  account), `error`. Si tengono le ultime 20.
- `ai_models`, nuove colonne: `availability` (`available` | `unavailable` | `unknown`, default `unknown`),
  `supports_tools` (bool nullable), `catalog_id` → model_catalog (set null), `last_probe_at`,
  `last_probe_ok` (bool nullable). Stato effettivo mostrato = ritirato se il catalogo dice `retired` o la
  data di dismissione è passata; non disponibile se `availability = unavailable`; altrimenti disponibile.
- Enum `ai_provider` + `gemini`.

## 4. Normalizzazione e abbinamento

- Id: tolto il prefisso `models/` (Gemini); minuscolo per il confronto.
- Abbinamento modello dell'account → catalogo per (provider, model_id); mappe per provider verso le chiavi
  delle fonti: OpenRouter `deepseek/…`, `google/…`, `mistralai/…`; LiteLLM `deepseek/…`, `gemini/…`,
  `mistral/…`, `groq/…`, `together_ai/…`, chiavi senza prefisso per OpenRouter stesso. Il provider
  `openrouter` usa direttamente il catalogo OpenRouter.
- Precedenza per campo: prezzi e strumenti dal catalogo OpenRouter del provider stesso se è OpenRouter,
  altrimenti LiteLLM, poi OpenRouter come riserva; data di rilascio da OpenRouter; dismissione da LiteLLM.
- I prezzi inseriti a mano (`price_source = manual`) non vengono mai sovrascritti; gli altri sì, con
  `price_source = catalog`.

## 5. Esecuzione

- Settimanale: un controllo nel processo dell'API ogni 24 h (e all'avvio, dopo 5 minuti) avvia
  l'aggiornamento se l'ultimo `completed`/`partial` ha più di 7 giorni. A richiesta: `POST /api/catalog/refresh`.
  Una sola esecuzione alla volta (riga `running` con indice unico parziale); all'avvio le `running` rimaste
  diventano `failed` ("interrotto dal riavvio").
- Passi: scarica le fonti → aggiorna `model_catalog` → per ogni account AI attivo non di sistema rilegge
  `/models` (verifica esistente, senza bloccare gli altri) → arricchisce `ai_models` → calcola il riepilogo.
- Ritiro senza costi: una chiamata reale (run o analisi) che riceve 404 o "modello inesistente" segna il
  modello `unavailable`; dismissione passata → ritirato.
- "Prova" (`POST /api/ai/models/:id/probe`, solo proprietario; 5/minuto): una chiamata con `max_tokens: 1`
  e un messaggio minimo; aggiorna `last_probe_*` e `availability`; il costo (frazioni di centesimo) è
  dell'account.

## 6. Console

- Pagina **Modelli** (menu laterale): novità dell'ultimo aggiornamento in cima (con data ed esito,
  pulsante "Aggiorna catalogo"); per provider, famiglie e versioni con data di rilascio, prezzi, contesto,
  strumenti, stato; i modelli dei propri account evidenziati.
- **Tendina dei modelli**: solo modelli disponibili con strumenti (o con strumenti non noti, segnati "?"),
  ritirati e non disponibili esclusi; gli altri in un gruppo chiuso "Altri modelli". Preselezione:
  disponibile, con strumenti, non anteprima (id che contiene `preview`, `exp`, `experimental`), prezzo noto più
  basso; se nessuno ha prezzo, il primo disponibile con strumenti.
- **Account AI**: colonne stato e strumenti nella tabella modelli; pulsante "Prova".
- **Gemini** nell'elenco dei provider (indirizzo precompilato `https://generativelanguage.googleapis.com/v1beta/openai`).

## 7. Errori e sicurezza

Messaggi fissi in italiano ("fonte OpenRouter non raggiungibile: dati non aggiornati", "aggiornamento
parziale", "aggiornamento già in corso"). Le chiavi restano nell'esecutore e nella verifica esistenti. Le
novità per account sono visibili solo al proprietario; il catalogo comune a tutti gli utenti ammessi.

## 8. Migrazione

`docs/migrations/2026-10-catalogo-modelli.sql`, idempotente, prima del merge: `ALTER TYPE ai_provider ADD
VALUE IF NOT EXISTS 'gemini'` (fuori dalla transazione se necessario), tabelle `model_catalog` e
`catalog_runs` con i loro enum, colonne nuove su `ai_models`.

## 9. Prove

Fonti finte (OpenRouter e LiteLLM in piccolo) e finto provider. Test: normalizzazione e abbinamento,
precedenza dei campi, prezzi manuali intatti, ritiro da data e da 404 reale, riepilogo delle novità,
fonte che fallisce (parziale), esecuzione unica e interrotta, avvio settimanale, preselezione, prova con
1 token, isolamento delle novità per utente. Prova nel browser; collaudo: "Aggiorna catalogo" con gli
account Gemini e DeepSeek di Ivan.
