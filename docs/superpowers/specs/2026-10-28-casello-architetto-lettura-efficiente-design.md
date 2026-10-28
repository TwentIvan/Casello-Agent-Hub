# Casello: Architetto, lettura efficiente (mappa calcolata, dossier tra le fasi, letture grandi, cache)

Data: 28 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Contesto e obiettivo

Le analisi di Mister con account AI in cloud falliscono per esaurimento del budget (1 000 000 token):
quello arrivato più lontano (Gemini) si è fermato con ~200k di contesto. Dalla lettura di
`lib/architect/phase-loop.ts` e `run-analysis.ts` le perdite sono tre, nessuna legata alla dimensione del
codice in sé:

1. **Ogni fase ricomincia da zero.** Tra le fasi passa solo l'esito (`previous`), non ciò che il modello
   ha letto: il codice viene ri-esplorato sei volte.
2. **Letture piccole, tanti giri, costo quadratico.** `read_file` dà ≤ 200 righe / 10 000 caratteri
   (`SOURCE_LIMITS.maxReadLines/maxReadChars`), l'output di uno strumento ≤ 12 000 caratteri
   (`MAX_TOOL_OUTPUT_CHARS`); fino a 25 giri per fase (`PHASE_MAX_ROUNDS`) e a ogni giro si ri-manda tutta
   la cronologia. Il budget somma `promptTokens + completionTokens` di ogni chiamata, quindi una
   cronologia da 100k costa 100k a ogni giro.
3. **La compattazione uccide la cache e la memoria.** `compactHistory` tiene solo 24 000 caratteri di
   output degli strumenti (`HISTORY_TOOL_OUTPUT_BUDGET`, ~6k token) e sostituisce **in loco** i messaggi
   `tool` vecchi con un segnaposto: il modello dimentica e rilegge, e il prefisso dei messaggi cambia a
   ogni giro, quindi la cache di prefisso dei provider (DeepSeek, Gemini, Anthropic via OpenRouter, in
   automatico) non colpisce mai. In più il budget conta i token in cache come pieni.

Obiettivo: un'analisi di Mister con un account cloud economico (DeepSeek o Gemini Flash via OpenRouter)
arriva a `completed` entro il budget predefinito, con una stima indicativa di 150-300k token effettivi
(da misurare), e il percorso cloud torna usabile per app di quella taglia. Le stesse strutture (mappa e
dossier) vengono riusate dall'esecutore locale (spec gemella `2026-10-28-casello-esecutore-locale-design.md`).

Decisioni prese:
- Includere nella spec anche la contabilità della cache (§5), pur toccando `ai/executor.ts` e il calcolo
  dei costi: senza, le altre tre misure riducono i giri ma il tetto continua a scattare sul ri-invio.
- Nessun cambiamento agli schemi degli esiti salvo l'aggiunta di `notes` (§3): diff, apply, issue e
  console non cambiano.

Fuori da questa spec: esecutore locale; parallelismo tra fasi; modelli nativi Anthropic/Google.

## 2. Mappa calcolata in codice (non dal modello)

Nuovo modulo `lib/architect/repo-map.ts`: a partire dal `SourceTree` già in memoria produce un testo
deterministico, **una volta per analisi**, inserito nel messaggio utente di **ogni** fase (prima del blocco
`previous`), così nessuna fase deve ricostruirla:

