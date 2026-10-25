# Casello: login con GitHub e collegamento ai repository

Data: 25 ottobre 2026. Stato: approvata in conversazione, da rivedere per iscritto.

## 1. Obiettivo

Chi usa Casello deve poter:

- entrare con Google **oppure** con GitHub;
- collegare il proprio account GitHub anche se è entrato con Google;
- scegliere il repository di un'app da un elenco, senza incollare un token per ogni app, e lasciare che
  l'architetto scarichi il codice con un accesso minimo e a scadenza.

Oggi Casello è usato solo da Ivan (`ALLOWED_EMAILS`), ma dovrà diventare utilizzabile da chiunque: le
scelte di questa fase non devono legarsi al singolo utente (utenti e identità in tabelle proprie,
collegamenti GitHub per utente, controllo d'accesso in un solo punto sostituibile).

Fuori da questa fase: proprietà delle app per utente o team (le app restano condivise tra gli utenti
ammessi, come oggi), registrazione aperta, webhook di GitHub.

## 2. Scelte

- **GitHub App "Casello"** (non una OAuth App con scope `repo`, che darebbe scrittura su tutti i repo
  privati con un token a lunga durata). Permessi dell'App: repository *Contents: read* e *Metadata:
  read*; account *Email addresses: read*. Opzione "Request user authorization (OAuth) during
  installation" attiva. Nessun webhook.
- Il login usa il flusso OAuth per utenti della GitHub App. Il token utente serve solo a leggere
  identità, email verificate e installazioni visibili all'utente, poi si scarta: **nessun token GitHub
  viene salvato**.
- L'accesso ai repository passa dai **token di installazione** (durata 1 ora), generati al bisogno
  firmando un JWT con la chiave privata dell'App (RS256 con `node:crypto`, nessuna nuova dipendenza).
- Il token incollato a mano (fase 3) resta come alternativa per i repository su cui non si può
  installare l'App.

## 3. Utenti e identità

- Tabella `users`: `id`, `email` (unica, minuscola), `name`, `picture`, `created_at`, `last_login_at`.
- Tabella `user_identities`: `id`, `user_id` → users (cascade), `provider` (`google` | `github`),
  `provider_user_id` (sub di Google, id numerico di GitHub come testo), `email`, `username` (login
  GitHub), `created_at`; unica su (`provider`, `provider_user_id`) e su (`user_id`, `provider`).
- La sessione contiene `userId` più i dati da mostrare (`email`, `name`, `picture`). `GET /api/auth/me`
  restituisce anche le identità collegate (`google`, `github` con username) e se GitHub è configurato.
- **Accesso**: una sola funzione `isAllowed(emails: string[]): boolean` decide chi entra; oggi è vera se
  una delle email verificate è in `ALLOWED_EMAILS`. Domani si sostituisce con "chiunque" o un invito.
- **Login Google**: invariato nel flusso; al callback trova l'identità Google o, in mancanza, l'utente con
  la stessa email (e gli collega l'identità) o lo crea.
- **Login GitHub** (`GET /api/auth/github/login` → GitHub → `GET /api/auth/github/callback`): `state` e
  PKCE S256 in sessione come per Google, redirect solo verso `PUBLIC_APP_URL`. Al callback: scambio del
  codice, `GET /user` e `GET /user/emails` (solo email `verified`). Se nessuna email verificata è
  ammessa → `/?auth=denied`. Se l'identità GitHub esiste si entra come il suo utente; altrimenti si cerca
  un utente con una delle email verificate (la primaria per prima) e gli si collega l'identità;
  altrimenti si crea l'utente con l'email primaria verificata.
- **Collegamento da loggato** (`GET /api/auth/github/link`): stesso flusso, ma l'identità GitHub viene
  collegata all'utente corrente. Se è già collegata a un altro utente → ritorno con errore
  (`/?github=conflict`), nessuna modifica. `DELETE /api/auth/github` scollega l'identità e le
  installazioni dell'utente; non si può scollegare l'unica identità di un utente.
- **Sessioni esistenti**: una sessione con solo `user.email` (formato della fase 1) viene convertita alla
  prima richiesta: si trova o crea l'utente da quell'email e si scrive `userId`. Nessuno deve rifare il
  login.
- `AUTH_DISABLED=true` (solo sviluppo) usa un utente di sviluppo creato al bisogno (`dev@localhost`).

## 4. Installazioni e repository

- Tabella `github_installations`: `id`, `user_id` → users (cascade), `installation_id` (bigint),
  `account_login`, `account_type` (`User` | `Organization`), `repository_selection` (`all` |
  `selected`), `created_at`, `updated_at`; unica su (`user_id`, `installation_id`).
- **Installazione**: la console offre "Installa Casello su GitHub" →
  `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`. GitHub torna al *Setup URL*
  `GET /api/github/setup?installation_id=…&setup_action=…&code=…`. L'`installation_id` nell'URL non è
  attendibile: con il `code` (autorizzazione utente durante l'installazione) si ottiene il token utente,
  si legge `GET /user/installations` e si salvano/aggiornano **tutte e sole** le installazioni dell'App
  visibili all'utente (quelle non più visibili vengono rimosse per quell'utente). Il setup richiede la
  sessione Casello; senza, si torna al login. Se l'identità GitHub del token non è quella collegata
  all'utente corrente (o è collegata a un altro) → errore, nessuna modifica.
- Per aggiornare le installazioni si ripassa dal setup: "Gestisci su GitHub" porta alla pagina
  dell'installazione, che al salvataggio torna al Setup URL. Nessuna route di aggiornamento separata.
- **Elenco dei repository**: `GET /api/github/repos` → per ogni installazione dell'utente, token di
  installazione e `GET /installation/repositories` (paginato, al massimo 1000 repo in tutto);
  risposta: `{ installationId, fullName, defaultBranch, private }[]` ordinati per nome. Un'installazione
  che risponde 401/404 viene rimossa per quell'utente e non blocca le altre.
- **Token di installazione** (`lib/github/app.ts`): JWT RS256 (`iat` = ora − 60 s, `exp` = ora + 9 min,
  `iss` = `GITHUB_APP_ID`) → `POST /app/installations/{id}/access_tokens`, eventualmente con
  `repositories: [nome]` e `permissions: { contents: "read" }`. Cache in memoria per
  (installazione, repo) fino a 5 minuti prima della scadenza. Mai salvati né registrati nei log.

## 5. Sorgenti dell'app e analisi

- Colonna `apps.source_installation_id` (bigint, nullable). Con `source_type = github`:
  - se `source_installation_id` è impostato, il repo (`source_repo`) deve appartenere a quell'installazione
    e l'utente che salva deve averla collegata (altrimenti 400 "installazione non trovata o non tua");
    il token manuale non serve;
  - altrimenti vale il comportamento della fase 3 (token manuale obbligatorio per avviare).
- Avvio dell'analisi: con un'installazione, l'utente che avvia deve averla collegata (altrimenti 403).
  Subito prima del download, `run-analysis` genera un token di installazione **limitato a quel repo e a
  `contents: read`** e lo passa a `fetchGithubTree` al posto del token manuale. 401/404 da GitHub →
  analisi `failed` con "l'App Casello non ha più accesso a questo repository: reinstallala o scegli un
  altro repo".
- Console, scheda Sorgenti: con GitHub collegato, combo "Repository" con i repo di `GET /api/github/repos`
  (scelta = installazione + repo, branch predefinito suggerito); link "usa un token manuale" che mostra i
  campi della fase 3. Senza GitHub collegato: invito "Collega GitHub" e campi manuali.

## 6. Configurazione

Nuove variabili dell'API, tutte facoltative: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (PEM; accettati sia gli
a capo veri sia `\n`). Se ne manca una, GitHub è **disattivato**: pulsanti nascosti, route GitHub → 404
"GitHub non configurato", token manuale ancora disponibile; l'API parte comunque. Il login Google resta
obbligatorio in produzione come oggi. Sull'App GitHub: Callback URL
`${PUBLIC_APP_URL}/api/auth/github/callback`, Setup URL `${PUBLIC_APP_URL}/api/github/setup` (con
"Redirect on update"). Solo per i test, come `OIDC_ISSUER`: `GITHUB_API_BASE` e `GITHUB_WEB_BASE`
(ignorate in produzione).

## 7. Sicurezza

- Chiave privata, client secret, token utente e token di installazione: mai in log, DB, risposte o
  messaggi d'errore; gli errori verso GitHub hanno testi fissi (stato HTTP o codice di rete al massimo).
- `state` monouso e legato alla sessione per login, collegamento e setup; PKCE S256 dove GitHub lo
  supporta; i redirect di ritorno accettano solo percorsi interni.
- Nessuna fiducia nei parametri di ritorno di GitHub: identità ed installazioni si leggono sempre con il
  token appena ottenuto.
- I token di installazione per l'analisi sono ristretti al repo e a `contents: read`.

## 8. Errori (in italiano)

"email GitHub non autorizzata", "account GitHub già collegato a un altro utente", "GitHub non
configurato", "installazione non trovata o non tua", "l'App Casello non ha più accesso a questo
repository: reinstallala o scegli un altro repo", "GitHub non risponde (riprova più tardi)".

## 9. Migrazione

`docs/migrations/2026-10-github.sql`, idempotente come le precedenti: tabelle `users`,
`user_identities`, `github_installations`, colonna `apps.source_installation_id`. Gli utenti nascono al
primo accesso, non nella migrazione. Da applicare **prima del merge** (l'API nuova legge le nuove
tabelle a ogni richiesta autenticata).

## 10. Prove

- Finto GitHub (server HTTP locale) per OAuth (`/login/oauth/access_token`), `/user`, `/user/emails`,
  `/user/installations`, `/app/installations/{id}/access_tokens` (con verifica della firma del JWT),
  `/installation/repositories`, zipball.
- Test: login GitHub ammesso/rifiutato; nuovo utente vs utente esistente per email; collegamento e
  conflitto; scollegamento; conversione di una vecchia sessione; setup con `installation_id` falsificato
  (non collegato); elenco repo con un'installazione revocata; token di installazione ristretto a
  repo e permesso; analisi con installazione (token mai nel log) e con installazione revocata; GitHub non
  configurato → route 404 e login Google intatto.
- Verifica nel browser con il finto GitHub; collaudo reale: creazione dell'App su GitHub con Ivan e
  installazione su `TwentIvan/Mister`.
