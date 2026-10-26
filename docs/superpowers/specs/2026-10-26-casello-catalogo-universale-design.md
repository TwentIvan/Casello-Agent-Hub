# Casello: catalogo universale dei modelli e registro dei provider

Data: 26 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Obiettivo

Casello deve conoscere **tutto** il mondo dei modelli in cloud (gli open weight sono un capitolo a parte) e
permettere a un utente di configurare **qualsiasi** account. Oggi il catalogo (spec
`2026-10-26-casello-catalogo-modelli-design.md`) scarta tutto ciò che non appartiene ai 7 provider dell'enum
`ai_provider`: dalle fonti arrivano 4 310 voci di 143 provider (LiteLLM) e 468 modelli di 67 autori
(OpenRouter), ne usiamo poche decine.

Il lavoro complessivo è diviso in tre sottoprogetti in sequenza, ciascuno con spec, piano e rilascio propri:

1. **Questa spec** — catalogo universale, registro dei provider come dati, ricerca per liste lunghe; ogni
   provider con API compatibile OpenAI diventa configurabile.
2. Esecutore **Anthropic nativo** (Messages API, prompt caching).
3. Cloud **hyperscaler**: Bedrock, Vertex, Azure (credenziali cloud), eventualmente Gemini nativo.

Pronto quando: dopo un aggiornamento la pagina Modelli contiene tutte le voci delle fonti, cercabili e
filtrabili, con vista per modello (offerte dei provider affiancate, la più economica in evidenza) e per
provider; i provider sconosciuti sono segnalati come *non gestiti*; un account si crea scegliendo il provider
da un elenco con ricerca; gli account e gli agenti esistenti funzionano come prima.

Vincoli che restano: aggiornamento a costo zero (nessuna chiamata ai modelli), "chi configura paga", prezzi
manuali mai sovrascritti, chiavi solo nell'esecutore e nella verifica.

Fuori da questa spec: esecutori Anthropic, Bedrock, Vertex, Azure (sottoprogetti 2 e 3); open weight; budget e
tetti di spesa per utente.

## 2. Concetti

- **Autore**: chi ha fatto il modello (Anthropic, Meta, Qwen, Mistral…).
- **Provider**: chi lo serve via API e lo fa pagare (Anthropic, Bedrock, Fireworks, DeepInfra, OpenRouter…).
- **Modello**: identità indipendente dal provider (autore, famiglia, versione, tipo, capacità).
- **Offerta**: un modello presso un provider (id presso il provider, prezzi, contesto, strumenti, stato).
- **Protocollo**: come si parla con il provider: `openai_compatible`, `anthropic`, `bedrock`, `vertex`,
  `azure`, `unknown`.

## 3. Dati

- `providers`: `slug` (chiave, testo), `name`, `protocol`, `default_base_url` (nullable), `source_keys` (jsonb:
  nomi del provider in LiteLLM — es. `bedrock`, `bedrock_converse`, `bedrock_mantle` — e prefisso OpenRouter se
  serve), `status` (`managed` | `coming` | `unmanaged`), `origin` (`registry` | `discovered`),
  `first_seen_at`, `updated_at`. Stato:
  - `managed`: protocollo con esecutore disponibile (in questa spec solo `openai_compatible`);
  - `coming`: protocollo noto senza esecutore (`anthropic`, `bedrock`, `vertex`, `azure`);
  - `unmanaged`: provider comparso nelle fonti e sconosciuto al registro (`protocol = unknown`).
- `models`: `id`, `canonical_key` (unica), `author`, `family`, `version`, `mode` (`chat`, `embedding`,
  `image_generation`, `image_edit`, `audio_transcription`, `audio_speech`, `video_generation`, `rerank`,
  `moderation`, `ocr`, `search`, `realtime`, `responses`, `completion`, `other`), `supports_tools`,
  `supports_vision`, `supports_reasoning` (bool nullable), `released_at`, `updated_at`.
- `model_offers`: `id`, `model_id` → models, `provider` → providers.slug, `provider_model_id`, prezzi input e
  output per Mtok, `context_tokens`, `supports_tools`, `status` (`available` | `deprecated` | `retired`),
  `deprecation_date`, `sources` (jsonb: fonte per campo), `updated_at`; unico (`provider`, `provider_model_id`).
  Sostituisce `model_catalog`.
