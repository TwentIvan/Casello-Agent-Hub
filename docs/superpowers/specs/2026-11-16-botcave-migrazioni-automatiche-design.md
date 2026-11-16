# Botcave: migrazioni additive applicate dal deploy

Data: 2026-11-16. Stato: approvato in chat da Ivan (design), da rivedere come spec.

## Obiettivo

Oggi una colonna o una tabella nuova arriva in produzione solo se Ivan incolla a mano lo script di `docs/migrations/` su Neon
PRIMA del merge. Le squadre di Botcave aprono e uniscono da sole le PR, ma una PR che tocca migrazioni o schema finisce in
«Da confermare» come voce `merge` con «applica prima l'SQL su Neon», senza nemmeno mostrare l'SQL.

Dopo questo lavoro:

- le migrazioni **additive** le applica `casello-api` all'avvio, prima di `listen`: nessun passaggio manuale;
- una PR delle squadre con sole migrazioni additive si unisce da sola come le altre (il deploy le applica);
- all'utente restano solo gli script **`-post`** (distruttivi), da applicare a mano dopo il deploy: la voce `merge` ne mostra
  l'SQL completo;
- i casi difettosi (migrazione già esistente modificata, schema senza migrazione, istruzioni distruttive fuori da un `-post`)
  tornano alla squadra con un messaggio fisso, non all'utente.

Fuori ambito: applicare automaticamente i `-post`; migrazioni per le altre App (The Hub Up…): la regola dei percorsi resta
quella di Botcave, come già oggi in `classifyPullFiles`; rollback automatico delle migrazioni.

## 1. Esecutore delle migrazioni (`artifacts/api-server/src/lib/migrations/`)

Moduli:

- `split.ts` (puro): divide il testo di un file SQL in istruzioni. Riconosce stringhe `'…'` (con `''`), identificatori `"…"`,
  dollar quoting `$tag$…$tag$` (anche `$$`), commenti `-- …` e `/* … */` (annidati). Il `;` separa solo fuori da questi.
  Istruzioni vuote o di soli commenti si scartano.
- `classify.ts` (puro): `classifyMigration(name, sql)` → `{ destructive: boolean, reasons: string[] }`. Distruttivo se il nome
  finisce con `-post.sql` oppure se un'istruzione (con commenti e stringhe tolti, maiuscole ignorate, spazi normalizzati)
  contiene:
  - `DROP TABLE`, `DROP COLUMN` (anche `DROP` dopo `ALTER TABLE … ` senza `CONSTRAINT`/`NOT NULL`/`DEFAULT`/`IDENTITY`/
    `EXPRESSION`), `DROP TYPE`, `DROP SCHEMA`, `DROP VIEW`, `DROP MATERIALIZED VIEW`, `DROP FUNCTION`, `DROP PROCEDURE`,
    `DROP SEQUENCE`, `DROP INDEX`, `DROP TRIGGER`, `DROP DOMAIN`, `DROP EXTENSION`, `DROP POLICY`;
  - `RENAME` (qualunque forma), `TRUNCATE`, `DELETE FROM`;
  - `ALTER COLUMN … TYPE` / `SET DATA TYPE`, `ALTER COLUMN … SET NOT NULL`.

  Ammessi: `DROP CONSTRAINT`, `DROP NOT NULL`, `DROP DEFAULT` (lo schema «togli e ricrea un vincolo» è già in uso), `UPDATE`,
  `INSERT`, blocchi `DO $$ … $$` (il corpo si controlla con le stesse parole). La regola è volutamente prudente: un falso
  positivo sposta lo script in un `-post`, mai il contrario.
- `baseline.ts`: `BASELINE_MIGRATIONS`, elenco fisso dei 38 file non `-post` presenti il 2026-11-16 (dal
  `2026-10-account-ai.sql` al `2026-11-thu-5c-tappa1.sql`).
- `runner.ts`: `runMigrations({ pool, dir, logger })`.

### Registro

```sql
CREATE TABLE IF NOT EXISTS "schema_migrations" (
  "name" text PRIMARY KEY,
  "sha256" text NOT NULL,
  "baseline" boolean NOT NULL DEFAULT false,
  "applied_at" timestamp with time zone NOT NULL DEFAULT now()
);
```