- **Albero annotato**: directory e file con dimensione in righe e linguaggio (dall'estensione); le
  directory con più di 25 file vengono compresse in una riga (`src/components/ (84 file .tsx, 6 120 righe)`)
  tranne i file più grandi (primi 5). Tetto: 8 000 token stimati (≈ 32 000 caratteri); oltre, si
  aumenta la compressione (soglia 25 → 10 → 5) fino a rientrare.
- **Esclusioni di default** dalla mappa e dagli strumenti di lettura/ricerca (restano nel tree per `has`,
  ma `list_dir`/`read_file`/`search` le saltano a meno di `includeIgnored: true`): lockfile
  (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`), `node_modules/`, `dist/`, `build/`, `.git/`,
  `generated/` e file con intestazione "generated", `*.min.*`, `*.map`, asset binari e immagini,
  `*.snap`, cartelle `test`/`tests`/`__tests__` e file `*.test.*`/`*.spec.*`, `coverage/`. I file di
  test si possono comunque leggere con `includeIgnored`.
- **Punti d'ingresso**: `package.json` (nome, `scripts`, dipendenze principali), workspace
  (`pnpm-workspace.yaml`), `Dockerfile`/`docker/`, file `.env.example`, `README` (prime 40 righe),
  `openapi.yaml` (riepilogo: numero di operazioni per tag).
- **Operazioni OpenAPI**: se l'app ha l'OpenAPI, l'elenco completo `METODO path — summary` (già prodotto
  da `describeOperation`), con lo stesso tetto; se supera il tetto, per tag con conteggio e si rimanda a
  `list_operations`.
- La fase `map` resta (il suo esito, `MapResultSchema`, è l'interpretazione architetturale), ma le sue
  istruzioni dicono di **partire dalla mappa fornita** e di esplorare solo per confermare o correggere.
  `PHASE_TOKEN_SHARES.map` scende da 0,22 a 0,10; la differenza va a `catalog` (0,22) e `agents` (0,17).
- `analyses.architecture_map` (jsonb, già esistente) salva anche la mappa calcolata (`repoMap: string`) per
  la console e per l'esecutore locale.

## 3. Dossier che passa tra le fasi

- `submit_result` di ogni fase accetta un campo **`notes`** (stringa, max 6 000 caratteri, facoltativo):
  "appunti per le fasi successive": file rilevanti e cosa contengono, convenzioni trovate (client HTTP,
  autenticazione, router), punti ambigui. Si aggiunge a tutti i `*ResultSchema` come `notes: z.string()
  .max(6000).optional()`; `phaseItems`/`diff`/`apply` lo ignorano; viene salvato nell'esito.
- `previousBlock` (prompts.ts) aggiunge, dopo gli esiti, una sezione "Appunti delle fasi precedenti"
  con le `notes` di ogni fase (ordine di fase). Tetto complessivo 20 000 caratteri: se superato, si
  tengono intere le note più recenti e si troncano le più vecchie dalla fine, con avviso.
- Le istruzioni di ogni fase chiedono esplicitamente di **non rileggere** i file già descritti negli
  appunti se gli appunti bastano, e di citarli come `evidence`.
- Per l'esecutore locale lo stesso campo arriva via `get_phase_instructions`.

## 4. Letture grandi e in blocco (meno giri)

- `SOURCE_LIMITS.maxReadLines` 200 → **1 500**, `maxReadChars` 10 000 → **48 000**;
  `MAX_TOOL_OUTPUT_CHARS` 12 000 → **64 000**. `read_file` continua ad accettare `offset`: un file da
  4 000 righe si legge in 3 chiamate invece di 20.
- Nuovo strumento **`read_files`**: fino a 6 percorsi per chiamata, tetto complessivo 64 000 caratteri;
  i file che non ci stanno tornano come "non letto: supera lo spazio, chiedilo da solo con offset".
- `search`: `MAX_SEARCH_MATCHES` resta 200 ma ogni corrispondenza riporta 2 righe di contesto (oggi 1),
  così più spesso non serve la lettura successiva.
- Il limite per chiamata al modello resta `MAX_COMPLETION_TOKENS` (output); i limiti qui sopra riguardano
  l'input. Un modello con `context_tokens` < 64k (campo di `ai_models`) riceve tetti dimezzati
  automaticamente (`scaleLimitsForContext`).
- `PHASE_MAX_ROUNDS` 25 → **18** e `PHASE_NUDGE_RATIO` invariato: con letture grandi 18 giri sono
  abbondanti e il tetto taglia prima le esplorazioni a vuoto.

## 5. Cache invece di compattazione; contabilità dei token in cache

- **Niente più compattazione in loco** durante una fase: `compactHistory` viene rimossa dal ciclo. La
  cronologia cresce solo in coda, quindi il prefisso resta stabile e la cache di prefisso del provider
  colpisce a ogni giro (OpenRouter la inoltra; DeepSeek e Gemini la applicano da soli).
- **Guardia sul contesto**: prima di ogni chiamata si stima la cronologia (caratteri/4) e, se supera il
  75 % di `context_tokens` del modello (o 120k se ignoto), si fa **un solo** passo di sintesi: una
  chiamata senza strumenti che chiede al modello "riassumi in ≤ 6 000 caratteri ciò che hai letto e che
  serve a consegnare l'esito" e la cronologia riparte da `system + user (mappa + previous) + sintesi`.
  Al massimo due sintesi per fase; alla terza la fase fallisce con "contesto del modello esaurito".
  Con il contesto noto la soglia lascia spazio alla risposta e agli strumenti: è il minimo tra il 75 % e
  `context_tokens − max_tokens della risposta − definizioni degli strumenti`, e la stima confrontata
  comprende sempre gli strumenti. Se già `system + user` non entrano, la fase fallisce prima del primo
  giro ("mappa e appunti non entrano nel contesto del modello"); senza almeno un giro dopo l'ultima
  sintesi non se ne fa un'altra: la fase fallisce con "contesto del modello esaurito".
- **`ChatResult`** (`ai-gateway.ts`) acquista `cachedPromptTokens: number` (0 se il provider non lo
  riporta): letto da `usage.prompt_tokens_details.cached_tokens` (OpenAI/OpenRouter),
  `usage.prompt_cache_hit_tokens` (DeepSeek); `promptTokens` resta il totale.
- **Budget**: `budget.tokensUsed` conta i **token effettivi** = `(promptTokens − cachedPromptTokens) +
  completionTokens + cachedPromptTokens × CACHE_WEIGHT` con `CACHE_WEIGHT = 0,1` (costante documentata:
  il prezzo di lettura dalla cache dei provider usati va dal 10 % al 25 % del pieno). `analyses` e `runs`
  acquistano `cached_tokens` (integer, default 0) per mostrare quanto è andato in cache.
- **Costo**: `ai_models` acquista `price_cached_input_per_mtok` (nullable; dal catalogo LiteLLM
  `cache_read_input_token_cost`, da OpenRouter `pricing.input_cache_read`; `price_source` come gli altri).
  `computeCost` usa `cached × price_cached + (prompt − cached) × price_input + completion × price_output`;
  se `price_cached` manca, i token in cache si pagano a prezzo pieno (stima prudente, costo non null).
- La stima pre-analisi (`GET /api/ai/estimate`) resta come oggi ma il testo dice "stima senza cache: con
  provider che la supportano il costo reale è inferiore".

## 6. Prompt

- `SYSTEM_BASE`: aggiunge le regole "usa la mappa fornita; non rileggere ciò che è negli appunti; leggi
  file interi con `read_files` quando servono più file insieme; consegna `notes` utili alle fasi successive".
- Esempi in `prompts.ts` (verificati dai test) aggiornati con `notes`.

## 7. Migrazione DB

`docs/migrations/2026-10-lettura-efficiente.sql` (additiva, idempotente): `analyses.cached_tokens`,
`runs.cached_tokens`, `ai_models.price_cached_input_per_mtok`. Nessuna parte distruttiva. `docs/schema-casello.sql`
aggiornato.

## 8. Prove

- `repo-map.test.ts`: albero compresso sotto il tetto, esclusioni, punti d'ingresso, OpenAPI per tag;
  determinismo (stesso tree → stesso testo).
- `phase-loop.test.ts`: `notes` consegnate e riportate nelle fasi successive con troncamento; `read_files`
  con tetto; guardia sul contesto e passo di sintesi (modello finto); budget con token in cache pesati;
  nessuna modifica in loco dei messaggi (snapshot della cronologia tra due giri: prefisso identico).
- `executor.test.ts`: `cachedPromptTokens` da entrambe le forme di `usage`; `computeCost` con e senza
  prezzo di cache.
- Catalogo: i prezzi di cache entrano da fonti finte (`fake-sources.ts`).
- Collaudo reale: analisi di Mister con DeepSeek (cache automatica) e con Gemini Flash via OpenRouter;
  si registrano token effettivi, token in cache, giri per fase e costo. Pronto quando entrambe arrivano a
  `completed` sotto il budget predefinito e la revisione in console mostra elementi con `evidence` corrette.

## 9. Ordine di consegna

1. §4 letture grandi + `read_files` + `PHASE_MAX_ROUNDS` (piccolo, misurabile subito).
2. §2 mappa calcolata e nuove quote di fase.
3. §3 `notes` e dossier.
4. §5 fine della compattazione, guardia sul contesto, `cachedPromptTokens`, budget e costi (migrazione).
Dopo ogni passo: una analisi di prova su Mister e i numeri nel PR (token effettivi, cache, giri, costo).

## 10. Note di verifica sul codice (28 ottobre 2026, `main` a 9958ea2)

Costanti e funzioni citate confermate: `SOURCE_LIMITS.maxReadLines/maxReadChars` (200 / 10 000, in
`source-tree.ts`), `MAX_TOOL_OUTPUT_CHARS` 12 000, `PHASE_MAX_ROUNDS` 25, `PHASE_NUDGE_RATIO` 0,8,
`HISTORY_TOOL_OUTPUT_BUDGET` 24 000, `MAX_SEARCH_MATCHES` 200, `compactHistory` chiamata nel ciclo,
`PHASE_TOKEN_SHARES` (map 0,22 · capabilities 0,13 · catalog 0,18 · agents 0,13 · completion 0,13 ·
evolution 0,09), `MAX_COMPLETION_TOKENS` 16 000 in `run-analysis.ts`. Precisazioni per §5:
- `readUsage` (`ai-gateway.ts`) legge già `prompt_tokens_details.cached_tokens` (forma OpenAI/OpenRouter),
  ma il valore finisce solo nei log: `ModelChatResult` di `ai/executor.ts` e `ChatResult` di
  `ai-gateway.ts` non lo espongono. Manca la forma DeepSeek `prompt_cache_hit_tokens`.
- `computeCost(prompt, completion, priceInput, priceOutput)` è in `ai/executor.ts`: la firma va estesa
  con i token in cache e `priceCachedInput`.
- Le nuove quote di §2 (map 0,10; catalog 0,22; agents 0,17) con le altre invariate sommano a 0,84 (oggi
  0,88, volutamente sotto 1). Dalla mappa si tolgono 0,12 ma catalog e agents ne ricevono 0,08: i valori
  della spec si applicano così come sono, il commento di `PHASE_TOKEN_SHARES` va aggiornato a 0,84.
- `OpenApiOperation` non ha i tag: il "riepilogo per tag" di §2 si fa per risorsa (primo segmento del
  percorso dopo un eventuale `/api`).
