# Botcave · merge automatico delle PR delle squadre

Data: 14/11/2026. Segue «Strumenti GitHub delle squadre» (`2026-11-10-botcave-strumenti-github-squadre-design.md`) e lo
«Spazio di lavoro automatico» (`2026-11-13-…`). Obiettivo: una squadra esegue un PLAN interamente, merge compresi, quando
l'utente lo concede a un ruolo. I paletti stanno nel codice, non nel prompt.

## 1. Scelta: valore `merge` del campo `code`

Il campo `code` del ruolo diventa `none | read | write | merge`; `merge` comprende `write` (legge, scrive, apre PR, legge la
CI) e aggiunge lo strumento `unisci_pr`.

Perché un valore e non un flag separato:

- i livelli sono ordinati (unire senza poter scrivere non serve: chi unisce deve poter leggere la PR e la CI, e se serve
  correggere); un flag `canMerge` ammetterebbe combinazioni senza senso (`code: none` + merge) da vietare con regole in più;
- tutto ciò che esiste per `code` vale senza codice nuovo: validazione dell'istanza (App con installazione GitHub),
  aggiornamenti proposti `role_changed:<key>:code`, tendina «Codice» dell'editor, `save-as-template`;
- nessuna migrazione del manifesto (è jsonb): solo l'enum OpenAPI e Zod si allargano.

Regole: `merge` solo per i ruoli `cloud` (il nodo esegue Claude Code senza gli strumenti di Botcave: `unisci_pr` non gli
arriverebbe) → 400 «un ruolo sul nodo non può unire le PR: usa un ruolo cloud o il capo». Il capo può avere `merge`: è
l'unico valore di `code` che per lui conta (riceve `unisci_pr` tra i suoi strumenti; non esegue compiti, quindi non riceve gli
strumenti di scrittura). Ovunque il codice controllava `code === "write"` (pacchetto del nodo, prontezza, sessione) si usa
`codeWrites(code)` (`write` o `merge`).

## 2. Strumento `unisci_pr`

`lib/code-writer/merge.ts` (`mergeTeamPull`), offerto ai ruoli `cloud` con `code: merge` (compiti) e al capo con
`code: merge` (turni). Argomenti: `compito` (id del PLAN) **oppure** `numero` (PR registrata in `team_code_tasks` della
squadra). Risultati `{ok:false}` con messaggi fissi (`MERGE_MESSAGES`), mai eccezioni né testo di GitHub.

Controlli lato server, in quest'ordine:

1. la riga di `team_code_tasks` è della squadra, ha una PR e `pr_state = open`; branch `botcave/<idSquadra>-<compito>`
   (ricalcolato con `codeBranch`, non letto dalla riga) e base uguale a quello registrato;
2. squadra attiva, chi l'ha attivata possiede l'installazione dell'App di riferimento (`userHasInstallation`);
3. limite di merge per squadra: al più 6 all'ora (`MAX_MERGES_PER_HOUR`), contati su `team_code_tasks.botcave_merged_at`
   con la riga della squadra bloccata; la stessa scrittura prenota la riga (una PR non si unisce due volte in parallelo);
4. PR letta da GitHub: aperta, `head.ref` = branch del compito, `base.ref` = base registrato; head = `head_sha` della riga
   (altrimenti «la PR è cambiata dall'ultimo controllo: aspetta l'esito della CI»);
5. CI dell'head letta dal vivo (`readCi` + `ciState`): solo `success`; `pending` → «CI ancora in corso», `failure` →
   «CI non superata», nessuna CI → «nessuna CI sulla PR: senza CI verde Botcave non unisce»;
6. file della PR (`GET /pulls/{n}/files`, al più 10 pagine da 100, anche `previous_filename`): nessun file in
   `.github/workflows/` (rifiuto senza scampo); se tocca `docs/migrations/`, `lib/db/src/schema/` o `docs/schema-casello.sql`
   il merge non avviene e si accoda una voce `merge` in «Da confermare» (§3).

Se passano: la PR esce dalla bozza (GraphQL `markPullRequestReadyForReview` con il `node_id`) e si unisce con squash
(`PUT /pulls/{n}/merge`, `merge_method: squash`, `sha` = head controllato: se l'head cambia in mezzo GitHub rifiuta con 409).
Token d'installazione ristretto al repository con `contents: write` e `pull_requests: write`; mai nei log (solo id, numero,
sha a 7). Merge non riuscito (405/409/422) → prenotazione tolta, messaggio fisso. Merge riuscito → `botcave_merged_at`
resta, `pr_state` non si tocca: la sorveglianza vede la PR unita ed emette evento e motivo `pr_closed` come oggi.

## 3. Voce `merge` in «Da confermare»

Nuovo valore `merge` di `pending_action_kind`: `team_instance_id` della squadra, niente app né tool, `args_public` =
`{taskCodeId, planTaskId, repo, prNumber, prUrl, headSha, files}` (file di migrazione e schema, al più 50), `summary`
«Unisci la PR #n (compito tX): applica prima le migrazioni su Neon», `recipient` = repository. Una sola voce aperta per PR:
una seconda richiesta risponde con il numero esistente. Il risultato dello strumento dice al ruolo che la voce è in coda e di
segnalare all'utente.

Approvare (`approveAction` → `approveMerge`): prenotazione `pending` → `executing`, poi gli stessi controlli tranne quello
sulle migrazioni (i workflow restano vietati) e con l'head uguale a quello della voce (l'utente approva ciò che ha visto),
poi merge. Esito `done` «PR #n unita» o `failed` col messaggio fisso; un fallimento accoda al capo il motivo `merge_failed`.
Rifiutare (nota ≤ 500) accoda il motivo `decision` come per i piani. Nessun token utente, ambito `api:write` per i token,
limite di 20 decisioni/min invariato. Console e pannello: tipo «Merge», sintesi, link alla PR, elenco dei file, «Approva»
anche nel pannello incorporato; Alfred le legge con `coda_da_confermare` e le decide col doppio passo di sempre.

## 4. Capo

Con almeno un ruolo `merge` nella squadra il prompt dice: «dopo la CI verde (e l'eventuale revisione) assegna il merge al
ruolo che può unire, o usa `unisci_pr` se puoi tu; poi passa al compito successivo; se `unisci_pr` mette la PR in
«Da confermare», segnala all'utente che deve applicare la migrazione su Neon e approvare». Senza ruoli `merge` resta la
regola di oggi: il merge è dell'utente.

## 5. Dati

Migrazione `docs/migrations/2026-11-merge-automatico.sql`, additiva e idempotente, PRIMA del merge:
`ALTER TYPE pending_action_kind ADD VALUE IF NOT EXISTS 'merge'` (fuori da una transazione esplicita) e
`ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS botcave_merged_at timestamp`. Motivo di turno `merge_failed` nel jsonb
(nessuna migrazione).

## 6. Fuori ambito

Merge di PR non di Botcave; revisione automatica del codice; strategie diverse dallo squash; applicazione delle migrazioni
su Neon da Botcave; merge per i ruoli `node` (il loro compito lo unisce un ruolo cloud o il capo).
