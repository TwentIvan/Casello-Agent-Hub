# Botcave: spazio di lavoro automatico dei ruoli `node` con codice

Data: 13 novembre 2026. Stato: approvata nel dialogo (tre parti), da rivedere per iscritto.

## 1. Perché

Oggi un compito di un ruolo `node` con `code: write` (vedi «Strumenti GitHub delle squadre» e «Nodi» in CLAUDE.md) funziona solo se
l'utente ha già clonato il repository dentro la radice del nodo (`~/Botcave`), ha configurato `gh auth setup-git` sul Mac e ha scelto lo
«Spazio di lavoro» nella scheda squadra. Senza, il nodo chiude il compito `blocked` «spazio di lavoro non valido» (`resolveWorkspace` in
`artifacts/casello-nodo/src/workspace.ts`). Nella prova reale del 13 novembre (squadra «Sviluppo Botcave») il capo ha fallito t11 tre volte e
ha poi chiesto all'utente di lanciare `rm -rf *`.

Obiettivo: una squadra con ruoli `node` con codice lavora appena attivata, senza clonare a mano, senza `gh` sul Mac e senza scegliere una
cartella; i problemi che restano (Mac spento, repository non collegato, Git mancante, nodo vecchio) si vedono nella console con la soluzione,
e il capo non chiede mai comandi da terminale all'utente.

Decisioni prese con l'utente:

1. Le operazioni Git verso GitHub (clone, fetch, push) le fa **il nodo**, non Claude Code; la PR la apre **Botcave** al report. Claude lavora
   e committa solo in locale e non vede mai il token.
2. La cartella dei compiti con codice è **gestita da Botcave** (clone condiviso nascosto più una copia di lavoro per compito), non quella
   dello «Spazio di lavoro» della squadra.
3. Il controllo «i ruoli `node` potranno lavorare?» **avvisa e non blocca** l'attivazione.

## 2. Ambito

Dentro:

- pacchetto del claim con il campo `git` per i compiti `node` con `code: write`, claim solo da nodi ≥ 0.4.0;
- route `POST /api/node/tasks/:id/git-token`;
- modulo `git-workspace.ts` di `casello-nodo` (clone, fetch, copia di lavoro, push), capacità `git` nell'heartbeat, voce «Installa Git» del menu;
- apertura della PR in bozza da Botcave al report `done`;
- route `GET /api/team-instances/:id/readiness`, carta «Pronta a lavorare» e dialogo di «Attiva» nella scheda squadra;
- regole nel prompt del capo e problemi di prontezza nel suo contesto;
- messaggi del nodo più chiari per lo spazio di lavoro dei ruoli `node` senza codice.

Fuori:

