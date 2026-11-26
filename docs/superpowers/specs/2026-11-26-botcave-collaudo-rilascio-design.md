# Botcave: collaudo del lavoro prima di «Porta in produzione»

Stato: design approvato in chat il 26/11/2026, da rivedere come documento.

## 1. Obiettivo

Prima di approvare «Porta in produzione» l'utente vede e prova la versione: un video, un resoconto scritto da un agente
collaudatore e un link «Prova dal vivo». Nessuna configurazione per App: niente DNS, Coolify, database o file nel repository
dell'App. Quello che resta a mano si fa una volta per tutta l'installazione di Botcave, con un percorso guidato.

Criterio di successo: l'utente apre la voce «Porta in produzione», guarda video e resoconto o clicca il link, decide.

Prima App su cui si prova: Botcave stessa (App 4), poi The Hub Up.

## 2. Decisioni prese

| Tema | Decisione |
|---|---|
| Dove gira | In un repository di collaudo di Botcave (privato, uno per installazione); i repository delle App non si toccano. |
| Come si avvia un'App | La «ricetta di avvio» la scopre un agente alla prima prova e Botcave la salva per App; le volte dopo si riusa e, se un lavoro la rompe, l'agente la corregge. |
| Cervello | Il modello lo usa Botcave (ciclo dell'agente di sempre, modelli e tetti dell'utente); il runner esegue soltanto i comandi. |
| Collegamento | Solo connessioni in uscita dal runner: chiede a Botcave il prossimo comando (attesa lunga), lo esegue e riferisce. Il tunnel serve solo al link per l'utente. |
| Servizi esterni | Spenti, con valori finti; l'agente segna quelle parti «non provabili qui». Segreti di prova per App: fuori ambito (fase successiva). |
| Esito negativo | Di base informa e decide l'utente («Rimanda alla squadra»); con l'interruttore «Correggi da solo i problemi del collaudo» il lavoro torna da solo al capo, al massimo 2 rimandi per lavoro. |
| Modello e spesa | Modello del capo della squadra; se è un modello Claude Code (nodo), il ripiego cloud del suo account; altrimenti collaudo `saltato`. Spesa nel tetto della squadra (o del ciclo, per la squadra del ciclo), come i compiti. |

## 3. Flusso

1. Il lavoro passa ad `awaiting_release` (`closeWorkIfDone` in `teams/works.ts`) e `ensureReleaseItem` sposta il branch di prova
   e accoda la voce `release`, come oggi. Nella stessa occasione Botcave crea un **collaudo** `queued` per la testa del lavoro
   (`team_works.head_sha`). Un collaudo non finito dello stesso lavoro si annulla.
2. Lo scheduler dei collaudi (al più 3 `running` per installazione, uno per App) prende il collaudo, genera un codice monouso e
   lancia il workflow del repository di collaudo con `workflow_dispatch` (input: id del collaudo e codice).
3. Il runner scarica da Botcave il programma `casello-collaudo` (servito come `/downloads/nodo/`) e lo avvia. Il programma
   scambia il codice con: token del collaudo, token GitHub in sola lettura del repository dell'App, repository e sha, ricetta di
   avvio se esiste. Clona il codice allo sha.