L'esecutore la crea da sé (`CREATE TABLE IF NOT EXISTS`); la tabella sta anche in `lib/db/src/schema/schema-migrations.ts` e in
`docs/schema-casello.sql`, così `drizzle-kit push` in sviluppo non la propone da cancellare. Nessuno script di migrazione la
crea: è l'esecutore stesso.

### Algoritmo

1. Una connessione dedicata dal pool (`pool.connect()`), `SET statement_timeout = 0`, poi
   `SELECT pg_advisory_lock(<chiave fissa>)` (bigint costante, es. hash di `"botcave:schema_migrations"`). Nel rolling update di
   Coolify il secondo container aspetta qui; poi trova tutto registrato e non fa nulla. `DATABASE_URL` è la stringa diretta di
   Neon (non il pooler), quindi il lock di sessione vale.
2. `CREATE TABLE IF NOT EXISTS schema_migrations …`.
3. **Registrazione iniziale**: se il registro è vuoto, per ogni nome di `BASELINE_MIGRATIONS` presente nella cartella si
   inserisce `(name, sha256, baseline = true)` senza eseguire il file. Log: `{count}` «Migrazioni esistenti registrate senza
   eseguirle».
4. Elenca i file `*.sql` della cartella, esclusi i `*-post.sql`, in ordine di nome (confronto di stringhe). Per ogni file:
   - registrato con lo stesso sha256 → niente;
   - registrato con sha diverso → avviso nel log (nome, sha a 7), niente riesecuzione, l'avvio prosegue;
   - non registrato: se `classifyMigration` lo dice distruttivo → errore «migrazione distruttiva fuori da un file -post: <nome>»;
     altrimenti si eseguono le istruzioni di `split.ts` una alla volta in autocommit, ognuna preceduta da
     `SET lock_timeout = '10s'` (impostato una volta sulla connessione), come `psql -f` con `ON_ERROR_STOP`; poi
     `INSERT INTO schema_migrations (name, sha256)`. Log: nome e durata.
5. `pg_advisory_unlock`, rilascio della connessione (anche in caso d'errore, `finally`).

Perché istruzione per istruzione e non il file intero: una query con più istruzioni è una transazione implicita, e un valore
aggiunto con `ALTER TYPE … ADD VALUE` non si può usare nella stessa transazione. Così vale esattamente ciò che vale oggi con
`psql -f` (anche i file con `BEGIN`/`COMMIT` espliciti funzionano: sono istruzioni come le altre).

### Errori

Al primo errore il file non si registra, `runMigrations` rilancia un errore con nome del file e numero dell'istruzione (mai il
testo SQL né parametri), `index.ts` registra l'errore ed esce con 1. Coolify, con l'Health Check che non risponde, tiene il
container vecchio. Le istruzioni già eseguite del file restano: al deploy successivo il file riparte dall'inizio, e questo è
sicuro perché le migrazioni nuove sono idempotenti (verificato in CI, §3). Un `lock_timeout` scaduto (tabella occupata dal
container vecchio) è un errore come gli altri: si riprova con un nuovo deploy.

### Avvio (`src/index.ts`)

`await runMigrations(...)` subito dopo il controllo di `PORT` e prima di ogni pulizia dell'avvio (che leggono già le tabelle),
dentro `try/catch` che registra l'errore ed esegue `process.exit(1)`. Cartella da `MIGRATIONS_DIR` (default
`/app/migrations` con `NODE_ENV=production`, altrimenti `docs/migrations` risolto dalla radice del repository rispetto al file).
`MIGRATIONS_DISABLED=true` salta l'esecutore, solo fuori produzione (serve ai test dell'API, che hanno già lo schema completo).

## 2. Primo avvio sul DB di produzione

Rieseguire i file esistenti **non è sicuro**: alcuni cambiano dati, non solo lo schema (`2026-10-tetti-di-spesa` riscrive
`runs.ai_model_id`, `2026-11-lucius-squadra` riscrive `plan_conversations.summarized_at`, `2026-11-strumenti-mcp` ricalcola
`app_tools.level`, `2026-10-fase-1` converte la vecchia tabella `tools` con un `DROP TABLE`, `2026-10-catalogo-universale`
cancella righe di `catalog_runs`). Per questo i 38 file di `BASELINE_MIGRATIONS` si registrano senza eseguirli.