- ruoli `node` senza codice: lo «Spazio di lavoro» resta com'è (solo il messaggio d'errore cambia);
- compiti `cloud` con codice (invariati);
- controllo dei segreti sui commit del nodo (oggi assente anche col flusso `gh`; il Mac è dell'utente);
- pulizia automatica dei cloni dei repository non più usati (restano su disco; si possono cancellare: si riclonano);
- merge, chiusura o approvazione di PR da Botcave (il merge resta all'utente);
- firma Apple del nodo, Windows e Linux.

## 3. Protocollo del nodo

### 3.1 Pacchetto del claim

`buildPackage` (`lib/nodes/protocol.ts`): se il ruolo del compito ha `code: write` e l'App di riferimento ha `source_repo`, il pacchetto
porta il campo facoltativo

```
git: { repo: "proprietario/nome", baseBranch: string, branch: "botcave/<idSquadra>-<idCompito>", issue: number | null }
```

- `baseBranch` = `apps.source_branch` o, se nullo, il branch predefinito del repository (`getDefaultBranch`); se non si legge, il pacchetto
  non si prepara e il compito torna `waiting_node` come oggi per gli errori di preparazione (`releaseClaim`).
- `branch` = `codeBranch(instance.id, task.planTaskId)` (lo stesso dei compiti cloud).
- `workspace` per questi compiti è ignorato dal nodo (resta nel pacchetto per compatibilità dello schema).
- Le istruzioni del compito portano in fondo la nuova sezione «Git» (`nodeGitSection`, `lib/code-writer/node-git.ts`):

  > Sei già sul branch `<branch>` in una copia del repository `<repo>` preparata da Botcave, partita da `<base>` (o dal lavoro già
  > pubblicato su questo branch). Lavora qui e fai commit piccoli e coerenti. Non fare push, non aprire PR, non cambiare branch e non
  > toccare altri branch: alla fine del compito Botcave pubblica il branch e apre la PR in bozza. Riferisci `done` quando i commit sono
  > pronti, oppure `blocked` col motivo.

  più `Issue: #n` se c'è.

Schema OpenAPI: `NodeTaskPackage.git` (nullable), `NodeTaskGit {repo, baseBranch, branch, issue}`.

### 3.2 Chi può prendere il compito

Nuova costante `NODE_GIT_MIN_VERSION = "0.4.0"` (`lib/nodes/`). Tra i candidati del claim un compito di un ruolo `node` con `code: write`
si consegna solo a un nodo con `version` ≥ `NODE_GIT_MIN_VERSION` (`compareVersions` di `lib/nodes/manifest.ts`; versione nulla o non
confrontabile = sotto). Lo stesso filtro vale per `pending` dell'heartbeat (un nodo vecchio non chiede il claim a vuoto) e per il controllo
«nessun nodo disponibile» del `lease-sweeper` (l'evento `bloccato` dice «nessun nodo aggiornato a Botcave Nodo 0.4.0»). `min-version.txt`
resta `0.2.0`: i nodi vecchi continuano a prendere i compiti senza codice.

### 3.3 Token per Git

`POST /api/node/tasks/:id/git-token` (token d'ambito `node`, corpo `{leaseToken}`) → `200 {token, expiresAt}`.

- Lease non valida o scaduta → 409 «lease non valida o scaduta» (come ping e report).
- Compito senza ruolo `code: write`, App senza `source_repo` o senza installazione (`source_installation_id`), GitHub non configurato o chi ha
  attivato la squadra che non possiede l'installazione (`userHasInstallation`) → 409 «accesso al repository non disponibile»
  (`CODE_WRITE_MESSAGES`, lo stesso dei compiti cloud).
- Errore di GitHub nel creare il token → 502 col messaggio fisso di `GITHUB_MESSAGES`.
- Token: `installationToken(cfg, installationId, {repo, permissions: {contents: "write"}})`, ristretto al solo repository, scade dopo un'ora
  (la cache esistente lo riusa fino a 5 minuti dalla scadenza). Basta per fetch e push: la PR la apre Botcave (§3.6). Senza il permesso
  `workflows` GitHub rifiuta i push che toccano `.github/workflows/`, come per i compiti cloud.
- Limite: 10 al minuto per compito (`middlewares/rate-limit.ts`, contatore nuovo), 429 oltre.
- Log: id del compito ed esito, mai il token. La risposta ha `Cache-Control: no-store`.

### 3.4 Capacità `git` nell'heartbeat

L'heartbeat porta il campo facoltativo `git: {found: boolean, version: string | null}` (versione ≤ 50 caratteri; campi di tipo sbagliato
scartati senza rifiutare l'heartbeat, come `claude`). Il server lo salva in `nodes.git_status` (jsonb, nuova colonna); l'ora della verifica è quella dell'heartbeat
(`last_seen_at`), nessuna colonna in più. Un heartbeat senza `git` (nodo vecchio)
lascia il valore com'era. `Node.gitStatus` nelle risposte di Account → Nodi.

### 3.5 Report

`NodeReportBody` aggiunge il campo facoltativo `git: {pushed: boolean, headSha: string | null, commits: integer ≥ 0}` (sha di 40 caratteri
esadecimali, altrimenti 400). È informativo: la decisione sulla PR guarda il branch su GitHub (§3.6); non entra nell'esito né nel PLAN.

### 3.6 PR aperta da Botcave

`adoptNodePull` (`lib/code-writer/node-git.ts`) diventa: al report `done` di un compito con ruolo `code: write` e App con installazione,

1. cerca la PR aperta sul branch (`findOpenPull`); se c'è, la adotta come oggi;
2. altrimenti, se il branch esiste su GitHub ed è avanti rispetto al base (`getBranchHead` non nullo e diverso dalla testa del base),
   qualunque sia `git.pushed` (il lavoro può essere stato pubblicato da un'esecuzione precedente finita `blocked` o `failed`), e chi ha
   attivato la squadra possiede l'installazione (`userHasInstallation`, come per il token Git), apre la PR in bozza con
   `createDraftPull` (`pull_requests: write`): titolo = titolo del compito del PLAN (≤ 200), corpo = «Closes #n» se il compito ha `issue`,
   poi l'esito riferito (≤ 300) e il piè di pagina «Botcave · squadra <nome> · compito <id>»; controllo dei segreti (`secrets-check.ts`)
   su titolo e corpo: se scatta, la PR si apre col solo piè di pagina;
3. crea o aggiorna la riga di `team_code_tasks` (CI in attesa) come oggi.

Errori di GitHub: il report riesce comunque, solo il log (come oggi). Un report `blocked` o `failed` non apre PR, anche con il branch
pubblicato: il capo riassegna e la riesecuzione riparte da lì; al primo `done` successivo la PR si apre anche se quella esecuzione non ha
pubblicato nulla di nuovo.

## 4. Lavoro sul Mac (`casello-nodo`)

Versione del pacchetto `0.4.0`. Nuovo modulo `src/git-workspace.ts`, usato da `runTask` (`runner.ts`) quando il pacchetto ha `git`.

### 4.1 Cartelle

- Clone condiviso, nudo: `<radice>/.botcave/repos/<proprietario>/<nome>.git` (`git clone --bare`, poi refspec di fetch
  `+refs/heads/*:refs/remotes/origin/*`).
- Copia di lavoro del compito: `<radice>/.botcave/compiti/<idSquadra>-<idCompito>` (`git worktree add`).
- Nomi di proprietario e repository validati con l'espressione di GitHub (`^[A-Za-z0-9_.-]{1,100}$`, niente `.`/`..`); ogni percorso si
  verifica dentro la radice con `realpath` e `isInside` (niente link simbolici in uscita), come `resolveWorkspace`.
- `scanFolders` salta già le cartelle nascoste: `.botcave` non compare tra le cartelle del nodo.
- Un lock per repository (la `WorkspaceQueue` esistente con chiave il percorso del clone) serializza clone, fetch, `worktree add/remove` e
  push dello stesso repository; Claude gira fuori dal lock, quindi compiti diversi dello stesso repository lavorano in parallelo. I compiti
  con lo stesso `<squadra>-<compito>` sono già esclusi dal server (un'esecuzione alla volta per compito).

### 4.2 Credenziali senza file

Ogni comando `git` verso GitHub parte con `spawnGroup` (gruppo di processi proprio, timeout 5 minuti) e un ambiente che contiene, oltre a
quello di `childEnv()`:

- `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` vuoto;
- `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=` (vuoto: azzera gli helper configurati, così il
  portachiavi del Mac non salva il token), `GIT_CONFIG_KEY_1=credential.helper`,
  `GIT_CONFIG_VALUE_1=!f() { echo username=x-access-token; echo "password=$BOTCAVE_GIT_TOKEN"; }; f`;
- `BOTCAVE_GIT_TOKEN=<token>`.

Indirizzo remoto `https://github.com/<repo>.git`, senza credenziali. Il token non va mai negli argomenti, su disco né nei log; non è
nell'ambiente di Claude Code (che parte con `childEnv()` come oggi). I comandi locali (`worktree`, `status`, `rev-list`) partono senza token.
Il testo d'errore di `git` non si inoltra: si sceglie un messaggio fisso (§4.5).

### 4.3 Prima di Claude

1. `git --version`: assente → `blocked` «Git non installato sul Mac: apri Botcave Nodo e scegli Installa Git».
2. Token da `POST …/git-token` (409 «accesso al repository non disponibile» → `blocked` con lo stesso testo; lease persa → come oggi).
3. Sotto il lock del repository: clone se manca (cartella del clone incompleta da un tentativo precedente → tolta e rifatta), altrimenti
   `fetch --prune origin`.
4. Copia di lavoro:
   - se esiste ed è un worktree valido di quel clone sul branch del compito, si riprende così com'è (lavoro non pubblicato di
     un'esecuzione precedente); se però `origin/<branch>` non è un antenato di `HEAD` (il branch è stato riscritto su
     GitHub), la copia si ricrea da `origin/<branch>` e l'esito riceve «commit locali non pubblicati scartati: il branch era cambiato su
     GitHub»; una cartella cancellata a mano si ripulisce con `git worktree prune`;
   - altrimenti (assente, o cartella non valida: tolta) `git worktree add -B <branch> <cartella> <origine>`, con `<origine>` =
     `origin/<branch>` se il branch esiste sul remoto, altrimenti `origin/<base>`; base assente sul remoto → `failed` «branch base non
     trovato».
5. `casello-compito.md`, `casello-esito.json` e `casello-allegati/` si aggiungono a `info/exclude` del clone (una volta), così non
   finiscono nei commit.
6. Allegati e file del compito si scrivono nella copia di lavoro come oggi; Claude parte con quella cartella come `cwd`.

### 4.4 Dopo Claude

Qualunque sia l'esito di Claude (anche `blocked`, timeout o stop: il lavoro committato non si perde), purché la lease non sia persa:

1. `commits` = `git rev-list --count origin/<branch>..HEAD` se il branch esiste sul remoto, altrimenti `origin/<base>..HEAD`.
2. Se `commits > 0`: token nuovo (§3.3), poi sotto il lock `git push origin HEAD:refs/heads/<branch>` (mai `--force`; il nodo verifica
   prima che `<branch>` cominci con `botcave/` e sia diverso da `<base>`). Push riuscito → `git.pushed = true`, `headSha` = `HEAD`.
3. Se il push fallisce: la copia di lavoro resta (la prossima esecuzione la riprende), il report diventa `failed` con il messaggio fisso
   (§4.5) e l'esito di Claude nel dettaglio.
4. Con il push riuscito o senza commit: si contano i file modificati e non committati (`git status --porcelain`, esclusi i file di
   servizio), la copia si toglie (`git worktree remove --force`, poi `git branch -D <branch>` nel clone) e, se erano più di zero, l'esito
   riceve in fondo « (modifiche non committate scartate: N file)» entro i 300 caratteri.
5. Lease persa o nodo fermato: nessun push, la copia resta.

### 4.5 Messaggi fissi (`GIT_MESSAGES`)

- «Git non installato sul Mac: apri Botcave Nodo e scegli Installa Git»
- «accesso al repository non disponibile» (dal server)
- «repository non raggiungibile: riprova più tardi» (clone o fetch falliti per rete o 5xx)
- «branch base non trovato: controlla il branch dell'App in Botcave»
- «push non riuscito: il branch è cambiato su GitHub» (rifiuto non fast-forward)
- «push non riuscito: GitHub ha rifiutato le modifiche» (es. file di workflow, file troppo grandi)
- «push non riuscito: riprova più tardi» (altro)
- «preparazione del repository non riuscita» (errore locale inatteso)

La classificazione usa frasi precise di stderr di `git` (es. `non-fast-forward`, `[rejected]`, `Could not resolve host`), mai inoltrate.

### 4.6 Ruoli senza codice

Invariati, salvo il messaggio: `WORKSPACE_INVALID` diventa «spazio di lavoro mancante o non trovato sul Mac: sceglilo nella scheda squadra
(Spazio di lavoro)».

### 4.7 Capacità e menu

- `src/git-check.ts`: `git --version` (10 s) all'avvio e ogni 10 minuti insieme a Claude Code; risultato nell'heartbeat (§3.4).
- Menu dell'app: voce «Installa Git» solo se Git manca; conferma, poi `xcode-select --install` (apre il dialogo di macOS), notifica
  «Segui il dialogo di macOS; Botcave Nodo se ne accorge da solo».

## 5. Prontezza della squadra

### 5.1 API

`GET /api/team-instances/:id/readiness` (ambiti per metodo come le altre route della squadra; squadra chiusa → 409 «squadra chiusa») →

```
{ roles: [ { roleKey, roleName, problems: [ { code, level: "error" | "warning", message, link: string | null } ] } ] }
```

Solo i ruoli `node`; un ruolo senza problemi ha `problems: []`. Utente di riferimento: chi ha attivato la squadra (`activated_by`) o, se
non è ancora attivata, l'utente della richiesta. Codice in `lib/teams/readiness.ts`, solo letture.

Controlli per ogni ruolo `node`:

| code | livello | messaggio | link |
| --- | --- | --- | --- |
| `no_node` | error | Nessun Mac collegato con le skill del ruolo (<elenco>): collega Botcave Nodo da Account → Nodi | `/account` |
| `node_offline` | warning | Nessun Mac acceso ora: i compiti aspetteranno che si accenda | null |

Ruoli `node` senza codice:

| code | livello | messaggio | link |
| --- | --- | --- | --- |
| `workspace_missing` | error | Scegli lo spazio di lavoro della squadra | null |
| `workspace_unknown` | warning | Lo spazio di lavoro <percorso> non è tra le cartelle viste dal Mac | null |

Ruoli `node` con `code: write`:

| code | livello | messaggio | link |
| --- | --- | --- | --- |
| `repo_not_linked` | error | L'App <nome> non ha il codice collegato tramite l'App GitHub | `/apps/<id>` |
| `repo_not_owned` | error | Il repository di <nome> è collegato con un'installazione GitHub che non è tua | `/apps/<id>` |
| `node_outdated` | error | Aggiorna Botcave Nodo alla versione 0.4.0 o successiva (oggi: <versione>) | `/account` |
| `git_missing` | error | Git non è installato sul Mac <nome>: apri Botcave Nodo e scegli Installa Git | null |

Regole: «nodi idonei» = nodi `active` dell'utente di riferimento con tutte le skill `node` del ruolo (stessa regola del claim,
`roleNodeSkills`). `node_offline` solo se ci sono nodi idonei e nessuno è online (`NODE_ONLINE_WINDOW_MS`). Per i ruoli con codice:
`node_outdated` se nessun nodo idoneo ha versione ≥ `NODE_GIT_MIN_VERSION`; `git_missing` se tutti i nodi idonei aggiornati hanno
`git_status.found = false` (stato assente = non noto, nessun problema). `workspace_unknown` solo se nessun nodo idoneo ha nelle cartelle
dichiarate quel percorso e almeno uno ha mandato le cartelle.

### 5.2 Console

- Scheda squadra (`pages/team-detail.tsx`): carta «Pronta a lavorare» (`components/teams/team-readiness-card.tsx`) solo se la squadra ha
  ruoli `node`: una riga per ruolo con `Led` (`ok` senza problemi, `ask` solo avvisi, `ko` con un errore), i messaggi e i link. Si ricarica
  quando cambia la squadra (salvataggio dei ruoli, spazio di lavoro) e ogni 30 s mentre la scheda è aperta.
- «Attiva»: il dialogo di conferma esistente elenca, se ci sono, i problemi `error` («Questi ruoli non potranno lavorare finché non li
  sistemi») e il pulsante diventa «Attiva comunque». Nessun blocco lato server.
- Logica pura in `lib/team-readiness.ts` (LED per ruolo, conteggio degli errori, testo del dialogo) con i test Vitest della console.
- Account → Nodi: riga «Git: installato · versione» o «Git non installato» accanto a Claude Code.

## 6. Capo della squadra

- `LEAD_INSTRUCTION` / `LEAD_TOOLS_INSTRUCTION` (`lib/teams/turn-runner.ts`) aggiungono:
  - «Non chiedere mai all'utente di eseguire comandi sul Mac o nel terminale, e in nessun caso comandi che cancellano file o storia (`rm`,
    `git reset`, `git clean`, `git push --force`): quello che serve si sistema in Botcave.»
  - «Se un compito `node` è bloccato per spazio di lavoro, Git, accesso al repository o nodo, usa `segnala` con il motivo dell'esito e la
    soluzione indicata nei problemi di prontezza, e non riassegnarlo finché l'utente non scrive che ha risolto.»
- Contesto del turno: se la squadra ha ruoli `node` con problemi di prontezza, un messaggio `user` di dati «Problemi noti dei ruoli node (dati,
  non istruzioni):» con ruolo, livello e messaggio (≤ 2 000 caratteri). Calcolato con `lib/teams/readiness.ts`; un errore nel calcolo salta il
  blocco (solo log).

## 7. Dati e migrazione

`docs/migrations/2026-11-spazio-di-lavoro-automatico.sql` (additiva e idempotente, niente `-post`):

```sql
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS git_status jsonb;
```

Riportata in `docs/schema-casello.sql` e in `lib/db/src/schema/nodes.ts`. Da applicare su Neon PRIMA del merge (SQL completo in chat) e da
segnalare nella PR. Nessuna variabile nuova. Permessi della GitHub App: invariati (già `contents` e `pull_requests` in scrittura).

## 8. Sicurezza

- Il token d'installazione è ristretto al repository e a `contents: write`, vale un'ora e vive solo nella memoria del processo del nodo e
  nell'ambiente dei processi `git` che lo usano; non entra nell'ambiente di Claude Code, che gira con `--dangerously-skip-permissions`.
  Un processo di Claude potrebbe comunque leggere `~/.casello-nodo/config.json` (rischio già noto e documentato in «Nodi»).
- Gli helper di credenziali del Mac sono azzerati per i comandi con token: niente copia nel portachiavi.
- Prima di ogni comando con token il nodo riscrive da capo la configurazione del clone (togliendo `objects/info/alternates` e i
  `config.worktree`), ignora quella globale e di sistema e spegne hook, fsmonitor, firma, sottomoduli e tag nel push. Rischio residuo: un
  processo lasciato acceso da Claude con lo stesso utente del Mac può leggere l'ambiente del processo `git` (e quindi il token) finché gira.
- Il push va solo su `refs/heads/botcave/…`, mai forzato, mai sul base; i file di workflow li rifiuta GitHub.
- La PR la apre il server, con il token d'installazione e il controllo dei segreti su titolo e corpo.
- Il capo non propone più comandi distruttivi; nessun comando del nodo cancella file fuori da `<radice>/.botcave/`.

## 9. Prove

- API (Vitest, PGlite, finto GitHub): `git-token` (lease, ruolo senza codice, installazione altrui, limite), claim e `pending` con versione
  sotto/sopra 0.4.0, heartbeat con `git`, `adoptNodePull` che apre la PR (con e senza issue, PR già aperta, `pushed: false`), readiness (ogni
  codice), contesto del capo con i problemi.
- `casello-nodo`: `git-workspace` con un repository Git vero locale come remoto (indirizzo del remoto sostituibile solo nei test con un
  parametro di `git-workspace`, `remoteUrl`): primo clone, fetch, ripresa della copia di lavoro, branch remoto esistente, push
  riuscito, push rifiutato (non fast-forward), modifiche non committate scartate, `info/exclude`; ambiente di Claude senza
  `BOTCAVE_GIT_TOKEN`; classificazione degli errori; `git-check`.
- Console: `lib/team-readiness.ts`.
- Prova di flusso: `code-team-flow.test.ts` esteso (compito `node` con codice: claim con `git`, token, report con `git.pushed`, PR aperta da
  Botcave e sorvegliata).
- Dopo il deploy: aggiornare Botcave Nodo, attivare una squadra con un ruolo `node` con codice su un repository mai clonato, verificare clone,
  commit, push, PR in bozza e CI.
