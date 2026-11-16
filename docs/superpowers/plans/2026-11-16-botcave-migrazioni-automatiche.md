# Migrazioni automatiche al deploy — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `casello-api` applica all'avvio le migrazioni additive di `docs/migrations/`; `unisci_pr` unisce da sé le PR con migrazioni additive e manda in «Da confermare» solo quelle con script `-post`, mostrandone l'SQL.

**Architecture:** modulo `lib/migrations/` (split e classificazione puri, elenco fisso dei file già applicati, esecutore con registro `schema_migrations` e lock consultivo), chiamato in `index.ts` prima di ogni pulizia. `code-writer/merge.ts` riusa `classifyMigration` sulla lista dei file della PR (con stato) e sul loro contenuto letto da GitHub.

**Tech Stack:** TypeScript, Express 5, `pg`, Drizzle, Vitest con PGlite (`@electric-sql/pglite`, `@electric-sql/pglite-socket`), React (console).

**Spec:** `docs/superpowers/specs/2026-11-16-botcave-migrazioni-automatiche-design.md`

## Global Constraints

- Italiano per commenti, documentazione e commit (`feat(casello): …`, con la riga `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`); identificatori in inglese.
- Nessun file `*-post.sql` si esegue mai in automatico.
- Nomi dei file nuovi: `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+(-post)?\.sql$`.
- `BASELINE_MIGRATIONS` = i 38 file non `-post` presenti oggi in `docs/migrations/`.
- Istruzioni eseguite una alla volta in autocommit, `lock_timeout` 10 s; errore = file non registrato, l'API esce con 1.
- Log: mai testo SQL, contenuti di file, token; solo nomi, sha a 7, conteggi, durate.
- Script `-post` nella voce: al più 100 KB in tutto.
- Console: token di design (niente colori scritti a mano), niente scorrimento orizzontale a 1280 px.
- `pnpm run typecheck` verde prima di ogni commit.

## Review Focus

- File con fine riga CRLF o BOM iniziale: split e classificazione devono comportarsi come con LF (test in Task 1).
- `;` dentro stringhe, identificatori tra virgolette o corpi `$tag$…$tag$`, e parole distruttive dentro commenti o stringhe: non devono spezzare né classificare male (Task 1).
- Due container che partono insieme: il file si applica una volta sola e il secondo non fallisce (Task 2).
- File che fallisce a metà e si riesegue al deploy dopo: la seconda esecuzione completa e registra (Task 2).
- PR che rinomina o toglie una migrazione esistente, o che aggiunge solo uno `-post` e cambia lo schema: classificazione corretta (Task 5).

---

### Task 1: split e classificazione degli script

**Files:**
- Create: `artifacts/api-server/src/lib/migrations/split.ts`, `artifacts/api-server/src/lib/migrations/classify.ts`
- Test: `artifacts/api-server/src/lib/migrations/split.test.ts`, `artifacts/api-server/src/lib/migrations/classify.test.ts`

**Interfaces:**
- Produces: `splitSql(text: string): string[]` (istruzioni senza il `;` finale, trim, scartate quelle vuote o di soli commenti; BOM iniziale tolto); `classifyMigration(name: string, sql: string): { destructive: boolean; reasons: string[] }`; `MIGRATION_NAME_RE: RegExp`; `isPostMigration(name: string): boolean` (finisce con `-post.sql`).

