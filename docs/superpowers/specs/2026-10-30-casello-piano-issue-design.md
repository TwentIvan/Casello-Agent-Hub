# Casello: dal piano alle issue (design)

Data: 2026-10-30. Sottoprogetto 2 del percorso «dalle analisi alle implementazioni».

## 1. Scopo

Le voci approvate del piano di un'app (capitoli endpoint, completamento, evoluzione; dell'architetto o della chat
del piano) oggi si esportano come markdown da copiare a mano su GitHub. Casello le crea invece direttamente come
issue nel repository dell'app, ricorda il collegamento voce ↔ issue e ne rilegge lo stato.

Chi lavora le issue oggi è l'utente con Claude Code («ogni lavoro parte da una GitHub Issue»); domani potranno
prenderle in carico squadre di agenti. Per questo: una issue per voce, dipendenze come riferimenti `#numero`,
collegamento e stato salvati in Casello.

Fuori ambito (passi successivi): PR collegata all'issue, modifica o chiusura delle issue da Casello, issue «epic»,
webhook di GitHub, creazione tramite l'agente locale.

## 2. Permessi e repository

- La GitHub App «Casello» riceve il permesso **Issues: read & write** (lo aggiunge l'utente su github.com; ogni
  installazione deve accettarlo). Da documentare in CLAUDE.md e nella PR.
