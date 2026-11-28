# Piano · Relazioni tra i ruoli di una squadra

Spec: `docs/superpowers/specs/2026-11-28-botcave-relazioni-ruoli-design.md` (approvata il 28/11/2026, con i punti del §10 come proposti).

## Scelte tecniche

- Le relazioni non entrano nel manifesto dei ruoli (che resta un array di ruoli, letto in molti punti): colonne nuove `links` jsonb
  (default `[]`) su `team_template_versions` e `team_instances`.
- `lib/teams/links.ts` (puro): schema `RoleLink {from, to, mode: full|notes}`, `validateLinks(roles, links)` con i messaggi del §4 della
  spec, `pruneLinks` (toglie le frecce dei ruoli spariti), `outgoing(links, key)`.
- Un `PUT` senza `links` lascia quelle attuali (potate ai ruoli rimasti); con `links` le sostituisce.
- Consultazioni e messaggi: tabella `team_role_messages` (enum `team_role_message_kind` `consult|note`, `team_role_message_status`
  `pending|answered|failed|delivered`), con token e costo della consultazione e `ai_model_id`: conta in `teamSpend` e in `lib/budget.ts` come i compiti.
- `lib/teams/role-links-runtime.ts`: strumenti `consulta_ruolo` e `scrivi_a_ruolo` (nomi riservati), `runConsultation` (ciclo
  dell'agente del ruolo consultato con limiti 4 giri / 60 s / 20 000 token, strumenti di sola lettura: tool L0 del ruolo e lettura del codice
  se ha `code ≠ none`, nessun `riferisci`), `pendingNotesFor` e `markNotesDelivered` per il prossimo compito del destinatario.
- Attesa della consultazione fuori dal tempo attivo: `ToolResult.waited` (nuovo campo facoltativo) fa contare la durata come attesa nel
  ciclo dell'agente, come per i tool `ui`.
- Ruoli `node`: le note arrivano nel testo delle istruzioni del pacchetto del claim (nessuna modifica a `casello-nodo`).
- Aggiornamenti proposti: `link_added`, `link_removed`; «Salva come modello» copia le relazioni.
- Console: dipendenza `@xyflow/react`; componente `components/teams/role-links-editor.tsx` (canvas + elenco accessibile) dentro l'editor dei
  ruoli; tipo «Colleghi» nell'attività della squadra.

## Passi

1. Migrazione `docs/migrations/2026-11-28-relazioni-ruoli.sql`, schema Drizzle, `docs/schema-casello.sql`.
2. `links.ts` con i test; modelli, istanze, aggiornamenti, «salva come modello».
3. Strumenti e consultazioni nei compiti, note nei compiti cloud e nel pacchetto dei compiti node, spesa.
4. `leggi_esito` e prompt del capo; route `GET /team-instances/:id/role-messages`; OpenAPI e codegen.
5. Console: editor delle relazioni (modello e squadra), «Colleghi» nell'attività.
6. Test (puri, servizio, prova di flusso con il finto provider), CLAUDE.md, typecheck, PR.