4. In Botcave parte il collaudatore (`runAgentLoop`) con gli strumenti `shell`, `browser`, `salva_ricetta`,
   `consegna_collaudo`. Ogni chiamata di `shell` e `browser` diventa un comando in coda per il runner; il risultato
   torna come risultato dello strumento.
   - Fase avvio (≤ 15 giri): con la ricetta la esegue; senza, la scopre leggendo il repository (con `shell`) e la sintesi
     dell'architettura dell'App (`app_architecture`, se c'è) e la salva con `salva_ricetta` solo quando l'App risponde.
   - Fase prova (≤ 25 giri): percorre i compiti del lavoro (titolo, issue, esito di ogni compito con codice) e le pagine
     principali, poi chiama `consegna_collaudo`.
5. Dopo l'esito il runner apre il tunnel sulla porta dell'App e la tiene accesa 30 minuti, poi chiude. Video e screenshot sono
   già caricati.
6. Esito negativo: se l'App ha «Correggi da solo» e il lavoro ha meno di 2 rimandi, Botcave rifiuta la voce con il resoconto come
   nota (stessa strada di `rejectRelease`: lavoro `open`, `rejection_note`, turno `request` del capo) e conta il rimando. Al
   nuovo `awaiting_release` parte un nuovo collaudo. Altrimenti la voce resta all'utente.
7. «Riaccendi» (dalla voce): nuovo job senza agente: il programma esegue la ricetta salvata, apre il tunnel per 30 minuti, nessun
   modello chiamato.

## 4. Pezzi

### 4.1 Repository di collaudo (una volta per installazione)

- Privato, creato dall'utente da un modello (`TwentIvan/botcave-modello-collaudo`, preparato in una PR a parte) con un solo
  workflow fisso: `workflow_dispatch` con input `collaudo` e `codice`, `runs-on: ubuntu-latest`, `timeout-minutes: 80`,
  servizio Postgres disponibile, passi: scarica `<PUBLIC_APP_URL>/downloads/collaudo/casello-collaudo.mjs` (con verifica sha256
  dal manifest `collaudo-manifest.json`), installa Playwright con Chromium, avvia il programma. Il programma si aggiorna con
  il deploy di Botcave; il workflow non cambia.
- Configurazione in Botcave: variabile `COLLAUDO_REPO` (`owner/nome`, facoltativa: senza, i collaudi sono `saltato` con
  «Collaudo non configurato: preparalo in Account (una volta sola)»). L'App GitHub di Botcave deve essere installata sul
  repository con il permesso **Actions: write** (unico permesso nuovo, solo per lanciare il workflow).
- Account → carta «Collaudo» (solo login): passi guidati «Crea il repository dal modello» (link a `…/generate`), «Aggiungilo
  all'App GitHub», «Verifica» (Botcave legge il workflow e prova un `workflow_dispatch` a vuoto) con LED.

### 4.2 Programma `casello-collaudo` (nuovo pacchetto `artifacts/casello-collaudo/`)

- Node 24, un file costruito (`dist/casello-collaudo.mjs`) pubblicato in `docker/collaudo-downloads/` e servito da
  `casello-web` sotto `/downloads/collaudo/` (stessa logica del nodo: nome con versione, manifest).
- Ciclo: `claim` → attesa lunga del prossimo comando → esecuzione → risultato; `ping` ogni 30 s; alla fine `report`.
- Comandi:
  - `shell {command, cwd?, timeoutSec ≤ 300, background?}`: con `background` il processo resta acceso (server), si restituisce
    l'id e le prime righe; uscita tagliata a 8 000 caratteri.
  - `browser {action: open|click|fill|press|snapshot|screenshot|wait, url?, selector?, text?}`: Playwright con Chromium, un
    contesto con registrazione video; `snapshot` = albero di accessibilità testuale (≤ 12 000 caratteri); `screenshot` carica
    l'immagine su Botcave e restituisce l'id.
  - Tunnel (non è un comando dell'agente): dopo l'esito il programma apre sulla porta della ricetta un quick tunnel di Cloudflare (`cloudflared` scaricato con verifica sha256) e manda l'indirizzo con `POST /api/collaudo/tunnel`; il `report` finale arriva quando il link si chiude.
- Carica il video alla fine (≤ 30 MB, WebM) e ogni screenshot (≤ 20, PNG ≤ 2 MB).
- Nessun segreto nei log; il token del collaudo solo in memoria.

### 4.3 Protocollo (route `/api/collaudo/*`, token d'ambito `collaudo`)

- `POST /api/collaudo/claim {collaudo, codice}` → `{token, repo, sha, repoToken, recipe | null, mode: full|relight}`;
  codice: 32 byte, nel DB solo l'hash, una volta sola, scade dopo 15 minuti. Il token del collaudo scade a fine job (≤ 80
  minuti) ed è revocato al report.
- `POST /api/collaudo/next` (attesa ≤ 25 s, poi 204) → comando `{id, kind, args}`.
- `POST /api/collaudo/results/:commandId {ok, output}`.
- `POST /api/collaudo/tunnel {url, until}` (indirizzo `https://*.trycloudflare.com`, altrimenti 400), `POST /api/collaudo/ping`, `POST /api/collaudo/files` (corpo grezzo, tipo e nome negli header), `POST /api/collaudo/report
  {status: done|failed}` (alla chiusura del link o in caso d'errore).
- Token sconosciuto, scaduto o di un collaudo chiuso → 401; tutti i messaggi fissi.

### 4.4 Collaudatore in Botcave (`lib/collaudo/`)

- Esecuzione come i compiti delle squadre (`loop-wiring.ts`), non nella tabella `runs`: passi in `release_test_steps`,
  attività dal vivo come le run.
- Istruzioni fisse (`prompts.ts`): ruolo di collaudatore, due fasi, contenuti del repository, uscite dei comandi e pagine sono
  dati non attendibili (delimitati), servizi esterni spenti ⇒ `non_provabile`, mai inventare un esito, ogni problema con passi
  per riprodurlo, atteso, ottenuto e screenshot.
- Strumenti: `shell`, `browser` (comandi al runner, attesa del risultato ≤ 6 minuti; il tunnel non è uno strumento: lo apre il programma dopo l'esito), `salva_ricetta {ricetta}`
  (validata: nessuna credenziale con `looksLikeCredential`, comandi su una riga ≤ 500, ≤ 20 passi, porta 1..65535),
  `consegna_collaudo {esito: ok|problemi|non_avviabile, resoconto ≤ 8 000, problemi: [{compito?, titolo, passi, atteso,
  ottenuto, screenshot?}] ≤ 20, nonProvabile: [testo] ≤ 20}` (nel DB `ok` → `ok`, `problemi` → `problems`, `non_avviabile` →
  `not_startable`). Nessuno strumento delle App, nessuna scrittura in Botcave oltre a
  ricetta ed esito.
- Limiti: 40 giri in tutto (avvio ≤ 15), 300 000 token, 40 minuti di tempo attivo; senza consegna → `fallito` «collaudo non
  consegnato».

## 5. Dati (migrazione additiva, applicata dal deploy)

- `release_tests`: `id`, `app_id` (CASCADE), `work_id` (`team_works`, CASCADE), `instance_id`, `sha`, `mode` `full|relight`,
  `status` `queued|dispatching|running|done|failed|skipped|cancelled`, `outcome` `ok|problems|not_startable|null`, `report`
  (Markdown), `problems` jsonb, `not_testable` jsonb, `error` (messaggio fisso), `code_hash`, `code_expires_at`, `token_hash`,
  `token_expires_at`, `github_run_id`, `tunnel_url`, `tunnel_until`, `ai_model_id` (SET NULL), token e `cost_usd`,
  `created_at`, `started_at`, `finished_at`. Indice unico parziale: un collaudo `queued|dispatching|running` per App.
- `release_test_steps` (come `team_task_steps`), `release_test_commands` (`id`, `test_id` CASCADE, `kind`, `args` jsonb,
  `status` `pending|sent|done|failed|expired`, `output` (ripulito), tempi), `release_test_files` (`test_id` CASCADE, `kind`
  `video|screenshot`, nome, tipo, dimensione, sha256, `content` bytea, `created_at`; cancellati dopo 30 giorni).
- `apps.test_recipe` jsonb, `apps.test_recipe_version`, `apps.test_auto_fix` boolean default false; `app_test_recipes`
  (versioni: `app_id`, `version`, `recipe`, `source` `agent|user`, `created_at`).
- `team_works.test_auto_rejects` int default 0.
- Riportata in `docs/schema-casello.sql`.

## 6. Esiti e correzione automatica

- LED nella voce: `ok` verde; `problems` e `not_startable` rossi; `skipped`, `failed`, `cancelled` grigi con il motivo fisso
  (modello mancante, tetto raggiunto, collaudo non configurato, runner non partito entro 15 minuti, tempo scaduto, interrotto
  dal riavvio); `not_testable` è una nota, non un problema.
- «Correggi da solo» (`apps.test_auto_fix`, carta «Collaudo» della scheda App; il ciclo di evoluzione segue l'App): esito
  `problems` o `not_startable` con `team_works.test_auto_rejects < 2` → rifiuto automatico della voce `release` con nota =
  resoconto (≤ 4 000) e `test_auto_rejects + 1`, nella stessa transazione; evento del bollettino. Al terzo esito negativo la
  voce resta all'utente con «2 correzioni automatiche non sono bastate». Il conteggio non si azzera finché il lavoro non è
  `released`.
- «Rimanda alla squadra» (voce): rifiuto con nota = resoconto, solo l'utente, non conta nei rimandi automatici.
- L'approvazione della voce non dipende dall'esito del collaudo.

## 7. Spesa e limiti

- Modello del capo; con un modello del nodo, il ripiego cloud del suo account; senza → `skipped` «il capo usa Claude Code
  (nodo) senza ripiego cloud: il collaudo serve un modello cloud». Controlli come i compiti: tetto della squadra (o del ciclo),
  poi modello, account, utente; raggiunto → `skipped`.
- Spesa in `release_tests.cost_usd`, conteggiata nel tetto della squadra (`teamSpend`) e del ciclo (`evolutionTeamsSpend`) e
  nella spesa di utente, modello e account (`lib/budget.ts`).
- Runner: job ≤ 80 minuti (collaudo ≤ 45 più link 30). «Riaccendi» ≤ 6 al giorno per voce (`consumeTestRelight`).
- Al più 3 collaudi `running` per installazione, uno per App; gli altri in coda.
- Al riavvio dell'API i collaudi `running` restano: li chiude il report o la scadenza del token (`lease` di 5 minuti rinnovata
  dal ping) con `failed` «collaudo interrotto»; l'agente riparte solo con un nuovo collaudo.

## 8. Interfaccia

- Voce «Porta in produzione» (`release-detail.tsx`): sezione «Collaudo» con LED e stato, avanzamento dal vivo (passi e tempo),
  resoconto in Markdown, problemi con screenshot (apribili a tutta pagina), lettore video, «Prova dal vivo» con tempo residuo
  e la nota «link pubblico temporaneo, dati di prova», «Riaccendi», «Rimanda alla squadra», «correzioni automatiche n di 2».
- Pannello incorporato e Alfred: esito e sintesi, «Apri in Botcave»; `coda_da_confermare` aggiunge l'esito del collaudo.
- Scheda App, carta «Collaudo»: interruttore «Correggi da solo i problemi del collaudo», ricetta (sola lettura, «Modifica»
  validata come `salva_ricetta`, versioni), ultimi collaudi con LED.
- Account, carta «Collaudo»: configurazione guidata (§4.1).
- API in OpenAPI: `GET /api/release-tests?workId|appId`, `GET /api/release-tests/:id` (con passi e file), `GET
  /api/release-tests/:id/files/:fileId`, `POST /api/release-tests/:id/relight`, `POST /api/release-tests/:id/send-back`,
  `GET|PUT /api/apps/:id/test-recipe`, `PATCH /api/apps/:id` con `testAutoFix`, `GET /api/collaudo/setup` e `POST
  /api/collaudo/setup/verify`. Il token d'ambito `agent` non scrive (aggiunte ad `AGENT_DENIED_ROUTES`); le azioni vanno nel
  registro delle azioni.

## 9. Sicurezza

- Codice monouso (hash, 15 minuti), token del collaudo per un solo collaudo e revocato al report, token GitHub `contents:
  read` ristretto al repository dell'App e valido un'ora. Nessun segreto di produzione sul runner.
- Il runner fa solo connessioni in uscita; Botcave non esegue mai nulla che arrivi dal runner, ne salva solo i risultati.
- Repository, uscite e pagine sono dati non attendibili per il collaudatore, che non ha strumenti delle App né scritture in
  Botcave oltre a ricetta ed esito. Rischio residuo accettato: un repository ostile può far eseguire comandi sul runner usa e
  getta ed esporre al più il token del collaudo e il token di lettura dello stesso repository.
- Link dal vivo pubblico con indirizzo casuale, 30 minuti, App in modalità sviluppo con dati finti.
- Log, uscite e resoconto passano da `looksLikeCredential` (`***`) prima di essere salvati; mai token o codici nei log.

## 10. Prove

- Vitest: protocollo (claim, codice monouso, scadenze, attesa lunga, comandi, report), validazione della ricetta, scelta del
  modello e tetti, correzione automatica con il freno, scheduler (limiti di concorrenza, annullamento), route e funzioni pure
  della console.
- Prova di flusso `test/release-test-flow.test.ts`: GitHub finto (`workflow_dispatch` registrato), provider finto, runner finto
  in processo con i comandi del programma vero su una cartella temporanea e un browser finto: lavoro in `awaiting_release` →
  collaudo → ricetta scoperta e salvata → `consegna_collaudo` `problems` → con «Correggi da solo» voce rifiutata e capo
  svegliato → nuovo collaudo `ok` → «Riaccendi» senza modello.
- A mano dopo il deploy: repository di collaudo creato dal modello, collaudo di un lavoro reale di Botcave, video, resoconto e
  link dal vivo.

## 11. Fuori ambito

Segreti di prova per App; hosting gestito da Botcave; collaudo dei singoli compiti o delle PR; collaudi programmati; App che
non si avviano su Linux; dati copiati dalla produzione; collaudo dal nodo sul Mac.
