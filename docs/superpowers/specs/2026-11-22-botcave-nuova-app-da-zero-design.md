# Nuova app da zero — tappa 1 (issue #143)

Stato: bozza da approvare. La tappa 2 (infrastruttura automatica) è fuori da questa spec.

## Obiettivo

Oggi «Nuova app» registra un'app che esiste già. La tappa 1 aggiunge la nascita di un'app da zero:

1. l'utente crea il repository dal modello su GitHub;
2. lo indica in Botcave;
3. approva una sola voce in «Da confermare».

Dopo l'approvazione Botcave personalizza il repository, registra l'App con il suo Responsabile, avvia l'analisi dell'architetto sul brief e mostra la lista di ciò che resta da fare a mano per il primo deploy.

La tappa si chiude quando Portfolio nasce da questo flusso, cioè quando:
- il repository è creato;
- l'App è registrata;
- il piano iniziale è generato;
- la prima PR di una squadra è unita con la CI verde;
- `https://portfolio.fantamister.cloud/api/healthz` risponde.

## Risposte alle domande aperte

| Domanda | Risposta per la tappa 1 | Perché |
|---|---|---|
| Dove sta il modello e come si chiama | `TwentIvan/botcave-modello-app`, privato e segnato come «Template repository». Il nome si configura con `APP_TEMPLATE_REPO` (default quello). | Nome che dice cosa è, accanto alle altre app. Privato perché nasce dalla struttura di Mister e Botcave. |
| Chi crea il modello | Ivan, su GitHub, vuoto. Il contenuto lo preparo io in una PR verso quel repository. Ivan poi lo segna come modello e lo aggiunge all'installazione dell'App GitHub «Casello». | Il token d'installazione non crea repository su un account personale. In alternativa, con un sì esplicito, lo creo io con `gh` a nome tuo. |
| Dominio | Sempre `<slug>.fantamister.cloud`, calcolato dal codice e non modificabile nel modulo. La base si configura con `APP_BASE_DOMAIN` (default `fantamister.cloud`). | Vincolo «nomi calcolati dal codice». Un dominio diverso resta fuori perimetro (DNS gestiti altrove). |
| Neon: un progetto per app o uno condiviso | Un progetto per app, nella lista guidata. In tappa 2 vanno ricontrollati limiti e prezzi del piano corrente prima di automatizzare. | Isolamento dei dati e rimozione semplice. Un database in un progetto condiviso lega le app tra loro (backup, limiti, credenziali). |
| Versione di prova | In tappa 2. | Richiede un terzo servizio su Coolify e un altro dominio: è infrastruttura. In tappa 1 la squadra lavora con la CI, e «Porta in produzione» con la versione di prova arriva dopo. |
| `EMBED_ALLOWED_ORIGINS` nel database | No, resta una variabile. Nella lista guidata diventa un punto che Botcave controlla da solo leggendo la propria configurazione. Lo spostamento nel database è un'issue a parte. | La CSP `frame-ancestors` di `/embed` la calcola nginx all'avvio di `casello-web`: portarla nel database cambia come la pagina `/embed` viene servita. È un lavoro di sicurezza da solo. |
| Creare il repository su un account personale (tappa 2) | Resta aperta per la tappa 2. | La tappa 1 non la richiede. |

## Il repository modello

Contenuto, ricavato da Mister e da Botcave (pnpm 10, Node 24):

- `pnpm-workspace.yaml` con `minimumReleaseAge`.
- `artifacts/api-server`: Express 5, `GET /api/healthz`, migrazioni additive applicate all'avvio prima di `listen`. È una copia ridotta di `lib/migrations/` di Botcave: registro, lock, ordine per nome, `-post` esclusi.
- `artifacts/__SLUG__-web`: Vite e React, con la riga del plugin già in `index.html`:
  `<script src="https://casello.fantamister.cloud/embed/v1/botcave.js" data-app="__SLUG__" defer>`.
- `lib/db` (Drizzle), `lib/api-spec` (`openapi.yaml` con il solo `healthz`), `lib/api-client-react` (codegen Orval).
- `docs/migrations/` con una prima migrazione vuota.
- `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/nginx.conf.template` (SPA e proxy di `/api/` verso `__SLUG__-api:3000`).
- `.github/workflows/deploy.yml`: test e typecheck; immagini `ghcr.io/<owner>/<repo>-api` e `-web`; `:latest` e deploy solo da `main`; sola build su `feat/**` e `botcave/**`.
  - Il workflow **non contiene lo slug**: ricava i nomi da `github.repository`, portato in minuscolo.
  - Il deploy si salta, verde e con un avviso, finché mancano i segreti `COOLIFY_TOKEN`, `COOLIFY_WEBHOOK_API`, `COOLIFY_WEBHOOK_WEB`.
  - Così Botcave non deve mai scrivere in `.github/workflows/`, che resta vietato, e il primo commit su `main` non fa una CI rossa.