- [ ] **Step 1: test di `splitSql`** — casi: due istruzioni; `'a;b'` e `'it''s; ok'`; `"col;x"`; `DO $$ BEGIN x; y; END $$;` resta una istruzione; `$fn$ … ; … $fn$`; `-- commento; con punto e virgola` e `/* a; /* b; */ c; */` ignorati; testo con `\r\n` e BOM uguale a quello con `\n`; file di soli commenti → `[]`; ultima istruzione senza `;` inclusa.
- [ ] **Step 2: test di `classifyMigration`** — distruttivi: nome `x-post.sql` (anche con SQL innocuo); ognuna di `DROP TABLE`, `ALTER TABLE t DROP COLUMN c`, `ALTER TABLE t DROP c`, `DROP TYPE`, `DROP INDEX`, `DROP VIEW`, `DROP FUNCTION`, `ALTER TABLE t RENAME TO u`, `ALTER TYPE e RENAME VALUE 'a' TO 'b'`, `TRUNCATE t`, `DELETE FROM t`, `ALTER TABLE t ALTER COLUMN c TYPE text`, `ALTER COLUMN c SET DATA TYPE int`, `ALTER COLUMN c SET NOT NULL`, `DROP TABLE` dentro `DO $$ … $$`. Ammessi: `ALTER TABLE t DROP CONSTRAINT IF EXISTS k`, `ALTER COLUMN c DROP NOT NULL`, `ALTER COLUMN c DROP DEFAULT`, `UPDATE t SET …`, `INSERT …`, `ALTER TYPE e ADD VALUE IF NOT EXISTS 'x'`, `CREATE TABLE IF NOT EXISTS`, `-- DROP TABLE x` (commento), `SELECT 'drop table x'` (stringa). `reasons` contiene la parola trovata (es. `"DROP TABLE"`), mai il testo dell'istruzione. `MIGRATION_NAME_RE` accetta `2026-11-16-a-b.sql` e `2026-11-16-a-post.sql`, rifiuta `2026-11-a.sql` e `2026-11-16-A.sql`.
- [ ] **Step 3: eseguire** `pnpm --filter @workspace/api-server exec vitest run src/lib/migrations` → FAIL (moduli assenti).
- [ ] **Step 4: implementare** `split.ts` con uno scanner a stati lineare (normale, stringa, identificatore, dollar con tag, commento di riga, commento di blocco con profondità); `classify.ts`: per ogni istruzione di `splitSql`, toglie commenti e il contenuto di stringhe `'…'` (non i corpi `$$`, che vanno controllati), maiuscole, spazi singoli, poi cerca le parole della spec §1. Per `ALTER TABLE … DROP <x>`: distruttivo se `<x>` non è `CONSTRAINT`, `NOT NULL`, `DEFAULT`, `IDENTITY`, `EXPRESSION`.
- [ ] **Step 5: eseguire** lo stesso comando → PASS; `pnpm run typecheck` → verde.
- [ ] **Step 6: commit** `feat(casello): split e classificazione degli script di migrazione`.

### Task 2: registro, elenco iniziale ed esecutore

**Files:**
- Create: `artifacts/api-server/src/lib/migrations/baseline.ts`, `artifacts/api-server/src/lib/migrations/runner.ts`, `lib/db/src/schema/schema-migrations.ts`
- Modify: `lib/db/src/schema/index.ts` (export), `docs/schema-casello.sql` (tabella `schema_migrations` come in spec §1)
- Test: `artifacts/api-server/src/lib/migrations/runner.test.ts`

**Interfaces:**
- Consumes: `splitSql`, `classifyMigration`, `isPostMigration` (Task 1).
- Produces: `BASELINE_MIGRATIONS: readonly string[]`; `MIGRATION_LOCK_KEY: bigint`; `runMigrations(opts: { pool: pg.Pool; dir: string; logger: Pick<Logger, "info" | "warn">; baseline?: readonly string[] }): Promise<{ baselined: number; applied: string[] }>` (`baseline` di default `BASELINE_MIGRATIONS`, sostituibile nei test); errore lanciato: `MigrationError` con `file: string`, `statement: number` (1-based) e messaggio «migrazione <file> non riuscita all'istruzione <n>» oppure «migrazione distruttiva fuori da un file -post: <file>».

