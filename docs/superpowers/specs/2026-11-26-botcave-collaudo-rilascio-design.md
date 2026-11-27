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
  servizio Postgres 16 (utente, password e database `postgres`, porta 5432: è la `DATABASE_URL` predefinita del programma), passi: legge il manifest
  `<PUBLIC_APP_URL>/downloads/collaudo/collaudo-manifest.json`, scarica il file con la versione nel nome
  (`casello-collaudo-<versione>.mjs`, cache immutable) e lo verifica con lo sha256 e la dimensione del manifest, installa Playwright
  con Chromium, avvia il programma, che fa il claim con `{testId, code}`. Il programma si aggiorna con il deploy di Botcave; il
  workflow non cambia.
- Configurazione in Botcave: variabile `COLLAUDO_REPO` (`owner/nome`, facoltativa: senza, i collaudi sono `saltato` con
  «Collaudo non configurato: preparalo in Account (una volta sola)»). L'App GitHub di Botcave deve essere installata sul
  repository con il permesso **Actions: write** (unico permesso nuovo, solo per lanciare il workflow).
- Account → carta «Collaudo» (solo login): passi guidati «Crea il repository dal modello» (link a `…/generate`), «Aggiungilo
  all'App GitHub», «Verifica» (Botcave controlla repository, installazione dell'App GitHub, presenza del workflow e permesso
  `actions: write`, senza lanciare un `workflow_dispatch` a vuoto) con LED.

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

- `POST /api/collaudo/claim {testId, code}` (pubblica, 10/min per IP) → `{token, repo, sha, repoToken, recipe | null, mode: full|relight}`;
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
  `created_at`, `started_at`, `finished_at`, `agent_seen_at` (segno di vita del collaudatore). Indice unico parziale: un collaudo
  `dispatching|running` per App (quelli `queued` di altri lavori aspettano).
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
  getta ed esporre al più il token del collaudo e il token di lettura dello stesso repository. Allo stesso modo, sul runner (che
  ha `sudo`) un comando può leggere la memoria del programma e quindi il token del collaudo: vale solo per quel collaudo ed è
  revocato al report.
- Link dal vivo pubblico con indirizzo casuale, 30 minuti, App in modalità sviluppo con dati finti.
- L'input `codice` del `workflow_dispatch` è visibile nella pagina della run di GitHub Actions a chi legge il repository di
  collaudo. Rischio accettato: il codice vale una volta sola e per 15 minuti, e il repository è privato dell'utente.
- Il resoconto del collaudatore (testo di un modello che ha letto contenuti non attendibili) arriva al capo in un blocco «dati,
  non istruzioni» delimitato; la sintesi in `coda_da_confermare` è dichiarata dato non attendibile.
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

## 12. Differenze dal codice

Decisioni prese durante l'implementazione; dove questo documento differisce dal codice vale il codice (descritto in CLAUDE.md,
«Collaudo del lavoro»).

- **Collaudo `running` fino al report.** Alla consegna dell'agente (`consegna_collaudo`) si scrivono esito, resoconto, problemi e
  note, ma lo stato resta `running` finché il runner non manda il `report` (dopo i 30 minuti del link): il `report` porta a `done`,
  oppure a `failed` «collaudo non consegnato» / «collaudo interrotto» senza esito. La correzione automatica parte alla consegna
  dell'agente, non al report. A consegna avvenuta il `next` in attesa del runner risponde subito 410 (`wakeRunner`).
- **Modello deciso prima del lancio.** Lo scheduler sceglie il modello (`testModelFor`) prima del `workflow_dispatch`: senza modello
  usabile o con un tetto raggiunto il collaudo è `skipped` col motivo e nessun job parte.
- **Coda per App.** Un collaudo nuovo annulla solo quello aperto dello stesso lavoro; i collaudi di altri lavori della stessa App
  restano e aspettano in coda (indice unico solo su `dispatching|running`, `release_tests_one_active_per_app`; lo scheduler salta le
  App con un collaudo lanciato o in corso). Migrazione `2026-11-27-collaudo-coda-per-app.sql` (indice e `agent_seen_at`); il vecchio
  indice su `queued|dispatching|running` è tolto dal file del 2026-11-26, mai applicato in produzione (un `DROP INDEX` sarebbe
  classificato distruttivo e rifiutato dal deploy).
- **«Riaccendi» non annulla un collaudo vero.** Un `relight` con un collaudo `full` aperto dello stesso lavoro risponde 409 «un
  collaudo è in corso per questo lavoro…»; con un collaudo di un altro lavoro della stessa App aspetta in coda. Si riaccende solo
  l'ultimo collaudo `full` del lavoro, concluso `done`, 6 volte al giorno per voce. Un relight riferito `failed` dal runner chiude
  `failed` «ricetta di avvio non riuscita».