- `ai_accounts.provider`: da enum `ai_provider` a testo con FK su `providers.slug`; valori invariati.
- `ai_models.catalog_id` → `ai_models.offer_id` (FK su model_offers, set null).
- `catalog_runs` invariata; il riepilogo aggiunge `newProviders` (slug, nome, numero di voci) per i provider
  scoperti in quell'esecuzione.

## 4. Registro dei provider

- Il registro vive nel codice (`lib/catalog/provider-registry.ts`): per ogni provider noto slug, nome,
  protocollo, indirizzo predefinito, `source_keys`. All'avvio Casello lo allinea alla tabella (upsert dei
  provider `origin = registry`; quelli `discovered` non si toccano finché il codice non li riconosce: allora
  diventano `registry`).
- Seme iniziale, almeno: i provider di oggi (deepseek, openrouter, huggingface, mistral, groq, together, gemini,
  custom, system_gateway) più OpenAI, xAI, Fireworks, DeepInfra, Cerebras, Perplexity, Moonshot, DashScope/Qwen,
  Z.ai, MiniMax, Nebius, SambaNova, Novita, Hyperbolic, Lambda, Nscale, OVHcloud, Scaleway; Anthropic, Bedrock
  (tutte le varianti `bedrock*`), Vertex (tutte le `vertex_ai*`), Azure (`azure`, `azure_ai`, `azure_text`) come
  `coming`; `custom` e `system_gateway` restano pseudo-provider `openai_compatible` (il secondo mai selezionabile).
  I provider con un protocollo proprio non elencato (es. Cohere nativo) restano `unmanaged`. Gli indirizzi si verificano sulla
  documentazione di ciascun provider durante l'implementazione; un provider il cui indirizzo non è certo entra
  senza `default_base_url` (l'utente lo inserisce).
- **Riconoscere un provider nuovo è l'intervento evolutivo**: si aggiunge al registro nel codice.

## 5. Aggiornamento

- Fonti, sicurezza e frequenza come nella spec del catalogo: indirizzi fissi, 30 s, niente redirect, 20 MB,
  valori ripuliti, settimanale e a richiesta, una sola esecuzione alla volta, costo zero.
- **Niente più scarti**: ogni voce delle fonti entra, di qualsiasi tipo (`mode` di LiteLLM; OpenRouter è chat).
- Provider di una voce LiteLLM: dal `litellm_provider` tramite i `source_keys` del registro; un nome sconosciuto
  crea (o riusa) un provider `unmanaged` con lo slug normalizzato, `origin = discovered`.
- OpenRouter: il provider delle offerte è `openrouter`; il prefisso dell'id (`anthropic/`, `qwen/`…) è l'autore.
- **Chiave canonica del modello** (abbinamento tra provider, al meglio): id senza prefisso del provider e senza
  prefissi d'autore in stile Bedrock (`anthropic.`, `meta.`…), senza suffissi di versione del provider
  (`-v1:0`, `@20250514`, date in coda dove identificano lo stesso modello), minuscolo, `_` e `.` uniformati.
  Due nomi che la regola non riconosce restano due modelli: nessun dato si perde. I campi del modello
  (autore, famiglia, versione, capacità, rilascio) si prendono dall'offerta più informativa, con precedenza a
  OpenRouter per rilascio e nome.
- Precedenze delle offerte, prezzi manuali, aggiornamento parziale che conserva i campi della fonte caduta,
  ritiro da data e da 404 reale, "Prova": come nella spec del catalogo.
- Arricchimento degli account: un modello di un account si abbina all'offerta (`account.provider`,
  `provider_model_id` normalizzato); per l'account di un provider `unmanaged` configurato come compatibile vale
  lo stesso.
- Riepilogo: novità come oggi (calcolate sulle offerte), più `newProviders`.

## 6. Account e esecuzione

- Creazione di un account: il provider si sceglie dal registro.
  - `managed`: indirizzo predefinito precompilato (modificabile solo per `custom`, come oggi).
  - `coming`: non selezionabile ("esecutore non ancora disponibile per questo provider").
  - `unmanaged`: configurabile come compatibile OpenAI con indirizzo inserito dall'utente, validato come per
    `custom` (https, nessun redirect; reti private solo con il consenso esplicito e mai loopback, link-local o
    metadata); verifica con `/models` e "Prova" come oggi.