- [ ] **Step 1: test** (PGlite nuovo + `PGLiteSocketServer` + `pg.Pool` per test, cartella temporanea con file scritti dal test; vedi `test/global-setup.ts` per l'avvio del socket):
  - registro vuoto, `baseline: ["2026-10-a.sql"]`, cartella con `2026-10-a.sql` (SQL che fallirebbe) → `{baselined: 1, applied: []}`, riga con `baseline = true` e sha256 del file;
  - seconda chiamata con un nuovo `2026-11-16-b.sql` (`CREATE TABLE IF NOT EXISTS b (id int)`) → `applied: ["2026-11-16-b.sql"]`, tabella creata; terza chiamata → `applied: []`;
  - ordine: `2026-11-16-b.sql` e `2026-11-17-a.sql`, il secondo usa la tabella del primo → entrambi applicati in quest'ordine;
  - `x-post.sql` presente → mai eseguito né registrato;
  - file registrato poi modificato → `logger.warn` chiamato, non rieseguito, nessun errore;
  - file non `-post` con `DROP TABLE` → `MigrationError` «migrazione distruttiva fuori da un file -post», niente registrato;
  - file con `CREATE TABLE c (id int); SELECT * FROM nonesiste;` → `MigrationError` con `statement: 2`, file non registrato, tabella `c` esistente; dopo aver corretto il file in `CREATE TABLE IF NOT EXISTS c (id int);` la chiamata successiva lo applica;
  - `CREATE TYPE e AS ENUM ('a'); ALTER TYPE e ADD VALUE IF NOT EXISTS 'b'; CREATE TABLE t (v e DEFAULT 'b');` → applicato;
  - due `runMigrations` concorrenti (`Promise.all`) con un file nuovo che inserisce una riga in una tabella di controllo → una sola riga, nessun errore;
  - CRLF nel file → applicato come con LF.
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/api-server exec vitest run src/lib/migrations/runner.test.ts` → FAIL.
- [ ] **Step 3: implementare** `baseline.ts` (i 38 nomi, in ordine, da `ls docs/migrations | grep -v -- -post`), lo schema Drizzle `schemaMigrationsTable` (`name` text pk, `sha256` text not null, `baseline` boolean not null default false, `appliedAt` timestamptz not null default now) e `runner.ts` secondo l'algoritmo della spec §1 (connessione dedicata, `SET statement_timeout = 0`, `SET lock_timeout = '10s'`, `pg_advisory_lock`/`unlock` in `finally`, registrazione iniziale solo a registro vuoto e solo per i nomi presenti in cartella).
- [ ] **Step 4: eseguire** → PASS; `pnpm --filter @workspace/api-server run test` → verde (lo schema di test ora ha la tabella); typecheck verde.
- [ ] **Step 5: commit** `feat(casello): esecutore delle migrazioni con registro e lock`.

### Task 3: avvio, immagine e prova dei file nuovi

**Files:**
- Modify: `artifacts/api-server/src/index.ts` (dopo il controllo di `PORT`), `docker/api.Dockerfile` (stadio runtime: `COPY docs/migrations /app/migrations` prima di `USER node`)
- Create: `artifacts/api-server/src/lib/migrations/config.ts`
- Test: `artifacts/api-server/test/migrations-auto.test.ts`

**Interfaces:**
- Consumes: `runMigrations`, `BASELINE_MIGRATIONS`, `splitSql`, `classifyMigration`, `MIGRATION_NAME_RE` (Task 1–2).
- Produces: `migrationsDir(): string` (`MIGRATIONS_DIR`, altrimenti `/app/migrations` con `NODE_ENV=production`, altrimenti `docs/migrations` risolto dalla radice del repository rispetto a `import.meta.url`); `migrationsDisabled(): boolean` (`MIGRATIONS_DISABLED=true` fuori produzione; in produzione ignorata con un avviso).

- [ ] **Step 1: test** `migrations-auto.test.ts`:
  - `BASELINE_MIGRATIONS` è uguale (stesso insieme) ai file non `-post` di `docs/migrations/` che non rispettano `MIGRATION_NAME_RE`;
  - ogni altro file `.sql` di `docs/migrations/` rispetta `MIGRATION_NAME_RE`;
  - per ogni file nuovo non `-post` (fuori da `BASELINE_MIGRATIONS`): `classifyMigration` non distruttivo e, su un PGlite con `docs/schema-casello.sql`, ogni istruzione di `splitSql` eseguita con `db.exec` due volte di fila senza errori (con l'elenco vuoto il test deve comunque esistere e passare: un `it` per file generato da `readdirSync`, più un `it` che verifica che l'insieme dei file sia leggibile);
  - `migrationsDir()` con `MIGRATIONS_DIR` impostata la restituisce; senza, fuori produzione, punta a una cartella che contiene `2026-10-account-ai.sql`.
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/api-server exec vitest run test/migrations-auto.test.ts` → FAIL.
- [ ] **Step 3: implementare** `config.ts` e in `index.ts`, prima di `failInterruptedRuns()`: se non disattivate, `await runMigrations({ pool, dir: migrationsDir(), logger })` in `try/catch`; sull'errore `logger.error({ file, statement, errName }, "Migrazioni non applicate: l'API non parte")` e `process.exit(1)`; log `info` con `baselined` e `applied`.
- [ ] **Step 4: eseguire** → PASS; typecheck verde; `docker build -f docker/api.Dockerfile .` se Docker è disponibile, altrimenti verificare a vista la riga `COPY`.
- [ ] **Step 5: prova a mano** in locale con un Postgres di sviluppo se disponibile (`AUTH_DISABLED=true pnpm run dev:api`): log «Migrazioni esistenti registrate senza eseguirle» con 38; secondo avvio senza registrazioni. Se non c'è un DB di sviluppo, dirlo nella PR.
- [ ] **Step 6: commit** `feat(casello): migrazioni applicate all'avvio dell'API`.

### Task 4: file della PR con stato e lettura del contenuto

**Files:**
- Modify: `artifacts/api-server/src/lib/code-writer/github-git.ts` (`listPullFiles`, nuova `readFileAt`), `artifacts/api-server/test/fake-github.ts` (endpoint `GET /repos/{o}/{r}/contents/{path}?ref=`; `previous_filename` per i rinominati non serve)
- Test: `artifacts/api-server/test/fake-github-git.test.ts`

**Interfaces:**
- Produces: `type PullFile = { filename: string; status: string; previousFilename: string | null }`; `listPullFiles(r: RepoRef, n: number): Promise<PullFile[] | null>`; `readFileAt(r: RepoRef, path: string, ref: string): Promise<string | null>` (contents API con token `contents: read`, JSON con `content` base64 decodificato UTF-8; 404 → null; file oltre 1 MiB o non `type: "file"` → errore `badShape`).

- [ ] **Step 1: test** nel fake: `listPullFiles` riporta `status` `added`/`modified`/`removed`; `readFileAt` restituisce il contenuto alla testa della PR e null per un percorso assente; `readFileAt` senza permesso `contents` risponde col messaggio fisso del permesso mancante come le altre letture.
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/api-server exec vitest run test/fake-github-git.test.ts` → FAIL.
- [ ] **Step 3: implementare**; aggiornare gli usi di `listPullFiles` in `merge.ts` mappando a `filename` (comportamento invariato fino al Task 5).
- [ ] **Step 4: eseguire** → PASS, `test/code-team-flow.test.ts` → PASS, typecheck verde.
- [ ] **Step 5: commit** `feat(casello): stato e contenuto dei file della PR`.

### Task 5: classificazione della PR, voce `merge` solo per i `-post`, istruzioni

**Files:**
- Modify: `artifacts/api-server/src/lib/code-writer/merge.ts`, `artifacts/api-server/src/lib/teams/task-runner.ts` (`CODE_MERGE_INSTRUCTIONS`), `artifacts/api-server/src/lib/teams/turn-runner.ts` (`mergeInstruction`)
- Test: `artifacts/api-server/src/lib/code-writer/merge.test.ts` (nuovo, puro), `artifacts/api-server/test/code-team-flow.test.ts`

**Interfaces:**
- Consumes: `PullFile`, `readFileAt` (Task 4); `classifyMigration`, `isPostMigration`, `MIGRATION_NAME_RE` (Task 1).
- Produces: `classifyPull(files: PullFile[], contents: Record<string, string>): { kind: "refuse"; message: string } | { kind: "queue"; postScripts: { path: string; sql: string }[]; files: string[] } | { kind: "merge" }` (pura; `contents` = contenuto dei file aggiunti di `docs/migrations/*.sql`); `MAX_POST_SQL_BYTES = 100_000`; messaggi nuovi in `MERGE_MESSAGES`: `migrationModified`, `migrationName`, `migrationDestructive(name)`, `schemaWithoutMigration`, `postTooLong`, `queued(n, pr)` e `summary(pr, task)` e `done(pr)` con i testi della spec §4.

- [ ] **Step 1: test puri di `classifyPull`** — workflow → `refuse` `workflows`; migrazione esistente `modified`/`removed`/`renamed` → `migrationModified`; nuovo `2026-11-x.sql` → `migrationName`; nuovo `2026-11-16-x.sql` con `DROP TABLE t` → `migrationDestructive("2026-11-16-x.sql")`; solo `lib/db/src/schema/a.ts` → `schemaWithoutMigration`; `docs/schema-casello.sql` + nuovo additivo → `merge`; nuovo additivo senza schema → `merge`; nuovo `2026-11-16-y-post.sql` (anche con schema cambiato) → `queue` con `postScripts` e il contenuto intero; due `-post` oltre 100 000 byte in tutto → `postTooLong`; `docs/migrations/LEGGIMI.md` ignorato; nessun file di migrazione → `merge`.
- [ ] **Step 2: aggiornare `code-team-flow.test.ts`**: il caso «PR con una migrazione» usa `2026-11-16-x.sql` additivo e si unisce da sola (`ok: true`, nessuna voce `merge`); nuovo caso con `2026-11-16-x-post.sql` → voce `merge` con `argsPublic.postScripts` = `[{path, sql}]`, approvazione → merge e `result` «PR #n unita: dopo il deploy applica lo script -post»; il caso «schema-casello senza migrazione» → `ok: false` con `schemaWithoutMigration` (al posto della voce e del rifiuto); un caso con migrazione esistente modificata → `migrationModified`.
- [ ] **Step 3: eseguire** `pnpm --filter @workspace/api-server exec vitest run src/lib/code-writer/merge.test.ts test/code-team-flow.test.ts` → FAIL.
- [ ] **Step 4: implementare** `classifyPull` al posto di `classifyPullFiles`; in `mergeTeamPull` leggere con `readFileAt(ctx.repo, path, pull.headSha)` i file aggiunti di `docs/migrations/*.sql` (un file assente → `internal`), poi agire per `kind`; la voce porta `postScripts` in `detail` (stesso oggetto cifrato e pubblico di oggi); `approveMerge` rifà la classificazione e procede solo con `kind: "queue"` (altro → `MergeRefused(itemChanged)`); descrizione di `MERGE_TOOL`, `CODE_MERGE_INSTRUCTIONS` e `mergeInstruction` con le regole della spec §4 «Messaggi del capo».
- [ ] **Step 5: eseguire** → PASS; `pnpm --filter @workspace/api-server run test` → verde; typecheck verde.
- [ ] **Step 6: commit** `feat(casello): merge automatico delle PR con migrazioni additive`.

### Task 6: SQL degli script `-post` nella voce in console

**Files:**
- Modify: `artifacts/casello/src/components/actions/merge-detail.tsx`
- Test: `artifacts/casello/src/components/actions/merge-detail.test.ts` (solo la funzione pura di lettura degli argomenti, esportata come `readMergeArgs`)

**Interfaces:**
- Produces: `readMergeArgs(a: unknown): { …campi di oggi; postScripts: { path: string; sql: string }[] }` (voci non valide scartate).

- [ ] **Step 1: test** di `readMergeArgs`: `postScripts` valido letto; voci senza `path` o `sql` stringa scartate; assente → `[]`.
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/casello run test` → FAIL.
- [ ] **Step 3: implementare**: per ogni script, etichetta «Da applicare su Neon dopo il deploy», percorso in `font-mono`, SQL in `<pre>` con `whitespace-pre-wrap break-words` dentro un contenitore con altezza massima e scorrimento verticale, pulsante `Button variant="outline"` «Copia SQL» (`navigator.clipboard.writeText`, toast «SQL copiato»). Solo classi dei token.
- [ ] **Step 4: eseguire** → PASS; typecheck verde.
- [ ] **Step 5: commit** `feat(casello): SQL degli script -post nella voce di merge`.

### Task 7: documentazione, memoria e PR

**Files:**
- Modify: `CLAUDE.md` («Stato», «Deploy → Schema DB», «Strumenti GitHub delle squadre → Merge automatico», «Flusso di lavoro»; voce in «Dove stanno le cose» per `lib/migrations/`); memoria `/Users/Ivan/.claude/projects/-Users-Ivan-Projects-Casello-Agent-Hub/memory/sql-neon-prima-del-merge.md` e riga in `MEMORY.md`.

- [ ] **Step 1:** scrivere in CLAUDE.md le regole della spec §5 (esecutore all'avvio, registro, lock, `-post` esclusi e manuali dopo il deploy, nomi `YYYY-MM-DD-slug.sql` idempotenti, `MIGRATIONS_DIR`/`MIGRATIONS_DISABLED`, tabella dei casi di `unisci_pr`, voce `merge` solo per i `-post` con l'SQL).
- [ ] **Step 2:** aggiornare la memoria: l'SQL completo in chat vale solo per gli script `-post`, da applicare dopo il deploy.
- [ ] **Step 3:** `pnpm run typecheck` e `pnpm --filter @workspace/api-server run test` e `pnpm --filter @workspace/casello run test` → tutti verdi (riportare l'esito reale).
- [ ] **Step 4: commit** `docs(casello): migrazioni applicate dal deploy`; push del branch; PR verso `main` con `gh` che dice: cosa cambia, come si è provato, **come si comporta il primo deploy** (crea `schema_migrations`, registra i 38 file `baseline` senza eseguirli, nessuna modifica a tabelle o dati), la query di verifica da lanciare prima del merge (oggetti degli ultimi script: `team_code_tasks.botcave_merged_at`, enum `pending_action_kind` con `merge`, `nodes.git_status`, tabella `lead_conversations`), nessuna variabile obbligatoria nuova. Merge solo con un sì esplicito di Ivan.