- `CLAUDE.md` con le regole del repository e `__APP_NAME__`; `AGENT_BRIEF.md` segnaposto.
- `.botcave/modello.json` `{"template": "botcave-modello-app", "version": 1}`: marcatore che il modello lo riconosce.

**Segnaposto**: `__SLUG__`, `__APP_NAME__` e `__DOMAIN__`, nei percorsi e nel testo dei file. Fuori da `.github/` e dal marcatore. Al più 200 file di testo da 1 MiB.

## Flusso

### 1. Modulo «Da zero»

In «Nuova app» una scelta in alto: «App esistente» (il modulo di oggi) o «Da zero». Campi:

- **Nome**, da 1 a 80 caratteri.
- **Slug**: formato di oggi `^[a-z0-9][a-z0-9-]{0,63}$`, unico tra le App. Non può essere `casello`.
- **Dominio**: mostrato, non modificabile.
- **Brief** in Markdown: da 1 a 20 000 caratteri, senza credenziali (`looksLikeCredential`).
- **Repository**: scelto da `GET /api/github/repos`. Deve chiamarsi esattamente come lo slug. Se non compare c'è un aiuto con «Usa il modello su GitHub» (link a `https://github.com/<APP_TEMPLATE_REPO>/generate`) e «Ricollega GitHub», che aggiorna l'elenco dei repository visibili.
- **Modello AI** per il Responsabile e per l'analisi: preselezionato con il predefinito, solo cloud.

«Prepara» manda `POST /api/app-bootstraps` e risponde con il numero della voce in coda. Il form avvisa: «Nulla viene scritto prima dell'approvazione in Da confermare».

Controlli alla richiesta, con 400 o 409 e messaggi fissi:
- slug libero e repository = slug;
- repository nell'elenco dell'utente (`userRepoAccess`);
- nessun'altra richiesta aperta per lo stesso slug o repository.

### 2. Voce in «Da confermare»

Tipo nuovo `app_bootstrap` di `pending_action_kind`. Una sola voce, con i passi e i nomi esatti:

1. verifica del repository (installazione, modello, `main` intatto);
2. commit «Inizializza <nome>» su `main`, con i file cambiati e quelli rinominati;
3. App `<slug>` con `base_url` `https://<dominio>`, sorgente GitHub su `main`, descrizione funzionale = brief, Responsabile con il modello scelto;
4. analisi dell'architetto, con la stima di costo di `GET /api/ai/estimate`;
5. lista guidata.

La voce dice anche cosa resterà a pagamento ogni mese: «in tappa 1 nulla: Neon e Coolify li crei tu (lista guidata)». Approvare non vuole token utente; rifiutare chiude la richiesta.

### 3. Esecuzione

I passi sono ripetibili e registrati in `app_bootstraps.steps`. Dopo un errore «Riprova» riparte dal passo fallito.

1. **Verifica.**
   - Token d'installazione con `contents: read`, ristretto al repository: se non si ottiene, «l'App GitHub non vede il repository: aggiungilo all'installazione».
   - Il marcatore `.botcave/modello.json` deve esserci e, se GitHub lo espone, `template_repository.full_name` deve essere `APP_TEMPLATE_REPO`. Altrimenti «il repository non è nato dal modello».
   - `main` deve avere un solo commit, oppure avere già il commit di inizializzazione di Botcave (ripresa). Altrimenti «il repository non è più quello appena creato: ricrealo dal modello».
2. **Personalizzazione.** Lettura del tree, sostituzione dei segnaposto (anche nei percorsi), `AGENT_BRIEF.md` = brief, controllo dei segreti (`secrets-check.ts`), un commit su `main` con la Git Data API e `force: false`, token `contents: write`.
   - È l'unica scrittura di Botcave sul branch base fuori da «Porta in produzione». È ammessa solo su un repository con il solo commit del modello: serve una funzione dedicata, `initializeRepo`, non l'eccezione `assertTaskBranch`.
   - Se il commit di inizializzazione c'è già, il passo si salta.
3. **Registrazione.**
   - App con slug, nome, `base_url`, `source_repo`, `source_installation_id`, `source_branch = main`, `functional_description` = brief.
   - Responsabile creato come per ogni App nuova, con il modello scelto.
   - Se l'App esiste già, creata da questa richiesta, il passo si salta. Se lo slug è stato preso da altri nel frattempo, il passo fallisce.
4. **Analisi.** Analisi cloud completa con il modello scelto, come «Analizza» dalla scheda App. Se il tetto di spesa è raggiunto il passo fallisce: «Riprova» dopo aver alzato il tetto. L'analisi già creata non si ricrea.
5. **Fine.** Voce `done` «App <nome> pronta: completa la lista guidata». Una qualsiasi failure lascia la voce `failed` con il passo e il messaggio fisso. Nulla si cancella: l'esito elenca cosa è stato creato (commit, App, analisi).