- L'esecutore si ricava dal protocollo del provider: `openai_compatible` e `unknown` → esecutore compatibile
  OpenAI esistente; gli altri → errore fisso finché non arrivano i sottoprogetti 2 e 3.

## 7. Console

- **Pagina Modelli** con selettore di vista:
  - *Per modello*: riga con autore, famiglia, versione, tipo, capacità, rilascio, prezzo più basso tra le
    offerte, numero di provider; si espande nelle offerte (provider con stato, id, prezzi, contesto, strumenti,
    stato, "nei tuoi account", configurabile o no).
  - *Per provider*: elenco dei provider con stato, numero di modelli, segno se hai un account; aprendolo, i suoi
    modelli con gli stessi filtri.
- **Ricerca**: testo libero (nome, id, autore, famiglia); filtri tipo (predefinito `chat`), autore, provider
  (selezione multipla con ricerca), capacità (strumenti, visione, ragionamento), "solo utilizzabili da me",
  prezzo massimo, contesto minimo, ritirati nascosti; ordinamento per prezzo, rilascio, contesto, nome;
  paginazione lato API (50 per pagina); filtri nell'indirizzo della pagina.
- Riquadro **"Da gestire in Casello"** (solo se ci sono provider `unmanaged`): nome, numero di voci, data di
  comparsa; ogni voce esportabile come testo di issue di evoluzione (come le proposte dell'architetto).
- **Aggiungi account AI**: campo con ricerca su tutto il registro al posto della tendina; `managed` per primi,
  `coming` visibili e disabilitati, `unmanaged` con il percorso compatibile.
- **Tendina dei modelli** di agenti e analisi: diventa un campo con ricerca (un account OpenRouter porta
  centinaia di modelli); regole invariate (per account, solo disponibili con strumenti, "Altri modelli",
  preselezione del più economico).

## 8. API

Contract-first (OpenAPI + codegen):
- `GET /catalog/models` con query `q`, `mode`, `author[]`, `provider[]`, `tools`, `vision`, `reasoning`,
  `usable`, `maxPrice`, `minContext`, `includeRetired`, `sort`, `page`, `pageSize` (max 100) → pagina di
  modelli con `cheapestOffer`, `offerCount`, `inMyAccounts`.
- `GET /catalog/models/{id}/offers` → offerte del modello.
- `GET /catalog/providers` con `q`, `status` → provider con conteggi e `hasMyAccount`.
- `GET /catalog/status`, `POST /catalog/refresh` come oggi (riepilogo con `newProviders`).
- `GET /ai/providers` → registro per la creazione degli account (slug, nome, stato, protocollo, indirizzo
  predefinito).

## 9. Errori

Messaggi fissi in italiano: "esecutore non ancora disponibile per questo provider", "provider non gestito:
inserisci l'indirizzo compatibile OpenAI", "provider sconosciuto", più quelli già esistenti ("fonte …
non raggiungibile: dati non aggiornati", "aggiornamento parziale", "aggiornamento già in corso", "indirizzo non
consentito").

## 10. Migrazione

`docs/migrations/2026-10-catalogo-universale.sql`, idempotente, da applicare **prima del merge** (testo
completo in chat prima del push): tabella `providers` con i provider di oggi; `ai_accounts.provider` da enum a
testo con FK; tabelle `models` e `model_offers`; `ai_models.offer_id` al posto di `catalog_id`; eliminazione di
`model_catalog`; svuotamento di `catalog_runs` (il catalogo si ricostruisce 5 minuti dopo il deploy e gli
account si ricollegano; si perde solo lo storico delle esecuzioni). L'enum `ai_provider` resta finché nessuna
colonna lo usa, poi si elimina in un passo successivo.

## 11. Prove

Fonti finte con più provider, varianti (`bedrock_converse` → Bedrock), un provider sconosciuto (→ `unmanaged`
e in `newProviders`), tipi non chat; abbinamento dello stesso modello tra provider diversi (Bedrock e
Anthropic diretto) e caso non riconosciuto (due modelli); ricerca, filtri e paginazione; migrazione dallo
schema attuale (account invariati, catalogo ricostruito); account su provider `unmanaged` col percorso
compatibile e rifiuto su provider `coming`; allineamento del registro idempotente. Prova nel browser con le
fonti vere (≈4 300 voci, 143 provider).