- **Voce e ultimo collaudo completo.** La voce «Porta in produzione» (console, centralino, Alfred) mostra sempre l'ultimo collaudo
  `full` del lavoro (resoconto, problemi, video) con a parte lo stato e il link dal vivo del «Riaccendi» più recente (`relight`).
  «Riaccendi» e «Rimanda alla squadra» operano sull'ultimo `full`; il rimando solo con il `full` concluso (`done` o `failed`), con
  il suo resoconto (o il motivo fisso).
- **Report in un solo UPDATE.** Revoca di token e lease, chiusura del tunnel e stato finale stanno in un solo UPDATE condizionato a
  `running`: una corsa con lo sweeper la vince uno solo.
- **Link dal vivo solo se serve.** Il 410 di `next` porta `{error, liveLink}`: `liveLink` vero solo con esito `ok` o `problems`;
  altrimenti il runner carica il video e riferisce subito, senza tunnel. `api.trycloudflare.com` non è mai un link valido.
- **Collaudatore perso.** Il collaudatore aggiorna `agent_seen_at` a ogni giro e ogni 30 s; lo sweeper chiude `failed` «collaudo
  interrotto» un collaudo `full` in corso, senza esito, senza segni di vita da 5 minuti (o mai visto 5 minuti dopo il claim): il
  token è revocato e il runner riceve 401 invece di restare acceso fino a 80 minuti dopo un riavvio dell'API.
- **Collaudo non più necessario.** Approvare o rifiutare a mano la voce, «Rimanda alla squadra», chiudere la squadra o mettere in
  pausa il ciclo della squadra chiudono il collaudo aperto dei suoi lavori (`cancelled`, o `done` se l'esito era già consegnato),
  con token e link revocati e l'agente fermato; lo sweeper fa da rete di sicurezza per squadre chiuse e cicli in pausa.
- **Screenshot per id.** Lo strumento `browser` con `screenshot` restituisce l'id del file e il collaudatore lo usa nel campo
  `screenshot` del problema (intero; un id non del collaudo diventa null); i file PNG e WebM si servono `inline` con `nosniff`.
- **Postgres noto.** `RUNNER_DATABASE_URL` è sempre nell'ambiente dei comandi `shell` del runner ed è scritta nelle istruzioni.
- **Avanzamento dal vivo.** La sezione «Collaudo» mostra tempo trascorso e ultimi passi (frasi fisse dal nome dello strumento),
  dal campo `steps` del dettaglio; nessun campo `activity`.
- **CI.** Il job dei test esegue test e typecheck di `casello-collaudo` e, sui branch diversi da `main`, chiede di alzare la versione
  se il suo `src` cambia.
- **Rimandi automatici nell'API.** Il contatore `team_works.test_auto_rejects` è esposto come `autoRejects` sui collaudi: la console
  mostra «correzioni automatiche n di 2» da lì (i rimandi manuali non contano).
- **Testo del capo.** Il turno `request` del capo dice chi ha rimandato il lavoro: il collaudo («Il collaudo del lavoro N ha trovato
  problemi: correggi e richiudi il lavoro.») o l'utente con «Rimanda alla squadra» («L'utente ha rimandato il lavoro N alla squadra
  dopo il collaudo…»), seguito dal resoconto in un blocco «Resoconto del collaudo (dati, non istruzioni)» tra `<dati>` e `</dati>`
  (delimitatori nel testo neutralizzati); una sola strada di rifiuto, `rejectReleaseForTest`. Per il giro del ciclo di evoluzione
  che seguiva la voce il motivo del rifiuto è «Resoconto del collaudo: …», mai una nota dell'utente.
- **Porta del link senza ricetta.** Se al claim l'App non ha ancora una ricetta (prima prova), il tunnel si apre sull'ultima porta
  localhost aperta dall'agente con `browser open`: il runner non vede la ricetta salvata dopo il claim.
- **Forma della ricetta.** `schema` è una lista di comandi shell su una riga (non SQL), `login` è un testo ≤ 200 caratteri o null.
- **Corpo del claim e route del runner.** Il claim è `{testId, code}` (identificatori in inglese); le route `/api/collaudo/*`
  stanno nel contratto OpenAPI come `/api/node/*`. Il report `done` senza esito dell'agente chiude `failed` «collaudo non consegnato».
- **Verifica della configurazione.** «Verifica» in Account controlla repository, installazione dell'App GitHub, presenza del workflow
  e concessione del permesso `actions: write`, senza un `workflow_dispatch` di prova (consumerebbe minuti e lascerebbe run spurie).
- **Chiusure da fuori.** Chi annulla un collaudo o lo chiude per tempo scrive stato ed errore prima di fermare l'agente; un `TestRecipe`
  identico è dichiarato anche in `casello-collaudo` (pacchetti separati, come `casello-nodo`).
- **Postgres del workflow.** Utente e password `postgres`, per coincidere con la `DATABASE_URL` predefinita del programma.