Al riavvio un bootstrap in corso diventa `failed` «interrotto dal riavvio», con il passo noto, e si riprende con «Riprova».

### 4. Lista guidata

Carta «Primo deploy» nella scheda App, solo per le App nate da zero. Le voci si segnano a mano, tranne quelle verificate da Botcave:

1. Progetto Neon `<slug>`, con la `DATABASE_URL` diretta.
2. Servizio Coolify `<slug>-api`: immagine `ghcr.io/twentivan/<slug>-api:latest`, porta 3000, solo rete interna, health check `/api/healthz`, variabili (elenco esatto).
3. Servizio Coolify `<slug>-web`: immagine `-web`, dominio `<dominio>`.
4. Segreti GitHub Actions `COOLIFY_TOKEN`, `COOLIFY_WEBHOOK_API`, `COOLIFY_WEBHOOK_WEB`.
5. `https://<dominio>` in `EMBED_ALLOWED_ORIGINS` di `casello-api` e `casello-web` e nuovo deploy di Botcave. **Verificata da Botcave**, che legge la propria variabile.
6. Primo deploy raggiungibile: `GET https://<dominio>/api/healthz` → 200. **Verificata da Botcave** ogni 10 minuti finché non riesce, con lo scaricatore di pagine a DNS guardato (`fetchPage`), più «Controlla ora».

Con l'ultima voce verde la carta si chiude e resta come riepilogo. Testi con i nomi esatti calcolati dallo slug e pulsante «Copia».

## Dati

Migrazione additiva `docs/migrations/2026-11-22-nuova-app-da-zero.sql`, applicata dal deploy:

- **Valore `app_bootstrap`** di `pending_action_kind`.
- **Tabella `app_bootstraps`**:

  | Colonna | Contenuto |
  |---|---|
  | `id` | identificativo |
  | `user_id` | chi ha chiesto |
  | `slug`, `name`, `domain` | nomi dell'app |
  | `repo`, `installation_id` | repository e installazione |
  | `brief` | testo del brief |
  | `ai_model_id` | modello scelto |
  | `status` | `pending`, `running`, `done`, `failed`, `rejected` |
  | `steps` | jsonb: passo, stato, esito |
  | `init_commit_sha` | commit di inizializzazione |
  | `app_id` | App creata |
  | `analysis_id` | analisi avviata |
  | `pending_action_id` | voce in coda |
  | `checklist` | jsonb: voce → segnata il, da |
  | `health_ok_at`, `health_checked_at` | esito del controllo di `healthz` |
  | `created_at`, `updated_at` | date |

- **Indice unico parziale** su `slug` e su `repo` tra le richieste non `rejected` e non `failed` chiuse.

## API

| Route | Cosa fa |
|---|---|
| `POST /api/app-bootstraps` | crea la richiesta e la voce (solo login: crea una voce e lega un repository) |
| `GET /api/app-bootstraps/:id` | stato e passi |
| `GET /api/apps/:id/bootstrap` | richiesta di un'App, con la lista guidata |
| `POST /api/app-bootstraps/:id/retry` | riprende dal passo fallito (solo login) |
| `PUT /api/app-bootstraps/:id/checklist/:item` | `{done}`, solo voci manuali |
| `POST /api/app-bootstraps/:id/health-check` | 6 al minuto |

Il token d'ambito `agent` riceve 403 su tutte le scritture. Errori `{error}` con `APP_BOOTSTRAP_MESSAGES`. OpenAPI e codegen come sempre.

## Sicurezza

- Nessun nome lo sceglie un modello: repository, immagini, servizi e dominio derivano dallo slug.
- Il brief è dato dell'utente:
  - finisce in `AGENT_BRIEF.md` e nella descrizione funzionale, già trattata come «dati, non istruzioni» nei prompt;
  - prima del commit passa dal controllo dei segreti.
- Nessuna credenziale nuova in tappa 1: bastano i permessi attuali dell'App GitHub (Contents read & write).
- L'unica scrittura nuova sul branch base è vincolata a un repository appena creato dal modello.
- Log: solo id, slug, sha a 7 caratteri ed esiti; mai brief né contenuti.

## Prove

- Vitest di sostituzione dei segnaposto (puro), verifica del repository, esecuzione dei passi con ripresa, route, lista guidata e controllo di `healthz` con finto GitHub e DNS finto.
- Prova di flusso `test/app-bootstrap-flow.test.ts`: modulo → voce → approvazione → commit → App con Responsabile → analisi in coda → errore simulato al passo 3 e «Riprova».
- Console: funzioni pure del modulo e della lista.
- Dopo il deploy: Portfolio reale.

## Fuori ambito

- Tutta la tappa 2: creazione del repository, Neon, Coolify, segreti, versione di prova, primo deploy automatico.
- Stack diversi, migrazione di app esistenti, domini diversi da `<slug>.<APP_BASE_DOMAIN>`.
- Origini del plugin nel database: issue a parte.
