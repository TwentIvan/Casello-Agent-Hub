# Piano · Ciclo di evoluzione automatica 3c: squadra del ciclo

Spec: `docs/superpowers/specs/2026-11-16-botcave-evoluzione-automatica-design.md` §15.8 (sostituisce §6.4–6.6 e §7). Base: 3a (PR #139)
e 3b (PR #140, lavoro su branch unico e «Porta in produzione»), entrambe in `main`.

## Decisioni sui punti aperti

1. **Modello di squadra facoltativo.** Senza `team_template_id` il giro resta quello della 3a (`done` «usa Implementa»). Con il modello il
   salvataggio verifica che la versione corrente abbia almeno un ruolo che scrive codice (`code: write|merge`), altrimenti 400
   «il modello di squadra deve avere un ruolo che scrive codice».
2. **Squadra creata al primo giro con voci** (`ensureCycleTeam`), non all'attivazione: così il modello si valida con i ruoli del momento e
   un ciclo senza voci non crea nulla. Si riusa la squadra salvata in `evolution_cycles.team_instance_id` se non è chiusa e viene dallo
   stesso modello; altrimenti se ne crea una nuova (`createInstance` con `ref` `{type: "evoluzione", id: <id App>, title: "Evoluzione di
   <app>"}`, nome «Evoluzione di <app>»), poi `activateInstance` con chi paga. Se chi paga è cambiato (consenso nuovo di un altro utente)
   la squadra passa a lui (`activated_by`). Un errore di regola nella creazione → giro `blocked` col messaggio e ciclo in pausa.
3. **Messaggio «Implementa» lato server** (`lib/evolution/implement.ts`): stesso testo di `artifacts/casello/src/lib/implement-plan.ts`,
   con id, titolo e issue delle voci del giro; turno `request` al capo. Il giro passa a `implementing` nella stessa transazione
   dell'approvazione delle voci; `implementation_started_at` (orologio del DB) si scrive solo quando il messaggio è partito: un giro
   `implementing` senza quell'istante si riprova al controllo successivo.
4. **Giro e lavoro**: colonne `evolution_rounds.team_instance_id`, `work_id`, `pending_action_id`, `implementation_started_at`. Il lavoro del
   giro è il primo lavoro della squadra creato dopo `implementation_started_at` (stesso orologio del DB). `syncRound` (dal controllo ogni
   5 minuti e da un aggancio chiamato da `works.ts` e `release.ts` a ogni cambio di stato del lavoro): lavoro `awaiting_release|releasing`
   con voce → giro `awaiting_release`; `released` → `done` «lavoro N in produzione» (errori azzerati); `abandoned` → `blocked`
   «nessuna voce completata»; lavoro di nuovo `open` dopo `awaiting_release` → `implementing` (timer ripartito); se la voce `release`
   del giro è stata rifiutata dall'utente con una nota, la nota va in `evolution_rounds.rejection_note` ed entra nell'analisi del giro
   dopo. `implementing` da oltre 72 ore → `blocked` «giro scaduto» (il lavoro resta: lo chiude l'utente o il capo).
5. **Nessun giro nuovo con un lavoro non chiuso** della squadra del ciclo (`open|awaiting_release|releasing`): 409 transitorio
   «il lavoro della squadra del ciclo non è ancora chiuso», senza pausa né errore.
6. **Tetto**: `cycleSpend` somma le analisi `evolution` dell'App e i turni e compiti di tutte le squadre dell'App con `ref_type =
   evoluzione` (tolta la squadra, la spesa resta). `teamCapBlock` per una squadra di ciclo usa il tetto del ciclo e quella spesa
   («tetto di spesa del ciclo raggiunto»). `team_instances.monthly_budget_usd` si allinea al tetto del ciclo (solo per la console);
   `PUT /team-instances/:id/budget` su una squadra di ciclo → 409 «il tetto della squadra del ciclo si cambia nelle impostazioni del ciclo».
   `teamSpend` passa in `teams/team-spend.ts` per evitare importazioni circolari.
7. **PLAN approvato dal ciclo**: dopo che `proponi_piano` ha accodato una voce `plan`/`plan_change`, se la squadra è del ciclo, il ciclo è
   attivo e il consenso valido, la voce si approva con `decidePlanItem` (`decided_by` = chi paga, `pending_actions.decided_by_cycle`),
   evento nel bollettino. `consentValid` passa in `consent.ts` (puro) per usarlo fuori dal servizio.
8. **Ferma**: il ciclo va in pausa; un giro `analyzing|approving` diventa `stopped` come prima, un giro `implementing|awaiting_release`
   **resta aperto** (segue il lavoro, che riprende con «Riprendi»; differenza dalla spec §8). Squadra del ciclo: compiti `queued` e
   `waiting_node` annullati (PLAN `failed`), nessun turno preso finché il ciclo è in pausa (`pumpTurn` lascia il turno in coda: i motivi
   si accumulano e partono con «Riprendi»), nessun merge automatico sul branch del lavoro (`mergeIntoWork` → `skipped`), `unisci_pr`
   rifiutato «ciclo di evoluzione fermato». «Riprendi» accoda al capo «Il ciclo di evoluzione è ripreso: riprendi il lavoro» e riparte
   il timer delle 72 ore. «Elimina» vuole il ciclo in pausa e nessun giro `analyzing|approving`.
9. **Eventi del giro**: valore nuovo `giro_evoluzione` di `team_event_type`: implementazione avviata, giro chiuso, giro scaduto, ciclo in
   pausa (se la squadra c'è).
10. **Consenso**: `CONSENT_VERSION` = `2026-11-17` (i cicli esistenti chiedono un consenso nuovo); `merge_mode` non entra più nell'impronta
    né nel testo, si accettano `staging` e `direct` e si salva `direct`. Testo con il modello: squadra, PLAN approvato da solo, merge
    automatici sul branch del lavoro con la CI verde, riscrittura del branch di prova dell'App; «Porta in produzione» resta all'utente.

## Passi

1. Migrazione `docs/migrations/2026-11-17-evoluzione-squadra.sql` (additiva): colonne dei giri, `pending_actions.decided_by_cycle`,
   valore `giro_evoluzione`; schema Drizzle e `docs/schema-casello.sql`.
2. `consent.ts` (versione, testo, impronta senza `merge_mode`, `consentValid`), `messages.ts`, `spend.ts` + `teams/team-spend.ts`, `team-budget.ts`.
3. `lib/evolution/implement.ts` (messaggio) e `lib/evolution/cycle-team.ts` (squadra del ciclo, approvazione automatica del PLAN, pausa).
4. `service.ts`: `saveCycle` (modello, allineamento del tetto), `advanceRound` (`implementing`), `startImplementation`, `syncRound`,
   `startRound` (lavoro non chiuso), `stopCycle`/`resumeCycle`/`deleteCycle`; schedulatore; agganci in `works.ts`, `release.ts`,
   `lead-tools.ts`, `turn-runner.ts`, `merge.ts`, `instances.ts`.
5. Analisi: nota dell'ultimo rifiuto di «Porta in produzione» nel prompt dell'analisi ridotta.
6. OpenAPI (`EvolutionCycleView.teamInstanceId/teamName`, `EvolutionRoundView.workId/rejectionNote`, `QueuedAction.decidedByCycle`, enum
   degli eventi), codegen; console: scelta del modello di squadra nel dialogo, squadra e fasi nella carta, «dal ciclo» sulle voci di piano.
7. Test: Vitest di consenso, messaggio, servizio (macchina a stati con il lavoro), prova di flusso estesa in `test/evolution-flow.test.ts`.
8. CLAUDE.md, typecheck, PR.