Elenco fisso e non «tutti i file presenti»: se il primo deploy fallisse e intanto si unisse una PR con una migrazione nuova,
«tutti i file presenti» la registrerebbe senza averla mai eseguita.

Prerequisito: i 38 file sono già applicati su Neon (regola in vigore finora). La PR riporta una query di verifica sugli oggetti
degli ultimi script (es. `team_code_tasks.botcave_merged_at`, valore `merge` di `pending_action_kind`, `nodes.git_status`,
`lead_conversations`).

Primo deploy: crea `schema_migrations`, inserisce 38 righe `baseline = true`, non esegue nessuna migrazione, non cambia tabelle
né dati esistenti, poi l'avvio prosegue come oggi.

## 3. Immagine, nomi dei file e prove

- `docker/api.Dockerfile`: `COPY docs/migrations /app/migrations` nello stadio di runtime (prima di `USER node`).
- **Nomi**: i file nuovi si chiamano `YYYY-MM-DD-<slug>.sql` (`^\d{4}-\d{2}-\d{2}-[a-z0-9-]+(-post)?\.sql$`), così l'ordine per
  nome segue la data. Più file dello stesso giorno: ordine alfabetico dello slug (chi li scrive ne tiene conto).
- **Test (Vitest, `artifacts/api-server/test/migrations-auto.test.ts` e test unitari accanto ai moduli)**:
  - `split`: stringhe con `;`, `''`, `$$` e `$tag$`, commenti di riga e di blocco, istruzioni vuote;
  - `classify`: ogni parola distruttiva, i casi ammessi (`DROP CONSTRAINT IF EXISTS`, `DROP NOT NULL`, `UPDATE`), parole dentro
    stringhe e commenti ignorate, `-post` sempre distruttivo;
  - per ogni file di `docs/migrations/` fuori da `BASELINE_MIGRATIONS` e non `-post`: nome nel formato, `classifyMigration` non
    distruttivo, applicato **due volte** con lo split dell'esecutore su un PGlite con `docs/schema-casello.sql` senza errori
    (oggi l'elenco è vuoto: la prova parte con la prima migrazione nuova);
  - `BASELINE_MIGRATIONS` coincide con i file non `-post` presenti con nome del vecchio formato (nessun file aggiunto per errore
    all'elenco, nessun file vecchio dimenticato);
  - `runMigrations` su PGlite (via `pg` sul socket, come `global-setup.ts`): registrazione iniziale senza esecuzione, ordine,
    file già registrato saltato, sha diverso solo avviso, file distruttivo rifiutato, errore che lascia il file non registrato
    e la seconda esecuzione che lo completa, `ALTER TYPE … ADD VALUE` seguito dall'uso del valore nello stesso file, due
    esecuzioni concorrenti (il lock) che applicano il file una volta sola.
- I test esistenti `migration-*.test.ts` restano.

## 4. `unisci_pr` e la voce `merge`

### Lettura dei file della PR

`listPullFiles` (`code-writer/github-git.ts`) restituisce anche lo stato (`added`, `modified`, `removed`, `renamed`…) e il nome
precedente. Nuova `readPullFile(repo, path, sha)` (contents API alla testa controllata, ≤ 1 MiB, testo UTF-8) per i file di
`docs/migrations/`.

### Classificazione (`classifyPullFiles` esteso, puro, in `merge.ts`)

Dati i file con stato e, per le migrazioni aggiunte, il contenuto:

| Caso | Esito |
|---|---|
| tocca `.github/workflows/` | rifiuto (come oggi) |
| file di `docs/migrations/` già esistente modificato, tolto o rinominato | rifiuto alla squadra: «la PR modifica una migrazione esistente: scrivi una migrazione nuova» |
| file nuovo di `docs/migrations/` non `-post` con nome fuori formato | rifiuto: «nome della migrazione non valido: usa YYYY-MM-DD-slug.sql» |
| file nuovo non `-post` distruttivo | rifiuto: «la migrazione <nome> contiene istruzioni distruttive: dividila in una parte additiva e uno script -post» |
| cambia `lib/db/src/schema/` o `docs/schema-casello.sql` senza nessun file nuovo in `docs/migrations/` | rifiuto: «lo schema cambia senza migrazione: aggiungi uno script in docs/migrations/» |
| file nuovo `-post` (e nessun caso di rifiuto) | voce `merge` in «Da confermare» |
| altrimenti (anche con migrazioni additive e schema) | merge automatico come le altre PR |

I rifiuti sono risultati `{ok:false}` con messaggi fissi in `MERGE_MESSAGES`, mai eccezioni; il capo li riceve come oggi e
riassegna il compito. File di `docs/migrations/` che non finiscono in `.sql` (es. note): ignorati dalla classificazione.

### Voce `merge`

- Nasce solo per PR con script `-post`. Sintesi (`MERGE_MESSAGES.summary`): «Unisci la PR #n (compito t): dopo il deploy applica
  su Neon lo script -post».
- `args_public`/`args_enc` aggiungono `postScripts: [{ path, sql }]`: contenuto completo dei file `-post` alla testa controllata,
  al più 100 KB in tutto (oltre: rifiuto alla squadra «script -post troppo lunghi per la voce: dividili»). Restano `files` e
  `moreFiles`.
- Approvare (`approveMerge`): stessi controlli dello strumento con la testa uguale a quella della voce (come oggi), poi merge;
  esito `done` «PR #n unita: dopo il deploy applica lo script -post». La classificazione si rifà all'approvazione (testa
  uguale, quindi stessi file): un rifiuto lì è un errore interno, non dovrebbe accadere.
- Console (`components/actions/merge-detail.tsx`): sotto i file, per ogni script «Da applicare su Neon dopo il deploy» con il
  percorso e l'SQL in un blocco di codice (`font-mono`, a capo, niente scorrimento orizzontale) e «Copia SQL». Pulsante
  «Approva e unisci» invariato.
- Alfred e il centralino: invariati (leggono la sintesi; l'SQL non si legge a voce).
- Nessuna modifica a OpenAPI: `argsPublic` è già un oggetto libero.

### Messaggi del capo

`MERGE_MESSAGES.queued` diventa «la PR #n contiene uno script -post: è in «Da confermare» (voce n. N). Dopo il merge l'utente lo
applica su Neon: segnalaglielo con segnala». Le istruzioni del capo e di `unisci_pr` (`CODE_MERGE_INSTRUCTIONS`, descrizione
dello strumento) dicono: le migrazioni additive le applica il deploy, una PR con migrazioni additive si unisce come le altre;
lo schema cambia solo con uno script nuovo `YYYY-MM-DD-slug.sql` idempotente; le parti distruttive vanno in un `-post`.

## 5. Documentazione

- `CLAUDE.md`, «Deploy → Schema DB»: le migrazioni additive le applica `casello-api` all'avvio (registro `schema_migrations`,
  lock, ordine per nome, `-post` esclusi, errore = l'API non parte); i file nuovi sono `YYYY-MM-DD-slug.sql` e idempotenti; i
  `-post` restano manuali dopo il deploy; `MIGRATIONS_DIR` e `MIGRATIONS_DISABLED`; mai `drizzle-kit push` in produzione.
- `CLAUDE.md`, «Strumenti GitHub delle squadre → Merge automatico»: la nuova tabella dei casi e la voce `merge` solo per i `-post`
  con l'SQL.
- `CLAUDE.md`, sezioni con «da applicare su Neon PRIMA del merge (SQL completo in chat)»: restano come storia; la regola nuova
  vale per i file nuovi. «Flusso di lavoro»: niente più SQL in chat per le migrazioni additive.
- Memoria «SQL Neon prima del merge»: vale solo per gli script `-post` (da dare in chat completi, da applicare dopo il deploy).

## 6. Rischi accettati

- Una migrazione additiva gira mentre il container vecchio serve ancora: è ciò che accade già oggi applicandola prima del
  merge. `lock_timeout` di 10 s evita di bloccare il servizio dietro un `ALTER TABLE`.
- La classificazione per parole può sbagliare in eccesso (un falso positivo manda la PR in un `-post`); in difetto la protegge
  il controllo dell'esecutore, che rifiuta di partire con un file distruttivo non `-post`.
- Un file registrato e poi modificato non si riesegue: la CI e il merge rifiutano la modifica, l'esecutore la segnala nel log.