- Repository di destinazione: `apps.source_repo`, raggiunto con l'installazione `apps.source_installation_id`. App
  con codice da zip, senza sorgente o con solo il token manuale: creazione non disponibile (409 con messaggio fisso
  «Collega il repository tramite l'App GitHub per creare le issue»).
- Token: token di installazione limitato a quel repo e a `{ issues: "write" }`, solo in memoria e con la stessa
  cache del token di lettura (chiave per installazione, repo e permessi). Il token per leggere il codice resta
  `contents: read`.
- Solo chi possiede l'installazione (`userHasInstallation`) crea o aggiorna: altrimenti 403 «installazione non
  trovata o non tua» (`INSTALLATION_NOT_YOURS`).
- Permesso non concesso (GitHub rifiuta il token con 422 o la chiamata con 403): messaggio fisso «L'App Casello non
  ha il permesso Issues su questo repository: attivalo nelle impostazioni dell'installazione su GitHub».

## 3. Dati

Migrazione additiva `docs/migrations/2026-10-piano-issue.sql` (+ `docs/schema-casello.sql`, fixture e test):

| Colonna su `analysis_items` | Tipo | Note |
|---|---|---|
| `issue_repo` | text | `owner/nome` al momento della creazione |
| `issue_number` | integer | null = nessuna issue |
| `issue_url` | text | `html_url` dell'issue |
| `issue_state` | text | `creating` (prenotata, §4) \| `open` \| `closed` |
| `issue_state_reason` | text | `completed` \| `not_planned` \| `reopened` \| null |
| `issue_created_at` | timestamp | |
| `issue_checked_at` | timestamp | ultima lettura dello stato |

- Indice parziale su `(issue_repo, issue_number)` dove `issue_number` non è null.
- Niente doppioni: il collegamento si scrive con `UPDATE … WHERE id = $1 AND issue_number IS NULL`; una voce già
  collegata viene saltata. Una creazione concorrente sulla stessa voce è impedita prenotando la voce prima della
  chiamata a GitHub (vedi §4, «prenotazione»).
- Voci ammesse: `status = approved` e capitolo `endpoint`, `completion` o `evolution`.
- Rianalisi: le voci con issue (di qualsiasi analisi dell'app) si aggiungono alle voci «già pianificate» passate
  all'architetto (`alreadyPlanned` in `run-analysis.ts`, oggi solo voci da chat), così non vengono riproposte.

## 4. API

Contratto in `openapi.yaml` (codegen), route in `routes/plan-issues.ts`, logica in `lib/plan-issues/`.

### `POST /api/apps/:id/plan/issues`

Corpo `{ itemIds: integer[1..30], dryRun?: boolean }`. Le voci devono appartenere all'app (altrimenti 400).

- `dryRun: true`: anteprima senza chiamare GitHub, `{ repo, issues: [{ itemId, title, body, labels, skipped }] }`.
  Non richiede il permesso Issues ma richiede repo e installazione dell'utente.
- Senza `dryRun`: crea in sequenza e risponde `{ repo, results: [{ itemId, outcome, number?, url?, error? }] }`
  con `outcome` = `created` | `skipped` (già collegata o non ammessa) | `failed`. Un errore su una voce non ferma le
  altre, tranne gli errori di repository o permesso (§6), che fermano il lotto e marcano `failed` le restanti.
- Ordine: le voci di completamento in ordine di dipendenza (stesso ordinamento di `dependencyOrder`), poi le altre
  nell'ordine ricevuto. Nel corpo, una dipendenza che ha già un'issue (creata ora o prima) diventa `#numero`,
  altrimenti resta il titolo.
- Prenotazione: prima della chiamata a GitHub la voce passa a `issue_state = 'creating'` con
  `UPDATE … WHERE issue_number IS NULL AND issue_state IS NULL`; se l'aggiornamento non trova la voce, è `skipped`.
  Dopo la risposta di GitHub si scrivono numero, url, stato `open`; su errore la prenotazione si toglie. All'avvio
  dell'API le prenotazioni rimaste (`creating` senza numero) si azzerano.
- Rate limit: 5 richieste di creazione al minuto per utente (le anteprime no). Una pausa di 1 s tra due creazioni
  (limite di GitHub sui contenuti nuovi).

### Contenuto dell'issue

- Titolo e corpo da `issueMarkdown(item, depTitles)` di `lib/architect/issues.ts` (lo stesso dell'export), con le
  dipendenze come `#numero` quando note.
- Piè di pagina: `---` + «Creata da Casello · piano di <app> · voce #<id>».
- Etichette: `casello`, capitolo (`endpoint`, `completamento`, `evoluzione`), `fase-N` per il completamento con
  fase, `P1`…`P5` per l'evoluzione con priorità. Create sul repo se mancano (422 «already_exists» ignorato), una
  volta per lotto.

### `POST /api/apps/:id/plan/issues/refresh`

Rilegge lo stato delle voci collegate dell'app: `GET /repos/{repo}/issues?state=all&labels=casello&per_page=100`
(paginato, al massimo 10 pagine, `since` = la più vecchia `issue_checked_at` del repo), aggiorna `issue_state`,
`issue_state_reason`, `issue_checked_at`. Un'issue non trovata nella lista resta com'era (es. etichetta tolta a
mano). Risposta: il riepilogo del §5. Rate limit: 6/minuto per utente.

### `GET /api/apps/:id/plan` (esistente)

Le voci espongono `issue: { repo, number, url, state, stateReason, checkedAt } | null` (null anche durante la
prenotazione) e il piano espone `issues: { available: boolean, unavailableReason: string | null, repo: string |
null, open, closed, approvedWithoutIssue, checkedAt }`.

## 5. Console

- Pagina «Piano e chat» (`/apps/:id/plan`), capitoli endpoint, completamento, evoluzione:
  - casella di selezione su ogni voce approvata senza issue; «Seleziona tutte le approvate senza issue»;
  - pulsante «Crea issue (N)» → finestra con anteprima (titolo, etichette, corpo espandibile) e «Crea su
    `owner/repo`»; al termine l'esito per voce;
  - riepilogo in cima: «Issue: X aperte, Y chiuse, Z voci approvate senza issue», «aggiornato … fa», «Aggiorna
    stato»; all'apertura della pagina l'aggiornamento parte da solo se l'ultima lettura ha più di 10 minuti;
  - app senza installazione: pulsante disattivato con la spiegazione e il link alla scheda dell'app.
- Badge sulla voce (anche nella pagina dell'analisi, in sola lettura): «#12 aperta» (verde), «#12 chiusa» (viola
  se `completed`, grigio se `not_planned`), con link all'issue.

## 6. Errori

Messaggi fissi in italiano, mai il testo della risposta di GitHub verso il client o nei log:

| Caso | Effetto |
|---|---|
| Token rifiutato (422) o chiamata 403 per permessi | ferma il lotto, «L'App Casello non ha il permesso Issues…» |
| 404 sul repo | ferma il lotto, «Repository non trovato o non accessibile all'App Casello» |
| 410 (issue disattivate) | ferma il lotto, «Le issue sono disattivate su questo repository» |
| 403/429 di rate limit | ferma il lotto, «GitHub ha limitato le richieste: riprova tra qualche minuto» |
| Errore di rete, 5xx, timeout (15 s) | `failed` sulla voce, «GitHub non raggiungibile» |
| Validazione di una singola issue (422) | `failed` sulla voce, «GitHub ha rifiutato l'issue» |

Chiamate verso `GITHUB_API_BASE` (fisso), niente redirect seguiti, risposta massima 1 MB.

## 7. Test

- Finto GitHub (`test/fake-github.ts`) esteso: token di installazione con `permissions` registrati (ed errore 422
  se `issues` non concesso), creazione di issue ed etichette, lista delle issue con `state`/`labels`/`since`,
  risposte d'errore configurabili.
- Casi: anteprima; creazione in ordine di dipendenza con `#numero`; voci non ammesse o di un'altra app; doppio
  avvio senza doppioni (prenotazione); errore per singola voce e errore di lotto; installazione non propria (403);
  app senza installazione (409); aggiornamento dello stato (chiusa completata / non pianificata); rate limit;
  voci con issue passate come già pianificate alla rianalisi; migrazione (idempotenza).
