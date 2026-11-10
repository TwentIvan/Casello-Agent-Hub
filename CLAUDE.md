# Botcave (nome in codice: Casello)

Il prodotto si chiama **Botcave**: trasforma le applicazioni in squadre di agenti che l'utente dirige, approvando le
decisioni importanti, anche a voce con Alfred. «Casello» resta il nome in codice: repository, pacchetti (`@workspace/casello`),
servizi, immagini, variabili, tabelle, URL e identificatori non si rinominano. Nei testi visibili all'utente si scrive sempre
«Botcave». È lo strato agentico comune a tutti i prodotti di Ivan (Mister, The Hub Up, ReMove, Vimini, TradeFlow).

Lingua: italiano per commenti, documentazione, issue e messaggi di commit. Codice e identificatori in inglese.

## Stato (ottobre 2026)

- API completa per il CRUD di App / Agent / Tool / Run e per l'esecuzione delle run con gli account AI degli utenti.
- Fase 1 "Agenti che agiscono": gli agenti chiamano i tool HTTP delle app (catalogo per app), con
  timeline dei passi; le azioni L2 passano dalla coda «Da confermare» (vedi "Strumenti MCP e coda delle conferme").
- Fase 3 "Architetto": analizza un'app (codice da GitHub o zip, OpenAPI, descrizione) e propone tool,
  agenti, skill, endpoint mancanti, piano di completamento ed evoluzione; nulla si attiva senza
  approvazione nella console (vedi "Architetto").
- Chat del piano: l'utente discute con un modello il piano di un'app e ne accetta le modifiche come schede
  (vedi "Chat del piano").
- Squadre (definizione): catalogo di skill, modelli di squadra e istanze legate a un lavoro di riferimento, con
  aggiornamenti proposti e «salva come modello» (vedi "Squadre (definizione)").
- Squadre (esecuzione): una squadra attiva ha un capo a turni, un PLAN versionato da approvare, compiti per i ruoli
  `cloud`, eventi e bollettino, centralino su `/mcp`; i ruoli `node` li esegue il nodo locale (vedi "Squadre (esecuzione)").
- Nodi (esecuzione dei ruoli `node`): servizio `casello-nodo` sul Mac dell'utente che prende i compiti `waiting_node`, li esegue
  con Claude Code in una cartella di lavoro della squadra e riferisce l'esito; allegati alle squadre, token d'ambito `node`
  (vedi "Nodi (esecuzione dei ruoli node)").
- Connettore OAuth: Casello è un authorization server OAuth 2.1 minimale, così l'app Claude (claude.ai, telefono) lo aggiunge come
  connettore personalizzato su `/mcp` e parla con le squadre senza token copiati (vedi "Connettore OAuth (app Claude)").
- Alfred: maggiordomo vocale nella console (`/alfred`, installabile sul telefono): parla con Gemini Live e usa gli strumenti del
  centralino; le decisioni vanno a doppio passo (vedi "Alfred (maggiordomo vocale)").
- Novità di Alfred a voce: durante una sessione vocale Alfred riferisce da solo le run dei Responsabili finite e le nuove voci in «Da confermare», solo nei momenti di silenzio
  (vedi "Alfred (maggiordomo vocale)").
- Lucius sulla squadra e memorie: nella scheda squadra Lucius discute identità e istruzioni dei ruoli e le propone come schede da
  accettare; Alfred e Lucius hanno una memoria (appunti e storico dei riassunti), visibile e modificabile in Account (vedi "Lucius
  sulla squadra e memorie").
- Lucius legge il codice: nella chat del piano, nelle schede agente e nelle aree degli agenti e nella chat di squadra Lucius legge il codice delle App collegate a GitHub (ultimo commit del branch, in cache) con
  `elenca_cartella`, `leggi_file`, `cerca_nel_codice` e verifica le voci prima di proporre (vedi "Lucius legge il codice"). Spec: `docs/superpowers/specs/2026-11-10-botcave-lucius-legge-il-codice-design.md`.
- Avanzamento dei turni: mentre una chat (Alfred scritto, Lucius, chat del piano e di squadra, console ed embed) aspetta la risposta, al posto di «sta pensando…» compaiono gli ultimi passi
  (strumenti chiamati, con frasi fisse) e il tempo trascorso; registro in memoria, nessuna migrazione (vedi "Avanzamento dei turni"). Spec: `docs/superpowers/specs/2026-11-10-botcave-avanzamento-turni-design.md`.
- Alfred e Lucius nelle aree: un solo pannello laterale a quattro schede (Alfred con la voce, Da confermare, Bollettino, Lucius), lo stesso in console ed embed, si apre
  dal pulsante di Alfred nella caverna o da «Chiedi a Lucius» (Alfred scritto con un filo unico che sa da quale pagina scrivi, Lucius sull'argomento che la pagina dichiara:
  agente, skill, modello di squadra, aree, piano, squadra); schede da accettare, passaggio di consegne tra le due schede, modello e tetto mensile per personaggio in
  Account → «Personaggi» (vedi "Alfred e Lucius nelle aree"). Spec: `docs/superpowers/specs/2026-11-09-botcave-pannello-unico-design.md`.
- Botcave incorporabile: una riga `<script>` nell'app ospite (prima prova: The Hub Up) mostra pulsante e pannello laterale (lo stesso pannello unico a quattro schede della console: Alfred con la voce, Da confermare,
  Bollettino, Lucius), in un iframe `/embed` con accesso OAuth «Collega con Botcave» (vedi "Botcave incorporabile (app ospiti)").
- The Hub Up come App (5b): collegata con il token di servizio `thu_…` di The Hub Up (identità `service` su tutti i tool), descrizione
  funzionale, analisi 24 rivista con 50 tool e un agente per ciascuna delle sue funzioni AI interne (ancora senza modello). Inventario
  degli agenti di The Hub Up e proposta per 5c in `docs/superpowers/specs/2026-11-07-botcave-the-hub-up-5b-design.md`.
- The Hub Up 5c, tappa 1: coda delle run con limiti di concorrenza, ambito `runs` dei token personali per le app ospiti, agente `general` =
  «Responsabile di prodotto» (scritture sempre in coda, descrizione funzionale nel prompt) e segnalazione dagli agenti di area con run figlia
  (vedi "The Hub Up 5c (tappa 1)").
- Inneschi: un agente parte da solo su un evento dell'app, senza modificare il server dell'app: sorveglianza (Botcave interroga a intervalli un
  tool L0, dedup, una run per elemento nuovo) e webhook in entrata con segreto nell'URL; carta «Inneschi» nella scheda agente, Lucius propone
  inneschi di sorveglianza (vedi "Inneschi").
- Alfred e i Responsabili: Alfred (voce, scritto e centralino `/mcp`) interpella il Responsabile di prodotto di ogni App con `chiedi_al_responsabile`, legge le App con `elenca_app` e l'esito con `leggi_run`; le scritture restano voci in «Da confermare» (vedi "Alfred (maggiordomo vocale)").
- Proposte multiple (4a): un agente propone più creazioni o modifiche collegate con lo strumento interno `proponi`; in «Da confermare» compare una sola voce «Proposta» con i passi,
  approvabile in parte (caselle per passo), con riferimenti agli id creati dai passi precedenti; Alfred la legge passo per passo e la decide (vedi "Proposte multiple").
- Esecutore «Claude Code (nodo)»: un account AI legato a un nodo fa eseguire a `casello-nodo` con `claude -p` (posto Claude Team dell'utente) i turni di Alfred scritto, Lucius,
  chat del piano e di squadra e le run degli agenti; strumenti su `/mcp/turn` con un token per turno, ripiego facoltativo su un modello cloud (vedi "Esecutore Claude Code (nodo)").
- Botcave Nodo (app per Mac): il nodo si installa, si collega, si aggiorna, si diagnostica e si disinstalla senza terminale: app senza finestre con Node
  incluso, abbinamento dal browser con un codice, aggiornamento automatico dal manifest, verifica e installazione di Claude Code, impostazioni, diagnosi
  e disinstallazione dalla console (vedi "Botcave Nodo (app per Mac)").
- Responsabile di Botcave stesso: l'App 4 (Botcave come app di sé stessa) con token di servizio d'ambito `agent`, che legge e scrive ma non decide mai al posto dell'utente (vedi "Token personali su `/api`").
- Frontend `artifacts/casello` completo: login Google, dashboard, App, Agenti (con Tool), lancio e
  monitoraggio delle Run. Pagine in `src/pages/`, componenti per area in `src/components/`; solo hook
  generati da Orval, mai fetch a mano.
- In produzione su https://casello.fantamister.cloud (vedi "Deploy").

## Identità Botcave

- Fonte di verità: `design/` alla radice (manuale `design/README.md`, istruzioni `design/IMPLEMENTA.md`). Colori, font, spazi e
  raggi stanno in `design/tokens.css`, generato da `design/tokens.json`: non si modifica a mano e non si scrivono colori nell'interfaccia
  (nessun esadecimale né classi di palette Tailwind come `amber-100`): un colore nuovo si propone in `tokens.json`.
- Console: `main.tsx` importa `@design/tokens.css` prima di `index.css`, dove le variabili di shadcn/ui e di Tailwind sono alias
  dei token (classi `bg-surface-1`, `text-ink-muted`, `text-accent-text`, `bg-brand`, `text-success`, `text-danger`…). Tema chiaro e
  scuro: segue il sistema, `data-theme` su `<html>` lo forza (menu utente → Tema, `lib/theme.ts`, chiave `botcave-theme`). JetBrains Mono
  per titoli, etichette, numeri e codice (`text-h2`, `text-label`, `font-mono`), Space Grotesk per testi e controlli. Niente ombre.
- Componenti di marca in `artifacts/casello/src/components/brand/`: `Led` (stati: `idle`, `work`, `ask`, `ok`, `ko`; fermi con la
  riduzione del movimento), `ConfirmItem` (voce della coda: il numero è quello del server, stabile, letto a voce da Alfred), `marks.tsx`
  (logo, segno, Alfred, Lucius dai file di `design/assets/`, versione chiara o scura secondo il tema). `Button` è `ui/button.tsx`
  (principale = `default`, secondario = `secondary`/`outline`, discreto = `ghost`/`link`). Gli stati si mostrano con i LED, non con
  badge colorati.
- Menu in un solo elenco (Dashboard, Squadre, Da confermare, Run, App, Agenti, Skill, Modelli di squadra, Modelli AI), senza aree.
  La caverna: `components/brand/cave.tsx` (`CaveVault`): la barra in alto di ogni pagina (`CaveHeader` in `app-shell.tsx`, 112 px,
  buia in entrambi i temi) ha la volta di stalattiti con il LED, sotto il logo chiaro su scuro, che è anche il pulsante del menu
  dell'account (`user-menu.tsx`), e a destra il pulsante di Alfred (segno chiaro su scuro, contatore delle voci da confermare, LED `work` mentre la voce è accesa) che apre il pannello sulla scheda Alfred (non il microfono verso `/alfred`; `/alfred` non è una voce di menu), poi il pavimento di
  roccia; niente titolo della pagina. Fondi e bordi in grigi neutri, senza dominanti calde o fredde. Alfred (il maggiordomo: a voce su
  `/alfred` e per iscritto nel pannello laterale) e Lucius (l'ingegnere del laboratorio: analisi, proposte, chat del piano e delle aree,
  nei prompt di `architect/prompts.ts`, `plan-chat/context.ts` e, per i due personaggi nel pannello, `lib/characters/instructions.ts`)
  sono due chatbot: compaiono con i loro segni dentro le funzioni dove si chiamano, non nella barra.
  Nessun riferimento a Batman.
- Icone e favicon: `design/icons/` servite alla radice dal plugin `botcaveIcons` di `vite.config.ts` (niente copie in `public/`); il
  manifest di Alfred usa `icon-192/512` e `icon-maskable-512`, colori `#151A21`. I Dockerfile copiano `design/` (web) e
  `design/tokens.json` (API: colori della pagina di consenso OAuth, `lib/oauth/pages.ts`).
- Tono dei testi: pulsanti che dicono cosa fanno, niente punti esclamativi, numeri precisi.

## Comandi

- `pnpm install` — installa tutto (pnpm 10, Node 24)
- `pnpm run dev` — avvia insieme API (`API_PORT`, default 3000) e frontend (`WEB_PORT`, default 5173);
  serve `DATABASE_URL` nell'ambiente. Il frontend Vite inoltra `/api` a `http://localhost:${API_PORT}`.
  Senza credenziali Google l'API non parte: in locale si usa `AUTH_DISABLED=true pnpm run dev`
- `pnpm run dev:api` / `pnpm run dev:web` — gli stessi due processi separati (es. in due terminali)
- `pnpm --filter @workspace/api-server run dev` — solo API su `PORT` (richiesta: es. `PORT=3000`)
- `pnpm --filter @workspace/casello run dev` — solo frontend (richiede `PORT` e `BASE_PATH=/`; proxy
  `/api` verso `API_PORT`, default 3000)
- `pnpm --filter @workspace/api-server run test` — test dell'API (Vitest; Postgres in memoria con PGlite,
  schema da `docs/schema-casello.sql`, nessun DB esterno necessario)
- `pnpm --filter @workspace/casello run test` — test della console (Vitest: protocollo, tema, rinnovo del token e coda del caricatore del pannello incorporabile)
- `pnpm --filter @workspace/casello-nodo run test` / `run build` — test e build del servizio `casello-nodo` (la build produce
  `artifacts/casello-nodo/dist/index.mjs`, richiesto da `casello-nodo install`)
- `bash artifacts/casello-nodo/scripts/build-app.sh` — build di Botcave Nodo per Mac (solo macOS, Node 24, rete verso nodejs.org e npm): app zippata,
  binario universale e `nodo-manifest.json` in `docker/nodo-downloads/` (in CI lo fa il job `build-nodo`)
- `pnpm run typecheck` — typecheck di tutti i package (da far passare prima di ogni commit)
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — rigenera hook React Query e schemi Zod da `openapi.yaml`
- `pnpm --filter @workspace/db run push` — applica lo schema Drizzle a un DB di SVILUPPO (`DATABASE_URL`
  richiesta). MAI in produzione: vedi "Schema DB" in "Deploy"

## Dove stanno le cose

- `lib/api-spec/openapi.yaml` — contratto API, fonte di verità (contract-first)
- `lib/api-client-react/src/generated/` — client generato da Orval: NON modificare a mano
- `lib/db/src/schema/` — schema Drizzle, una tabella per file (apps, agents, app_tools, agent_tools, runs,
  run_steps, sessions, analyses, analysis_items, agent_skills, users, user_identities, github_installations,
  ai_accounts, ai_models, providers, models, model_offers, catalog_runs, plan_conversations, plan_messages, plan_proposals,
  skills, skill_versions, team_templates, team_template_versions, team_instances, team_instance_skills,
  team_plans, team_plan_versions, team_tasks, team_task_steps, team_turns, team_turn_steps, team_events, alfred_sessions, alfred_confirmations, team_chat_conversations, team_chat_messages, team_chat_proposals, character_notes, character_history, character_conversations, character_messages, character_proposals, nodes, node_turns, team_attachments, oauth_clients, oauth_grants, oauth_codes, oauth_tokens, agent_triggers, trigger_seen_items, pending_action_steps)
- `artifacts/api-server/src/routes/` — route Express 5: `/api/apps`, `/api/apps/:id/tools` (catalogo dei
  tool dell'app, CRUD), `/api/agents`, `PUT /api/agents/:id/tools` (tool collegati a un agente di area),
  `POST /api/agents/:id/runs`, `/api/runs`, `GET /api/runs/:id/steps` (timeline dei passi),
  `/api/dashboard/stats`, `/api/pending-actions` (coda delle conferme), `POST /api/apps/:id/mcp-tools/refresh`,
  `GET|PUT /api/budget` (tetti di spesa), `/api/healthz`; architetto: `GET|POST /api/apps/:id/analyses`,
  `POST /api/apps/:id/analyses/zip` (corpo zip grezzo), `GET /api/analyses/:id`,
  `GET /api/analyses/:id/issues`, `PATCH /api/analysis-items/:id`, `GET|DELETE /api/agents/:id/skills`; GitHub: `GET /api/github/installations`, `GET /api/github/repos`
  (login e collegamento in `/api/auth/github/*`, vedi "Autenticazione"). Body, parametri e query si leggono con `parseRequest` (errore → 400);
  le risposte con `*Response.parse` (errore → 500, è un bug del server)
- `artifacts/api-server/src/lib/auth.ts` — login Google (OIDC), sessione e middleware che protegge `/api` (`requireAuth`: sessione o token personale; `sessionOnly`; `TOKEN_MESSAGES`); token in `lib/api-tokens.ts`, limite per token in `middlewares/rate-limit.ts`; UI in `components/account/api-tokens-section.tsx`
- `artifacts/api-server/src/lib/ai/` — account AI: provider e indirizzi (`providers.ts`), scoperta dei modelli
  (`discovery.ts`), esecutore unico (`executor.ts`), tipi condivisi delle chiamate (`chat-types.ts`), scelta del modello
  (`choice.ts`), riverifica e arricchimento dei modelli (`accounts.ts`), stato effettivo e preselezione
  (`model-status.ts`), prova con 1 token (`probe.ts`), modello predefinito e ripiego degli agenti
  (`default-model.ts`); route in `src/routes/ai.ts`; `GET|PUT /api/account/default-model` in
  `src/routes/account-model.ts`; `PUT /api/apps/:id/agent-models` in `src/routes/agents.ts`
- `artifacts/api-server/src/lib/catalog/` — catalogo dei modelli: fonti pubbliche (`sources.ts`), normalizzazione
  e fusione (`normalize.ts`, `merge.ts`), riepilogo delle novità (`summary.ts`), aggiornamento (`refresh.ts`),
  avvio settimanale (`scheduler.ts`); route in `src/routes/catalog.ts`; fonti finte per i test in
  `artifacts/api-server/test/fake-sources.ts`
- `artifacts/api-server/src/lib/agent-loop.ts` — ciclo dell'agente (puro, senza DB né rete): chiamate al
  modello, esecuzione dei tool, pause, limiti del turno
- `artifacts/api-server/src/lib/run-executor.ts` — orchestrazione delle run: collega il ciclo al DB,
  all'esecutore dei tool e all'esecutore dei modelli; scrive i passi in `run_steps`; le chiamate L2 diventano voci
  di `pending_actions` e la run prosegue senza fermarsi (niente più pausa). `POST /api/agents/:id/runs` risponde subito con la run
  `pending` e NON la avvia: la prende lo scheduler di `lib/run-queue.ts` (la UI fa polling su `GET /api/runs/:id`); all'avvio le run
  `running` diventano `failed`, le `pending` con `has_user_token` anche («token utente perso al riavvio: rilancia la run»), le altre `pending`
  restano in coda e ripartono (vedi "The Hub Up 5c (tappa 1)"). `lib/escalation.ts`: strumento `segnala_al_responsabile`.
- `artifacts/api-server/src/lib/product-leads.ts` — Responsabili di prodotto per Alfred: elenco delle App dell'utente, richiesta al Responsabile con attesa dell'esito e lettura delle run (vedi "Alfred (maggiordomo vocale)")
- `artifacts/api-server/src/lib/run-queue.ts` — coda delle run (`createQueuedRun`, `scheduleRuns`, `startRunQueue`) e
  `artifacts/api-server/src/lib/escalation.ts` — segnalazione al Responsabile di prodotto (vedi "The Hub Up 5c (tappa 1)")
- `artifacts/api-server/src/lib/tools/` — client MCP (`mcp-client.ts`), sincronizzazione degli strumenti MCP
  (`mcp-sync.ts`), livelli d'azione (`levels.ts`), catalogo (`catalog.ts`), validazione delle definizioni
  (`definition.ts`), esecutore HTTP (`executor.ts`), regole degli header verso le app (`headers.ts`: autenticazione e header fissi), oscuramento degli argomenti sensibili (`sensitive.ts`)
- `artifacts/api-server/src/lib/secrets.ts` — cifratura AES-256-GCM dei segreti di servizio (anche il token GitHub)
- `artifacts/api-server/src/lib/users.ts` — utenti e identità (`isAllowed`, `resolveLogin`, `linkIdentity`, `unlinkIdentity`)
- `artifacts/api-server/src/lib/github/` — GitHub App: configurazione (`config.ts`), client con JWT e token di
  installazione (`app.ts`), login/collegamento/callback (`oauth-routes.ts`), sincronizzazione delle installazioni
  (`installations.ts`); finto GitHub per i test in `artifacts/api-server/test/fake-github.ts`
- `artifacts/api-server/src/lib/actions/` — coda delle azioni da confermare: accodamento (`queue.ts`), controllo del
  testo (`text-check.ts`), approvazione/rifiuto (`decide.ts`); route in `src/routes/pending-actions.ts`; pagina
  `artifacts/casello/src/pages/pending-actions.tsx`; server MCP finto per i test in `artifacts/api-server/test/fake-mcp.ts`
- `artifacts/api-server/src/lib/architect/` — architetto: sorgenti in memoria (`source-tree.ts`, `zip-reader.ts`,
  `search-worker.ts`, `sources.ts`), schemi ed esempi delle fasi (`schemas.ts`, `prompts.ts`), ciclo di fase
  (`phase-loop.ts`), orchestrazione (`run-analysis.ts`), differenze/applicazione/issue (`diff.ts`, `apply.ts`, `issues.ts`),
  fonte MCP (`mcp-source.ts`) e testi condivisi (`text.ts`)
- `artifacts/api-server/src/lib/plan-chat/` — chat del piano: contesto (`context.ts`), strumenti (`tools.ts`), turno
  (`turn.ts`), decisione sulle schede (`decide.ts`), esecuzione in background (`run-turn.ts`); route in
  `src/routes/plan-chat.ts`; pagina `/apps/:id/plan` in `artifacts/casello/src/pages/app-plan.tsx` e `components/plan/`
- `artifacts/api-server/src/lib/plan-issues/` e `lib/github/issues.ts` — issue GitHub dalle voci del piano: contenuto
  ed etichette (`content.ts`), prenotazione/creazione/aggiornamento (`service.ts`), client GitHub e token `issues: write`
  (`issues.ts`); route in `src/routes/plan-issues.ts` (`POST /api/apps/:id/plan/issues`, `POST /api/apps/:id/plan/issues/refresh`);
  console in `artifacts/casello/src/components/plan/` (`create-issues-dialog.tsx`, `issues-summary.tsx`, `issue-badge.tsx`)
- `artifacts/api-server/src/lib/teams/` — squadre: skill del catalogo (`skills.ts`), manifesto dei ruoli (`manifest.ts`),
  regole di salvataggio (`rules.ts`), modelli (`templates.ts`), istanze (`instances.ts`), aggiornamenti proposti
  (`updates.ts`), salva come modello (`save-as-template.ts`); route in `src/routes/skills.ts`, `team-templates.ts` e
  `team-instances.ts`; console: pagine `skills.tsx`, `skill-detail.tsx`, `team-templates.tsx`, `team-template-detail.tsx`,
  `teams.tsx`, `team-detail.tsx` in `artifacts/casello/src/pages/` (route `/skills`, `/team-templates`, `/teams`; vedi "Squadre (definizione)")
- Esecuzione delle squadre (vedi "Squadre (esecuzione)"): in `artifacts/api-server/src/lib/teams/` PLAN (`plan.ts`),
  decisione sulle voci di piano (`plan-decisions.ts`), coda dei turni (`turn-queue.ts`), strumenti dei ruoli (`role-tools.ts`),
  strumenti del capo (`lead-tools.ts`), turni del capo (`turn-runner.ts`), compiti (`task-runner.ts`), eventi (`events.ts`),
  tetto della squadra (`team-budget.ts`), centralino (`centralino.ts`); ciclo e costi condivisi con le run in
  `artifacts/api-server/src/lib/loop-wiring.ts`; route nuove in `src/routes/team-instances.ts` (attivazione, PLAN, messaggi,
  compiti, turni, eventi, tetto) e `src/routes/account-model.ts` (modello del centralino); console: componenti in
  `artifacts/casello/src/components/teams/` (`plan-card.tsx`, `plan-approval-card.tsx`, `plan-editor-dialog.tsx`,
  `team-activity.tsx`, `team-bulletin.tsx`, `lead-message.tsx`, `team-budget.tsx`) usati da `pages/team-detail.tsx`
- Nodi locali (vedi "Nodi (esecuzione dei ruoli node)"): in `artifacts/api-server/src/lib/nodes/` registrazione dei nodi (`nodes.ts`),
  autenticazione del protocollo (`auth.ts`: `requireNodeToken`), heartbeat/claim/ping/report/scarico degli allegati (`protocol.ts`),
  controlli periodici (`lease-sweeper.ts`); allegati e spazio di lavoro in `lib/teams/attachments.ts`; route in `src/routes/nodes.ts`
  (`/api/account/nodes`, solo login) e `src/routes/node.ts` (`/api/node/*`, solo token `node`); allegati in `src/routes/team-instances.ts`;
  servizio `artifacts/casello-nodo/` (README, `src/`: `cli.ts`, `loop.ts`, `runner.ts`, `client.ts`, `config.ts`, `launchd.ts`,
  `workspace.ts`, `capabilities.ts`, `task-file.ts`); console: `components/account/nodes-section.tsx` (Account → Nodi) e
  `components/teams/team-attachments.tsx` (scheda squadra). Spec: `docs/superpowers/specs/2026-11-04-casello-nodo-locale-design.md`
- Botcave Nodo per Mac (vedi "Botcave Nodo (app per Mac)"): API in `artifacts/api-server/src/lib/nodes/` (`pairing.ts` abbinamento, `manifest.ts` manifest e
  aggiornamenti, `node-admin.ts` impostazioni, diagnosi e disinstallazione, con `protocol.ts` e `lease-sweeper.ts`), route `src/routes/node-pairing.ts` e
  `src/routes/nodes.ts`/`node.ts`, Dashboard in `src/routes/dashboard.ts`; schema `lib/db/src/schema/node-pairings.ts` e `nodes.ts`; nodo in `artifacts/casello-nodo/src/`
  (`app-mode.ts` modalità app e menu, `pairing.ts`, `dialogs.ts` con `osascript`, `updater.ts`, `claude-check.ts`, `node-admin.ts` diagnosi e disinstallazione, con
  `loop.ts`, `cli.ts`, `config.ts`, `index.ts`), build `artifacts/casello-nodo/scripts/build-app.sh`, `app/` (`Info.plist`, `sea-config.json`), `min-version.txt`; file pubblicati in
  `docker/nodo-downloads/`; console `pages/node-pair.tsx` (`/nodes/pair`), `lib/pair-code.ts`, `components/account/` (`node-download-card.tsx`, `node-status-list.tsx`,
  `node-settings-dialog.tsx`, `nodes-section.tsx`). Prova di flusso `artifacts/api-server/test/node-app-flow.test.ts`. Spec:
  `docs/superpowers/specs/2026-11-10-botcave-nodo-senza-terminale-design.md`
- Alfred (vedi "Alfred (maggiordomo vocale)"): `artifacts/api-server/src/lib/alfred/` (`config.ts`, `settings.ts`, `gemini.ts`, `sessions.ts`,
  `tools.ts`, `tool-declarations.ts`, `confirmations.ts`, `instructions.ts`, `notifications.ts`); route `src/routes/alfred.ts`; schema `lib/db/src/schema/alfred.ts`;
  console `artifacts/casello/src/pages/alfred.tsx`, `components/alfred/` (`use-alfred-voice.ts`, `mic-worklet.ts`, `alfred-transcript.tsx`, `notification-queue.ts`),
  `components/account/characters-section.tsx` (la carta «Personaggi» che assorbe le impostazioni di Alfred); `public/alfred.webmanifest` e icone. Spec: `docs/superpowers/specs/2026-11-05-casello-alfred-design.md`
- Lucius sulla squadra e memorie (vedi "Lucius sulla squadra e memorie"): `artifacts/api-server/src/lib/team-chat/` (`context.ts`, `snapshot.ts`,
  `tools.ts`, `instructions-file.ts`, `run-turn.ts`, `decide.ts`) e `lib/memory/` (`types.ts`, `notes.ts`, `history.ts`, `credentials.ts`,
  `context.ts`, `tools.ts`, `summaries.ts`); `lib/zip-writer.ts` (zip dei file dei ruoli); route `src/routes/team-chat.ts` e
  `src/routes/memories.ts`; schema `lib/db/src/schema/team-chat.ts` e `character-memory.ts`; console `components/teams/role-instructions-card.tsx`
  (il pannello della squadra è ora il pannello comune `components/characters/`), `components/account/memories-section.tsx`. Spec: `docs/superpowers/specs/2026-11-06-botcave-lucius-squadra-design.md`
- Alfred e Lucius nelle aree (vedi "Alfred e Lucius nelle aree"): `artifacts/api-server/src/lib/characters/` (`types.ts`, `registry.ts`,
  `conversations.ts`, `run-turn.ts`, `instructions.ts`, `proposals.ts`, `handoff.ts`, `settings.ts`; `subjects/`: `index.ts` (registrazione
  unica), `alfred-thread.ts`, `agent.ts`, `skill.ts`, `team-template.ts`, `areas.ts`, `shared.ts`, `hash.ts`), `lib/agents.ts` (funzioni
  condivise con `routes/agents.ts`); route `src/routes/characters.ts` e `src/routes/account-characters.ts`; schema
  `lib/db/src/schema/characters.ts`; console `artifacts/casello/src/components/characters/` (`character-chat.tsx`, `lucius-button.tsx`, adattatori `adapters.ts`, `character-adapters.ts`, `plan-team-adapters.tsx`, schede
  `proposal-cards.tsx`, `proposal-previews.tsx`, `chat-messages.tsx`, `chat-toolbar.tsx`, `new-conversation-dialog.tsx`) e
  `components/account/characters-section.tsx`. Pannello unico (spec `docs/superpowers/specs/2026-11-09-botcave-pannello-unico-design.md`): `artifacts/casello/src/components/panel/`
  (`botcave-panel.tsx`, `console-panel-sheet.tsx`, `panel-context.tsx` con `PanelProvider`/`usePanel`/`usePanelSubject`, `panel-state.ts` riduttore puro, `page-subject.ts` con `pageFromPath` e
  `handoffTarget`, `voice-context.tsx` con `AlfredVoiceProvider`, `panel-link.tsx`, `tabs.ts`, `tabs/`: `alfred-tab.tsx`, `pending-tab.tsx`, `bulletin-tab.tsx`, `lucius-tab.tsx`); tolti
  `character-sheet.tsx`, `character-button.tsx`, `handoff-context.tsx`, `embed/tab-content.tsx` e `embed/tabs/`. Spec dei personaggi: `docs/superpowers/specs/2026-11-06-botcave-personaggi-design.md`
- `artifacts/casello/src/` — frontend React + Vite + Tailwind + shadcn/ui (`components/ui/` pronti)
- `artifacts/api-server/src/lib/mcp/` e `lib/architect/local-executor.ts` — server MCP `/mcp` e coda/lease delle analisi locali
  (`lib/mcp/auth.ts`: `requireApiToken`, accetta `cas_…` e `cao_…`)
- Connettore OAuth (vedi "Connettore OAuth (app Claude)"): `artifacts/api-server/src/lib/oauth/` (`config.ts`, `errors.ts`, `metadata.ts`,
  `clients.ts`, `authorize.ts`, `pages.ts`, `tokens.ts`, `grants.ts`); route `src/routes/oauth.ts` (alla radice: `/.well-known/…` e `/oauth/…`,
  fuori da `/api`) e `src/routes/oauth-grants.ts` (`/api/account/oauth-grants`); schema `lib/db/src/schema/oauth.ts`; console
  `artifacts/casello/src/components/account/oauth-grants-section.tsx` (Account → «App collegate»); limiti in `middlewares/rate-limit.ts`
- Botcave incorporabile (vedi "Botcave incorporabile (app ospiti)"): API in `artifacts/api-server/src/lib/embed/` (`origins.ts`, `clients.ts`) e
  `src/routes/embed.ts` (`GET /api/embed/config`), con le parti in `lib/auth.ts` (`sessionOrEmbed`), `lib/oauth/` (`authorize.ts`, `tokens.ts`,
  `grants.ts`) e `routes/alfred.ts`; console `artifacts/casello/embed.html`, `src/embed/` (`main.tsx`, `embed-app.tsx`, `auth.ts`, `callback.ts`,
  `protocol.ts`, `theme.ts`, `use-host.ts`, `use-badge.ts`, `loader/`; le schede sono in `components/panel/tabs/`: il caricatore `botcave.js`),
  `vite.loader.config.ts`, `embed-demo.html` (solo sviluppo); `docker/nginx.conf.template`, `docker/15-embed-origins.envsh`. Spec:
  `docs/superpowers/specs/2026-11-06-botcave-plugin-incorporabile-design.md`
- Inneschi (vedi "Inneschi"): `artifacts/api-server/src/lib/triggers/` (`config.ts`, `extract.ts`, `input.ts`, `eligibility.ts`, `queue-run.ts`, `poller.ts`,
  `webhook.ts`, `secrets.ts`, `service.ts`, `messages.ts`); route `src/routes/triggers.ts` (`/api/agents/:id/triggers`, `/api/triggers/*`) e `src/routes/hooks.ts`
  (`/api/hooks/*`, pubblico); schema `lib/db/src/schema/agent-triggers.ts`; console `artifacts/casello/src/components/agents/` (`agent-triggers-section.tsx`,
  `trigger-dialog.tsx`, `trigger-test-table.tsx`, `webhook-url-dialog.tsx`); Lucius in `lib/characters/subjects/agent.ts` e `proposals.ts`. Spec:
  `docs/superpowers/specs/2026-11-07-botcave-inneschi-design.md`
- Proposte multiple (vedi "Proposte multiple"): `artifacts/api-server/src/lib/actions/` (`proposal.ts`, `propose.ts`, `proposal-exec.ts`, `proposal-view.ts`, con `queue.ts` e `decide.ts`), `lib/run-executor.ts`
  (offerta di `proponi`, oscuramento nella timeline), `routes/pending-actions.ts`, `routes/app-tools.ts`, `lib/teams/centralino.ts`, `lib/mcp/server.ts`, `lib/alfred/` e `lib/characters/` (`leggi_proposta`, `escludi`); schema
  `lib/db/src/schema/pending-action-steps.ts`; console `artifacts/casello/src/components/actions/` (`proposal-steps.tsx`, `use-proposal-selection.ts`) e `src/lib/proposal-steps.ts`. Spec:
  `docs/superpowers/specs/2026-11-08-botcave-proposte-multiple-design.md`
- Esecutore Claude Code (vedi "Esecutore Claude Code (nodo)"): account nodo in `artifacts/api-server/src/lib/ai/node-account.ts` (con `accounts.ts`, `executor.ts`,
  `routes/ai.ts`); coda e protocollo dei turni in `lib/node-turns/` (`queue.ts`, `protocol.ts`, `sweeper.ts`, `registry.ts`, `prompt.ts`, `delegate.ts`, `chat-turn.ts`,
  `messages.ts`); server MCP del turno `lib/mcp/turn-server.ts` (`/mcp/turn`); smistamento delle tool call delle run `lib/agent-dispatch.ts`; route in `src/routes/node.ts`
  (`/api/node/turns/*`); schema `lib/db/src/schema/node-turns.ts`; nodo `artifacts/casello-nodo/src/turns.ts` e `turn-runner.ts`; console
  `components/account/ai-account-dialog.tsx`, `node-account-fields.tsx`, `ai-accounts-section.tsx`, `nodes-section.tsx`, `components/runs/run-steps.tsx`. Prova di flusso
  `artifacts/api-server/test/node-turn-flow.test.ts` con `test/fake-claude.mjs`. Spec: `docs/superpowers/specs/2026-11-09-botcave-esecutore-claude-code-nodo-design.md`
- `artifacts/api-server/src/lib/turn-progress/` — avanzamento dei turni di chat: frasi dei passi (`describe.ts`) e registro in memoria (`progress.ts`); con `lib/node-turns/chat-turn.ts` e
  console `components/characters/` (`turn-progress.ts`, `turn-progress-view.tsx`, `character-chat.tsx`) (vedi "Avanzamento dei turni")
- `artifacts/api-server/src/lib/code-reader/` — lettura del codice delle App per Lucius: cache per commit (`source-cache.ts`), strumenti (`tools.ts`), messaggi e istruzioni (`messages.ts`); con
  `lib/github/commit.ts` (SHA del branch) e `userHasInstallation` in `lib/github/installations.ts` (vedi "Lucius legge il codice"). Spec: `docs/superpowers/specs/2026-11-10-botcave-lucius-legge-il-codice-design.md`
- `docs/skills/casello-architetto-locale/` — skill dell'agente locale (da copiare in `~/.claude/skills/`)
- `artifacts/mockup-sandbox/` — sandbox di mockup: NON va in produzione, non toccare
- `gateway/` — config LiteLLM storica (gateway dismesso, vedi "Modelli AI"); non è più usata dal codice
- `docker/`, `.github/workflows/deploy.yml` — build e deploy (vedi sotto)

## Modello di dominio

- **App**: applicazione registrata: nome, `slug`, `base_url`, `internal_base_url` (raggiunto
  dall'esecutore al posto di `base_url`), autenticazione utente/servizio (header + scheme), segreto di
  servizio cifrato (mai esposto: l'API dice solo `serviceSecretSet`), `mcp_url` (server MCP dell'app, facoltativo), stato
  e header fissi `extra_headers` (`[{name, value}]`, non segreti, es. `X-Organization-Id`): l'esecutore li manda su ogni chiamata ai tool,
  HTTP e MCP (anche la lista), con entrambe le identità, prima dell'autenticazione che vince sempre. Regole in `lib/tools/headers.ts`
  (`checkExtraHeaders`, insieme a `checkAuthHeaderName`): al più 10, nomi validi e non ripetuti, diversi dagli header di autenticazione
  (ricontrollato anche quando la PATCH cambia `userAuth`/`serviceAuth`), valori di 1..500 caratteri visibili su una riga e mai credenziali
  (`looksLikeCredential`), altrimenti 400 «extraHeaders: …». Migrazione `docs/migrations/2026-11-header-app.sql` (additiva, PRIMA del merge)
  Organizzazioni: vedi "App con organizzazioni".
- **Agent**: appartiene a una App; `system_prompt`, `model` (facoltativo: senza modello le run rispondono 409), stato (draft/active/inactive),
  `confirm_writes` (conferma delle scritture: le L1 vanno in «Da confermare»; sempre vera per il `general`), ruolo:
  `general` (uno per app, creato con l'app, non eliminabile, usa tutti i tool `active` dell'app; in console è il «Responsabile di prodotto») o `area`
  (usa solo i tool collegati in `agent_tools`)
- **Tool** (`app_tools`): catalogo per App; `kind` (`http`, `mcp`, `ui`, `composite`: al modello si offrono
  solo `http` e `mcp`; `mcp` ha `definition {mcpName}`), `identity` (`user`: token dell'utente da `X-App-User-Token`; `service`:
  segreto di servizio), `level` (L0–L3) e `levelOverride` (al posto dei vecchi flag `requiresConfirmation`/`readOnly`), stato (draft/active/disabled), definizione
  (metodo, path, posizione dei parametri) e `params_schema` JSON (`"x-sensitive": true` oscura un parametro)
- **Run**: esecuzione di un Agent: input, output, errore, durata, token, stato
  (pending/running/awaiting_client/succeeded/failed/cancelled; `awaiting_client` è solo storico); i passi in `run_steps`

## App con organizzazioni

Convenzione per ogni app collegata a Botcave che separa i dati per organizzazione (The Hub Up per prima; poi Mister, ReMove, Vimini,
TradeFlow). Botcave non conosce le organizzazioni delle app: le sceglie con gli header fissi dell'app (`extra_headers`, es.
`X-Organization-Id` e `X-Organization-Scope` per The Hub Up), mandati su ogni chiamata ai tool.

- Il token di servizio che l'app dà a Botcave è legato a un utente dell'app e ha un ambito di organizzazione scelto alla creazione:
  **una organizzazione** (l'app la impone e ignora gli header della richiesta) oppure **tutte le organizzazioni dell'utente** (l'organizzazione
  la sceglie la richiesta con i suoi header; l'app verifica che l'utente ne sia membro, altrimenti 403; senza header vale il comportamento
  predefinito della sua interfaccia).
- Il perimetro resta l'utente del token: con «tutte» Botcave non vede mai più di quanto quell'utente vede dall'interfaccia. I token esistenti
  a una organizzazione restano tali: nessun permesso in più senza un token nuovo.
- In Botcave: segreto di servizio = token «tutte», header fissi = organizzazione su cui devono lavorare gli agenti dell'app. Gli header valgono
  per tutta l'app (non per agente o per innesco).
- The Hub Up: token `thu_…` con «Tutte le mie organizzazioni», header `X-Organization-Id` = id dell'organizzazione «Personal» e
  `X-Organization-Scope: all` (Personal più tutte le organizzazioni dell'utente).

## Strumenti MCP e coda delle conferme

- Spec: `docs/superpowers/specs/2026-11-03-casello-strumenti-mcp-design.md`.
- Livelli d'azione dei tool (`app_tools.level`): L0 lettura, L1 scrittura reversibile/a basso rischio (eseguita dalla
  run), L2 azione con effetti verso terzi (mai eseguita dalla run: va in coda e la decide l'utente), L3 mai offerta al
  modello. `levelOverride` può solo alzare il livello. Livello dei tool MCP: `_meta["casello/level"]` del server; senza,
  `readOnlyHint` → L0, altrimenti L2.
- Server MCP dell'app: `apps.mcp_url` (stesse regole di indirizzo e autenticazione dell'app); i suoi strumenti diventano
  tool `kind mcp` con `definition {mcpName}`. «Aggiorna strumenti» = `POST /api/apps/:id/mcp-tools/refresh` (6/min): nuovi
  → `draft`, cambiati → aggiornati, spariti → `disabled`; omonimi di tool esistenti o nomi non validi → `conflicts`;
  nomi ripetuti dal server → 502. Client (`lib/tools/mcp-client.ts`): `tools/list` 30 s e max 500 strumenti,
  `tools/call` 15 s e risposta max 1 MiB, nessun redirect, nessun flusso SSE con GET; credenziali e valori
  `x-sensitive` oscurati; messaggi fissi in italiano.
- Coda (`pending_actions`, numerata per utente, `UNIQUE(user_id, number)`): i tool L2 hanno `destinatario` e `sintesi`;
  proprietario = chi possiede l'account AI del modello della run. Controllo del testo (`text-check.ts`): segnaposto e
  menzioni sugli argomenti oscurati. Max 50 azioni `pending` per utente. Argomenti cifrati (`args_enc`), copia pubblica
  oscurata (`args_public`). Tipi di voce (`pending_actions.kind`, default `action`): `action` (L2 di un tool), `plan` e
  `plan_change` (piano o modifica del PLAN proposti dal capo di una squadra, vedi "Squadre (esecuzione)"); colonne
  `team_instance_id` (squadra, `SET NULL`) e `plan_version`; per `plan`/`plan_change` `tool_id` e `app_id` sono null
  (CHECK: obbligatori solo con `kind = action`) e `args_enc`/`args_public` contengono la proposta; l'approvazione non
  vuole `userToken`. Tipo `proposal`: proposta multipla di un agente, con i passi in `pending_action_steps` (vedi "Proposte multiple"). Numerazione e limite di 50 valgono per tutti i tipi.
- Route (`routes/pending-actions.ts`; il limite di 20/min per utente vale solo per approvare e rifiutare, non per le GET,
  ed è lo stesso contatore degli strumenti MCP `approva`/`rifiuta`, `consumeActionDecision`): `GET /api/pending-actions`, `GET /api/pending-actions/:number`,
  `POST …/approve` (con `userToken` se l'identità del tool è `user`), `POST …/reject` (nota ≤ 500 caratteri). Ambiti
  token `api:read` (GET) e `api:write` (approvare/rifiutare). Esecuzione esattamente una volta: UPDATE condizionato
  `pending` → `executing`; all'avvio le azioni `executing` diventano `failed` («esito incerto: verifica sul servizio»).
  Nessuna scadenza. `pending_actions.tool_id` è `ON DELETE RESTRICT`: eliminare un tool con azioni in coda o già
  decise è rifiutato (409 «il tool ha azioni in coda o già decise: disattivalo invece di eliminarlo»), si disattiva;
  eliminando un'app si elimina anche il suo storico della coda (stessa transazione).
- Console: pagina «Da confermare» con contatore (`pendingActions` in `/api/dashboard/stats`, conta tutti i tipi) e colonne
  tipo (Azione / Piano / Modifica del piano) e squadra.
- Migrazioni: `docs/migrations/2026-11-strumenti-mcp.sql` (additiva: PRIMA del merge) e
  `2026-11-strumenti-mcp-post.sql` (DOPO il deploy: toglie `app_tools.requires_confirmation|read_only` e
  `runs.pending_action|loop_state|paused_at`). Il codice non legge più quelle colonne.

## Squadre (definizione)

- Spec: `docs/superpowers/specs/2026-11-03-casello-squadre-definizione-design.md` (sottoprogetto 3a). Una squadra è un
  insieme di ruoli con un capo, skill e strumenti: si definisce come **modello** riusabile e si applica a un lavoro come
  **istanza** (es. The Hub Up · WI 1174). Struttura a stella: un solo capo, gli altri ruoli riferiscono a lui. Squadra
  trasversale alle app: ogni ruolo sceglie strumenti (`app_tools`) di qualunque app; l'istanza è legata a un'app e a un
  lavoro (`ref_app_id`, `ref_type`, `ref_id`, `ref_title`).
- **Skill** (`skills` + `skill_versions`): codice unico (`^[a-z0-9][a-z0-9._-]{1,63}$`), tipo `casello` (istruzioni, max
  20 000 caratteri, non vuote; `tool_hints` informativi) o `node` (nome della skill sul nodo, `^[a-zA-Z0-9:_-]{1,100}$`, niente
  `tool_hints`). Versioni immutabili: `PATCH` di `content`/`toolHints` crea la versione `current_version + 1` (riga bloccata
  FOR UPDATE; max 200 versioni → 409), nome e descrizione si cambiano senza nuova versione. Deprecata (`POST …/deprecate`):
  resta dove già usata, non entra in ruoli nuovi.
- **Modello** (`team_templates` + `team_template_versions`): ogni `PUT` (nome, descrizione e ruoli insieme, tutto o niente)
  crea una versione con il suo manifesto jsonb; le skill nel modello sono codici senza versione. Nome unico tra i non
  archiviati (409 «nome già usato»); modello archiviato → 409 «modello archiviato» (non si salva né si copia). `DELETE`
  cancella se non ha istanze, altrimenti archivia e risponde `{deleted, archived}`.
- **Manifesto del ruolo** (`manifest.ts`): `key` (`^[a-z0-9_-]{1,40}$`, stabile tra versioni), `name` (1..80), `task`
  (max 8 000; in console e nei prompt è l'«Identità» del ruolo, il campo resta `task`), `isLead`, `runsOn` `cloud`|`node`, `aiModelId`, `tools` (id di `app_tools`), `skills`; nell'istanza le skill
  sono `{code, version}` fissate e c'è `localSkills` (codici delle skill specializzate).
- **Regole** (`rules.ts`, `validateRoles`, a ogni salvataggio di modello o istanza; violazione → 400 con messaggio fisso in
  `TEAM_MESSAGES`, nulla salvato): un solo capo («una squadra ha esattamente un capo»); 1..20 ruoli, `key` e `name` unici,
  ≤ 30 skill per ruolo (catalogo + specializzate); `cloud` → `aiModelId` di un modello dei propri account («modello non
  disponibile»), `node` → `aiModelId` null; skill `node` solo su ruoli `node`; skill inesistenti o deprecate rifiutate,
  salvo quelle già nel ruolo della versione precedente (stessa `key`); nelle istanze la versione fissata deve esistere;
  strumenti `active` e con livello effettivo ≠ L3 («lo strumento <nome> non può essere usato da una squadra»), salvo
  quelli già nel ruolo precedente. La validazione legge dal pool ed è SEMPRE fuori dalla transazione di scrittura.
  Strumento poi disattivato o L3 resta nel ruolo e si legge con `available: false` (eliminato: nome «strumento eliminato»).
- **Istanza** (`team_instances`, `roles` jsonb, `team_instance_skills`): `POST /team-instances` copia il manifesto della
  versione corrente del modello fissando ogni skill alla sua `current_version` (`template_version`), `draft`; senza modello
  i `roles` sono obbligatori. `ref_title` di default `<tipo> · <id>`. Skill specializzate (max 100 per istanza, codice
  unico per istanza e con il formato del catalogo, stesse regole di contenuto delle skill): `PUT` sostituisce ruoli e
  skill specializzate insieme, può portare `status` `draft`↔`active`; `POST …/close` chiude (non si riapre né si salva più:
  409 «squadra chiusa», anche su `GET …/updates`). `ref_app_id` è `RESTRICT`, `template_id` `SET NULL`.
- **Aggiornamenti proposti** (`updates.ts`): `GET /api/team-instances/:id/updates` confronta il modello corrente con la
  versione copiata (`template_version`) e le skill con la loro versione corrente. Tipi: `role_added`, `role_removed`,
  `role_changed` (per campo: nome, compito, luogo, modello, strumenti, capo), `skill_added`, `skill_removed`, `skill_version`;
  `id` stabile (es. `role_changed:<key>:<campo>`). Una voce compare solo se il modello è cambiato rispetto alla versione
  copiata E l'istanza non ha già il valore proposto: le modifiche fatte solo nella squadra e i valori già uguali non
  generano voci; dopo un'applicazione parziale un valore può essere riproposto finché non si applicano tutte le
  modifiche del modello.
  `POST …/updates/apply` con `{ids}` (senza ripetizioni, 400 «aggiornamenti ripetuti»): tutto o niente, valida il
  risultato (es. senza capo → 400), un id non più attuale o un'istanza cambiata nel frattempo → 409 «aggiornamenti
  cambiati: ricarica». `template_version` passa alla versione corrente solo se non restano voci del modello (le
  `skill_version` non contano).
- **Salva come modello** (`POST …/save-as-template`, 201): `{mode: "new" | "new_version", name?, promote?: [{localCode, code}]}`
  (max 100). `new` richiede il nome (400) e crea un modello con le skill del catalogo senza versione; le specializzate
  elencate in `promote` entrano nel catalogo (v1) con il codice nuovo (già usato → 409, formato non valido → 400, ripetizioni
  → 400), le altre vengono tolte; `new_version` crea la versione successiva del modello d'origine, che ne conserva nome e
  descrizione (409 se l'istanza non ha modello o è archiviato) e riallinea l'istanza d'origine: `template_version` alla
  nuova versione e, per le skill promosse, nei ruoli la skill del catalogo (v1) al posto di quella specializzata (che
  si toglie dall'istanza), così non restano aggiornamenti spuri. Tutto o niente, in una transazione.
- Regole e legami: ruoli con strumenti o skill ripetuti → 400 («strumenti/skill ripetuti nel ruolo <nome>», verificati da
  `validateRoles` con gli schemi del manifesto). Copiando da un modello, skill deprecate e strumenti non più usabili già
  presenti nel modello restano ammessi. Un'app che è il lavoro di riferimento di una squadra non si elimina: `DELETE
  /api/apps/:id` → 409 «l'app è il lavoro di riferimento di <n> squadre».
- Route: `GET|POST /api/skills`, `GET|PATCH /api/skills/:code`, `POST …/deprecate`, `GET …/versions`, `GET …/versions/:version`;
  `GET|POST /api/team-templates` (`archived`), `GET|PUT|DELETE /api/team-templates/:id`, `GET …/versions/:version`;
  `GET|POST /api/team-instances` (filtri `status`, `appId`, `refType`, `refId`), `GET|PUT /api/team-instances/:id`,
  `POST …/close`, `GET …/updates`, `POST …/updates/apply`, `POST …/save-as-template`. Con un token personale valgono gli
  ambiti per metodo (`api:read` / `api:write`); errori con `{error}` in italiano, mai il testo del DB.
- Console: voci di menu «Skill» (elenco con filtri, scheda con versioni e confronto), «Modelli di squadra» (ruoli, capo
  evidenziato, editor) e «Squadre» (istanze, skill specializzate, riquadro «Aggiornamenti disponibili», «Salva come
  modello», «Attiva»/«Chiudi»); niente scorrimento orizzontale a 1280 px.
- Migrazione: `docs/migrations/2026-11-squadre.sql` (additiva e idempotente, nessuna modifica a tabelle esistenti, niente
  `-post`): da applicare in produzione PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`.
- L'esecuzione (3b) è descritta in "Squadre (esecuzione)", il nodo locale (4) in "Nodi (esecuzione dei ruoli node)".
  Organizzazioni e policy dei dati (2) e The Hub Up (5) restano fuori.

## Squadre (esecuzione)

- Spec: `docs/superpowers/specs/2026-11-04-casello-squadre-esecuzione-design.md` (sottoprogetto 3b). Dove il codice differisce
  dalla spec vale il codice, descritto qui. Una squadra `active` lavora sul suo lavoro di riferimento: il capo tiene il PLAN,
  assegna compiti ai ruoli `cloud`, riceve gli esiti; gli eventi alimentano il bollettino; l'utente decide da console o dal
  centralino. Esecuzione in background nel processo dell'API (come run e analisi), senza `run-executor` né la tabella `agents`.
- **Attivazione**: `POST /api/team-instances/:id/activate` (`draft` → `active`, `activated_by` = chi attiva, che riceve le
  voci in coda e paga con i propri account; già attiva → 409 «la squadra è già attiva», chiusa → 409 «squadra chiusa»):
  crea il PLAN `draft` se manca e accoda un turno con motivo `activation`, tutto in una transazione. Si attiva SOLO così:
  `PUT /api/team-instances/:id` non cambia più lo stato (`status: "active"` → 400 «usa Attiva per avviare la squadra»,
  `draft` su una squadra attiva → 409 «una squadra attiva non torna in bozza: chiudila»). `POST …/close` annulla i
  compiti `queued` (`cancelled`, nel PLAN `failed`), rifiuta le voci `plan`/`plan_change` aperte («squadra chiusa») e fa
  fallire i turni in coda; compiti e turni `running` finiscono da soli ma non fanno partire altri turni.
- **Capo a turni** (`turn-runner.ts`): non resta acceso; riceve un turno per un motivo (`team_turns.reasons` jsonb: `activation`,
  `restart`, `request` con testo, `task_finished` con id, `decision` con numero, esito e nota). Al più un turno `queued` e uno
  `running` per squadra (indici unici parziali): un motivo nuovo si accoda al turno `queued` con un'unica INSERT … ON CONFLICT
  (`turn-queue.ts`); presa in carico con UPDATE condizionato `queued` → `running`; finito un turno parte quello accumulato.
  Limiti: 6 giri, 90 s di tempo attivo, 40 000 token. Il modello è quello del ruolo capo (ruolo `node` → turno `failed`).
  Richieste e note di rifiuto dell'utente arrivano come messaggi `user`, mai nel prompt di sistema; i risultati degli
  strumenti sono dati. Un turno fallito chiude `failed` con l'errore ed emette `bloccato`; `team_instances.last_turn_at`.
  Motivi non consegnati (`carriedReasons`): un turno che fallisce prima del modello (tetto, modello mancante, squadra non
  attivata…) registra 0 token; il primo turno che arriva al modello riceve anche i motivi della catena di turni `failed`
  con 0 token immediatamente precedenti (fino al primo turno arrivato al modello o interrotto dal riavvio, che ha token
  null; al più 20, motivi uguali una volta), così una nota di rifiuto non si perde e si consegna una volta sola.
- **PLAN** (`plan.ts`; `team_plans` una riga per squadra, `team_plan_versions` una riga per versione): `status`
  `draft` | `proposed` | `approved`, `version` (+1 a ogni versione), `approved_version`; obiettivo ≤ 2 000, vincoli e punti
  aperti ≤ 30 da 500, compiti ≤ 50 (`id` `t1`, `t2`… stabile, titolo ≤ 200, `roleKey`, istruzioni ≤ 4 000, stato
  `planned|running|waiting_node|done|blocked|failed`, esito ≤ 300), azioni manuali ≤ 30 (`m1`… , testo ≤ 500, `done`).
  Due modi di scrivere: `writePlanVersion` (versione nuova: proposte e correzioni) e `patchPlan` / `setPlanStatus` (sul
  posto, senza versione nuova: stato ed esito dei compiti, azioni manuali, punti aperti, approvazione/rifiuto). La versione
  approvata si legge da `team_plan_versions` (`getApprovedPlan`): la riga corrente può già essere una proposta.
  Ordine dei lock: riga della squadra → riga del PLAN → righe di `pending_actions`; letture e validazioni dal pool, fuori
  dalle transazioni di scrittura.
- **Strumenti del capo** (`lead-tools.ts`, risultati `ok: false` con messaggio fisso, mai eccezioni): `leggi_piano`;
  `proponi_piano` (obiettivo, vincoli, punti aperti, compiti con `id` per gli esistenti, senza per i nuovi; id sconosciuto →
  «id di compito sconosciuto: ometti l'id per i compiti nuovi»; ruolo inesistente rifiutato); `aggiorna_piano` (punti aperti,
  azioni manuali, stato/esito dei compiti non in corso: `planned|done|blocked|failed`, compito in corso →
  «il compito <id> è in corso: aspetta il suo esito»); `assegna_compito` (solo compito del PLAN approvato in `planned|blocked|failed`,
  altrimenti «il compito non è nel piano approvato: proponi una modifica» o «il compito è già in corso»; se le ultime 3
  esecuzioni del compito sono tutte `failed` o `blocked` → «compito fallito 3 volte: segnala all'utente», `MAX_TASK_FAILURES`:
  un'esecuzione riuscita in mezzo azzera il conto); `leggi_esito`;
  `segnala` (`bloccato|decisione_richiesta|azione_manuale_richiesta`, bollettino ≤ 300, dettaglio ≤ 4 000;
  `azione_manuale_richiesta` aggiunge l'azione al PLAN, max 30); `chiudi_lavoro` (evento `lavoro_finito`: la squadra resta
  attiva finché l'utente non la chiude). Tutti i capo-strumenti che scrivono bloccano la squadra e falliscono con «la squadra
  non è attiva» se non lo è. Il capo usa anche i suoi strumenti di app (livelli di sempre; L2 in coda con `team_instance_id`).
- **Proposte e approvazioni**: senza versione approvata `proponi_piano` scrive la versione `proposed` e accoda una voce
  `plan`; con una versione approvata, una modifica rilevante (obiettivo, vincoli, compiti aggiunti/tolti, titolo/ruolo/istruzioni
  di un compito: `isRelevantChange`) accoda una `plan_change` con le differenze (`diffSummary`); una modifica non rilevante
  non chiede approvazione (solo punti aperti sul posto, oppure versione nuova già `approved` se la riga corrente non era
  la versione approvata, e allora una proposta aperta è ritirata con evento «Il capo ha ritirato la proposta di piano»).
  Una proposta nuova rifiuta le voci `plan`/`plan_change` ancora aperte («superata da una nuova proposta»). Versione nuova,
  rifiuti e voce in coda stanno nella stessa transazione: se la voce non si può accodare (es. 50 in attesa) non resta
  scritto nulla, evento `bloccato` «Piano non proposto: …». Stato ed esito dei compiti si conservano dalla riga corrente,
  dall'ultima esecuzione o dalla versione approvata; i compiti nuovi partono `planned`. Decisione (`plan-decisions.ts`,
  chiamata da `approveAction`/`rejectAction` per i tipi ≠ `action`): approvare rende approvata la versione proposta
  (`setPlanStatus`); rifiutare, se c'è una versione approvata, rimette il suo contenuto (`restoreApprovedPlan`, letto da
  `team_plan_versions`) come versione nuova `approved` che diventa la versione approvata: la proposta rifiutata non resta
  nella riga corrente; stato ed esito dei compiti dalla riga corrente, per i compiti assenti dall'ultima esecuzione in
  `team_tasks`; punti aperti e azioni manuali (sul posto, senza approvazione) restano quelli della riga corrente; tutto
  nella stessa transazione, con il lock del PLAN prima delle righe di `pending_actions`. Senza versione approvata il PLAN
  torna `draft` (nessuna versione nuova). Poi un turno con motivo `decision` (numero, esito, nota). Proposta non più attuale
  (versione o stato cambiati) → la voce passa a `failed` «proposta superata da una versione più recente»; squadra chiusa:
  approvare → 409 «squadra chiusa», rifiutare toglie la voce senza turno.
- **Correzione dell'utente**: `PUT /api/team-instances/:id/plan` (stesso schema del PLAN; ruolo inesistente → «ruolo <key>
  inesistente», id ripetuto → «compito <id> ripetuto») scrive una versione nuova già `approved` (l'approvatore è l'utente),
  stato ed esito dei compiti esistenti restano quelli registrati (i nuovi sono `planned`), rifiuta le voci di piano aperte
  («superata dalla modifica dell'utente») e accoda al capo un turno `request` con le differenze. `POST
  …/plan/manual-actions/:actionId/done` segna «Fatto» sul posto (404 «azione manuale non trovata»). `GET …/plan` legge il PLAN
  (se manca lo crea `draft`).
- **Compiti** (`task-runner.ts`; `team_tasks` + `team_task_steps`, stati `queued|running|waiting_node|done|blocked|failed|cancelled`):
  `startTask` (da `assegna_compito`) crea l'esecuzione di un compito del PLAN approvato con la squadra bloccata:
  «la squadra non è attiva» se non lo è, «il compito è già in corso» se lo stesso compito ha già un'esecuzione
  `queued|running|waiting_node`. Ruolo `node` → `waiting_node` (lo prende il nodo locale, vedi "Nodi (esecuzione dei ruoli node)"), altrimenti
  `queued` e lo scheduler li porta a `running` (UPDATE con la squadra bloccata): al massimo 3 `running` per squadra, gli altri
  in coda. Il ruolo `cloud` esegue il ciclo dell'agente con prompt del ruolo, contenuto delle sue skill `casello` (versione
  fissata dell'istanza e specializzate), PLAN in sola lettura (messaggio `user`), istruzioni del compito, strumenti del ruolo
  (`app_tools` di più app, ognuno con la connessione della sua app, solo `active`, `http`/`mcp`, livello effettivo ≠ L3,
  identità solo di servizio: un tool `user` risponde «token utente mancante»; nome ripetuto o uguale a uno interno →
  `<nome>_<appId>`) più `riferisci` (`status` `done|blocked`, `outcome` ≤ 300, `detail` ≤ 20 000). Limiti come una run: 8 giri,
  120 s, 60 000 token. Fine: con `riferisci` l'esito è quello riferito; senza, l'ultimo messaggio (troncato a 300) con stato
  `done`; errore o limite → `failed`. Poi, in ogni caso: stato ed esito nel PLAN, evento (`compito_finito` se `done`, altrimenti
  `bloccato`) e turno del capo con motivo `task_finished`. Le azioni L2 di un ruolo vanno in coda all'utente che ha attivato la
  squadra (voce `action` con `team_instance_id`, la run non si ferma).
- **Eventi e bollettino** (`events.ts`; `team_events`): tipi `piano_proposto`, `compito_finito`, `bloccato`, `decisione_richiesta`,
  `azione_manuale_richiesta`, `lavoro_finito`, `interrotto`; bollettino ≤ 300 caratteri, dettaglio ≤ 4 000; mai segreti né
  indirizzi delle app. Il bollettino è dell'utente che ha attivato la squadra. `GET /api/team-instances/:id/events`,
  `GET /api/team-events?unread=true|false` (dell'utente, al massimo 200; altro valore → 400), `POST /api/team-events/read`
  con `{ids}` (risponde `{updated}`).
- **Centralino** (strumenti su `/mcp`, ambito `mcp`, 60 chiamate/min per utente; logica in `lib/teams/centralino.ts`, solo dati
  dell'utente: una squadra di un altro è «squadra non trovata»): `squadre_stato` (una riga per squadra attiva), `bollettino`
  (fino a 100 eventi non letti, li segna letti; `remaining` per gli altri), `squadra_dettaglio` (PLAN, ultimi 30 compiti,
  ultimi 20 eventi), `invia_al_capo` (`id`, `testo` ≤ 4 000: turno `request`; vuoto → «messaggio vuoto»; stesso contatore di
  10/min per utente di `POST …/messages`, oltre → «Troppe richieste: riprova tra poco»), `coda_da_confermare` (fino a 50
  voci `pending` con tipo, squadra, sintesi, `needsUserToken`), `approva` (`numero`, `userToken?`) e `rifiuta` (`numero`, `nota?`
  ≤ 500) per tutti i tipi; `approva` e `rifiuta` vogliono anche l'ambito `api:write` del token (altrimenti «il token non ha
  l'ambito per questa operazione») e consumano il limite di 20/min per utente delle route di decisione (oltre → «Troppe
  richieste: riprova tra poco»). Annotazioni MCP: `destructiveHint` su `approva`/`rifiuta`, `readOnlyHint` su
  `squadre_stato`, `squadra_dettaglio`, `coda_da_confermare` (non su `bollettino`, che segna letti). **Modello del centralino**: `users.centralino_ai_model_id`, `GET|PUT /api/account/centralino-model`
  (solo login; modello dei propri account, altrimenti 400; null = modello predefinito); oggi serve solo a `squadre_stato`
  quando le squadre attive sono più di 5 (riassunto in al massimo 5 righe, 30 s, 1 000 token; senza modello disponibile o in
  caso di errore, elenco completo; costo del riassunto solo nel log). In console: Account, carta «modello del centralino».
- **Costi e tetti**: ogni turno e compito registra token e costo (`prompt_tokens`, `completion_tokens`, `cached_tokens`,
  `cost_usd`; null = prezzo mancante). Prima di ogni turno o compito (`team-budget.ts`): tetto mensile della squadra
  (`team_instances.monthly_budget_usd`, `PUT /api/team-instances/:id/budget` `{monthlyBudgetUsd}`, null = nessuno; spesa del
  mese di turni e compiti dell'istanza ≥ tetto → «tetto di spesa della squadra raggiunto»), poi modello, account AI e utente
  come per le run; l'utente controllato è il proprietario dell'account del modello del ruolo (non per forza chi attiva). Un
  compito bloccato dal tetto chiude `blocked` (evento `bloccato`), un turno `failed` (evento `bloccato` che finisce con
  «Alza il tetto per riprendere.»). `PUT …/budget` su una squadra attiva con un tetto nuovo nullo o sopra la spesa del mese
  accoda al capo un turno `request` «Il tetto di spesa della squadra è stato aggiornato: riprendi il lavoro»
  (`BUDGET_RESUME_REQUEST`), che riceve anche i motivi dei turni bloccati. Restano i limiti tecnici per turno e per compito.
- **Avvio e riavvio** (`index.ts`): turni e compiti `running` diventano `failed` («interrotto dal riavvio») con un evento
  `interrotto` e il compito nel PLAN `failed`; le squadre `active` coinvolte ricevono un turno `restart`; poi ripartono i turni
  rimasti `queued` e i compiti `queued` delle squadre attive. Turno e compito presi in carico con UPDATE condizionato: una sola
  esecuzione alla volta.
- Route: `POST /api/team-instances/:id/activate`, `POST …/messages` (`{text}` ≤ 4 000, 202 `{queued}`, vuoto → 400
  «messaggio vuoto», squadra non attiva → 409 «la squadra non è attiva», 10/min per utente), `GET|PUT …/plan`, `POST
  …/plan/manual-actions/:actionId/done`, `GET …/tasks` (ultimi 200), `GET …/tasks/:taskId` (con i passi; 404 «compito non
  trovato»), `GET …/turns` (ultimi 50, con i passi), `GET …/events`, `PUT …/budget`, `GET /api/team-events`, `POST
  /api/team-events/read`. Con un token personale valgono gli ambiti per metodo.
- Console (scheda squadra, `pages/team-detail.tsx`): «Piano da approvare» (Approva / Rifiuta con nota), «Piano» (compiti con
  stato ed esito, azioni manuali con «Fatto», punti aperti, «Modifica»), «Scrivi al capo», «Attività» (turni e compiti con i
  passi), «Bollettino» («Segna come letti»), tetto di spesa, «Attiva». Polling ogni 5 s finché un turno o un compito è in
  coda o in corso, più un periodo di grazia di ~10 s dopo la fine o dopo un'azione dell'utente che accoda un turno. Niente
  scorrimento orizzontale a 1280 px.
- Migrazione: `docs/migrations/2026-11-squadre-esecuzione.sql` (additiva e idempotente, nessuna colonna tolta, niente `-post`):
  tabelle `team_plans`, `team_plan_versions`, `team_tasks`, `team_task_steps`, `team_turns`, `team_turn_steps`, `team_events`;
  colonne su `team_instances` (`activated_by`, `monthly_budget_usd`, `last_turn_at`), `pending_actions` (`kind`,
  `team_instance_id`, `plan_version`; `tool_id`/`app_id` nullable) e `users` (`centralino_ai_model_id`). Da applicare in produzione
  PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`.
- Il nodo locale (esecuzione dei ruoli `node` e dei loro compiti `waiting_node`) è descritto in "Nodi (esecuzione dei ruoli node)".
- Non ancora fatto: interfaccia in The Hub Up (5), organizzazioni e policy dei dati (2).

## Nodi (esecuzione dei ruoli node)

- Spec: `docs/superpowers/specs/2026-11-04-casello-nodo-locale-design.md` (sottoprogetto 4). Dove il codice differisce dalla spec
  vale il codice, descritto qui. Un **nodo** è il servizio `casello-nodo` sul Mac dell'utente (tabella `nodes`: nome unico per
  utente, `active|disabled`, capacità dichiarate `executor`, `version`, `skills`, `workspace_root`, `max_concurrent`, `last_seen_at`).
  Esegue i compiti `waiting_node` dei ruoli `node` con Claude Code; Casello non lo chiama mai: è il nodo che interroga (heartbeat
  e claim). Un nodo prende solo compiti di squadre attivate dal suo stesso utente.
- **Nodi e token** (`lib/nodes/nodes.ts`, `routes/nodes.ts`, solo con il login: `sessionOnly`): `GET|POST /api/account/nodes`
  (`{name}` 1..100 caratteri, 400 «nome obbligatorio, al massimo 100 caratteri», doppione per utente 409 «nome già usato»; la
  creazione risponde 201 con il token `cas_…` in chiaro, mostrato una sola volta), `POST …/:id/disable`, `POST …/:id/token`
  («Rigenera token»: revoca i token precedenti e ne crea uno nuovo, riga del nodo bloccata), `DELETE …/:id` (204; elimina anche i
  token a cascata). Nodo di un altro utente → 404 «nodo non trovato». Un nodo disattivato non si riattiva (se ne crea un altro);
  il suo token smette di valere: 403 «nodo disattivato». Disattivare, eliminare o rigenerare il token ferma i compiti che il nodo ha in
  carico: nella stessa transazione (riga del nodo bloccata, compiti letti prima di eliminare: poi `node_id` diventa null) i compiti
  `running` con lease del nodo chiudono `failed` «nodo disattivato» con la guardia `node` di `closeTaskRow` (stessa lease, una
  volta sola) e perdono la lease; dopo il commit PLAN, evento `bloccato` e turno del capo. Anche «Rigenera token» interrompe i compiti in
  corso: il vecchio processo non potrebbe più riferire. Il token ha ambito `node`, scade dopo 365 giorni, non compare in
  «Token personali» ed è accettato solo da `/api/node/*` (`requireNodeToken`, montato prima di `requireAuth`: senza header Authorization
  o con un token non di nodo → 403 «il token non ha l'ambito per questa operazione», token non valido → 401). «Online» = visto negli
  ultimi 2 minuti (`NODE_ONLINE_WINDOW_MS`).
- **Protocollo** (`lib/nodes/protocol.ts`, `routes/node.ts`; limiti per nodo in `middlewares/rate-limit.ts`): `POST /api/node/heartbeat`
  (capacità: `version`, `executor`, `skills`, `workspaceRoot`, `maxConcurrent`; risponde `{pending}` = compiti che il nodo potrebbe
  prendere; 6/min), `POST /api/node/claim` (204 se non c'è nulla, altrimenti il pacchetto del compito; 6/min, contatore separato),
  `POST /api/node/tasks/:id/ping` (`{leaseToken}`, rinnova la lease, 4/min per compito), `GET /api/node/tasks/:id/attachments/:attachmentId`
  (header `X-Lease-Token`; byte come `application/octet-stream`, `attachment`, `nosniff`), `POST /api/node/tasks/:id/report` (204). Lease
  non valida o scaduta → 409 «lease non valida o scaduta»; allegato non citato dal compito o di un'altra squadra → 404 «allegato non trovato».
- **Claim e skill**: sono candidati i compiti `waiting_node` di squadre `active` attivate dall'utente del nodo, dal più vecchio
  (`waiting_since`), fino a 200 per chiamata, il cui ruolo è `node` e le cui skill `node` (catalogo, versione fissata, e specializzate
  di tipo `node`: `roleNodeSkills`) sono tutte tra quelle dichiarate dal nodo. Il claim blocca squadra → nodo → compito (`SKIP LOCKED`) e
  rispetta `max_concurrent` (i compiti `running` con lease del nodo); `running`, `node_id`, `lease_token` e `lease_expires_at` si
  scrivono in un colpo, il PLAN diventa `running` dopo il commit (se il pacchetto non si prepara il compito torna `waiting_node`).
  Pacchetto: squadra, spazio di lavoro, ruolo (con il nome del modello preferito), compito, PLAN, skill `casello`, nomi delle skill
  `node`, metadati degli allegati. Un compito di nodo si riconosce da `lease_token IS NOT NULL`: il limite dei compiti
  cloud (3 `running` per squadra) non lo conta. Se la squadra ha raggiunto il tetto di spesa, i suoi compiti `waiting_node` si
  chiudono `blocked` «tetto di spesa della squadra raggiunto» (PLAN, evento `bloccato`, turno del capo, una volta sola con UPDATE
  condizionato a `waiting_node`) e non si consegnano: al claim e nel controllo di ogni minuto (`blockCappedWaitingTasks`), perché
  l'heartbeat non li conta in `pending` e il nodo, con `pending` 0, non chiede il claim.
- **Lease e scadenze** (`lease-sweeper.ts`, all'avvio e ogni minuto): lease di 15 minuti (`LEASE_MS`), rinnovata da ogni ping. Una
  lease scaduta chiude il compito `failed` «nodo non più raggiungibile» (evento `bloccato`, turno del capo), con UPDATE condizionato
  alla stessa lease: un report o un ping arrivati nel frattempo vincono. Il riavvio dell'API NON fallisce i compiti presi da un nodo
  (restano `running`, non girano nell'API): li chiude il report o la scadenza della lease. Un compito in attesa da oltre 10 minuti
  senza alcun nodo vivo e attivo dell'utente con le skill del ruolo emette una volta sola (`no_node_notified`) l'evento `bloccato`
  «Compito <id> (<ruolo>): nessun nodo disponibile con le skill: …»; il controllo salta i primi 2 minuti di vita del processo (i nodi
  devono poter ricomparire) e il compito resta in attesa. `POST …/close` annulla (`cancelled`) anche i compiti `waiting_node` e quelli
  `running` presi da un nodo: la lease si toglie (PLAN `failed`, nessun turno), ping e report del nodo ricevono 409 e il nodo interrompe
  il lavoro.
- **Report** (`POST …/report`: `leaseToken`, `status` `done|blocked|failed`, `outcome` (troncato a 300), `detail` (≤ 20 000, troncato),
  `costUsd`, `promptTokens`, `completionTokens` (interi, altrimenti 400), `sessionId`): chiude il compito come i compiti cloud (`finishTaskExecution`: PLAN, evento
  `compito_finito` o `bloccato`, turno del capo `task_finished`) una volta sola. Il costo riferito si registra con `ai_model_id` null: conta
  solo nel tetto della squadra, non nella spesa di utente, modello o account. `/api/node/*` ha un parser JSON da 256 KB al posto di
  quello globale da 100 KB (`app.ts`): un `detail` di 20 000 caratteri tutti da escapare non fa perdere il report.
- **Allegati** (`lib/teams/attachments.ts`, `team_attachments`; route in `team-instances.ts`, ambiti per metodo): `GET|POST
  /api/team-instances/:id/attachments` (il corpo del POST è il file grezzo, nome in `X-Attachment-Name`, anche codificato con
  `encodeURIComponent`), `GET|DELETE …/:attachmentId` (204; il GET scarica con `Content-Disposition: attachment`). Max 10 MiB a file («allegato
  troppo grande», 413) e 50 MiB per squadra tra i non eliminati («spazio allegati della squadra esaurito», 413); nome 1..200 caratteri senza
  `/`, `\`, `..` né controlli («allegato non valido», 400); nome già usato da un allegato non eliminato della squadra, senza distinguere
  le maiuscole (sul nodo si sovrascriverebbero) → 409 «nome già usato», controllato nella transazione con la squadra bloccata; squadra
  chiusa → 409 «squadra chiusa». Come per le squadre non c'è un
  proprietario per allegato (le squadre sono condivise tra gli utenti ammessi; la proprietà per utente è del sottoprogetto 2). Il capo li
  assegna con `assegna_compito` (`attachments`: id, max 20, tutti della squadra e non eliminati, altrimenti «allegato <id> inesistente»;
  riletti nella transazione di `startTask`, con la squadra bloccata). Eliminare: cancellazione vera se nessun compito `queued`,
  `waiting_node` o `running` lo cita, altrimenti solo `deleted_at` (sparisce dall'elenco e dal limite, ma il nodo che lo ha in carico lo
  scarica ancora); lo sweep cancella poi gli eliminati non più citati.
- **Spazio di lavoro** (`team_instances.node_workspace`, `PUT /api/team-instances/:id`, `nodeWorkspace` null = tolto): percorso relativo
  alla radice del nodo, 1..300 caratteri `[A-Za-z0-9._ -]` e `/`, senza `/` iniziale o finale, segmenti vuoti, `.` o `..` (400 «spazio di
  lavoro non valido»). **Cartelle del nodo** per sceglierlo in console («Sfoglia», `components/teams/node-folder-picker.tsx`): il browser non
  vede i percorsi del Mac, quindi l'elenco lo manda il nodo. Ogni heartbeat porta `folders` (facoltativo, ≤ 2 000 percorsi relativi ≤ 300
  caratteri; `scanFolders` in `capabilities.ts`: in ampiezza fino a 3 livelli, al massimo 5 000 cartelle lette, solo cartelle, saltate le
  nascoste, `node_modules`, `casello-allegati`, i nomi non ammessi con il loro contenuto e i link simbolici); Casello tiene solo quelle valide
  come spazio di lavoro (`cleanFolders`), senza ripetizioni e in ordine, in `nodes.workspace_folders` con `folders_updated_at`; un heartbeat
  senza `folders` (nodo di versione precedente) lascia l'elenco com'era. `GET /api/account/nodes/:id/folders` (solo login, 404 per un nodo
  altrui) risponde `{nodeId, workspaceRoot, folders, foldersUpdatedAt}`, `folders` null se il nodo non le ha mai mandate.
- **`casello-nodo`** (`artifacts/casello-nodo/`, README incluso; Node 24, `claude` nel PATH con il login già fatto): ciclo con heartbeat
  ogni 30 s; se `pending > 0` e c'è posto prende i compiti, li esegue e riferisce (il report si ritenta finché la lease è valida).
  Rinnova la lease con i ping. Per ogni compito scrive nello spazio di lavoro `casello-compito.md` (istruzioni, piano, skill) e gli
  allegati in `casello-allegati/` (verificati con dimensione e sha256), lancia `claude` con quella cartella e legge l'esito da
  `casello-esito.json`; a fine compito i file di servizio si tolgono. Lo spazio di lavoro si risolve con `realpath` e deve stare dentro la
  radice (niente `..`, percorsi assoluti o link simbolici in uscita); compiti con lo stesso spazio girano uno alla volta. `claude` parte in un
  gruppo di processi proprio: al timeout (`taskTimeoutMinutes`, default 60) o allo stop riceve SIGTERM e dopo 10 s SIGKILL; lo stop
  riferisce `failed` «esecuzione interrotta: nodo fermato». Un 409, 401 o 403 su ping, report o scarico di un allegato è lease persa
  (compito chiuso o annullato, token rigenerato, nodo disattivato o eliminato): il gruppo si termina come al timeout, nessun report, lo
  spazio di lavoro si libera, una riga di log. Su `uncaughtException`/`unhandledRejection` (`run`) il nodo registra l'errore, dà SIGKILL
  subito a tutti i gruppi di `claude` in corso (`killAllTaskGroups`) ed esce con 1. Skill con un nome non valido per l'heartbeat (oltre
  100 caratteri) si ignorano con un avviso; al massimo 500. Le skill dichiarate sono le cartelle con `SKILL.md` in `~/.claude/skills` e nella
  cache dei plugin (`<plugin>:<skill>`, solo la versione più recente).
- **Config e servizio**: config `~/.casello-nodo/config.json` con permessi 600 (altrimenti il nodo non parte), scritta in modo atomico; campi
  `caselloUrl` (https, http solo verso localhost/127.0.0.1/[::1]), `token`, `workspaceRoot`, `claudeBin` (default `claude`),
  `permissionMode` (default `bypassPermissions` = `--dangerously-skip-permissions`), `skillsDirs`, `maxConcurrent` (1..3, default 1),
  `taskTimeoutMinutes` (default 60). Stato in `~/.casello-nodo/state.json`, log in `~/.casello-nodo/logs/` (senza token, allegati né
  istruzioni). Comandi: `casello-nodo install` (richiede la build: `corepack pnpm --filter @workspace/casello-nodo run build`, poi
  `node artifacts/casello-nodo/dist/index.mjs install`; chiede indirizzo, token (non mostrato) e radice, oppure `--url`, `--workspace-root`,
  `--token-file`; `--token` lascia il token nella cronologia della shell; copia il programma costruito in
  `~/.casello-nodo/bin/casello-nodo.mjs`, file temporaneo e rename, ed è quella copia che lancia il servizio: il repository serve
  solo per costruire), `uninstall` (toglie anche la copia; config e log restano), `status`, `run` (in primo piano, è ciò che lancia
  launchd). Servizio LaunchAgent con etichetta `cloud.fantamister.casello-nodo` (`~/Library/LaunchAgents/…plist`, avvio al login e riavvio
  se cade; `ExitTimeOut` 30 s: allo stop launchd aspetta che il nodo termini i gruppi di `claude` e riferisca prima del SIGKILL).
- **Sicurezza**: l'agente gira con `--dangerously-skip-permissions` dentro lo spazio di lavoro (esegue comandi e modifica file senza
  conferma): la radice deve contenere solo ciò che può toccare. Il token del nodo sta in `config.json`, leggibile dallo stesso utente con cui
  gira l'agente; se si sospetta una compromissione: «Rigenera token» o disattiva il nodo in console.
- Console: Account → «Nodi» (creazione con token mostrato una volta, stato online, «Rigenera token», «Disattiva», elimina) e, nella scheda
  squadra, spazio di lavoro e «Allegati» (`team-attachments.tsx`).
- Migrazione: `docs/migrations/2026-11-nodo-locale.sql` (additiva e idempotente, niente `-post`): tabelle `nodes` e `team_attachments`, colonne
  su `api_tokens` (`node_id`), `team_instances` (`node_workspace`) e `team_tasks` (`node_id`, `lease_token`, `lease_expires_at`, `session_id`,
  `waiting_since`, `no_node_notified`, `attachment_ids`). Da applicare in produzione PRIMA del merge e da segnalare nella PR; riportata in
  `docs/schema-casello.sql`. Poi `docs/migrations/2026-11-nodo-cartelle.sql` (additiva e idempotente, PRIMA del merge): colonne
  `nodes.workspace_folders` (jsonb) e `nodes.folders_updated_at`.
- Installazione, collegamento, aggiornamento e disinstallazione senza terminale (app «Botcave Nodo»): vedi "Botcave Nodo (app per Mac)"; i comandi qui sopra restano
  l'alternativa da terminale.
- Non ancora fatto: interfaccia in The Hub Up (5), organizzazioni e policy dei dati (2: proprietà degli allegati e dei nodi per organizzazione).

## Modelli AI (account AI)

- Casello è l'unico centro di configurazione dei modelli: ogni utente aggiunge i propri **account AI**
  (tabella `ai_accounts`: DeepSeek, OpenRouter, Hugging Face, Mistral, Groq, Together o endpoint
  compatibile OpenAI "personalizzato") dalla pagina Account; la chiave è cifrata con `CASELLO_SECRET_KEY`
  e mai restituita. Al salvataggio Casello verifica la chiave e legge i modelli da `GET /models`
  (tabella `ai_models`, con prezzi USD per milione di token: dal provider, dalla tabella iniziale
  `lib/ai/price-seed.ts` o inseriti a mano). Una modifica di chiave o indirizzo si verifica PRIMA di salvare.
- Esecutore unico `lib/ai/executor.ts`: `resolveModel(aiModelId)` → account, indirizzo, chiave (solo in
  memoria) e prezzi; `modelChat` chiama il provider e calcola il costo. Errori con messaggi fissi in italiano
  (`lib/ai/discovery.ts`). Predisposto per un secondo esecutore (agente locale via MCP, prossimo sottoprogetto).
- "Chi configura paga": un utente sceglie solo modelli dei propri account; le run usano il modello salvato
  nell'agente (`agents.ai_model_id`; senza modello `POST /agents/:id/runs` risponde 409), le analisi quello scelto
  da chi le avvia (obbligatorio per le analisi cloud).
  Costi in `runs.cost_usd` e `analyses.cost_usd` (null = costo parziale, prezzo mancante); stima prima
  dell'analisi (`GET /api/ai/estimate`).
- Indirizzi dei provider: solo `https`; "Consenti rete privata" (solo personalizzato) ammette `http` e reti
  private, mai loopback, link-local o metadata. Nessun redirect seguito.
- Il gateway LiteLLM (account di sistema "Gateway Casello", variabili `AI_GATEWAY_*`) è dismesso e il codice è
  stato rimosso. Finché in produzione non si applica `docs/migrations/2026-10-pulizia-gateway-post.sql` (dopo il
  deploy), l'account senza proprietario, i suoi modelli e la riga `system_gateway` di `providers` restano nel DB e
  il codice li ignora (`LEGACY_GATEWAY_PROVIDER` in `lib/ai/providers.ts`): fuori da elenchi, scelte e catalogo,
  `resolveModel` li tratta come modello non disponibile. I nomi storici (`agents.model`, `analyses.model`) e i
  costi registrati restano.
- Route: `/api/ai/accounts` (+ `/:id/verify`, `/:id/default`, `/:id/models`), `/api/ai/models`,
  `POST /api/ai/models/:id/probe`, `/api/ai/estimate`.
- Modello predefinito e mappa: `users.default_ai_model_id` (`GET|PUT /api/account/default-model`, solo sessione).
  Per gli agenti che Casello crea (agente generale di un'app nuova, agenti approvati dall'architetto,
  `POST /agents`) `resolveAgentModel` sceglie: modello scelto → predefinito (solo se è ancora di un account
  dell'utente) → nessuno. `PUT /api/apps/:id/agent-models` imposta i modelli di tutti gli agenti dell'app: tutto
  o niente (un errore non salva nulla). Agente senza modello: run 409 «scegli un modello per l'agente»; analisi
  cloud: `aiModelId` obbligatorio.
- Migrazioni: `docs/migrations/2026-10-pulizia-gateway.sql` (additiva: PRIMA del merge; senza, ogni richiesta
  autenticata fallisce perché `users` si legge con select *) e `2026-10-pulizia-gateway-post.sql` (DOPO il deploy;
  prima verificare che `model_catalog` non esista più).
- Costi sempre sotto controllo: a parità di risultato si preferisce il modello o il percorso più economico.

## Dal piano alle issue

- Spec: `docs/superpowers/specs/2026-10-30-casello-piano-issue-design.md`. Le voci approvate del piano (capitoli
  `endpoint`, `completion`, `evolution`; da architetto o da chat) si creano come issue nel repo dell'app
  (`apps.source_repo`, installazione `source_installation_id`), una per voce. Niente PR/chiusura da Casello, niente webhook.
- Route (`routes/plan-issues.ts`, codice in `lib/plan-issues/`): `POST /api/apps/:id/plan/issues` con
  `{ itemIds (1..30, senza ripetizioni), dryRun? }`: `dryRun` dà l'anteprima (titolo, corpo, etichette, `skipped`) senza
  chiamare GitHub; altrimenti crea in sequenza e risponde per voce `created` | `skipped` | `failed`.
  `POST /api/apps/:id/plan/issues/refresh` rilegge lo stato e risponde col riepilogo. `GET /api/apps/:id/plan` espone
  `AppPlan.issues` (`available`, `unavailableReason`, `repo`, `open`, `closed`, `approvedWithoutIssue`, `checkedAt`) e
  `AnalysisItem.issue` (`repo`, `number`, `url`, `state`, `stateReason`, `checkedAt`; null anche durante la prenotazione).
- Dati: colonne `analysis_items.issue_repo|number|url|state|state_reason|created_at|checked_at` (indice parziale su
  repo + numero). Prenotazione: prima di chiamare GitHub la voce passa a `issue_state = 'creating'` con un UPDATE
  condizionato (`issue_number` e `issue_state` null): due richieste concorrenti non fanno doppioni; se la creazione su
  GitHub fallisce si toglie; se fallisce solo il collegamento alla voce (scrittura riprovata una volta) resta, la voce è
  `failed` («Issue creata su GitHub ma non collegata alla voce: ricollegala a mano (#n)») e il log riporta voce, repo,
  numero e indirizzo. All'avvio quelle rimaste si azzerano (`resetStaleIssueReservations`). Poi `open`/`closed` (+ `completed`,
  `not_planned`, `reopened`).
- Voci ammesse: `approved` e capitolo endpoint/completion/evolution, senza issue né prenotazione; le altre `skipped`;
  una voce non dell'app → 400. Ordine: completamento per fase e dipendenze, poi le altre; una dipendenza con issue
  diventa `#numero` nel corpo, altrimenti resta il titolo. Piè di pagina «Creata da Casello · piano di <app> · voce #id».
- Limiti: 30 voci per richiesta, 5 creazioni/min per utente (le anteprime no), refresh 6/min, pausa di 1 s tra due
  tentativi di creazione, lista delle issue di GitHub ≤ 10 pagine da 100 (con `since` = lettura più vecchia; un'issue non trovata
  resta com'era). Chiamate a `GITHUB_API_BASE`, niente redirect.
- Etichette (create sul repo se mancano, grigie): `casello`, capitolo (`endpoint`, `completamento`, `evoluzione`),
  `fase-N` (completamento), `P1`..`P5` (evoluzione).
- Repository e installazione: serve un'app con codice da GitHub tramite App (zip, nessun sorgente o solo token manuale
  → 409 «Collega il repository tramite l'App GitHub per creare le issue»); solo chi possiede l'installazione
  (`userHasInstallation`, altrimenti 403). Token di installazione ristretto al repo e a `issues: write`, solo in memoria.
- Errori: messaggi fissi in italiano (`ISSUE_MESSAGES`), mai il testo di GitHub. Fermano il lotto (le voci restanti
  `failed`): permesso Issues mancante, repo non trovato, issue disattivate, limite di richieste di GitHub. Solo la voce:
  GitHub non raggiungibile (rete, 5xx, 15 s), issue rifiutata (422). Errori sull'etichettatura o sul token e sul
  refresh → 502 col messaggio fisso.
- Console (pagina Piano): selezione delle voci approvate senza issue, anteprima e creazione, riepilogo con «Aggiorna
  stato» (parte da solo se l'ultima lettura ha più di 10 minuti), badge sulla voce (anche nella pagina dell'analisi).
- La rianalisi tratta le voci con issue come già pianificate (`chatPlannedItems`: origine chat o `issue_number` non
  null, capitoli endpoint, completion ed evolution) e non le ripropone: la fase catalog riceve quelle `endpoint`,
  completion ed evolution tutte. Anche il piano (`loadPlanItems`) porta con sé dalle analisi precedenti le voci
  approvate da chat o con un'issue, così badge e conteggi restano dopo una rianalisi.
- Migrazione: `docs/migrations/2026-10-piano-issue.sql` (additiva, da applicare in produzione PRIMA del merge e da
  segnalare nella PR, insieme al permesso Issues della GitHub App, vedi "Autenticazione").

## Tetti di spesa

- Tetto mensile in USD (null = nessun limite) per utente (`users.monthly_budget_usd`, pagina Account), per agente
  (`agents.monthly_budget_usd`, scheda agente), per account AI (`ai_accounts.monthly_budget_usd`: una chiave, il credito
  si carica per chiave) e per modello (`ai_models.monthly_budget_usd`); questi ultimi due nella pagina Account, solo sui
  propri account. Mese di calendario, ora italiana (`lib/budget.ts`).
- Spesa dell'utente (chi configura paga): run, analisi cloud e conversazioni del piano con un modello dei suoi account
  AI (una conversazione, a costo cumulativo, conta nel mese del suo ultimo turno). Spesa dell'agente: le sue
  run con qualsiasi modello. Spesa di un modello o di un account: run, analisi cloud e chat con quel modello o con i
  modelli dell'account. Ogni run ricorda il modello con cui è partita (`runs.ai_model_id`). I costi null (prezzo
  mancante) non si sommano: si contano come esecuzioni senza prezzo. Anche i compiti e i turni del capo delle squadre
  (`team_tasks`, `team_turns`, con il loro `ai_model_id`) contano nella spesa dell'utente, del modello e dell'account;
  i compiti eseguiti da un nodo (`ai_model_id` null) contano solo nel tetto della squadra. Contano anche le sessioni di
  Alfred (`alfred_sessions`, con il loro `ai_model_id`) nella spesa dell'utente, del modello e dell'account. Contano anche le chat
  di squadra con Lucius (`team_chat_conversations`, costo cumulativo, nel mese del suo ultimo aggiornamento) e i riassunti delle memorie
  (`character_history`, costo cumulato per voce), con il loro `ai_model_id`. Contano anche le conversazioni dei personaggi
  (`character_conversations`, costo cumulativo, nel mese dell'ultimo aggiornamento).
- Tetto per personaggio (`users.alfred_monthly_budget_usd`, `users.lucius_monthly_budget_usd`, Account → «Personaggi»; `characterSpend` e
  `characterBudgetBlock` in `lib/budget.ts`): spesa di Alfred = `alfred_sessions`, `character_conversations` con `character = alfred` e
  `character_history` di Alfred; spesa di Lucius = `plan_conversations`, `team_chat_conversations`, `character_conversations` con
  `character = lucius` e `character_history` di Lucius (le analisi dell'architetto restano fuori: hanno i loro tetti). Filtrata per
  `user_id` della riga, non per proprietario del modello. Ordine dei controlli: personaggio, modello, account AI, utente; raggiunto → 409
  «Tetto di spesa mensile di Alfred/Lucius…» su messaggi e sessioni a voce (dopo «senza modello» e «modello non usabile»); i riassunti si
  saltano (`summarized_at` scritto comunque).
- Ordine dei controlli: agente, modello, account AI, utente (il primo raggiunto dà il messaggio); per i compiti e i turni
  delle squadre prima il tetto della squadra, poi modello, account AI e utente (vedi "Squadre (esecuzione)").
- Raggiunto un tetto (spesa ≥ tetto) le nuove run, analisi cloud e messaggi della chat rispondono 409 con il motivo;
  le analisi locali e le riprese delle run in pausa no. `GET|PUT /api/budget`: riepilogo e tetto dell'utente; la
  console avvisa dall'80% e propone di annullare le run ancora attive su un tetto raggiunto (mai da sola).
- Migrazioni: `docs/migrations/2026-10-tetti-di-spesa.sql`, `docs/migrations/2026-10-tetti-modello-provider.sql`.

## Catalogo dei modelli

- Spec: `docs/superpowers/specs/2026-10-26-casello-catalogo-modelli-design.md` (base) e
  `docs/superpowers/specs/2026-10-26-casello-catalogo-universale-design.md` (catalogo universale e registro).
- **Provider come dati**: tabella `providers` (slug, nome, protocollo, indirizzo predefinito, nomi nelle fonti,
  stato `managed` | `coming` | `unmanaged`, origine `registry` | `discovered`). Il registro vive nel codice
  (`lib/catalog/provider-registry-data.ts`) ed è allineato all'avvio e a ogni aggiornamento
  (`ensureProviderRegistry`); `ai_accounts.provider` è testo con FK su `providers.slug`. `managed` = esecutore
  disponibile (oggi solo `openai_compatible`), `coming` = protocollo noto senza esecutore (Anthropic, Bedrock,
  Vertex, Azure), `unmanaged` = provider comparso nelle fonti e sconosciuto al registro. **Riconoscere un provider
  nuovo è un intervento evolutivo**: si aggiunge al registro (la pagina Modelli li elenca in "Da gestire in
  Casello" ed esporta il testo dell'issue). Un account su un provider `unmanaged` si configura come compatibile
  OpenAI con l'indirizzo dell'utente (regole di `custom`; rete privata solo per `custom`/`unmanaged` e solo
  finché il provider lo è). Un account `custom` con chiave, senza rete privata e con esattamente l'indirizzo
  predefinito di un provider gestito (es. Gemini) diventa quel provider alla lettura dei modelli (creazione,
  modifica, «Verifica», aggiornamento del catalogo), così i modelli prendono prezzi e strumenti dal catalogo.
  Gemini elenca i modelli come `models/<id>`, ma l'endpoint compatibile OpenAI li vuole senza prefisso:
  l'esecutore lo toglie nella chiamata (`providerModelName`).
- Aggiornamento deterministico, senza chiamare modelli: fonti pubbliche con indirizzi fissi (OpenRouter
  `/api/v1/models` e listino LiteLLM `model_prices_and_context_window.json`), 30 s, niente redirect, max 20 MB.
  Entra tutto (≈4 300 voci, ogni tipo di modello): `models` (chiave canonica: stesso modello tra provider
  diversi, al meglio) e `model_offers` (modello presso un provider, unico per provider + id). Precedenza: prezzi
  e strumenti da LiteLLM poi OpenRouter (che è solo riserva di un'offerta diretta già nota a LiteLLM; per il
  provider `openrouter` il contrario), data di rilascio da OpenRouter, dismissione da LiteLLM. Se una fonte cade
  l'esecuzione è `partial`, i campi che venivano da quella fonte restano e i modelli esistenti non cambiano.
- `catalog_runs` (ultime 20, una sola `running` per indice unico parziale, `newProviders` nel riepilogo); su
  `ai_models`: `availability`, `supports_tools`, `offer_id`, `last_probe_*`. I prezzi `manual` non si toccano
  mai; quelli presi dal catalogo hanno `price_source = catalog`.
- Quando: ogni 7 giorni o se `model_offers` è vuota (controllo all'avvio dopo 5 minuti e poi ogni 24 h) e a
  richiesta con `POST /api/catalog/refresh` (2/minuto; 409 se già in corso). Ogni esecuzione rilegge `/models`
  di tutti gli account degli utenti e ricollega `ai_models` alle offerte; all'avvio le esecuzioni rimaste
  `running` diventano `failed`.
- API: `GET /api/catalog/models` (ricerca, filtri, ordinamento, paginazione ≤ 100, pagina ≤ 10 000),
  `GET /api/catalog/models/:id/offers`, `GET /api/catalog/providers`, `GET /api/catalog/providers/:slug/issue`,
  `GET /api/catalog/status` (novità per account solo al proprietario), `GET /api/ai/providers` (registro per gli
  account). Console: pagina "Modelli" (vista per modello e per provider, filtri nell'indirizzo), scelta del
  provider e del modello con ricerca.
- Stato effettivo di un modello: ritirato (offerta ritirata o data di dismissione passata) > non disponibile
  (`availability = unavailable`, messo da un 404 o "model_not_found" di una chiamata vera) > disponibile. La
  tendina propone solo modelli disponibili con strumenti (o non noti, "?"); gli altri disponibili in "Altri
  modelli". "Prova" (5/minuto, solo sui propri account, 1 token, 20 s) riporta un modello a disponibile.
- Limiti noti: l'enum Postgres `ai_provider` resta nel DB inutilizzato fino alla migrazione
  `2026-10-pulizia-gateway-post.sql`, che lo elimina insieme al vecchio gateway.

## Agenti operativi (fase 1)

- Spec: `docs/superpowers/specs/2026-10-25-casello-agenti-operativi-design.md`.
- Limiti per turno: 8 giri di tool, 120 s di tempo attivo (ogni chiamata al
  modello è limitata dal tempo rimasto, minimo 1 s), 60 000 token. Il Responsabile di prodotto (agente `general`) ha
  12 giri, 180 s e 200 000 token (`PRODUCT_LEAD_LIMITS` in `run-executor.ts`): ogni chiamata porta il catalogo intero dell'app.
  Il prompt di sistema delle run riporta la data e l'ora italiane (`todayLine`). Per chiamata HTTP: 15 s, risposta
  massima 1 048 576 byte. Nessuna pausa per la conferma: i tool L2 vanno in coda e la run
  continua (vedi "Strumenti MCP e coda delle conferme"). Le run `awaiting_client` rimaste dal vecchio meccanismo si chiudono
  `cancelled` all'avvio.
- L'esecutore raggiunge solo `internal_base_url` (o `base_url`) + path del tool: dagli argomenti del
  modello arrivano solo valori codificati. Gli indirizzi e gli header di autenticazione si validano
  già al salvataggio dell'app.
- Il token dell'utente vive solo in memoria per la durata della run: mai nel DB né nei log. Credenziali
  rimandate dall'app nelle risposte vengono sostituite con `***`; gli argomenti `x-sensitive` sono
  oscurati nei passi e nell'azione in coda pubblica.

## Architetto (fase 3)

- Spec: stessa di sopra, §4 e §6; piano `docs/superpowers/plans/2026-10-25-fase-3-architetto.md`.
- Sorgenti dell'app (`apps.source_*`, `openapi_url`, `functional_description`): codice da GitHub (zipball con
  token di sola lettura, cifrato, mai restituito: l'API dice solo `sourceTokenSet`) o da zip caricato
  (max 50 MB; nginx ha `client_max_body_size 51m`). Il codice vive SOLO in memoria per la durata
  dell'analisi: niente file su disco, niente log del contenuto.
- Limiti: zip letto con un parser proprio (anti zip bomb), regex di ricerca in un worker con timeout 2 s,
  OpenAPI max 2 MB; analisi max 30 minuti e 1 000 000 token (default), 25 giri e 2 correzioni per fase.
  Ogni fase ha una quota del tetto di token (`PHASE_TOKEN_SHARES`, somma 0,88): all'80% della quota o
  dei giri il modello riceve un avviso a consegnare e ha 2 giri di margine (più le correzioni di una
  consegna non valida); il limite rigido resta il tetto complessivo. Chiamata al modello max 300 s
  (nessun nuovo tentativo sui timeout); letture da 200 righe / 12 000 caratteri per strumento
  (`list_operations` a pagine con `prefix`/`offset`), cronologia degli output di 24 000 caratteri.
- Sei fasi (map, capabilities, catalog, agents, completion, evolution): ogni esito è validato con Zod
  (`schemas.ts`, esempi in `prompts.ts` verificati dai test). Gli elementi (`analysis_items`) sono
  confrontati con lo stato attuale dell'app (`diff`: new/changed/unchanged/removed).
- La fase catalog riceve nel prompt i tool esistenti non disattivati dell'app (`existingToolsForPrompt` in `phase-record.ts`: nome,
  descrizione, kind, identità, livello effettivo, definizione e schema; dettagli fino a 40 000 caratteri, poi solo i nomi), sia
  nell'esecutore cloud sia in `get_phase_instructions` dell'esecutore locale: un tool esistente non riproposto risulta `removed`.
- Revisione: approvare un tool/agente/skill lo applica in una transazione e lo rende `active` (un tool
  `removed` diventa `disabled`, mai cancellato); endpoint/completamento/evoluzione si esportano come issue.
  Un'analisi alla volta per app; all'avvio le analisi rimaste aperte diventano `interrupted`.
- Fonte MCP: se l'app ha `mcp_url` l'architetto legge gli strumenti del server (`list_mcp_tools`, `read_mcp_tool`) e
  propone tool con `kind` (`http`/`mcp`) e `level`; il livello proposto non scende mai sotto quello dichiarato dal
  server, nemmeno se modificato in revisione. Le lacune dello strumentario MCP diventano voci `endpoint`.

## Chat del piano

- Spec: `docs/superpowers/specs/2026-10-29-casello-chat-del-piano-design.md`.
- Pagina `/apps/:id/plan` (`src/pages/app-plan.tsx`, `src/components/plan/`): piano dell'app e conversazioni con
  un modello; la chat è il pannello comune `CharacterChat` (`components/characters/`, adattatore `usePlanChatAdapter`) a pagina intera, i
  vecchi `chat-panel.tsx` e `conversation-list.tsx` non esistono più (vedi "Alfred e Lucius nelle aree"). Il modello propone schede `add` / `update` / `discard`; solo quelle accettate dall'utente diventano
  voci `analysis_items` con `origin = chat` (e `conversation_id`). Lucius può leggere il codice dell'app (vedi "Lucius legge il codice").
- Strumento `propose` (`lib/plan-chat/tools.ts`): la descrizione elenca i campi di ogni capitolo (`CHAPTER_FIELDS`); un payload non valido risponde col nome
  del campo tra virgolette (`campo "missing": campo obbligatorio`: in completion un campo si chiama proprio `missing`) e con l'elenco dei campi del capitolo;
  con `update` bastano i campi da cambiare (si fondono sulla voce esistente prima della validazione). Correzioni: 2 per proposta (stesso tipo, capitolo e voce;
  poi «correzioni esaurite per questa proposta») e al più 8 proposte non valide per turno (poi «correzioni esaurite: non proporre altro in questo turno»).
- Route (`routes/plan-chat.ts`): `GET /api/apps/:id/plan`, `GET|POST /api/apps/:id/plan-conversations`,
  `GET|PATCH|DELETE /api/plan-conversations/:id`, `POST /api/plan-conversations/:id/messages`,
  `POST /api/plan-proposals/:id/decision`. Codice in `lib/plan-chat/` (`context.ts`, `tools.ts`, `turn.ts`,
  `decide.ts`, `run-turn.ts`).
- Limiti per turno: 6 giri, 40 000 token, 120 s di tempo attivo (con il codice disponibile 12 giri, 150 000 token, 240 s: `CODE_TURN_LIMITS`); messaggio max 8 000 caratteri; contesto
  ~30 000 token (la cronologia si riduce); 10 messaggi/min per utente. `PlanConversationCreate.aiModelId` è facoltativo: senza modello si
  usa quello di Lucius (`characterModelFor`); il tetto di Lucius vale anche qui (409 nella route, messaggio d'errore dell'assistente nel turno).
- Nel contesto del modello non entrano segreti né indirizzi delle app. Il turno gira in background: la UI fa
  polling sulla conversazione; all'avvio i turni rimasti aperti (`failInterruptedPlanTurns`) vengono chiusi come falliti.
  **Turni appesi** (`lib/stale-turns.ts`, vale anche per conversazioni dei personaggi e chat di squadra): durante un deploy il container nuovo
  parte prima che il vecchio si fermi, quindi un turno avviato nel vecchio dopo la pulizia dell'avvio resterebbe `running` per sempre (la
  conversazione rifiuterebbe ogni messaggio). Ogni processo ricorda i turni che esegue (`trackTurn`); ogni minuto `startStaleTurnSweeper`
  chiude con il messaggio del riavvio i turni `running` con `updated_at` più vecchio di 5 minuti (`STALE_TURN_MS`) che non girano in questo
  processo, con le stesse `failInterrupted*` dell'avvio (filtro `olderThan`/`exclude`).
- La rianalisi dell'architetto riceve le voci da chat approvate (e quelle con un'issue) come "già pianificate" (fasi
  completion ed evolution; la fase catalog solo quelle `endpoint`) e non le ripropone. Nel piano restano anche le voci
  da chat approvate delle analisi precedenti.
- Migrazione: `docs/migrations/2026-10-chat-del-piano.sql` (da applicare in produzione PRIMA del merge e da
  segnalare nella PR). Dipendenze frontend: `react-markdown`, `remark-gfm`.

## Lucius legge il codice

- Spec: `docs/superpowers/specs/2026-11-10-botcave-lucius-legge-il-codice-design.md` (con «Differenze dal codice» in fondo). Dove il codice differisce dalla spec vale il codice, descritto qui. Lucius legge il
  codice delle App collegate a GitHub (`lib/code-reader/`) per verificare le voci del piano e le proposte prima di farle; nessuna migrazione, nessuna variabile nuova.
- **Cache per commit** (`source-cache.ts`): al più 3 repository in memoria, sfrattati dopo 15 minuti di inattività o per LRU oltre il terzo repository (`SourceTree.dispose` ferma anche la ricerca regex in corso: dopo lo sfratto la ricerca regex dell'albero
  non parte più; `CodeToolRunner` se ne accorge (`isDisposed`) e rilegge il codice con `getAppSource`; GitHub 5xx sullo zipball → «GitHub non raggiungibile»). I suggerimenti degli output usano i parametri di Lucius
  (`daRiga`, niente `includeIgnored`) e i parametri non previsti sono rifiutati. Lo SHA del branch si legge con `lib/github/commit.ts` (`accept: application/vnd.github.sha`): stesso SHA → si riusa l'albero, SHA nuovo → nuovo download, richieste
  concorrenti → un solo download. Se lo SHA non è leggibile ma il repository è in memoria lo si riusa con la dicitura «commit non verificato»; 401/403 sullo SHA → «accesso al repository revocato».
  Lo zipball si scarica al branch (lo SHA è quello letto prima).
- **Accesso**: serve un'App con codice da GitHub tramite installazione (`source_installation_id`) o token manuale; l'installazione deve essere dell'utente (`userHasInstallation`, controllata a ogni
  chiamata anche con il repository in memoria); app con zip o senza sorgenti → «codice non disponibile». Token d'installazione ristretto a `contents: read`, solo in memoria.
- **Strumenti** (`tools.ts`; parametro `app` = slug, obbligatorio dove le App sono più d'una): `elenca_cartella`, `leggi_file` (al più 400 righe e 16 000 caratteri per lettura), `cerca_nel_codice` (regex,
  worker con timeout); uscita di ogni strumento ≤ 20 000 caratteri, intestazione con lo sha7 e codice dichiarato dato non attendibile. Errori fissi in `CODE_MESSAGES` (`messages.ts`), mai il testo di GitHub; nella
  chat dei personaggi un errore degli strumenti del codice è un risultato `{ok:false}`.
- **File grandi** (`SOURCE_LIMITS.maxFileBytes` = 1 MiB, uguale per l'architetto): un file oltre il limite non si carica ma non sparisce. `SourceTree` ne
  ricorda percorso e dimensione: `leggi_file`/`read_file` rispondono «File troppo grande da leggere: <percorso> (N KB, limite 1024 KB)» invece di «File
  inesistente», `elenca_cartella`/`list_dir` e `cerca_nel_codice`/`search` aggiungono l'avviso con i file esclusi (al più 10 nomi); una cartella con soli file
  troppo grandi esiste (elenco vuoto più l'avviso).
- **Dove si offrono**: chat del piano (App del piano), argomento `agent` (App dell'agente), `area_agents` (tutte le App con il codice leggibile dall'utente, slug nell'elenco), chat di squadra (App di riferimento); solo con il
  codice disponibile. Limiti dei turni con il codice: 12 giri, 150 000 token, 240 s (`CODE_TURN_LIMITS`, parametro `limits` di `runChatTurn`); sul nodo (`/mcp/turn`) `maxTurns` 13.
- **Istruzioni**: `CODE_INSTRUCTIONS` nel piano (verificare, citare file e righe, `discard`/`update` con le evidenze); `CODE_INSTRUCTIONS_GENERAL` negli altri contesti, aggiunta da `extraInstructions` nel turno
  (non in `lib/characters/instructions.ts`).

## Avanzamento dei turni

- Spec: `docs/superpowers/specs/2026-11-10-botcave-avanzamento-turni-design.md`. Dove il codice differisce dalla spec vale il codice, descritto qui. Durante un turno di chat l'utente vede i passi in corso invece del solo «sta pensando…».
- **Registro** (`lib/turn-progress/progress.ts`): in memoria, una voce per conversazione. `runChatTurn` (`lib/node-turns/chat-turn.ts`) apre la voce all'inizio e la chiude in `finally`, e avvolge `runTool`:
  vale per il modello cloud, per il nodo e per il ripiego. Si tengono gli ultimi 8 passi (`omitted` conta quelli scartati), il conteggio si ferma a 200.
- **Frasi** (`describe.ts`, `describeStep`): una frase fissa per strumento (es. lettura di un file, ricerca nel codice), degli argomenti entra solo un elenco chiuso di campi (percorsi, testi cercati, glob, slug, codici delle skill, numero della proposta, app del Responsabile), mai contenuti, risultati, appunti, messaggi, segreti né indirizzi delle app; strumento sconosciuto → frase generica.
- **API**: schema OpenAPI `TurnProgress`, campo facoltativo `progress` in `PlanConversationDetail`, `TeamChatConversationDetail` e `CharacterConversationDetail` (anche il filo di Alfred), valorizzato solo con
  `turnStatus = running`; la console già fa polling sulla conversazione.
- **Console**: `components/characters/turn-progress.ts` (righe e `formatElapsed`) e `turn-progress-view.tsx`, usati da `character-chat.tsx` (console ed embed).
- Nessuna migrazione e nessuna variabile. Limite: il registro è in memoria, quindi vale con un solo container API; con più container i passi andrebbero salvati nel DB.

## Autenticazione

- Login Google OIDC (`/api/auth/login` → Google → `/api/auth/callback`), sessione in Postgres (tabella
  `sessions`) con cookie `casello.sid` httpOnly. Accede solo chi è in `ALLOWED_EMAILS`.
- Tutto `/api` richiede la sessione tranne `/api/healthz` e `/api/auth/*`; senza sessione risponde 401 e
  il frontend (`AuthGate`) mostra la pagina di login.
- In produzione, se manca una variabile di login, l'API non parte (meglio giù che aperta).
  `AUTH_DISABLED=true` salta il login solo in sviluppo ed è rifiutata con `NODE_ENV=production`.
- Client OAuth su Google Cloud: redirect URI autorizzato `${PUBLIC_APP_URL}/api/auth/callback`.
- Utenti in `users`, identità (`google`, `github`) in `user_identities`; la sessione contiene `userId` (le
  sessioni vecchie con solo l'email vengono convertite alla prima richiesta). Chi entra lo decide solo
  `isAllowed` in `lib/users.ts` (oggi: un'email verificata in `ALLOWED_EMAILS`).
- Alternativa al cookie: token personale `cas_…` con ambiti `api:read`/`api:write` (vedi "Token personali su `/api`").
- Login con GitHub (facoltativo) tramite la GitHub App "Casello": `/api/auth/github/login`,
  `/api/auth/github/link` (da loggati), un'unica callback `/api/auth/github/callback` (anche per il ritorno
  dall'installazione: un `code` senza il nostro `state` non viene mai scambiato), `DELETE /api/auth/github`.
  `GET /api/auth/providers` (pubblica) dice alla pagina di login se GitHub è attivo. Pagina Account nella
  console per accessi e installazioni.
- Repository: le installazioni dell'App (`github_installations`, per utente) si sincronizzano a ogni
  callback; `GET /api/github/installations`, `GET /api/github/repos`. Un'app con `source_installation_id`
  fa scaricare all'architetto il codice con un token di installazione limitato a quel repo e a
  `contents: read` (un'ora, solo in memoria). Nessun token GitHub viene salvato. Il token manuale della
  fase 3 resta come alternativa.
- Limite noto: l'ambito di un'installazione può superare i repo a cui l'utente ha accesso su GitHub; prima
  di aprire Casello a chiunque va verificato l'accesso con il token dell'utente (spec GitHub, §5).
- GitHub App su github.com: permessi Contents read, Issues read & write (per creare le issue del piano: ogni installazione deve accettare il
  nuovo permesso; il token con cui l'architetto legge il codice resta `contents: read`), Metadata read, Email
  addresses read (account); "Request
  user authorization (OAuth) during installation" attivo, nessun Setup URL, nessun webhook; Callback URL
  `${PUBLIC_APP_URL}/api/auth/github/callback`.

## Token personali su `/api`

- Spec: `docs/superpowers/specs/2026-10-31-casello-token-api-design.md`. Il token `cas_…` (Account → "Token personali")
  vale anche su `/api`, per agenti che agiscono su Casello stesso e per script/automazioni.
- I token `cas_…` sono una delle due credenziali di `/mcp`; l'altra è il token OAuth `cao_…` del connettore, che su `/api` NON vale
  (come `car_…`: 401 «token non valido o scaduto»).
- Ambiti (`api_tokens.scopes`, almeno uno, senza ripetizioni, immutabili dopo la creazione): `mcp` (server `/mcp`),
  `api:read` (GET/HEAD su `/api`), `api:write` (tutti i metodi, include la lettura), `node` (solo `/api/node/*`, vedi "Nodi"), `runs` (solo avvio e lettura delle run, vedi
  "The Hub Up 5c (tappa 1)"). Default alla creazione `["mcp"]`; i token esistenti sono diventati `{mcp}`: nessun permesso nuovo. L'ambito `node` non si sceglie
  (`createNodeToken`: nasce solo con un nodo, `api_tokens.node_id`, scade dopo 365 giorni, non compare tra i token personali);
  un token di nodo su `/api` (fuori da `/api/node`) → 403 «il token non ha l'ambito per questa operazione», su `/mcp` → 401.
- Ambito `agent` (token personale per il Responsabile di Botcave stesso, segreto di servizio dell'App 4): **esclusivo** (con altri ambiti → 400 «l'ambito agent non si combina con altri
  ambiti»), vale su `/api` come `api:read` + `api:write` (GET/HEAD e scritture) tranne `AGENT_DENIED_ROUTES` (`lib/auth.ts`, confronto senza distinzione di maiuscole), che danno 403 «il token non ha
  l'ambito per questa operazione»: `POST /pending-actions/:n/approve|reject`, `POST /plan-proposals|team-chat-proposals|character-proposals/:id/decision`, `PATCH /analysis-items/:id`,
  `PUT /team-instances/:id/plan` e `POST /team-instances/:id/plan/manual-actions/:actionId/done` (l'agente non decide mai al posto dell'utente), `POST /apps` e `PATCH /apps/:id`
  (configurazione delle app con indirizzi e segreti: un tool dell'App 4 riprogrammato non deve poter dirottare il segreto di servizio di un'altra app) e ogni `DELETE` (regola sul
  metodo: le eliminazioni restano alla sessione dell'utente; vale anche sulle route `sessionOnly`, che con `agent` rispondono quindi 403 d'ambito). Le route `sessionOnly` restano 403, su `/mcp` 401. Durata
  massima 90 giorni (come ogni token personale). In console: Account → «Token personali», casella «Agente di Botcave (segreto di servizio)», che spegne e disattiva le altre.
- Il token OAuth `cao_…` con ambito `embed` (pannello incorporabile) vale invece su `/api` come `api:read` + `api:write`, con le eccezioni descritte in
  "Botcave incorporabile (app ospiti)".
- Regola unica in `requireAuth` (`lib/auth.ts`): con l'header `Authorization` presente conta solo il token, mai il
  cookie (nemmeno con `AUTH_DISABLED`); header non `Bearer cas_…`, token sconosciuto/revocato/scaduto o utente non più
  in `ALLOWED_EMAILS` → 401 «token non valido o scaduto». Senza header vale la sessione. Ambito per metodo (GET/HEAD →
  `api:read` o `api:write`; POST/PUT/PATCH/DELETE → `api:write`), altrimenti 403 «il token non ha l'ambito per questa
  operazione». Messaggi in `TOKEN_MESSAGES`. `req.auth` = `{kind:"session"}` | `{kind:"token", tokenId, scopes}`.
- Solo con il login (`sessionOnly`; con un token 403 «operazione disponibile solo con il login»): `GET|POST
  /account/tokens`, `DELETE /account/tokens/:id`; `POST /ai/accounts`, `PATCH|DELETE /ai/accounts/:id`,
  `POST /ai/accounts/:id/verify|default|models`, `PATCH /ai/models/:id` (chiavi, indirizzi, prezzi, tetti);
  `PUT /budget`; `DELETE /auth/github` e `GET /auth/github/link` (con un token, l'account GitHub che completa il
  flusso verrebbe collegato all'utente del token e darebbe un login completo).
- `GET /api/auth/me` accetta anche il token e risponde con l'utente più `auth` (`{kind:"session"}` o
  `{kind:"token", scopes}`).
- Limite: 120 richieste/min per token (`tokenRateLimit`, chiave: id del token), oltre ai limiti per utente/IP → 429.
- Su `/mcp` gli strumenti `approva`, `rifiuta` e `chiedi_al_responsabile` del centralino vogliono un token con `mcp` **e** `api:write` (solo `mcp` →
  errore «il token non ha l'ambito per questa operazione», `TOKEN_MESSAGES.scope`); gli altri strumenti bastano con `mcp`.
- Log: mai header `Authorization`, token o hash. Un errore del DB nella verifica del token risponde 500 fisso
  («errore interno») e registra solo il nome dell'errore (i parametri della query conterrebbero l'hash).
- Migrazione: `docs/migrations/2026-10-token-api.sql` (additiva, idempotente): da applicare in produzione PRIMA del
  merge e da segnalare nella PR.
- Casello come app di sé stesso (App 4, spec `docs/superpowers/specs/2026-11-09-botcave-responsabile-di-se-stesso-design.md`): `internal_base_url` `http://localhost:3000`
  (l'API chiama sé stessa), autenticazione di servizio header `Authorization` + scheme `Bearer`, tool con identità `service`, segreto di servizio = token personale con
  ambito `agent`; catalogo dei tool in `docs/botcave-self/catalogo-tool.json`.
- In sviluppo con `AUTH_DISABLED=true` i token funzionano solo se `ALLOWED_EMAILS` include `dev@localhost`.

## Connettore OAuth (app Claude)

- Spec: `docs/superpowers/specs/2026-11-05-casello-connettore-oauth-design.md` (sostituisce la «Tappa 2» dell'esecutore locale). Dove il
  codice differisce dalla spec vale il codice, descritto qui. Casello è un authorization server OAuth 2.1 minimale: l'app Claude
  (claude.ai, app del telefono, Enterprise) aggiunge `<PUBLIC_APP_URL>/mcp` come connettore personalizzato, l'utente entra con il login di
  Casello (Google o GitHub) e acconsente; poi il centralino e gli strumenti dell'architetto locale sono usabili dalla chat. I token
  personali `cas_…` restano come sono. Indirizzi assoluti da `PUBLIC_APP_URL` (`lib/oauth/config.ts`; in sviluppo `http://localhost:<WEB_PORT>`).
- **Scoperta**: ogni 401 di `/mcp` porta `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_APP_URL>/.well-known/oauth-protected-resource"`.
  `GET /.well-known/oauth-protected-resource` (anche `…/mcp`) e `GET /.well-known/oauth-authorization-server` (`metadata.ts`): solo
  client pubblici (`token_endpoint_auth_methods_supported: none`), PKCE `S256`, scope `mcp`, `client_id_metadata_document_supported`.
- **Client** (`clients.ts`, `oauth_clients`, `kind` `dcr` | `metadata`): registrazione dinamica `POST /oauth/register` (RFC 7591: `redirect_uris`
  1..5, `client_name` ≤ 100; registrazione permissiva come RFC 7591 §3.2.1: un `token_endpoint_auth_method` diverso da `none` non è un
  errore e la risposta dice sempre `none`; dei `redirect_uris` si tengono solo quelli ammessi, errore `invalid_redirect_uri` solo se non ne
  resta nessuno; `client_id` `cac_…`), oppure `client_id` = URL `https` di un documento
  del client, scaricato alla prima autorizzazione con `node:https` e un DNS guardato (`guardedLookup`/`isPublicIp` di `lib/ai/providers.ts`: ogni
  indirizzo risolto deve essere pubblico e il socket si collega a quello verificato; solo https, nessun redirect, 10 s, 64 KB; il suo
  `client_id` deve essere lo stesso URL; riscaricato dopo 24 ore; `client_name` troncato a 100 caratteri, `redirect_uris` filtrati come sopra, client nullo se non ne resta
  nessuno). Massimo 1 000 righe in `oauth_clients` (DCR e documenti insieme): oltre, `register` → 503 «registrazioni temporaneamente
  sospese»; i client documento con `client_id` che inizia con `https://claude.ai/` o `https://claude.com/` non contano nel tetto e passano
  anche se è pieno. Indirizzi di ritorno ammessi, uguali carattere per carattere:
  `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, loopback `http://localhost:<porta>/callback` e
  `http://127.0.0.1:<porta>/callback` (Claude Code); altro → `invalid_redirect_uri`.
- **Autorizzazione** (`authorize.ts`, `pages.ts`): `GET /oauth/authorize` (`response_type=code`, `client_id`, `redirect_uri`, `code_challenge` +
  `S256`, `state` ≤ 500 caratteri altrimenti `invalid_request`, `scope` lista separata da spazi che contiene `mcp` (valori sconosciuti ignorati, una lista senza `mcp` → `invalid_scope`), `resource` uguale a
  `<PUBLIC_APP_URL>/mcp` (un `/` finale si ignora, anche sul token endpoint). Client
  sconosciuto o `redirect_uri` non ammesso: pagina d'errore, mai un redirect; altri errori: redirect con `error` e `state`. Senza sessione
  redirect a `/api/auth/login?returnTo=…` (utente fuori da `ALLOWED_EMAILS` respinto dal login). Con sessione: pagina di consenso HTML servita
  dall'API (nome del client E host del ritorno, account, «Consenti»/«Annulla»; CSP restrittiva, `X-Frame-Options: DENY`, testo escapato).
  La richiesta in attesa sta nella sessione (`oauthPending` con token CSRF); `POST /oauth/authorize` (form) con CSRF e `decision`
  `allow|deny`. Richiesta scaduta o CSRF sbagliato, o due consensi concorrenti per lo stesso client e utente (violazione dell'indice unico) → pagina «Richiesta scaduta:
  ricomincia dall'app Claude»; un errore DB inatteso su GET/POST `/oauth/authorize` → pagina 500 «Errore interno: riprova tra poco»; `deny` → `access_denied`. `allow`
  crea il **collegamento** (`oauth_grants`, al più uno non revocato per utente e client: un nuovo consenso revoca il precedente, stessa
  transazione) e un codice (32 byte, 10 minuti, una volta, legato a client, `redirect_uri` e `code_challenge`).
- **Token** (`tokens.ts`): `POST /oauth/token` (form, `Cache-Control: no-store`). `authorization_code` (con `code_verifier` 43..128, consumo con
  UPDATE condizionato: due scambi concorrenti, uno solo riesce) e `refresh_token`. Risposta: `access_token` `cao_…` (3 600 s), `refresh_token`
  `car_…` (30 giorni), `scope: mcp`. **Rotazione**: ogni rinnovo segna il vecchio come usato ed emette una coppia nuova; un token di rinnovo già
  usato da PIÙ di 60 s (`REFRESH_REUSE_GRACE_MS`) → `invalid_grant` e revoca dell'intero collegamento (rilevamento del furto); riusato da meno di 60 s
  (un client che ritenta dopo una risposta persa, o due rinnovi quasi insieme) → `invalid_grant` semplice, senza revoca: il token nuovo resta valido.
  Perso l'UPDATE condizionato si rilegge la riga: scaduto e mai usato, o usato dentro la finestra → nessuna revoca.
  Errori RFC 6749 con `error_description` fissa in italiano (`errors.ts`); `oauthErrorHandler` montato su `/oauth` trasforma le eccezioni in
  JSON OAuth (`invalid_request`, `server_error`). Di codici e token si salva solo l'hash SHA-256.
- **Uso su `/mcp`** (`lib/mcp/auth.ts`): `cao_…` valido se non scaduto, collegamento non revocato e utente ancora ammesso (`isAllowed`); dà
  `mcpScopes = ["mcp", "api:write"]` (tutti gli strumenti, `approva` e `rifiuta` compresi: scelta dell'utente), `last_used_at` aggiornato al
  massimo una volta al minuto. Su `/api` `cao_…`/`car_…` sono sconosciuti (401). Le descrizioni di `approva`/`rifiuta` dicono al modello di
  ripetere numero e sintesi e chiedere conferma.
- **Limiti** (`middlewares/rate-limit.ts`, in memoria): `register` 10/min e 50/giorno (24 h) per IP (429), `token` 30/min per `client_id` e IP (429 `slow_down`), `authorize`
  (GET e POST) 20/min per utente (per IP senza sessione); restano 60/min di `/mcp` e il contatore di approva/rifiuta. Log: mai token, codici,
  hash, `code_verifier` né Authorization.
- **Console** (solo login, `sessionOnly`, tag OpenAPI `nodes`): `GET /api/account/oauth-grants`, `DELETE /api/account/oauth-grants/:id` (204;
  altrui o già revocato → 404 «collegamento non trovato»); la revoca vale dalla richiesta successiva. Account → «App collegate» (nome, host del
  ritorno, collegato il, ultimo uso, «Revoca»; vuota: indirizzo del connettore con «Copia indirizzo»). Pulizia `sweepOAuth` all'avvio e ogni ora
  (`startOAuthSweeper` in `src/index.ts`): codici e token scaduti da oltre un giorno, collegamenti revocati da oltre 30 giorni, client senza
  collegamenti da oltre 24 ore.
- **Enterprise e prova**: i connettori personalizzati li permette l'amministratore dell'organizzazione; il supporto della modalità vocale ai
  connettori personalizzati è da verificare nella prova finale dopo il deploy (chat scritta e vocale dal telefono).
- Migrazione: `docs/migrations/2026-11-connettore-oauth.sql` (additiva e idempotente, niente `-post`): tabelle `oauth_clients`, `oauth_grants`,
  `oauth_codes`, `oauth_tokens`. Da applicare in produzione PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`.
- Client `embed` (pannello incorporabile): tipo di client e ambito `embed` in "Botcave incorporabile (app ospiti)"; non contano nel tetto dei
  1 000 client, non si registrano con `register`, `sweepOAuth` non li cancella.
- Fuori ambito: token OAuth su `/api` (salvo l'ambito `embed`), revoca RFC 7009, scelta degli ambiti al consenso, strumenti nuovi del centralino.

## Alfred (maggiordomo vocale)

- Spec: `docs/superpowers/specs/2026-11-05-casello-alfred-design.md`; piano `docs/superpowers/plans/2026-11-05-alfred.md`. Dove il codice
  differisce dalla spec vale il codice, descritto qui. Alfred è la pagina vocale `/alfred` della console: l'utente parla, un modello
  Gemini Live risponde a voce e consulta le squadre con gli strumenti del centralino. L'audio va direttamente tra browser e Gemini
  (WebSocket) e non passa mai da Casello: all'API arrivano solo token, chiamate degli strumenti e contatori dei consumi.
- **Impostazioni** (`lib/alfred/settings.ts`; `users.alfred_ai_model_id`, `users.alfred_voice`): `GET|PUT /api/account/alfred`
  (`{aiModelId, voice?}`; il GET risponde `{aiModelId, voice, models: [{id, name, accountName}]}`). Modelli idonei: dei propri account
  Gemini, per nome (senza prefisso `models/`); al salvataggio Casello verifica con la chiave dell'account che il modello supporti
  `bidiGenerateContent` (`gemini.ts`, `checkLiveSupport`; modello non idoneo → 400, chiave rifiutata o Gemini non raggiungibile → 502,
  messaggi fissi). Voci (`ALFRED_VOICES`, default `Kore`): `Kore`, `Charon`, `Aoede`, `Puck`, `Fenrir`, `Leda`, `Orus`, `Zephyr`;
  altro → 400 «voce non disponibile».
- **Sessioni** (`sessions.ts`, `alfred_sessions`: `active|closed`, `prompt_tokens`, `completion_tokens`, `cost_usd` null = prezzo mancante),
  tutte solo con il login (`sessionOnly`: con un token personale 403): `POST /api/alfred/sessions` (10/min per utente, 429; senza
  modello 409 «scegli il modello di Alfred in Account»; modello o account non usabili o tetto raggiunto, nell'ordine modello → account
  AI → utente, 409 col motivo; chiude le altre sessioni `active` dell'utente) risponde `{sessionId, token, model, voice, expiresAt}`;
  `POST …/:id/renew` (nuovo token per la stessa sessione; corpo facoltativo `{resumptionHandle}` 1..4096 caratteri, altrimenti 400, che finisce in `sessionResumption.handle` del token e mai nei log; condivide il limite di 10/min con l'avvio; chiusa o altrui → 404 «sessione non trovata»); `POST …/:id/usage`
  `{promptTokens, completionTokens}` (totali cumulativi della sessione: il browser somma i `usageMetadata`, che Gemini manda per turno; interi ≥ 0 altrimenti 400; si tiene il massimo tra salvato e ricevuto, mai
  all'indietro; ricalcola il costo; con modello o account eliminati il costo resta null e la sessione si chiude comunque);
  `POST …/:id/close` (204, idempotente; corpo facoltativo `{transcript}` ≤ 20 000: solo alla chiusura volontaria produce il riassunto nello storico di Alfred, in background e senza salvare la trascrizione; chiusure per inattività o riavvio non riassumono). Controllo ogni 5 min: `active` senza attività da 35 min → `closed` (anche le conferme scadute
  da oltre 1 h si cancellano); all'avvio tutte le `active` → `closed`.
- **Token temporaneo di Gemini** (`gemini.ts`): `POST <GEMINI_NATIVE_BASE>/auth_tokens` con la chiave dell'account (`x-goog-api-key`),
  `uses: 1`, `expireTime` +30 min, `newSessionExpireTime` +1 min, 15 s, nessun redirect (`GEMINI_NATIVE_BASE`, letta in `config.ts`, solo per i test e ignorata con
  `NODE_ENV=production`). La **configurazione sta tutta nel token** (`bidiGenerateContentSetup`: modello, `responseModalities` AUDIO,
  voce, istruzioni di `instructions.ts`, strumenti di `tool-declarations.ts`, trascrizioni, `sessionResumption`, compressione del
  contesto; senza `fieldMask`): verificato contro Gemini vero, il browser manda solo `{setup: {model}}` e istruzioni o strumenti
  diversi vengono ignorati. Mai chiavi o token nei log; errori verso Gemini → 502 con messaggio fisso.
- **Strumenti** (`tools.ts`, sopra `lib/teams/centralino.ts`, solo dati dell'utente): `POST /api/alfred/sessions/:id/tools/:name`
  `{args}` → `{ok:true,result}` | `{ok:false,error}`; sessione non attiva o altrui, o strumento sconosciuto → 404. Strumenti:
  `squadre_stato`, `squadra_dettaglio` (ridotto per la voce), `bollettino`, `coda_da_confermare`, `scrivi_al_capo` (limite condiviso
  `consumeTeamMessage`, 10/min), `prepara_decisione`, `conferma_decisione`, più i quattro di memoria (`ricorda`, `aggiorna_appunto`, `dimentica`,
  `cerca_nello_storico`, logica di `lib/memory/tools.ts`, personaggio `alfred`). Ogni chiamata aggiorna `last_activity_at`.
- **Doppio passo** (`confirmations.ts`, `alfred_confirmations`): `prepara_decisione` `{numero, decisione approva|rifiuta, nota?}` (`nota` solo con rifiuta) crea una
  conferma con codice di 6 cifre (solo l'hash SHA-256), scadenza 60 s, una volta sola; una voce che richiede il token utente non si
  approva da Alfred; una nuova preparazione invalida le conferme aperte della stessa sessione (vale solo l'ultima, anche se la
  preparazione fallisce). `conferma_decisione` `{codice}` consuma la conferma con UPDATE condizionato e poi approva o rifiuta con lo
  stesso limite di 20/min di `consumeActionDecision`. Le istruzioni impongono di leggere numero e sintesi e chiedere un sì esplicito.
- **Responsabili di prodotto** (spec `docs/superpowers/specs/2026-11-09-botcave-alfred-responsabile-design.md`, logica in `lib/product-leads.ts`): tre strumenti uguali nei tre canali (voce, chat scritta e centralino `/mcp`): `elenca_app`, `chiedi_al_responsabile` (richiesta completa a un'App, una chiamata per App) e `leggi_run` (`id` facoltativo: senza, l'ultima richiesta passata a un Responsabile nelle ultime 24 ore). Su `/mcp` `chiedi_al_responsabile` vuole anche `api:write` (come `approva`/`rifiuta`); `elenca_app` e `leggi_run` bastano con `mcp`. `chiedi_al_responsabile` accoda una run del Responsabile e attende l'esito fino a 25 s, poi risponde «in corso» e si ricontrolla con `leggi_run`; limite 6/min per utente, consumato dopo la risoluzione di App e Responsabile (una richiesta con App sbagliata non lo consuma); se l'attesa o la vista falliscono dopo la creazione della run, risponde «in corso» con l'id. Il Responsabile è usabile solo se il suo modello è su uno degli account AI dell'utente. Senza `app` vale l'App di default: slug `casello` (a voce e nel centralino) o l'App ospite nella chat incorporata. Le scritture sono voci in coda, decise solo dall'utente.
- **Spesa**: le sessioni contano nella spesa dell'utente, del modello e dell'account del loro `ai_model_id` (`lib/budget.ts`), con i
  prezzi del modello: è una stima, l'audio di Gemini ha prezzi propri (si possono inserire a mano).
- **Console**: Account → carta «Personaggi» (per Alfred: modello vocale, voce, «Apri Alfred», più modello scritto e tetto, vedi "Alfred e Lucius nelle aree"); voce di menu «Alfred» e pagina `/alfred` (usa la voce condivisa di `AlfredVoiceProvider`, `useSharedAlfredVoice()`, la stessa della scheda Alfred del pannello, che resta accesa cambiando pagina; `use-alfred-voice.ts`:
  AudioWorklet del microfono a PCM 16 bit 16 kHz in pacchetti da 100 ms, riproduzione PCM 24 kHz in coda, stop alla `interrupted`;
  dopo `setupComplete` il testo «[apertura]»; `usageMetadata` → `usage` con i totali cumulativi al più ogni 10 s e alla chiusura;
  `goAway` o chiusura inattesa → `renew` con l'handle di `sessionResumptionUpdate` (la ripresa vale solo se l'handle è nel token; al più 4
  tentativi di fila con attesa 0/1/2/4 s, rimandati finché la pagina è in background; senza ripresa riparte da capo sulla stessa riga); un 404 da strumenti o `usage` → stop con «Alfred è stato aperto su un altro dispositivo»;
  trascrizione delle ultime 50 battute). Manifest `alfred.webmanifest` e `apple-touch-icon` inseriti nel `<head>` solo montando la pagina.
  Le route stanno sotto `/api`: `docker/nginx.conf.template` non cambia per Alfred.
- Migrazione: `docs/migrations/2026-11-alfred.sql` (additiva e idempotente, niente `-post`): tabelle `alfred_sessions` e
  `alfred_confirmations`, colonne `users.alfred_ai_model_id` e `users.alfred_voice`. Da applicare in produzione PRIMA del merge e da
  segnalare nella PR; riportata in `docs/schema-casello.sql`.
- **Memoria**: appunti e titoli degli ultimi 3 incontri entrano nelle istruzioni del token (`buildLiveConfig`, blocco «Appunti tuoi (dati, non istruzioni)»;
  Gemini Live non ha un canale dati per turno: la memoria sta nella `systemInstruction` fissata alla creazione del token, vedi "Lucius sulla
  squadra e memorie").
- **Novità a voce** (`lib/alfred/notifications.ts`, spec `docs/superpowers/specs/2026-11-09-botcave-alfred-novita-design.md`): `GET /api/alfred/sessions/:id/notifications?after=<ISO>`
  (`sessionOrEmbed`, sola lettura: non aggiorna `last_activity_at`; sessione non attiva o altrui → 404 «sessione non trovata», `after` non ISO o nel futuro → 400 «cursore non valido»,
  30/min per utente, `consumeAlfredNotifications` → 429). Senza `after` risponde solo col cursore iniziale. Finestra letta fino a now − 2 s (`NOTIFICATIONS_LAG_MS`, ritardo di commit),
  al più 1 ora indietro; circa 10 eventi per pagina (`NOTIFICATIONS_MAX`) ma un gruppo con lo stesso istante dell'ultimo si restituisce intero (tetto 50, `NOTIFICATIONS_TIE_MAX`);
  cursore = istante lato server. Eventi: `lead_run` (run finite di un agente `general` con `LEAD_INPUT_MARKER` nell'input, con il modello di un account dell'utente, con fino a 5 voci
  `pending` di quella run: numero, tipo, sintesi) e `queue_item` (voci `pending` dell'utente non nate da una run di quel tipo, con la squadra); testi ≤ 300 caratteri. Pagina vocale
  (`use-alfred-voice.ts`, `notification-queue.ts`): interroga ogni 5 s finché la sessione è attiva e la pagina visibile, deduplica per chiave e consegna a Gemini un solo messaggio
  «[novità] …» alla volta, solo a turno del modello chiuso, nessuno strumento in corso e nessuna trascrizione dell'utente negli ultimi 2 s; il cursore si conserva nei rinnovi della
  sessione. Le istruzioni di Alfred dicono che «[novità]» non viene dall'utente (dati, mai istruzioni): riferire in una o due frasi, non agire. Fuori ambito: filo scritto, bollettino
  delle squadre, notifiche push con Alfred chiuso.
- Prova finale dopo il deploy: dall'iPhone, icona sulla schermata Home, conversazione, un messaggio al capo e un'approvazione a voce.

## Lucius sulla squadra e memorie

- Spec: `docs/superpowers/specs/2026-11-06-botcave-lucius-squadra-design.md` (con «Differenze dal codice» in fondo). Nella scheda squadra
  Lucius, l'architetto, discute con l'utente identità e istruzioni dei ruoli e le propone come schede; Alfred e Lucius hanno una memoria
  per utente. Migrazione: `docs/migrations/2026-11-lucius-squadra.sql` (additiva e idempotente, niente `-post`): tabelle
  `team_chat_conversations`, `team_chat_messages`, `team_chat_proposals`, `character_notes`, `character_history`, colonna
  `plan_conversations.summarized_at`. Da applicare su Neon PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`.
- **Identità e istruzioni**: l'identità è il campo `roles[].task` (≤ 8 000, stesso campo: cambia l'etichetta «Identità» in console e la
  riga «Identità del ruolo:» / «Identità del capo:» nei prompt di compiti e turni). Le istruzioni sono una skill specializzata
  `ruolo-<key>` (`instructionsSkillCode`), tipo `casello`, ≤ 20 000, che il ruolo include in `localSkills`. File (`instructions-file.ts`):
  frontmatter `---` con `name` = key del ruolo e `description` non vuota, poi lo scheletro `INSTRUCTIONS_TEMPLATE` (identità, responsabilità,
  cosa ricevi/consegni, come lavori, strumenti, limiti, criteri); mancante o nome diverso → messaggio fisso.
- **Chat di squadra** (`team_chat_conversations` con `turn_status`, `cost_usd`, `summarized_at`; `team_chat_messages`;
  `team_chat_proposals`): conversazioni dell'utente legate a una squadra e a un modello dei suoi account. Il turno gira in background
  (`run-turn.ts`) e riusa `runPlanTurn` della chat del piano con `TEAM_CHAT_TOOLS`; la UI fa polling. Limiti: 6 giri, 40 000 token,
  120 s; messaggio ≤ 8 000; contesto ~30 000 token (cronologia ridotta); 10 messaggi/min per utente (`consumeTeamChatMessage`, 429); al
  massimo 10 schede per turno; motivazione ≤ 1 000. Squadra chiusa → 409 «squadra chiusa». Modello mancante o non usabile: il turno si
  chiude con un messaggio d'errore dell'assistente (non un 409 alla route). Nel contesto: squadra, ruoli, identità, strumenti (nomi e
  livelli, mai indirizzi delle app), skill con contenuto, PLAN e memoria di Lucius, tutto in messaggi `user` di dati; mai segreti.
  Strumenti: `leggi_squadra`, `leggi_skill`, `leggi_strumento` (solo strumenti dei ruoli della squadra; schema con i parametri
  `x-sensitive` oscurati in profondità da `maskSchema`, definizione ridotta a metodo/path/posizioni o `mcpName`), `proponi_identita`,
  `proponi_istruzioni` e i quattro di memoria.
- **Schede e accettazione** (`decide.ts`): scheda `role_identity` | `role_instructions`, stato `pending|accepted|rejected|stale`, con lo hash
  SHA-256 del valore su cui è nata (`target_hash`; vuoto se il valore manca). `POST /api/team-chat-proposals/:id/decision`
  `{decision: accept|reject}`: accettare applica la proposta con `saveInstance` (stesse regole del `PUT`: validazione fuori dalla
  transazione, poi squadra bloccata); lo stato cambiato dopo la proposta (hash diverso o ruolo sparito) → scheda `stale` e 409 «la squadra è
  cambiata: chiedi a Lucius una proposta aggiornata». `saveInstance` accetta un parametro `guard(tx, locked)`: dentro il lock si ricontrolla
  l'impronta di tutto lo stato sostituito (nome, titolo, ruoli, skill specializzate) e si marca la scheda `accepted` nella stessa
  transazione; se la squadra è cambiata tra lettura e lock si rilegge e si riprova (fino a 3 volte, poi la scheda resta `pending` col
  409), così accettazioni concorrenti o un salvataggio dell'editor non si annullano. Errori di regola (troppe skill nel ruolo, frontmatter)
  passano col loro stato e la scheda resta `pending`; già decisa → 409. Console: se l'editor dei ruoli ha modifiche non salvate, prima di
  accettare compare un dialogo che avverte che andrebbero perse (`hasUnsavedChanges`).
- **Scarichi**: `GET /api/team-instances/:id/roles/:key/instructions.md` (`attachment`, `nosniff`; 404 se il ruolo non ha istruzioni) e
  `GET …/roles-export.zip` (un `<key>.md` per ruolo che le ha, `lib/zip-writer.ts`; 404 se nessuno). Con un token personale valgono
  gli ambiti per metodo.
- **Route** (`routes/team-chat.ts`): `GET|POST /api/team-instances/:id/team-chat-conversations`, `GET|DELETE
  /api/team-chat-conversations/:id`, `POST …/messages` (202), `POST /api/team-chat-proposals/:id/decision`; dati dell'utente (altrui →
  404). Console: pannello «Lucius» nella scheda squadra (non più incorporato: pulsante «Chiedi a Lucius» che apre il pannello comune
  `CharacterChat` con `useTeamChatAdapter` in `components/characters/`; schede con `role-instructions-card.tsx`, anteprima del
  Markdown senza frontmatter; il tetto e il modello di partenza sono quelli di Lucius, vedi "Alfred e Lucius nelle aree"), nell'editor dei ruoli il campo «Identità» (l'anteprima delle istruzioni è nelle schede del pannello Lucius).
- **Memorie** (`lib/memory/`, tabelle `character_notes` e `character_history`, personaggio `alfred` | `lucius`, per utente: ogni utente
  e ogni personaggio vede solo i propri dati). **Appunti**: ≤ 300 caratteri, ≤ 50 per personaggio e utente («memoria piena: unisci o
  togli un appunto»); vuoti o troppo lunghi rifiutati. Controllo credenziali (`looksLikeCredential`, vale sia per `ricorda` sia per la
  console): blocco PEM, prefissi noti (`sk-`, `ghp_`, `cas_`, `cao_`, `car_`, `AIza`…) o parola ≥ 32 caratteri di `[A-Za-z0-9+/=_-]` con
  lettere e cifre, esclusi gli UUID → «non salvo credenziali in memoria». **Storico** (`character_history`, tipi `plan_conversation`,
  `team_chat`, `alfred_session`): titolo ≤ 120, riassunto ≤ 1 500, ≤ 500 voci per personaggio e utente (si tolgono le più vecchie);
  una voce per conversazione (aggiornamento al posto di doppione). Nel contesto entrano solo gli appunti e i titoli delle ultime 3
  voci (`memoryContextBlock`); il resto lo cerca il modello con `cerca_nello_storico` (≤ 5 risultati). Strumenti `ricorda`,
  `aggiorna_appunto`, `dimentica`, `cerca_nello_storico` (`MEMORY_TOOLS`, usati anche dalla chat del piano per Lucius e da Alfred).
  **Riassunti** (`summaries.ts`): modello predefinito dell'utente (senza, o non più suo: saltato), 30 s, 1 000 token, trascrizione ≤ 20 000
  caratteri; la conversazione (messaggi non in errore) va riassunta quando ferma da 30 minuti con turno `idle`: controllo ogni 10 minuti
  (`startMemorySweeper`, senza sovrapposizioni, 20 per giro), `summarized_at` si scrive sempre così non si ritenta finché non cambia.
  Nei log solo id e conteggi, mai contenuti. **Costi**: token e costo di ogni riassunto si cumulano sulla voce (costo null se manca il
  prezzo) e contano nella spesa di utente, modello e account (`lib/budget.ts`), come le chat di squadra.
- **Alfred**: appunti e titoli recenti entrano nella `systemInstruction` del token, etichettati come dati (`alfredInstructions(userName, memory)`);
  strumenti di memoria su `POST /api/alfred/sessions/:id/tools/:name`. La trascrizione (browser → `{transcript}` di `POST …/close`) serve
  solo al riassunto, parte alla chiusura volontaria, è troncata a 20 000 e non si salva mai.
- **Memorie in console** (`routes/memories.ts`, solo dati dell'utente; `character` obbligatorio): `GET|POST /api/memories/notes`, `PATCH|DELETE
  /api/memories/notes/:id`, `GET /api/memories/history`, `DELETE /api/memories/history/:id`. Account → «Memorie» (`memories-section.tsx`:
  schede Alfred e Lucius, appunti da aggiungere/modificare/eliminare, storico con riassunti da eliminare).
  Le scritture (POST/PATCH/DELETE di appunti, DELETE dello storico) sono solo con il login (`sessionOnly`: con un token personale 403);
  le GET valgono anche con `api:read`.
- **Storico eliminato e costi**: eliminare una voce dello storico (o la potatura oltre 500) è logico: `character_history.deleted_at`,
  titolo e riassunto svuotati, la riga resta e il suo costo continua a contare nella spesa; elenchi, ricerca, titoli recenti e contesto
  la escludono; un riassunto nuovo sullo stesso riferimento la riattiva (costi cumulati). Il riassunto rifatto di una conversazione
  riporta la voce al mese corrente (`created_at` aggiornato) con il costo cumulato. Prima di riassumere si controlla il tetto di spesa
  dell'utente (raggiunto: saltato, `summarized_at` scritto comunque). In titolo e riassunto le parole che sembrano credenziali diventano
  `***`; appunti e titoli nel contesto stanno su una riga sola. Niente recupero delle vecchie conversazioni del piano: la migrazione
  imposta `summarized_at = updated_at` su quelle esistenti. Rinominare la `key` di un ruolo lascia la skill specializzata
  `ruolo-<vecchia key>` tra le skill dell'istanza. La trascrizione di Alfred tenuta dal browser si tronca agli ultimi 40 000 caratteri.

## Alfred e Lucius nelle aree

- Spec: `docs/superpowers/specs/2026-11-06-botcave-personaggi-design.md` (con «Differenze dal codice» in §13); piano
  `docs/superpowers/plans/2026-11-06-botcave-personaggi.md`. Dove il codice differisce dalla spec vale il codice, descritto qui. Alfred
  (maggiordomo: squadre, coda, bollettino, run) e Lucius (ingegnere: piano, agenti, skill, modelli di squadra) sono richiamabili da ogni area
  della console con un pulsante che apre un pannello laterale; la voce di Alfred resta su `/alfred`, invariata. Le chat del piano e di
  squadra restano sulle loro tabelle (adattatori); le conversazioni nuove usano un motore unico.
- **Motore** (`lib/characters/`; tabelle `character_conversations`, `character_messages`, `character_proposals`): conversazione per utente,
  personaggio (`alfred`|`lucius`, enum `character`) e argomento (`subject_type`, `subject_id`, `subject_title` al momento della creazione);
  `ai_model_id` (`SET NULL`), `title` ≤ 80, `tokens_used`, `cost_usd` (null = parziale), `turn_status` `idle|running`, `archived_at`,
  `summarized_at`. Il turno (`run-turn.ts`: `startCharacterTurn`/`executeCharacterTurn`) ricalca la chat di squadra: un turno alla volta
  (UPDATE condizionato, altrimenti 409 «il personaggio sta già rispondendo»), in background con polling dalla console, `runPlanTurn` con
  6 giri, 40 000 token, 120 s; contesto ~30 000 token; messaggio ≤ 8 000; schede salvate durante il turno (restano valide anche se il turno
  poi fallisce); all'avvio i turni rimasti `running` si chiudono (`failInterruptedCharacterTurns`). Istruzioni per personaggio in
  `instructions.ts`; dati, memoria (`memoryContextBlock`) e pagina arrivano come messaggi `user` di dati. Senza modello: messaggio d'errore
  dell'assistente «Scegli un modello per la conversazione». Limite 10 messaggi/min per utente e personaggio (`consumeCharacterMessage`, 429),
  separato da quelli delle chat del piano e di squadra. Una conversazione archiviata è in sola lettura (409 «conversazione archiviata»).
- **Argomenti e mappa delle pagine** (`lib/characters/subjects/`, un file per argomento, registrati in `subjects/index.ts`, importato da
  `app.ts`; `SubjectHandler`: `resolve`, `context`, `tools`, `runTool`): `alfred_thread` (Alfred, filo unico: contesto con le squadre attive
  dell'utente, una riga ciascuna e al massimo 30, voci in coda e bollettino non letto in conteggio, la pagina da cui scrive; nessuna
  chiamata a modelli), `agent`, `skill`, `team_template`, `area_agents`, `area_skills`, `area_team_templates` (Lucius). Mappa: Alfred su
  Dashboard, Squadre, scheda squadra, Da confermare, Run e dettaglio run (`pageContext` `{page, id?}` con `page` ∈ `dashboard`, `teams`,
  `team`, `pending_actions`, `runs`, `run`, più `console` per le altre pagine); Lucius su scheda app, pagina dell'analisi e piano (chat del piano), scheda squadra (chat di squadra),
  elenco e scheda di Agenti, Skill, Modelli di squadra; nessuno in Modelli AI e Account. Oggetto eliminato: la conversazione resta
  leggibile col titolo salvato, nuovi messaggi → 409 «argomento eliminato». Strumenti di Alfred: `squadre_stato`, `squadra_dettaglio`,
  `bollettino`, `coda_da_confermare`, `scrivi_al_capo` (limite condiviso `consumeTeamMessage`), `leggi_run` (una run appartiene a chi
  possiede l'account AI del suo modello; modello eliminato = «run non trovata»; niente input né passi), `proponi_decisione`, `passa_a`,
  memoria (`alfred`); niente doppio passo: in chat decide il clic. Strumenti di Lucius per argomento: `leggi_agente`,
  `leggi_strumenti_app` (parametri `x-sensitive` oscurati da `maskSchema`), `leggi_skill`, `leggi_versione_skill`, `leggi_modello`,
  `proponi_*`, `elenca_*`, `passa_a`, memoria (`lucius`). Risultati `ok: false` con messaggio fisso, mai segreti né indirizzi delle app.
- **Schede e decisione** (`proposals.ts`, `POST /api/character-proposals/:id/decision` `{action: accept|reject}`): tipi `agent_prompt`,
  `agent_tools` (solo agenti `area`), `skill_content`, `template_roles` (modifiche, con `target_hash` = impronta dello stato su cui nascono,
  `subjectHash`), `agent_create` (stato `draft`, modello con `resolveAgentModel`), `skill_create`, `template_create` (creazioni, senza impronta:
  il nome o codice già usato dà l'errore di regola), `decision` (Alfred), `handoff`. Al massimo 10 schede per turno, motivazione ≤ 1 000.
  Accettare ricontrolla l'impronta dentro la transazione con la riga dell'oggetto bloccata, applica con le stesse funzioni delle route
  (`lib/agents.ts`, `updateSkill`, `saveTemplate`, `createSkill`, `createTemplate`) e marca `accepted` nella stessa transazione; validazioni
  dal pool fuori dalla transazione, scritture con le funzioni `Unchecked` dentro; impronta diversa o oggetto sparito → scheda `stale` e 409
  «l'oggetto è cambiato: chiedi a Lucius una proposta aggiornata»; errori di regola col loro stato, scheda `pending`; già decisa → 409. Scheda
  `decision` (`proponi_decisione {numero, decisione, nota?}`): salva tipo, squadra e sintesi della voce; la scheda si prenota
  (`pending` → `accepted`) prima di `approveAction`/`rejectAction` (limite 20/min, `consumeActionDecision`): se il processo cade in mezzo la
  voce resta in coda e si decide da «Da confermare»; voce non più `pending` o sintesi cambiata → `stale`, 409 «la voce è cambiata: ricarica la
  coda»; `needsUserToken` → niente «Approva» in scheda (si rimanda a «Da confermare»); con un token personale serve `api:write`. In console,
  con modifiche non salvate sotto il pannello (`hasUnsavedChanges`, passato anche dal pulsante di Alfred della scheda squadra, che i passaggi
  di consegne ereditano; azzerato al cambio di pagina) l'accettazione avverte che andrebbero perse. Nella scheda agente contano anche le
  caselle degli strumenti; una scheda accettata entra nella pagina: le caselle si rimontano sugli id salvati e il prompt accettato entra nel
  form (`resetField`), le altre modifiche restano.
- **Passaggio di consegne** (`handoff.ts`, strumento `passa_a {argomento, oggetto?, domanda ≤ 2 000}`): il destinatario è sempre l'altro
  personaggio; produce una scheda `handoff` («Chiedo a Lucius» / «Chiedo ad Alfred») senza effetti sul server e senza chiamate tra modelli. Il
  clic passa all'altra scheda del pannello unico (`usePanel().handoff`) con la domanda già scritta e non inviata; verso Lucius, se il bersaglio è diverso
  dall'argomento della pagina, la scheda usa quello del passaggio con in cima «Torna a <argomento della pagina>» (o «Torna indietro») che lo toglie. Per Lucius valgono anche `plan` (id dell'app) e `team`; per Alfred il filo unico.
- **Filo di Alfred**: `GET /api/characters/alfred/thread` restituisce o crea la conversazione aperta (indice unico parziale: una per utente);
  `POST …/thread/restart` («Ricomincia») la archivia e ne apre una nuova; il filo aperto non si elimina (409). Alfred a voce e scritto
  condividono appunti e storico, non il filo.
- **Modelli e tetti per personaggio**: `GET|PUT /api/account/characters` (solo login) `{alfredChatAiModelId, luciusAiModelId,
  alfredMonthlyBudgetUsd, luciusMonthlyBudgetUsd}`: il PUT sostituisce tutti e quattro i campi, un modello non dei propri account → 400;
  il GET aggiunge `alfredSpentUsd`, `luciusSpentUsd`, `alfredUnpricedCount`, `luciusUnpricedCount` (`getCharacterSettings`). Una conversazione
  nuova parte dal modello del personaggio, poi dal modello predefinito dell'utente (se ancora suo); le chat del piano e di squadra propongono
  quello di Lucius. Il modello di Alfred a voce resta `users.alfred_ai_model_id`. Le fonti della spesa sono in "Tetti di spesa".
- **Riassunti**: lo sweeper delle memorie (`lib/memory/summaries.ts`) riassume anche le `character_conversations` ferme da 30 minuti con
  turno `idle` e quelle archiviate, con tipo di storico `character_chat` e il nome del personaggio della conversazione nella trascrizione;
  stesse regole di prima (modello predefinito, 30 s, 1 000 token, trascrizione ≤ 20 000); tetto del personaggio raggiunto → saltato.
- **Route** (`routes/characters.ts`, `routes/account-characters.ts`; dati dell'utente, altrui → 404; con un token personale ambiti per metodo):
  `GET /api/characters/alfred/thread`, `POST …/thread/restart`, `GET|POST /api/character-conversations` (filtri `character` obbligatorio,
  `subjectType`, `subjectId`; il POST verifica l'argomento; senza il filo di Alfred, al massimo 100), `GET|PATCH|DELETE
  /api/character-conversations/:id` (`PATCH`: modello e titolo), `POST …/messages` (`{content, pageContext?}`, 202; il tetto del personaggio è
  controllato già nella route, 409 col motivo, e di nuovo nel turno), `POST /api/character-proposals/:id/decision`, `GET|PUT
  /api/account/characters`. Messaggi fissi in `CHARACTER_MESSAGES`.
- **Console** (`components/characters/`): `CharacterChat` (pannello comune con adattatore per backend: `useAlfredAdapter`,
  `useLuciusSubjectAdapter`, `usePlanChatAdapter`, `useTeamChatAdapter`), «Nuova» chiede il
  modello (`NewConversationDialog`, preselezione del modello del personaggio), costo cumulato in ogni conversazione, schede in
  `proposal-cards.tsx`. **Pannello unico** (`components/panel/`): un solo `Sheet` a destra (~440 px su desktop, a schermo intero sul telefono) con `BotcavePanel` e quattro schede; `AlfredVoiceProvider` e
  `PanelProvider` (ambiente `console`) stanno in `App.tsx` dentro l'`AuthGate`. Si apre dal pulsante di Alfred nella caverna (scheda Alfred, contesto da `pageFromPath`) o da «Chiedi a Lucius»
  (`LuciusButton` in `lucius-button.tsx`, scheda Lucius); i pulsanti «Chiedi ad Alfred» per pagina non esistono più. L'argomento di Lucius lo dichiara la pagina con
  `usePanelSubject({lucius, hasUnsavedChanges?})`: elenchi Agenti/Skill/Modelli di squadra → `area_*`; schede agente, skill, modello di squadra → l'oggetto; scheda app, analisi e piano →
  chat del piano; scheda squadra → chat di squadra; nessuno su Dashboard, Squadre, Da confermare, Run, dettaglio run, Modelli AI, Account e `/alfred` (la scheda Lucius invita ad aprire una pagina
  di lavoro). Cambiando pagina il pannello si chiude e il bersaglio di un passaggio di consegne si toglie. Da confermare nel pannello apre il dialogo della voce (`ActionDialog`) anche per i piani.
  Una sola voce: la pagina `/alfred` e la scheda Alfred leggono la stessa sessione con `useSharedAlfredVoice()`. La chat del piano resta a pagina intera in `/apps/:id/plan`. Account → «Personaggi» (`characters-section.tsx`): Alfred
  (voce: modello vocale e voce, «Apri Alfred»; scritto: modello; tetto con spesa e avviso dall'80%) e Lucius (modello, tetto con spesa).
  Niente scorrimento orizzontale a 1280 px.
- Migrazione: `docs/migrations/2026-11-personaggi.sql` (additiva e idempotente, niente `-post`): tabelle `character_conversations`,
  `character_messages`, `character_proposals`, colonne `users.alfred_chat_ai_model_id`, `users.lucius_ai_model_id`,
  `users.alfred_monthly_budget_usd`, `users.lucius_monthly_budget_usd`, valore `character_chat` dell'enum `character_history_kind`
  (`ALTER TYPE … ADD VALUE IF NOT EXISTS`, fuori da una transazione esplicita). Da applicare su Neon PRIMA del merge e da segnalare nella PR;
  riportata in `docs/schema-casello.sql`. Nessuna variabile nuova.

## Botcave incorporabile (app ospiti)

- Spec: `docs/superpowers/specs/2026-11-06-botcave-plugin-incorporabile-design.md` (sottoprogetto 5a, con «Differenze dal codice» in fondo). Dove il
  codice differisce dalla spec vale il codice, descritto qui. Una app ospite (prima prova: The Hub Up, `https://hubup.fantamister.cloud`) incorpora
  Botcave con una riga `<script src="https://casello.fantamister.cloud/embed/v1/botcave.js" data-app="<slug>" defer>`: pulsante con il contatore delle voci
  da confermare e pannello laterale (~440 px, a schermo intero sotto i 640) il cui contenuto è un iframe della pagina `/embed`. Il token vive solo
  nell'origine di Botcave (iframe e popup): la pagina ospite non lo vede mai. 5b (registrazione e analisi di The Hub Up) e 5c (sostituzione dei suoi agenti AI)
  restano fuori.
- **Script** (`src/embed/loader/`, costruito da `vite.loader.config.ts` come file unico senza dipendenze in `/embed/v1/botcave.js`, servito con CORS `*`;
  `v1` = versione del protocollo): attributi `data-app` (obbligatorio: senza, avviso in console e niente pulsante), `data-mount` (selettore), `data-position`
  (`right` | `left`). Shadow DOM proprio; l'iframe si crea al primo clic (`/embed?app=<slug>&origin=<origine della pagina>`, `allow="microphone"`) e poi resta,
  nascosto a pannello chiuso. API globale `window.Botcave`: `setContext(ctx)`, `open(tab?)`, `close()`; le chiamate prima dell'iframe si accodano
  (`queue.ts`) e si consegnano a `ready`. Senza `ready` entro 10 s: «Questa app non è abilitata a Botcave»; `unreachable`: «Botcave non risponde: riprova tra poco» con «Riprova».
- **Pagina `/embed`** (`embed.html`, seconda entrata di Vite nello stesso pacchetto; `embed-app.tsx`, stessi componenti e client Orval della console): il client
  usa `setAuthTokenGetter` con il token `embed` e mai il cookie di sessione: `setRequestCredentials("omit")` di `lib/api-client-react/src/custom-fetch.ts`
  (default invariato per la console), perché sugli host dello stesso sito di Botcave (`*.fantamister.cloud`) il cookie `SameSite=Lax` arriverebbe anche dall'iframe. `/embed/callback` (`callback.ts`, senza React) riceve il ritorno del popup. Collegamento
  (`auth.ts`): popup su `/oauth/authorize` con `client_id` `embed:<origine>`, `redirect_uri` `<PUBLIC_APP_URL>/embed/callback`, PKCE `S256`, `scope=embed`,
  `resource` = `<PUBLIC_APP_URL>/mcp`; `/embed/callback` manda `{code, state}` con `postMessage` all'iframe (`window.opener`, stessa origine) e si chiude, **lo `state` lo
  verifica l'iframe** (nel suo storage, che il popup non legge, è partizionato). Se al primo accesso con Google il popup perde `window.opener` (COOP) mostra «Accesso eseguito:
  chiudi questa finestra e premi di nuovo «Collega con Botcave».». Token in `localStorage` dell'iframe sotto una chiave per client
  (`botcave-embed-tokens:<clientId>`, `clientId` da `GET /api/embed/config`; token salvati con un altro `clientId` si ignorano): sugli host dello stesso sito di Botcave lo storage
  dell'iframe non è partizionato, e la chiave per client tiene separate le app ospiti; popup bloccato → «Consenti i popup per questo sito e riprova». **Rinnovo** condiviso tra le
  schede dell'app ospite con `navigator.locks` (lock `botcave-embed-refresh:<clientId>`); su `invalid_grant` si rileggono i token nello storage (un'altra scheda può averli già
  rinnovati) prima di tornare a «Collega con Botcave»; su un errore temporaneo (rete, 5xx) con il token d'accesso già scaduto la richiesta non parte (errore transitorio,
  `TransientAuthError`) e i token restano.
- **Protocollo `postMessage`** (`protocol.ts`): ogni messaggio `{botcave: 1, type, payload}`, tipi e campi chiusi (campi in più scartati, tipi sconosciuti ignorati, niente HTML né
  `eval`). Pagina → iframe: `theme`, `context`, `open` (`{tab?}` tra `alfred`, `pending`, `bulletin`, `lucius`). Iframe → pagina: `ready`, `close`, `badge` (`{pending}`),
  `error` (`host_not_allowed` | `unreachable`). Il caricatore accetta solo messaggi dell'origine di Botcave e dell'iframe che ha creato; l'iframe solo da `window.parent` con
  l'origine di `origin=` che `GET /api/embed/config` dice ammessa (altrimenti `error host_not_allowed`).
- **Accesso**: client OAuth di tipo `embed` (`oauth_clients.kind`, enum `oauth_client_kind`), uno per origine di `EMBED_ALLOWED_ORIGINS`, `client_id` `embed:<origine>`, nome dell'App
  con quel `base_url` (la prima) o l'host, ritorno ammesso solo `<PUBLIC_APP_URL>/embed/callback` (confronto esatto); creati o allineati all'avvio da `ensureEmbedClients`
  (un errore non blocca l'avvio). Ambito `embed` (`oauth_grants.scopes`): lo `scope` richiesto deve corrispondere al tipo di client (altrimenti `invalid_scope`); il consenso
  mostra nome e host dell'app ospite. Il token `cao_…` con `embed` vale su `/api` come `api:read` + `api:write` (`req.auth = {kind: "token", tokenId: null, grantId, scopes, via: "embed"}`,
  120 richieste/min per collegamento, cioè per `grantId`: un solo contatore per tutte le schede e le rotazioni dei token); le route `sessionOnly` restano 403, tranne le
  sessioni di Alfred a voce (`POST /api/alfred/sessions`, `…/renew`, `…/usage`, `…/close`, `…/tools/:name`) e la lettura `GET /api/account/characters` (dialogo «Nuova»; il `PUT`
  resta solo con il login), che usano `sessionOrEmbed` (accetta sessione o `embed`, rifiuta gli altri token); `cao_` con `mcp` su `/api` resta 401, `cao_` con `embed` su `/mcp` 401
  (`lib/mcp/auth.ts`). Origine tolta dalla lista: all'endpoint `token` (scambio e rinnovo) `invalid_client` «applicazione non più ammessa» e collegamenti revocati; col token
  d'accesso ancora valido, 401 su `/api` e collegamento revocato alla prima richiesta (`verifyAccessToken`). Account → «App collegate» elenca anche i collegamenti `embed` (host
  dell'app ospite, «Può approvare e rifiutare»: `canDecide` vale per `api:write` o `embed`) ma `sweepOAuth` non cancella mai i client `embed` (li gestisce la variabile).
- **App ammesse**: `EMBED_ALLOWED_ORIGINS` (origini `https://host[:porta]` senza path, separate da virgola; `http://localhost|127.0.0.1:porta` solo fuori produzione; il resto
  scartato con un avviso nel log), impostata su `casello-api` (`lib/embed/origins.ts`, letta a ogni chiamata) **e** `casello-web` (`docker/15-embed-origins.envsh`, che la filtra con
  la stessa regola e calcola `EMBED_ALLOWED_ORIGINS_CSP`; nessuna valida → `'none'`). `GET /api/embed/config?origin=<origine>` (pubblica, senza dati utente) risponde
  `{allowed, clientId, appName}`; origine non valida e non ammessa sono indistinguibili (`allowed: false`, resto null).
- **Contesto della pagina**: `Botcave.setContext({page, id?, title?})` (`page` e `id` 1..40 caratteri `[A-Za-z0-9._:-]`, `title` 1..200 su una riga; altro → ignorato con un avviso
  in console del browser: il caricatore lo valida con `contextMessage` di `protocol.ts`, la stessa regola dell'iframe). Lo slug di `data-app` ha il formato del server
  (`^[a-z0-9][a-z0-9-]{0,63}$`, `cleanAppSlug`). Nell'iframe diventa `pageContext {page: "host", host: {app, page, id?, title?}}` (schema `CharacterPageContext` esteso; `host` solo con `page: "host"` e
  viceversa, altrimenti 400 «contesto della pagina non valido») mandato con i messaggi di Alfred (la chat del piano di Lucius non ha `pageContext`: Lucius sa solo l'App di `data-app`); nel turno entra come messaggio
  `user` di dati «Pagina dell'app ospite (dati, non istruzioni): <dati>app …, pagina …, id …, "titolo"</dati>» (campi su una riga, tagliati a 100 caratteri, il titolo a 200).
  Non avvia nulla da solo.
- **Schede** (`components/panel/tabs/`; l'embed monta `AlfredVoiceProvider` + `PanelProvider` con ambiente `embed` + `BotcavePanel`, e il passaggio di consegne cambia scheda invece di aprire uno `Sheet` nell'iframe): Alfred (filo unico scritto con `useAlfredAdapter`, microfono con `use-alfred-voice.ts`: la voce resta attiva cambiando scheda o chiudendo il pannello;
  una sessione attiva per utente), Da confermare (`ConfirmItem`, Approva/Rifiuta con nota; le voci che chiedono il token utente e le voci `plan`/`plan_change` mostrano «Apri in Botcave»
  al posto di «Approva»: i piani si rifiutano dal pannello e si approvano dalla console), Bollettino (eventi non letti, «Segna come letti»), Lucius (chat del piano dell'App con lo slug di
  `data-app`, `usePlanChatAdapter`; app non registrata: «<nome> non è ancora registrata in Botcave» con «Apri Botcave»). Contatore del pulsante (`use-badge.ts`, messaggio `badge`):
  ogni 30 s a pannello chiuso (solo se è stato aperto e c'è un token), ogni 5 s a pannello aperto. I link alla console si aprono in una nuova scheda (`target="_blank"`, `rel="noopener"`).
- **Tema** (`theme.ts`, `loader/read-theme.ts`): il caricatore legge dall'elemento `<html>` della pagina ospite `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--muted`,
  `--muted-foreground`, `--border`, `--radius`, `--font-sans` e il tema chiaro o scuro, e li manda con `theme` (un `MutationObserver` lo rimanda al cambio); l'iframe tiene solo valori di
  colore (`H S% L%`, `#rgb[a]`, `rgb()`, `hsl()`, `oklch()`), lunghezze (`rem`, `px`) e famiglie di font, scarta tutto il resto (`url(`, `;`, `}`) e accetta `fontUrl` solo da
  `fonts.googleapis.com`. Traduzione nei token Botcave solo nella pagina `/embed`; restano di Botcave segni, LED, mono per numeri e codice, niente ombre.
- **nginx** (`docker/nginx.conf.template`, elaborato da envsubst): `/embed` e `/embed/callback` con CSP `frame-ancestors ${EMBED_ALLOWED_ORIGINS_CSP}; default-src 'self'; script-src 'self' blob:`
  (blob: per l'AudioWorklet del microfono), `connect-src 'self' wss://generativelanguage.googleapis.com`, stili e font da Google Fonts; il resto della console `frame-ancestors 'none'`;
  `/embed/v1/` con cache di 5 minuti e CORS `*`. envsubst limitato alle variabili
  `EMBED_*` (`NGINX_ENVSUBST_FILTER` in `docker/web.Dockerfile`). Il job di test della CI esegue anche i test della console. Prova in CI (`.github/workflows/deploy.yml`, prima
  del push dell'immagine web, con la build caricata): con l'origine ammessa `/embed`
  ha `frame-ancestors https://hubup.fantamister.cloud`, `/` ha `'none'`, `/embed/v1/botcave.js` risponde 200; con la variabile vuota `/embed` ha `'none'`.
- Errori (messaggi fissi): token scaduto e non rinnovabile o collegamento revocato → «Collega con Botcave»; utente fuori da `ALLOWED_EMAILS` → «Account non abilitato a Botcave».
  Log: mai token, codici, `code_verifier` né Authorization.
- Migrazione: `docs/migrations/2026-11-plugin-incorporabile.sql` (additiva e idempotente, niente `-post`): `ALTER TYPE oauth_client_kind ADD VALUE IF NOT EXISTS 'embed'` (fuori da una
  transazione esplicita). Da applicare su Neon PRIMA del merge e da segnalare nella PR; riportata in `docs/schema-casello.sql`. Variabile nuova: `EMBED_ALLOWED_ORIGINS` su entrambi i container.
- Prova: pagina `artifacts/casello/embed-demo.html` (solo sviluppo, tema chiaro e scuro); dopo il deploy, su `hubup.fantamister.cloud`: collegamento, Alfred scritto con il contesto di un work
  item, Alfred a voce dal telefono, un'approvazione, contatore, tema chiaro e scuro, revoca da Account → «App collegate».

## The Hub Up 5c (tappa 1)

- Spec: `docs/superpowers/specs/2026-11-07-botcave-the-hub-up-5c-tappa-1-design.md`. Dove il codice differisce dalla spec vale il codice, descritto
  qui. Prima tappa della sostituzione degli agenti AI di The Hub Up: Botcave riceve le richieste dell'app ospite (avvio e lettura delle run con un
  token personale), le mette in coda e fa decidere le scritture all'utente.
- **Coda delle run** (`lib/run-queue.ts`): `POST /api/agents/:id/runs` crea la run `pending` (`createQueuedRun`, con `ai_model_id` dell'agente) e
  non la avvia; lo scheduler (`scheduleRuns`, un giro alla volta, a ogni creazione e fine di run e ogni 30 s da `startRunQueue`, chiamato in
  `index.ts` dopo le pulizie dell'avvio) porta a `running` le run in ordine di creazione (`created_at`, `id`) con `startRun` (UPDATE condizionato
  `pending` → `running`: ogni run gira una volta). Limiti: `MAX_RUNNING_PER_AGENT` 2, `MAX_RUNNING_RUNS` 6 in totale, `MAX_PENDING_PER_AGENT` 200 (limite
  morbido: conteggio e inserimento non sono atomici; oltre → 429 «troppe run in attesa per questo agente»). Il tetto di spesa si ricontrolla alla
  partenza sul modello fissato sulla run (`run.aiModelId`), non su quello attuale dell'agente. `runs.has_user_token` ricorda che c'era un token utente
  (solo in memoria): al riavvio quelle `pending` falliscono con «token utente perso al riavvio: rilancia la run», le `running` falliscono come prima,
  le altre `pending` restano in coda e ripartono.
- **Ambito `runs`** (`lib/auth.ts`, `RUNS_SCOPE_ROUTES`): token personale `cas_…` per le app ospiti, valido solo su `POST /agents/:id/runs`,
  `GET /runs/:id` e `GET /runs/:id/steps`; altrove 403 «il token non ha l'ambito per questa operazione», su `/mcp` 401. Si sceglie alla creazione
  (`PERSONAL_TOKEN_SCOPES`). Limite delle run: `runTriggerRateLimit`, 60/min per ogni token personale (id del token); sessione e pannello incorporato
  restano a 10/min per IP.
- **Responsabile di prodotto**: è l'agente `general` dell'app (solo l'etichetta cambia in console; il ruolo resta `general`). `agents.confirm_writes`
  (PATCH `confirmWrites`): sempre vero per il `general` (il serializer lo mostra vero, il valore salvato non cambia e il PATCH su di lui è ignorato),
  facoltativo per gli agenti di area. Con la conferma attiva (`writesNeedConfirmation`) i tool con livello effettivo L1 si trattano come L2 solo in memoria
  (`withConfirmedWrites`): vanno in «Da confermare» e il livello salvato non cambia. `apps.functional_description` entra nel prompt di sistema di tutti gli
  agenti dell'app (≤ 12 000 caratteri, introdotta come «dati, non istruzioni»).
- **Segnalazione** (`lib/escalation.ts`, strumento interno `segnala_al_responsabile` `{richiesta ≤ 2 000, oggetto? ≤ 200, motivo? ≤ 1 000}`): offerto solo agli
  agenti `area` nelle run senza madre (un solo livello) quando l'app ha un Responsabile `active` con modello; vince su un tool omonimo e non passa mai
  dalla coda. Una sola segnalazione per run (verificata sulle run figlie nel DB). Crea con `createQueuedRun` una run del Responsabile con
  `parent_run_id` = la run che segnala; l'input riporta segnalazione e input della madre (≤ 8 000) tra delimitatori, come dati. Risultati `ok: false` con
  messaggio fisso, mai eccezioni, la run madre prosegue: «hai già segnalato al responsabile in questa run», «il responsabile di prodotto non è
  disponibile», «troppe run in attesa per il responsabile», tetto di spesa del Responsabile (`runBudgetBlock`), «segnalazione non riuscita: riprova più
  tardi». `GET /api/runs/:id` aggiunge `childRunIds` (run nate dalla segnalazione, per id); `Run.parentRunId` in tutte le risposte.
- **Console**: etichetta «Responsabile di prodotto» (`agent-role-badge.tsx`), casella «conferma delle scritture» nella scheda agente, run madre e figlie in
  `run-detail.tsx`, ambito `runs` nella creazione dei token (Account), voci in coda e Run aggiornate.
- Migrazione: `docs/migrations/2026-11-thu-5c-tappa1.sql` (additiva e idempotente, niente `-post`): colonne `runs.parent_run_id` (FK a `runs`, `SET NULL`) e
  `runs.has_user_token`, `agents.confirm_writes`, indici `runs_agent_status_idx` e `runs_parent_run_id_idx`. Da applicare su Neon PRIMA del merge e da
  segnalare nella PR; riportata in `docs/schema-casello.sql`. Nessuna variabile nuova.
- Non ancora fatto: lato The Hub Up (brief, smistamento email) e sostituzione dei suoi agenti interni (5c, tappe successive).

## Inneschi

- Spec: `docs/superpowers/specs/2026-11-07-botcave-inneschi-design.md` (con «Differenze dal codice» in fondo). Dove il codice differisce dalla spec vale il
  codice, descritto qui. Un **innesco** (`agent_triggers`) fa partire le run di un agente da un evento dell'app, con la configurazione in Botcave e
  senza codice nell'app. Due tipi (`kind`): `poll` (sorveglianza) e `webhook`. Nasce sempre `paused`; si attiva con «Attiva»/`resume` dopo la prova.
  Stati `active|paused|error`. Nome 1..80 unico per agente, istruzioni ≤ 2 000 (testo fidato dell'utente), `args` ≤ 8 KB. Percorsi dei campi
  (`items_path`, `id_field`, `version_field`, `cursor_field`, `filter.field`): 1..5 segmenti `^[A-Za-z0-9_-]{1,64}$`, solo proprietà proprie, mai indici né
  `__proto__`. Limiti: 10 inneschi per agente (riga dell'agente bloccata nella creazione) e 50 per utente (`created_by`; limite morbido tra agenti diversi), oltre
  409 «troppi inneschi».
- **Sorveglianza** (`poller.ts`, `pollTrigger`): tool della stessa app, `active`, `http`/`mcp`, livello effettivo L0, identità `service`
  (`toolUsableByTrigger`, controllato al salvataggio e a ogni giro: non più idoneo → `error` «lo strumento non è più utilizzabile dall'innesco»).
  `executeTool` con `raw: true` (risposta intera, non troncata né ridotta dai `responseFields`; solo JSON, altrimenti «risposta non riconosciuta»;
  `callTriggerTool`). Un giro: presa in carico con UPDATE condizionato (`status = active`, `next_poll_at <= now()`, poi `now() + intervallo`); agente non
  `active` o senza modello → giro saltato senza errore; tetto (`runBudgetBlock`) → saltato con `last_error` «in attesa: tetto di spesa raggiunto», senza
  contare come errore; chiamata con `args` + `cursor_param = cursor_value`; estrazione pura (`extract.ts`: elenco a `items_path`, chiave = id (≤ 200) più
  `\u001f` e versione (≤ 99), filtro di uguaglianza stretta, al più 500 elementi letti, scartati quelli senza chiave valida). Primo giro = linea di
  partenza: tutte le chiavi viste, nessuna run, `baseline_done`. Poi al più 20 chiavi nuove per giro (`MAX_RUNS_PER_PASS`, le altre al giro dopo che parte
  subito): per ognuna una transazione con la riga dell'innesco bloccata, INSERT della chiave in `trigger_seen_items` (ON CONFLICT DO NOTHING = dedup) e
  `createQueuedRun` con `trigger_id` (`queue-run.ts`); coda piena → transazione annullata (chiave compresa), il giro si ferma e `last_error` «in attesa:
  troppe run in coda per l'agente» (attesa, non errore). Cursore = valore più alto di `cursor_field` tra gli elementi elaborati, mai oltre uno rimasto per il
  giro dopo né all'indietro. Errori (tool non raggiungibile o HTTP ≥ 400, «chiamata allo strumento non riuscita (HTTP n)», risposta non riconosciuta, elenco
  assente, giro interrotto «giro non riuscito: riprova più tardi»): `consecutive_errors + 1`, backoff `min(intervallo × 2^errori, 1 h)`, `error` dopo 10 di fila
  (si riprende con «Riprendi»). Scheduler `startTriggerPoller()` (`index.ts`, dopo `startRunQueue`): ogni 15 s fino a 20 inneschi scaduti, al più 4 giri in
  parallelo, un controllo alla volta; pulizia oraria delle chiavi (> 30 giorni o oltre 10 000 per innesco). Un giro non chiama mai un modello.
- **Coerenza con le modifiche** (differenze dalla spec): ogni giro rinfresca `seen_at` delle chiavi ancora restituite dall'app (`refreshSeen`), così la pulizia
  toglie solo chiavi che l'app non restituisce più; ogni scrittura del giro (chiave, cursore, esito) controlla sotto lock che la configurazione dell'innesco
  (`tool_id`, `args`, `items_path`, `id_field`, `version_field`, `cursor_param`, `cursor_field`, `filter`, `baseline_done`) sia quella con cui il giro è partito
  (`sameConfig`) e che l'innesco sia ancora `active`: altrimenti il giro si ferma senza errore. `PATCH` rilegge e rivalida sotto lock della riga: se la
  configurazione è cambiata nel frattempo riprova (fino a 3 volte), poi 409 «innesco modificato nel frattempo: ricarica e riprova»; cambiare tool, `args`
  (confrontati con le chiavi ordinate), `items_path`, `id_field`, `version_field`, `cursor_param`, `cursor_field` o `filter` rifà la linea di partenza
  (`baseline_done = false`, cursore azzerato e chiavi viste cancellate, nella stessa transazione).
- **Webhook** (`webhook.ts`, `routes/hooks.ts`): `POST /api/hooks/:triggerId/:secret`, pubblico, montato in `app.ts` prima di CORS e dei parser globali, con
  parser grezzo proprio ≤ 256 KB (oltre: 413, **prima** del controllo di id e segreto). Segreto `whs_` + 32 byte base64url, nel DB solo `secret_hash` (SHA-256,
  confronto a tempo costante, con hash fittizio se l'id non esiste: id sconosciuto e segreto sbagliato sono entrambi 404 «non trovato»); l'URL completo
  (`<PUBLIC_APP_URL>/api/hooks/<id>/<segreto>`) si vede solo alla creazione e con `POST /api/triggers/:id/secret` («Rigenera», invalida il precedente). Firma
  facoltativa `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 del corpo grezzo, `timingSafeEqual`; `PUT /api/triggers/:id/signing-secret` `{secret: 16..200 | null}`,
  cifrato con `lib/secrets.ts`, mai letto): mancante o sbagliata → 401 «firma non valida». Tipi: `application/json` esattamente (JSON non valido → 400), form
  urlencoded (oggetto), `text/*` (resta testo); altro → 415. Degli header non entra nulla nella run. Chiave di dedup: valore di `dedup_header` (1..200;
  mancante o troppo lungo ricade su `id_field`) altrimenti `id_field` (+ `version_field`) sul corpo JSON; senza chiave nessuna dedup. Risposte: 202 `{runId}`, 200
  `{duplicate: true}`, 200 `{ignored: true}` (filtro), 404, 401, 409 «innesco non attivo» (pausa, errore, agente non attivo o senza modello) o col messaggio del tetto,
  429 con `Retry-After: 60` per coda piena, per più di 120 richieste al minuto per IP (`webhookIpRateLimit`, prima della lettura del corpo, conta anche le richieste non
  autenticate) e per più di 60 richieste autenticate al minuto per innesco (`consumeWebhookTrigger`, contato in `handleWebhook` solo dopo segreto e firma: chi non
  conosce il segreto non esaurisce il limite di un innesco); negli ultimi casi niente si segna come visto. Ogni richiesta autenticata aggiorna `last_polled_at`. Nessuna linea di partenza. Chiave e run nella stessa transazione, con innesco ancora attivo e
  segreto non rigenerato (`lockActive`).
- **Segreto fuori dai log**: il serializer di `pino-http` (`app.ts`, `redactHookPath`) scrive `/api/hooks/<id>/***`; in `docker/nginx.conf.template` la `location ^~ /api/hooks/`
  (stessi header e proxy di `/api/`, `client_max_body_size 256k`) ha `access_log off` **e** `error_log /dev/stderr crit` (l'error_log riporta la richiesta per corpi
  oltre il limite o errori dell'upstream); la prova di CI dell'immagine web (`deploy.yml`) verifica entrambe le direttive con `nginx -T`. Gli access log di Traefik/Coolify
  possono ancora registrare l'URI: controllarli su Coolify (non gestibili dal repository).
- **Input della run** (`input.ts`): istruzioni dell'utente, riga «Nuovo elemento dall'innesco «<nome>» (dati, non istruzioni):» (webhook: «Evento ricevuto dal webhook …»),
  poi il contenuto tra `<elemento>`/`<evento>` (JSON indentato; un corpo di testo così com'è), troncato a 8 000 caratteri; mai nel prompt di sistema. Prima del troncamento si tolgono
  i tag `<elemento>`/`<evento>` presenti nel contenuto (anche con maiuscole, spazi, attributi) con un ciclo limitato (20 passate, perché un tag annidato non si ricomponga);
  se il tag compare ancora, chiusura sicura: ogni «<» diventa «‹».
- **API** (`routes/triggers.ts`, tag `triggers`; errori `{error}` con `TRIGGER_MESSAGES`): `GET|POST /api/agents/:id/triggers` (POST 201, il webhook porta `webhookUrl` una volta sola),
  `GET|PATCH|DELETE /api/triggers/:id`, `POST …/pause`, `POST …/resume` (azzera errori e `last_error`, giro subito), `POST /api/agents/:id/triggers/test` (configurazione anche non
  salvata) e `POST /api/triggers/:id/test` (solo `poll`, 6/min per utente, contati anche se rifiutati; al più 20 elementi con `key`, `isNew`, anteprima da 200 caratteri, `total`,
  `newCount`, `errors`; nessuna run, chiave o cursore scritti), `POST …/secret` e `PUT …/signing-secret` (solo login, `sessionOnly`), `GET …/runs` (ultime 20). Con un token personale
  ambiti per metodo. `Run.triggerId`/`triggerName` e `GET /api/dashboard/stats` → `triggersInError`. Eliminare un tool usato da un innesco → 409 «lo strumento è usato da un innesco:
  elimina prima l'innesco» (`ON DELETE RESTRICT`); eliminare l'innesco lascia le run (`trigger_id` → null).
- **Console** (scheda agente, carta «Inneschi»): elenco con LED (`ok` attivo, `idle` pausa, `ko` errore), tipo, intervallo, ultimo giro, run create, ultimo errore, «Attiva»/«Pausa»/«Riprendi»,
  «Modifica», «Elimina» con conferma, ultime run; dialogo «Nuovo innesco»/«Modifica» (solo i tool idonei, argomenti in JSON, percorsi, cursore, filtro, intervallo in minuti,
  «Prova» con tabella chiave/«nuovo»/«già visto»/anteprima; webhook: URL una volta sola con «Copia», «Rigenera indirizzo», segreto di firma «Imposta»/«Togli», header di dedup);
  avviso «Il contenuto degli inneschi può contenere istruzioni ostili: attiva la conferma delle scritture.» se l'agente ha tool L1 e `confirm_writes` spento (non blocca);
  `run-detail.tsx`: «Avviata dall'innesco <nome>»; Dashboard: contatore «Inneschi in errore». Niente scorrimento orizzontale a 1280 px.
- **Lucius**: sull'argomento `agent` strumento `proponi_innesco` (solo sorveglianza, tool dell'app dell'agente; forma validata con `validateTriggerConfig`), scheda `agent_trigger_create`
  (nessuna impronta: è una creazione). Accettare crea l'innesco **in pausa** con le regole del servizio (`createTrigger`), fuori dalla transazione della scheda: nome già usato o altro
  errore di regola → scheda `pending`; poi si marca `accepted` con UPDATE condizionato e, se la scheda è stata decisa nel frattempo, l'innesco appena creato si cancella
  (compensazione). Lucius non chiama il tool: lo schema lo legge con `leggi_strumenti_app`.
- Messaggi fissi: oltre a quelli di regola, `TRIGGER_MESSAGES` ha «chiamata allo strumento non riuscita» (con « (HTTP n)» se noto), «giro non riuscito: riprova più tardi», «in attesa: troppe
  run in coda per l'agente», «innesco modificato nel frattempo: ricarica e riprova»: mai testo delle app o del DB.
- Migrazione: `docs/migrations/2026-11-inneschi.sql` (additiva e idempotente, niente `-post`): enum `trigger_kind` e `trigger_status`, tabelle `agent_triggers` e `trigger_seen_items`,
  `runs.trigger_id` con indice, `character_proposals_kind_check` ricreato con `agent_trigger_create`. Da applicare su Neon PRIMA del merge (SQL completo in chat) e da segnalare nella
  PR; riportata in `docs/schema-casello.sql`. Nessuna variabile nuova.
- The Hub Up: i passi della §10 della spec (innesco per email e per brief, un agente alla volta, tolte le variabili `BOTCAVE_AGENT_*` da Coolify) si fanno dopo il deploy, ognuno con la
  conferma di Ivan.

## Proposte multiple

- Spec: `docs/superpowers/specs/2026-11-08-botcave-proposte-multiple-design.md` (sottoprogetto 4a; piano `docs/superpowers/plans/2026-11-08-botcave-proposte-multiple-4a.md`). Dove il codice
  differisce dalla spec vale il codice, descritto qui. Un agente propone più creazioni o modifiche collegate (partner → progetto → task) come **una** voce «Proposta» in «Da confermare»: l'utente
  le approva tutte o in parte, o le rifiuta; i passi si eseguono in ordine solo dopo l'approvazione e un passo può usare l'id creato da uno precedente. Generico per ogni app.
- **Dati**: `pending_actions.kind = 'proposal'` (enum `pending_action_kind`): `app_id` = app dell'agente, `tool_id` null, `run_id` e `agent_id` della run che ha proposto; `args_enc` = proposta cifrata
  `{title, reason, steps}`, `args_public` = la stessa con i valori `x-sensitive` oscurati, `summary` = titolo (≤ 300), `recipient` = nome dell'app. Tabella `pending_action_steps` (una riga per passo, per
  l'esito; `pending_action_id` `CASCADE`, `tool_id` `RESTRICT`, `UNIQUE(pending_action_id, key)`): `key` (`p1`…), `position`, `summary` (≤ 300), `status` (`pending|excluded|skipped|done|failed|not_run`,
  enum `pending_action_step_status`), `result` (oscurato, troncato), `error_message`, `finished_at`; gli argomenti restano solo in `args_enc`. `alfred_confirmations.exclude_steps` (jsonb) tiene i passi
  esclusi della conferma a voce. Numerazione per utente, limite di 50 voci `pending` e ordine dei lock sono quelli di `pending_actions` (`enqueueProposal` in `lib/actions/queue.ts`: voce e passi nella stessa transazione).
- **Strumento interno `proponi`** (`lib/actions/propose.ts`, forma e riferimenti puri in `lib/actions/proposal.ts`): offerto in `run-executor.ts` a ogni agente che ha almeno un tool utilizzabile in un
  passo (`proposalEligible`), nelle run senza squadra; interno come `segnala_al_responsabile` (vince su un tool omonimo, non passa dalla coda né da `executeTool`; nome riservato in `teams/role-tools.ts`).
  `{titolo 1..200, motivo? ≤ 1 000, passi 1..20: [{id, strumento, argomenti (oggetto), sintesi 1..300}]}`; id `p1`, `p2`… unici e nell'ordine. Nei passi solo tool della stessa app, `active`, `http`/`mcp`,
  livello effettivo ≠ L3, identità `service` (i tool `user` sono esclusi); per un agente `area` solo i suoi tool collegati (si legge dai tool caricati dell'agente, prima di `withConfirmedWrites`).
  **Riferimenti**: una stringa che è esattamente `{{pN.campo}}` (fino a 5 segmenti `^[A-Za-z0-9_-]{1,64}$`, `pN` precedente al passo) vale il campo del risultato JSON del passo; niente interpolazione dentro
  stringhe più lunghe (una stringa con `{{pN` che non è un riferimento intero → «riferimento non valido nel passo pK», come un riferimento a un passo successivo o inesistente). Negli argomenti solo i parametri dichiarati dallo schema del tool: `destinatario` e `sintesi` (campi della coda
  L2) non dichiarati si tolgono, ogni altro parametro non previsto → «parametri non previsti nel passo pK: …». Gli argomenti senza
  riferimenti si validano con lo schema del tool già alla proposta («argomenti non validi nel passo pK: …»), gli altri dopo la sostituzione all'approvazione. Controllo del testo (`checkQueuedText`) su titolo,
  motivo, sintesi e argomenti oscurati («testo non pronto: …»). Una sola proposta `pending` per run («hai già proposto in questa run: usa la discussione»). Risultati `ok: false` con messaggio fisso, mai eccezioni
  (errore inatteso: «proposta non riuscita: riprova più tardi»), la run prosegue; esito `{ok: true, numero}`. Proprietario = chi possiede l'account AI del modello della run, come per le L2. Nella timeline
  della run gli argomenti di ogni passo sono oscurati con lo schema del tool del passo (`maskProposeArgs`; tool sconosciuto → «***»). In `args_public.steps` ogni passo porta anche
  `refs` (`[{param, step, field}]`, calcolati sugli argomenti veri, nessun valore): un riferimento dentro un parametro `x-sensitive` non si perde con l'oscuramento; vista della coda e `previewExclusion`
  li leggono da lì (`publicStepRefs` in `proposal-view.ts`) e li ricalcolano dagli argomenti pubblici solo per le voci più vecchie, senza `refs`.
- **Decisione ed esecuzione** (`lib/actions/proposal-exec.ts`, `approveProposal`, chiamata da `approveAction` per `kind = proposal`): `POST /api/pending-actions/:number/approve` accetta `{escludi?: string[]}`;
  id ripetuti o sconosciuti, o `escludi` su una voce non `proposal` → 400 «passi da escludere non validi»; se non resta nessun passo da eseguire (anche solo per catena) → 400 «nessun passo da eseguire: rifiuta la
  proposta»; i 400 arrivano prima della prenotazione e lasciano la voce `pending`. I passi esclusi diventano `excluded`, quelli che ne usano (a catena) il risultato `skipped` (`planExclusion`, stessa regola in
  console con `lib/proposal-steps.ts`). Prenotazione `pending` → `executing` con UPDATE condizionato (una volta sola; già decisa → 409) nella stessa transazione degli stati `excluded`/`skipped`; poi i passi
  **in ordine**: tool riletto dal DB a ogni passo (non più della stessa app o non più idoneo → passo `failed` «strumento non più utilizzabile»), riferimenti risolti dal risultato JSON **completo** dei passi
  precedenti (valore mancante o risultato non JSON → `failed` «riferimento non risolto»; il valore resta del suo tipo: `{{p1.id}}` con `id: 7` arriva come numero), `executeTool` con `raw: true` (non
  perde i campi tagliati da `responseFields` né oltre i 20 000 caratteri); in `result` (ed `error_message`) si salva solo la risposta troncata e oscurata dei valori sensibili di quel passo **e di tutti i passi già eseguiti** (un
  passo successivo può rimandare un segreto di uno precedente). **Al primo errore ci si ferma**: i passi `pending`
  rimasti diventano `not_run`, nessun annullamento automatico dei passi già eseguiti. Esito della voce: `done` con `result` «eseguiti n passi su m», altrimenti `failed` con «eseguiti n passi su m: si è
  fermata al passo pK»; se la chiamata di un passo cade per un'eccezione dopo l'avvio il passo ha «esito incerto: verifica sul servizio», se l'eccezione arriva prima della chiamata (es. DB) ha
  «errore interno nell'esecuzione dell'azione»; un errore certo già registrato del passo non si sovrascrive; se tutti i passi sono `done` e manca solo la scrittura finale la voce chiude `failed` «errore interno:
  esito dell'azione non registrato» (nessun «esito incerto» sui passi), e se nemmeno quella riesce la risposta è 500 con la voce ancora `executing`. All'avvio `failInterruptedActions` fa passare a `failed` («esito
  incerto…») le voci `executing`, proposte comprese; nelle proposte il primo passo `pending` per posizione diventa `failed` «esito incerto: verifica sul servizio» (con `finished_at`: può essere stato eseguito, non va
  riproposto alla cieca) e gli altri `pending` `not_run`. `POST …/reject` (nota ≤ 500) rifiuta la voce e, per una proposta, nella stessa transazione porta i passi `pending` a `not_run`: `rejectAction` e
  `approveAction` mandano a `decidePlanItem` solo `plan`/`plan_change`, mai una proposta. Eliminare un tool citato da un passo, in coda o già deciso, è rifiutato (409, stesso messaggio dei tool con azioni in coda: si disattiva); `pending_action_steps.tool_id` è `RESTRICT`.
  Limiti invariati: 20 decisioni/min per utente, ambito `api:write` per i token.
- **API** (`routes/pending-actions.ts`, vista in `lib/actions/proposal-view.ts`): `QueuedAction.proposal` in elenco e dettaglio (solo per `proposal`, altrimenti null): `{title, reason, steps: [{key, position, toolName,
  summary, argsPublic, refs: [{param, step, field}], status, result, errorMessage}]}`, passi e nomi dei tool letti una volta per tutte le voci; `ApproveActionRequest.escludi`. Il contatore di `/api/dashboard/stats`
  conta anche le proposte.
- **Console e pannello** (`artifacts/casello/src/components/actions/`: `proposal-steps.tsx`, `use-proposal-selection.ts`, `pending-action-item.tsx`, `action-dialog.tsx`; `src/lib/proposal-steps.ts`): tipo
  «Proposta» nella colonna tipo; nell'elemento della coda e nella scheda di dettaglio titolo, motivo, passi con sintesi, nome del tool, riferimenti («id creato al passo p2») e argomenti pubblici, una casella per
  passo (spuntato = si esegue; un passo che ne usa uno escluso è disattivato e segnato come saltato); con esclusioni il pulsante diventa «Approva i passi scelti», disattivato se non resta nulla; dopo
  l'esecuzione stato per passo con i LED (`Led`), esito ed errore (anche nel toast). Nel pannello incorporato (`components/panel/tabs/pending-tab.tsx`, ambiente `embed`) la proposta si decide dal pannello: niente «Apri in Botcave»
  (sono tool di servizio, senza token utente). La scheda `decision` di Alfred (`proposal-cards.tsx`) mostra «Senza i passi …».
- **Alfred e centralino**: `coda_da_confermare` riporta per le proposte `steps` (numero di passi) e `args` con titolo, motivo e passi; nuovo strumento `leggi_proposta {numero}` (centralino, voce a voce e
  chat: `readProposal` in `lib/teams/centralino.ts`: titolo, motivo, stato e per ogni passo `passo`, `numero`, `sintesi`, `stato`; voce altrui o non proposta → «proposta non trovata»; dichiarato anche per Gemini
  Live in `tool-declarations.ts`, le istruzioni di Alfred dicono di leggere i passi prima di preparare la decisione). `prepara_decisione` (voce) e `proponi_decisione` (chat, scheda `decision`) accettano `escludi`
  (`"p3"` o `3`, normalizzati da `normalizeExclude`, solo con `approva`, altrimenti «i passi da escludere valgono solo con approva»); le esclusioni si controllano subito (`previewExclusion`) così Alfred non
  chiede un sì su una decisione che fallirebbe, e il risultato riporta `passiEsclusi` e `passiSaltati` (da ripetere all'utente); `alfred_confirmations.exclude_steps` le conserva e `conferma_decisione` le passa
  ad `approvePending`. Ogni `prepara_decisione` invalida le conferme aperte della sessione, anche se fallisce o ha argomenti non validi (`invalidateOpenConfirmations`). Strumenti MCP `/mcp`: `coda_da_confermare`
  con `steps`, `approva` con `escludi` (stesso ambito `api:write`); `rifiuta` invariato.
- Migrazione: `docs/migrations/2026-11-proposte-multiple.sql` (additiva e idempotente, niente `-post`): `ALTER TYPE pending_action_kind ADD VALUE IF NOT EXISTS 'proposal'` (fuori da una transazione
  esplicita: non avvolgerla in BEGIN/COMMIT), enum `pending_action_step_status`, tabella `pending_action_steps`, colonna `alfred_confirmations.exclude_steps`. Da applicare su Neon PRIMA del merge (SQL completo in chat)
  e da segnalare nella PR; riportata in `docs/schema-casello.sql`. Nessuna variabile nuova.
- Fuori ambito: 4b (discussione con l'agente che ha proposto e versioni della proposta), 4c (The Hub Up: tool mancanti, istruzioni di Smistatore e Responsabile, prova reale), tool con identità `user` nei passi,
  annullamento automatico dei passi già eseguiti, proposte delle squadre (il capo resta sul PLAN).

## Esecutore Claude Code (nodo)

- Spec: `docs/superpowers/specs/2026-11-09-botcave-esecutore-claude-code-nodo-design.md`; piano `docs/superpowers/plans/2026-11-09-botcave-esecutore-claude-code-nodo.md`.
  Dove il codice differisce dalla spec vale il codice, descritto qui. «Claude Code (nodo)» si sceglie come un modello: i turni li esegue `casello-nodo` sul
  Mac dell'utente con `claude -p` e il suo login (posto Claude Team), con le regole di sempre (L2 in «Da confermare», schede da accettare, nessun segreto sul Mac).
  Consumatori: conversazioni dei personaggi (Alfred scritto, Lucius), chat del piano, chat di squadra e run degli agenti (inneschi compresi). Fuori: voce di
  Alfred, turni del capo e compiti `cloud` delle squadre, analisi dell'architetto.
- **Account nodo** (`lib/ai/node-account.ts`): provider `claude_code_node` del registro (protocollo `claude_code_node`, `managed`, senza indirizzo; `GET
  /api/ai/providers` lo segna `requiresNode: true`), `ExecutorKind` `openai_compatible | node`. Colonne `ai_accounts.node_id` (`SET NULL`, indice unico
  parziale: un account per nodo) e `fallback_ai_model_id` (`SET NULL`). `POST /api/ai/accounts` con `provider: "claude_code_node"` vuole `nodeId` di un nodo
  `active` dell'utente (altrimenti 400 «nodo non disponibile»; già legato → 409 «il nodo ha già un account Claude Code»), niente chiave, indirizzo né rete
  privata (400); `nodeId`/`fallbackAiModelId` su altri provider → 400. Ripiego facoltativo (POST e PATCH, solo login): modello di un account **non nodo**
  dell'utente, altrimenti 400 «modello di ripiego non valido». La risposta espone `nodeId`, `nodeName`, `nodeTurnReady`, `fallbackAiModelId`. «Verifica»
  (e l'aggiornamento settimanale del catalogo) non fa chiamate di rete: riallinea i modelli e mette lo stato `ok` se il nodo esiste ed è attivo, `error`
  «nodo eliminato» / «nodo disattivato» altrimenti; un Mac in stop non mette l'account in errore (la prontezza è `nodeTurnReady`). `resolveModel` su un
  account nodo restituisce `kind: "node"`, `nodeId`, `fallbackAiModelId` e il nome del modello, senza chiavi; `modelChat` su `kind: "node"` è un errore di
  programmazione.
- **Dove non si sceglie**: i consumatori che girano solo nell'API rifiutano un modello di un account nodo con 400 «Claude Code (nodo) non è disponibile
  qui: scegli un modello cloud» (`NODE_MODEL_NOT_ALLOWED`, `chooseCloudModel` in `lib/ai/choice.ts`): ruoli `cloud` delle squadre (`validateRoles`,
  `TEAM_MESSAGES.nodeModelNotAllowed`), avvio delle analisi cloud, `PUT /api/account/centralino-model`; Alfred a voce accetta solo modelli Gemini (400 «modello
  non adatto ad Alfred»). `POST /api/ai/models/:id/probe` su un modello nodo → 400 «la prova non è disponibile per Claude Code: usa Verifica sull'account»
  (nessuna chiamata). Righe già salvate non si migrano: un'analisi accodata con un modello nodo fallisce col messaggio fisso, il riassunto del centralino
  salta i modelli nodo (`centralinoModelFor`), i riassunti delle memorie con un predefinito nodo usano il ripiego cloud del suo account se è usabile,
  altrimenti si saltano. In console quei selettori (editor dei ruoli, avvio dell'analisi, carta del centralino, preselezione di squadre nuove e analisi:
  `ModelPicker cloudOnly`, `useDefaultAiModelId({cloudOnly})`, `lib/node-models.ts`) non mostrano i modelli nodo e la tabella dei modelli di un account
  nodo non ha «Prova»; restano negli agenti, nei personaggi (Alfred scritto, Lucius), nelle chat del piano e di squadra e nel modello predefinito.
- **Modelli dell'account**: alias `fable`, `opus`, `sonnet`, `haiku` («<alias> (ultimo)») più le offerte `anthropic` non ritirate di `model_offers` (id del
  catalogo passato così com'è a `--model`), riallineati a ogni «Verifica» e aggiornamento del catalogo (spariti → `unavailable`, mai cancellati); prezzi nulli
  (il costo lo riferisce il nodo: `total_cost_usd`, conta in tutti i tetti come quello di ogni modello, `lib/budget.ts` non cambia), `supports_tools = true`;
  `available` dopo un turno riuscito, `unavailable` su `model_unavailable`.
- **Coda dei turni** (`node_turns`, `lib/node-turns/queue.ts`): `consumer` `character|plan_chat|team_chat|run`, `ref_id` (conversazione o run), `message_id`,
  stato `queued|running|done|failed|cancelled|expired`, `package` jsonb (svuotato alla chiusura), solo l'hash del token del turno, lease, `content` ≤ 20 000,
  `error_code` chiuso, token, costo, `session_id`. È la traccia tecnica: il risultato sta nel messaggio o nella run. **Protocollo** (`protocol.ts`, `routes/node.ts`,
  token d'ambito `node`): `POST /api/node/turns/claim` aggiorna `nodes.last_turn_poll_at`, prende il più vecchio `queued` del nodo (`SKIP LOCKED`, lease di
  2 minuti) o attende fino a 25 s un avviso in memoria e ritenta una volta, poi 204 (40/min per nodo, contatore separato); `POST …/:id/ping` `{leaseToken}`
  (6/min per turno) e `POST …/:id/report` (una volta sola; codice fuori elenco → `claude_failed`; numeri interi ≥ 0 altrimenti 400); lease non valida → 409
  «lease non valida o scaduta». **Pronto per i turni** = nodo `active` con un claim o un ping di un turno negli ultimi 60 s (anche il ping aggiorna
  `last_turn_poll_at`: un nodo con tutti i posti occupati non fa claim ma resta pronto; un nodo di versione precedente non lo è mai). Controllo ogni 5 s
  (`startNodeTurnSweeper`): `queued` da oltre 20 s → `expired` se il nodo non ha turni `running` con lease viva; su un nodo occupato il turno in coda
  attende un posto fino a 10 minuti (`TURN_BUSY_QUEUE_TIMEOUT_MS`) prima di `expired`; lease scaduta → `failed` `lease_lost`; `running` oltre
  `claimed_at + timeoutMs del pacchetto + 60 s` → `failed` `timeout` (un nodo che rinnova la lease senza mai riferire); pulizia oraria delle righe chiuse
  da oltre 30 giorni. All'avvio, prima di `listen`, `queued`/`running` → `failed` `restart`. Disattivare, eliminare o rigenerare il token del nodo chiude i suoi turni `failed` `node_disabled`
  nella stessa transazione.
- **Pacchetto**: `model`, `systemPrompt` (messaggio `system` più «Gli strumenti di Botcave si chiamano mcp__botcave__<nome>: usa solo quelli.»), `prompt` (gli
  altri messaggi con le etichette `[utente]`/`[assistente]`, su stdin), `mcpUrl` = `<PUBLIC_APP_URL>/mcp/turn`, `turnToken` `cat_…`, `maxTurns` = giri di oggi + 1
  (chat 7, run 9, Responsabile 13), `timeoutMs` 300 000 (Responsabile 600 000). Il limite di token non si impone a Claude Code: si registra.
- **`/mcp/turn`** (`lib/mcp/turn-server.ts`, montato prima di `/mcp`, nessuna modifica a nginx): Streamable HTTP stateless con `Server` di basso livello,
  solo `Bearer cat_…` di un turno `running` con lease valida e voce nel registro (altrimenti 401; `cat_` su `/mcp` o `/api` è sconosciuto, `cas_`/`cao_` qui 401).
  Token: 32 byte base64url, nel DB solo l'hash, in chiaro solo in memoria fino al claim. Registro in memoria (`registry.ts`): strumenti del turno e dispatcher,
  scritti da `delegateTurn` e tolti alla chiusura; `tools/call` → dispatcher, `isError` se il testo è JSON con `ok: false`; strumento sconosciuto → errore; 60
  chiamate/min e al massimo 4 × `maxTurns` per turno; corpo ≤ 2 MB. Log: id del turno, strumento, esito.
- **Consumatori**: le chat chiamano `runChatTurn` (`chat-turn.ts`) al posto di `runPlanTurn`: cloud → `runPlanTurn`, nodo → `delegateTurn` con gli stessi
  strumenti e `runTool` come dispatcher (schede, memoria e `passa_a` funzionano da soli). Le run (`run-executor.ts`): `delegateTurn` con i messaggi iniziali di
  sempre, gli strumenti dell'agente (`proponi` e `segnala_al_responsabile` compresi) e come dispatcher `dispatchAgentCall` (`lib/agent-dispatch.ts`, condivisa con
  `runAgentLoop`: L2 in coda, conferma delle scritture compresa); i passi `tool`/`queued` compaiono mentre Claude lavora, a fine turno un passo `model` con la
  durata e la nota «Claude Code sul nodo «<nome>»» (colonna nuova `run_steps.note`, testo informativo dei passi); `cancelRun` chiude il turno `cancelled` (il
  ping dopo riceve 409 e il nodo termina `claude`).
- **Ripiego** (`delegate.ts`): si ripiega sul `fallback_ai_model_id` dell'account nodo se il nodo non è pronto, disattivato o eliminato (deciso prima di
  accodare), se il turno scade `expired` o se il nodo riferisce `usage_limit`/`not_logged_in` **e** il turno non ha registrato chiamate agli strumenti
  (`calls` del registro = 0); mai su `timeout`, `claude_failed`, `stopped`, `lease_lost`, `model_unavailable` né dopo una chiamata (Claude può aver già agito).
  Prima si controllano usabilità (`resolveModel`) e tetti (`runBudgetBlock`, `characterBudgetBlock`, utente per piano e squadra); modello di ripiego non usabile
  o al tetto → il messaggio fisso del nodo. Chat: risposta con in fondo «_(Claude Code non disponibile: risposta del modello di ripiego)_» (limite noto: la spesa
  resta sul modello della conversazione); run: `runs.ai_model_id` diventa il ripiego e il passo dice «Claude Code non disponibile: eseguita con <nome>».
  Senza ripiego, messaggi fissi `NODE_TURN_MESSAGES` (`messages.ts`): nodo offline, nodo eliminato, limite d'uso, accesso mancante, modello non disponibile,
  tempo scaduto, nodo non raggiungibile, esecuzione interrotta, riavvio, errore generico; chat: messaggio d'errore dell'assistente, run `failed`.
- **`casello-nodo`** (`turns.ts`, `turn-runner.ts`, README): ciclo dei turni accanto a quello dei compiti, un claim in attesa per posto libero
  (`maxConcurrentTurns` 1..4, default 2); all'avvio toglie tutta `~/.casello-nodo/turns/` (resti di un arresto improvviso); per turno cartella vuota in
  `~/.casello-nodo/turns/` (cwd del turno) con `mcp.json` e `system-prompt.md` (600) e `claude -p --output-format json --model … --system-prompt-file …
  --setting-sources project --tools "" --strict-mcp-config --mcp-config … --allowedTools "mcp__botcave__*" --max-turns … --permission-mode dontAsk`
  (impostazioni personali di Claude Code del Mac escluse, istruzioni fuori dagli argomenti; provato con il `claude` vero e il login Team), prompt su
  stdin, gruppo di processi proprio, ping ogni 30 s, timeout con SIGTERM e SIGKILL dopo 10 s; codice d'errore scelto da frasi precise del testo (mai inoltrato);
  409/401/403 su ping o report = turno perso, nessun report. Log senza prompt, risposta né token. Dopo il deploy il nodo va aggiornato (`casello-nodo install`).
- Console: Account → Account AI «Aggiungi Claude Code (nodo)» (nodo tra i propri attivi, ripiego tra i modelli cloud), LED di prontezza e «Modifica» del
  ripiego; Account → Nodi: «pronto per i turni» e versione; i modelli dell'account nodo compaiono nelle tendine come gli altri; timeline delle run con la nota.
- Prova: `test/node-turn-flow.test.ts` (API in memoria e ciclo vero di `casello-nodo` con `fake-claude.mjs` che chiama `/mcp/turn` con il client MCP: scheda di
  Lucius, azione L2 di una run, nodo con un posto occupato e un secondo turno in coda); con `CASELLO_REAL_CLAUDE=1` anche un turno di Alfred scritto con il `claude` vero (`haiku`, `squadre_stato`).
- Migrazione: `docs/migrations/2026-11-esecutore-nodo.sql` (additiva e idempotente, niente `-post`): valore `claude_code_node` di `provider_protocol` (`ALTER
  TYPE … ADD VALUE IF NOT EXISTS`, fuori da una transazione esplicita; la riga del provider la scrive `ensureProviderRegistry` all'avvio), colonne
  `ai_accounts.node_id`/`fallback_ai_model_id` con indice unico parziale, `nodes.last_turn_poll_at`, enum `node_turn_consumer` e `node_turn_status`, tabella
  `node_turns` con indici, `run_steps.note`. Da applicare su Neon PRIMA del merge (SQL completo in chat) e da segnalare nella PR; riportata in
  `docs/schema-casello.sql`. Nessuna variabile nuova.

## Botcave Nodo (app per Mac)

- Spec: `docs/superpowers/specs/2026-11-10-botcave-nodo-senza-terminale-design.md`; piano `docs/superpowers/plans/2026-11-10-botcave-nodo-senza-terminale.md`. Dove il
  codice differisce dalla spec vale il codice, descritto qui. «Botcave Nodo.app» installa, collega, aggiorna, diagnostica e disinstalla il nodo locale (vedi "Nodi
  (esecuzione dei ruoli node)") senza terminale; la console (Account → Nodi) è l'unica interfaccia di gestione. La CLI (`casello-nodo install|uninstall|status|run`)
  resta per sviluppo, test e chi la preferisce: l'app è un'altra entrata dello stesso programma. Prima versione **senza firma Apple** (primo avvio con «Apri comunque»).
- **App** (`app-mode.ts`, `index.ts`): eseguibile unico (Node 24 «single executable application» con il bundle CommonJS di `casello-nodo`) in
  `Botcave Nodo.app/Contents/MacOS/botcave-nodo`, `CFBundleIdentifier` `cloud.fantamister.botcave-nodo`, `LSUIElement` (niente icona nel Dock). Senza argomenti (un `-psn_…` aggiunto dal Finder si ignora,
  `launchArgs`) e dentro un `.app` (`isAppExecPath`) parte la modalità app, con argomenti la CLI (`--version` stampa la versione, iniettata con `--define:__NODE_VERSION__` da `package.json`). Senza
  config → abbinamento; con una config valida della CLI ma senza `~/.casello-nodo/bin/casello-nodo` → la adotta (indirizzo, token e radice restano) e installa programma e
  LaunchAgent; collegato → menu nativo (`choose from list`): «Apri Botcave» (`/account`), «Installa Claude Code» (solo se `claude` manca), «Accedi a Claude», «Cambia
  cartella di lavoro» (config e `kickstart -k` del servizio), «Apri i log», «Ricollega», «Disinstalla». Dialoghi e notifiche con `osascript` (`dialogs.ts`: ogni riga un
  argomento `-e`, testi escapati, mai una shell; il testo d'errore di `osascript` non si mostra). L'installazione copia l'eseguibile in `~/.casello-nodo/bin/casello-nodo`
  (temporaneo e rename; prima del rename `xattr -d com.apple.quarantine` sulla copia, così Gatekeeper non blocca il servizio avviato da launchd, errori
  ignorati; la config col token si scrive **prima** della copia, così un errore non perde il token consegnato una volta sola) e carica il LaunchAgent di
  sempre (`cloud.fantamister.casello-nodo`) con `[programma, "run"]`; toglie la copia `.mjs` della CLI. Il servizio usa la copia: l'app in Applicazioni non cambia mai.
  Indirizzo fisso `https://casello.fantamister.cloud` (`DEFAULT_URL`); `BOTCAVE_NODO_URL` lo sostituisce solo in sviluppo (https, http solo verso localhost).
- **Abbinamento** («device flow», `lib/nodes/pairing.ts`, `routes/node-pairing.ts`, nodo `pairing.ts`; tabella `node_pairings`, stati `pending|approved|denied|consumed|expired`):
  `POST /api/node-pairing/start` (pubblica, 10/min per IP) `{deviceName ≤ 100, version}` → `{pairingId, userCode, pollSecret, expiresAt}`: codice di 8 caratteri
  dell'alfabeto `ABCDEFGHJKMNPQRSTVWXYZ23456789` mostrato `XXXX-XXXX` (accettato anche senza trattino e in minuscolo), segreto di 32 byte, nel DB solo gli hash SHA-256,
  10 minuti, IP abbreviato all'/24 o /48. Il nodo apre `<caselloUrl>/nodes/pair?code=…`, notifica il codice e interroga `POST /api/node-pairing/poll` `{pairingId,
  pollSecret}` ogni 3 s (30/min per richiesta; si ferma al 410, con una sicurezza locale calcolata come durata, scadenza meno l'ora del server dell'header `Date`
  di `start` (12 minuti se manca) più 2 minuti dall'inizio, mai con l'orologio del Mac): 202 `pending`; 200 `{token, nodeId, nodeName}` crea il token di nodo (`createNodeToken`) e consuma la richiesta nella stessa
  transazione (consegna una volta sola); altrimenti 410 «collegamento non più valido». Console (solo login, `sessionOnly`, 20/min per utente): `GET
  /api/account/node-pairings/:code` (404 «richiesta di collegamento non trovata o scaduta»), `POST …/approve` `{name, replaceNodeId?}` (nodo nuovo con le regole di
  `POST /api/account/nodes`; con `replaceNodeId` un nodo attivo dell'utente tiene nome e id e i suoi token si revocano come con «Rigenera token», compiti e turni in carico
  chiusi; nella stessa transazione si azzerano richieste e stato del Mac vecchio: `uninstall_requested_at`, `diagnostics_requested_at`, `update_failed_version`, `kind`,
  `claude_status`, `claude_checked_at`), `POST …/deny`; al più 5 decisioni fallite per codice, poi `expired`. L'approvazione proroga la richiesta di almeno 2 minuti (`COLLECT_GRACE_MS`) perché il nodo
  ritiri il token; il token NON nasce all'approvazione. Richieste più vecchie di 1 ora cancellate dal controllo orario dei nodi. Il nodo chiede poi la radice con
  `choose folder` (da `~/Botcave`, creata se manca; annullato = `~/Botcave`). Pagina `/nodes/pair` (`node-pair.tsx`): «Nuovo nodo» (default) o «Sostituisci <nome>»
  (preselezionato se il nome coincide), avviso «Conferma solo se hai appena aperto Botcave Nodo su questo Mac»; il codice si toglie dall'indirizzo e, senza login, resta in
  `sessionStorage` (`lib/pair-code.ts`): il `returnTo` del login è `/nodes/pair` senza query. Nodo collegato: «collegato il … da <IP abbreviato>» in Account → Nodi
  (`nodes.paired_at`, `paired_ip`; `Node.pairedAt`, `Node.pairedIp`) e per 24 ore l'avviso «Nuovo Mac collegato» nella Dashboard (`recentlyPairedNodes` di `/api/dashboard/stats`).
- **Ricollega e token revocato**: «Ricollega» rifà l'abbinamento e scrive solo il nuovo token nella config, poi riavvia il servizio. Con 401/403 sull'heartbeat un nodo
  `app` non esce (launchd lo riavvierebbe in ciclo): non prende lavoro, notifica una volta «Botcave Nodo non è più collegato: aprilo e scegli Ricollega» e riprova a ogni
  heartbeat. Un nodo disattivato non si riattiva: la console dice «per usare di nuovo questo Mac apri Botcave Nodo e scegli Ricollega (crea un nodo nuovo)». «Rigenera
  token» della console resta per i nodi della CLI.
- **Build e distribuzione** (`scripts/build-app.sh`, job `build-nodo` di `deploy.yml`, vedi "Deploy"): `pnpm run build:sea` (bundle CJS), blob SEA iniettato con `postject`
  negli eseguibili ufficiali di Node 24 `darwin-arm64` e `darwin-x64` (scaricati da nodejs.org e verificati con `SHASUMS256.txt`), `lipo` universale, firma ad-hoc, prova di
  `--version` in arm64 e x64 (Rosetta). Escono `Botcave-Nodo-<versione>.zip`, `casello-nodo-<versione>` e `nodo-manifest.json` `{version, minVersion, binary: {file, sha256,
  size}, app: {…}}`; `minVersion` da `artifacts/casello-nodo/min-version.txt` (oggi `0.2.0`: i nodi della CLI 0.2.0 continuano a prendere lavoro), la versione da
  `package.json` (oggi `0.3.0`). **Ogni modifica a `artifacts/casello-nodo/src` richiede di alzare `version` in
  `artifacts/casello-nodo/package.json`**: i file pubblicati hanno la versione nel nome e la cache immutable (la CI lo controlla sui branch diversi da `main`). L'API legge il manifest da `NODO_MANIFEST_PATH` (default `/app/nodo/nodo-manifest.json`; assente = nessun aggiornamento proposto e nessun
  nodo sotto la minima). `GET /api/account/nodes/download` (solo login) dà versione, dimensione e indirizzo dello zip; Account → Nodi → carta «Botcave Nodo per Mac» con
  «Scarica per Mac» e i passi del primo avvio (trascina in Applicazioni, apri, «Apri comunque» in Privacy e sicurezza, «Collega»).
- **Aggiornamento automatico** (`manifest.ts`, nodo `updater.ts` e `loop.ts`; solo nodi con heartbeat `kind: "app"`, cioè il programma in esecuzione è
  `~/.casello-nodo/bin/casello-nodo`): la risposta all'heartbeat porta `update {version, sha256, size, required}` se la versione è sotto quella del manifest e diversa da
  quella già fallita (`nodes.update_failed_version`); `required` sotto `minVersion`. Sotto la minima il server non consegna compiti né turni (`claim` 204), per ogni `kind`.
  Un aggiornamento non obbligatorio parte solo con il nodo libero (ricontrollato a ogni heartbeat); il nodo scarica `<caselloUrl>/downloads/nodo/casello-nodo-<versione>`
  (indirizzo dalla config, mai dalla risposta; nessun redirect né token, ≤ 300 MB, 10 minuti) in `casello-nodo.download`, verifica dimensione e sha256 **continuando a
  lavorare**, poi smette di prendere lavoro e aspetta quello in corso fino a 30 minuti (obbligatorio: poi lo interrompe come uno stop; altrimenti rinvia). Scrive
  `~/.casello-nodo/update.json` `{from, to, startedAt, starts: 0}`, tiene la versione precedente come `casello-nodo.prev` (collegamento fisico), rinomina il nuovo sopra il
  programma ed esce con 0 (launchd lo riavvia). Ogni errore lascia intatto il programma (e toglie l'`update.json` appena scritto, non una
  versione fallita già registrata); nuovo tentativo dopo un'ora. Ritorno indietro (`checkUpdateOnStart`, prima di
  `run`): con `update.json` aperto ogni avvio incrementa `starts`; al terzo entro 2 minuti ripristina `.prev`, registra `failedVersion` ed esce; il nodo la riferisce con
  `updateFailed` e la console mostra «L'aggiornamento alla versione <v> non è riuscito» (il server la toglie quando l'heartbeat riporta quella versione o una più
  nuova). Il primo heartbeat riuscito chiude `update.json` (`markUpdateHealthy`). Nodi della CLI
  (`kind: "cli"` o senza `kind`): nessun aggiornamento, la console dice «Installa Botcave Nodo per gli aggiornamenti automatici».
- **Claude Code** (`claude-check.ts`): verifica all'avvio e ogni 10 minuti (`claude` nel PATH del servizio, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; `claude
  --version` e `claude auth status --json`, 10 s ciascuno); l'heartbeat porta `claude {found, version, loggedIn, authMethod, subscriptionType, loginExpiresAt}` (niente email né
  organizzazione; il server tiene solo questi campi e scarta quelli di tipo sbagliato senza rifiutare l'heartbeat) in `nodes.claude_status` con `claude_checked_at`. Console: LED in Account →
  Nodi («installato · versione», accesso, piano, scadenza), avviso se il login manca (`loggedIn: false`; assente = non noto, nessun avviso) o scade entro 3 giorni anche sulla carta dell'account «Claude Code (nodo)» e nella
  Dashboard (`nodeClaudeWarnings`). «Installa Claude Code» (conferma, poi `/bin/bash -c "curl -fsSL https://claude.ai/install.sh | bash"` con URL costante, 10 minuti,
  notifiche) e «Accedi a Claude» (`claude auth login`, poi verifica ogni 5 s per al più 10 minuti).
- **Impostazioni, diagnosi, disinstallazione** (`lib/nodes/node-admin.ts`, nodo `node-admin.ts`; route solo login): `PUT /api/account/nodes/:id/settings`
  `{maxConcurrent 1..3, maxConcurrentTurns 1..4, taskTimeoutMinutes 5..240}` (ognuno null = config locale; altro → 400 «impostazioni del nodo non valide») in
  `nodes.settings`: arrivano con l'heartbeat e valgono senza riavvio (ridurre i posti non interrompe nulla); `permissionMode` resta locale. `POST
  /api/account/nodes/:id/diagnostics-request` (6/ora per nodo) → `diagnosticsRequested` nell'heartbeat → `POST /api/node/diagnostics` (token di nodo, ≤ 256 KB) con
  versioni, esito di Claude, config senza token, `state.json` e le ultime 500 righe di `casello-nodo.log` (il token si toglie comunque; righe vecchie tagliate per stare nel
  limite), in `node_diagnostics` (una per nodo, la nuova sostituisce la vecchia, cancellata dopo 7 giorni); `GET …/diagnostics` la scarica come testo (`attachment`,
  `nosniff`; 404 se manca). Disinstallazione dal menu (con conferma) o dalla console (`POST …/uninstall-request` → `uninstallRequested`): il nodo smette di prendere lavoro,
  chiude quello in corso come uno stop, chiama `POST /api/node/uninstalled` (il server disattiva il nodo come «Disattiva»; un errore non ferma la disinstallazione), toglie
  `~/.casello-nodo/bin` (anche `.prev`), config e plist e per ultimo fa il `bootout` (che termina il servizio stesso); log e spazi di lavoro restano; notifica «Botcave Nodo è
  stato rimosso. Puoi spostare l'app nel cestino.». La disinstallazione vince su un aggiornamento in sospeso.
- **Sicurezza**: route pubbliche di abbinamento con i loro limiti, codici monouso, solo hash nel DB, token creato solo al `poll` dopo un'approvazione con il login (mai
  token personali, `agent` o `embed`), avviso in Dashboard a ogni collegamento. Il codice non va nei log: `/nodes/pair` e `/api/account/node-pairings/` senza access log in
  nginx, percorso oscurato (`…/node-pairings/***`) nei log dell'API, sia delle richieste (`app.ts`) sia degli errori non gestiti
  (`middlewares/error-handler.ts`, che oscura allo stesso modo anche `/api/hooks/`), codice e segreto mai nei log del nodo. Aggiornamenti: indirizzo dalla config, sha256 e dimensione dalla
  risposta all'heartbeat (TLS e token del nodo), file temporaneo e rename. Senza firma Apple la fiducia sta nell'HTTPS di Botcave: va chiusa con firma e notarizzazione
  (Developer ID) prima degli utenti esterni. L'URL dell'installatore di Claude Code è nel codice; le richieste della console sono un elenco chiuso di azioni del nodo.
- **Differenze dalla spec**: proroga di 2 minuti all'approvazione; codice di abbinamento in `sessionStorage` attraverso il login e location nginx senza access log (non
  previste dalla spec); con 401/403 il nodo app non si ferma (resta in attesa e notifica); un aggiornamento non obbligatorio non si scarica finché il nodo è occupato e
  la pausa del lavoro avviene solo dopo download e verifica; l'immagine dell'API copia solo il manifest; `min-version.txt` = `0.2.0`.
- Prove: Vitest dell'API (abbinamento, heartbeat esteso, `claim` sotto la minima, diagnosi, disinstallazione), di `casello-nodo` (abbinamento, adozione, aggiornamento e
  ritorno indietro, Claude Code, impostazioni, disinstallazione, con `osascript` finto) e della console (`pair-code`); prova di flusso
  `artifacts/api-server/test/node-app-flow.test.ts` (API in memoria e codice vero del nodo, dialoghi, `launchctl`, `open` e Claude finti, home temporanea, binario servito
  da `/downloads/nodo/` dello stesso server: abbinamento → heartbeat `app` con Claude → aggiornamento e uscita 0 → avvio senza ritorno indietro → disinstallazione dalla
  console). A mano sul Mac dopo il deploy: scaricare lo zip, «Apri comunque», abbinare, un turno di Alfred scritto, un aggiornamento, disinstallare.
- Migrazione: `docs/migrations/2026-11-nodo-senza-terminale.sql` (additiva e idempotente, niente `-post`): enum `node_pairing_status`, tabelle `node_pairings` e
  `node_diagnostics`, colonne `nodes.kind`, `paired_at`, `paired_ip`, `claude_status`, `claude_checked_at`, `settings`, `diagnostics_requested_at`, `uninstall_requested_at`,
  `update_failed_version`. Da applicare su Neon PRIMA del merge (SQL completo in chat) e da segnalare nella PR; riportata in `docs/schema-casello.sql`. Nessuna variabile
  nuova obbligatoria: `NODO_MANIFEST_PATH` (API) è facoltativa, `BOTCAVE_NODO_URL` (nodo) solo per lo sviluppo.
- Fuori ambito: firma e notarizzazione (prima degli utenti esterni), icona nella barra dei menu, Windows e Linux, MDM, cambio della radice dalla console, Claude Code
  incluso nell'app.

## Esecutore locale

Le analisi dell'architetto possono essere eseguite da Claude Code sul Mac dell'utente invece che dal cloud
(`analyses.executor`). L'agente si collega al server MCP su `/mcp` (Streamable HTTP stateless, solo POST,
60 chiamate/min per utente; nginx ha `location /mcp`) con un token personale `cas_…` creato in console (Account → "Token personali",
casella "Agente locale (MCP)", ambito `mcp`; tabella `api_tokens`, salvato come hash) oppure, dall'app Claude, con il token OAuth
`cao_…` del connettore (vedi "Connettore OAuth (app Claude)"). `/mcp` richiede l'ambito `mcp` (un token `cas_…` senza riceve 401 «token non valido o scaduto»; il `cao_…` ha `mcp` e `api:write`). Gli esiti di fase stanno in
`analysis_phase_results`; la lease dura 15 minuti (rinnovo con consegna o `ping_analysis`). Migrazione:
`docs/migrations/2026-10-esecutore-locale.sql` (da applicare in produzione e segnalare nella PR). Procedura
dell'agente: skill `docs/skills/casello-architetto-locale/SKILL.md`. Il server `/mcp` espone anche `read_mcp_tools`
(strumenti del server MCP dell'app, per l'analisi locale) e gli strumenti del centralino (`squadre_stato`, `bollettino`,
`squadra_dettaglio`, `invia_al_capo`, `coda_da_confermare`, `approva`, `rifiuta`; logica in `lib/teams/centralino.ts`, solo
dati dell'utente del token; `invia_al_capo` condivide il limite 10/min con `POST …/messages` via `consumeTeamMessage`;
modello del centralino: `GET|PUT /api/account/centralino-model`, solo login).

## Deploy (non toccare senza motivo)

- Push su `main` → GitHub Actions builda `ghcr.io/twentivan/casello-api` e `casello-web` e chiama i
  webhook Coolify. Push su `feat/**` builda soltanto (collaudo), senza deploy.
- Il tag `:latest` (quello che deploya Coolify) lo scrive solo `main`; ogni build ha anche il tag
  `:<sha>`. I run su `main` sono in coda uno alla volta e il job di deploy chiama i webhook con
  `force=true` e attende la fine del deploy su Coolify: merge ravvicinati non lasciano un'immagine vecchia.
- Due container su Coolify: `casello-api` (porta 3000, solo rete interna) e `casello-web` (nginx: SPA +
  proxy di `/api/` verso `casello-api:3000`). Il frontend chiama `/api` con URL relativi: un solo dominio.
- Immagini `node:24-slim` (non alpine: il workspace esclude i binari musl).
- Variabili dell'API: `DATABASE_URL` (Neon, stringa diretta), `PORT`, `NODE_ENV`, `LOG_LEVEL`,
  `CASELLO_SECRET_KEY`
  (64 caratteri esadecimali, `openssl rand -hex 32`; cifra i segreti a riposo, obbligatoria con
  `NODE_ENV=production`); `PUBLIC_APP_URL`
  (origine della UI, `https://casello.fantamister.cloud`: usata dal login e dal CORS, che in produzione
  accetta solo quella e in dev qualsiasi `localhost`); per il login `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS` (separati da virgola); `OIDC_ISSUER` solo per i test.
  GitHub (tutte facoltative: se ne manca una GitHub è disattivato e nei log compaiono i nomi mancanti):
  `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_PRIVATE_KEY` (PEM, a capo veri o `\n`); `GITHUB_API_BASE`/`GITHUB_WEB_BASE` solo per i test.
- `EMBED_ALLOWED_ORIGINS` (origini `https://…` separate da virgola, oggi `https://hubup.fantamister.cloud`; vuota = incorporamento spento) va impostata su
  **entrambi** i container, `casello-api` e `casello-web` (vedi "Botcave incorporabile (app ospiti)"); aggiungere un'app = aggiornarla nei due e rifare il deploy.
- nginx inoltra all'API l'`X-Forwarded-Proto` ricevuto da Traefik: serve al cookie `secure`. Oltre a `/api/` e `/mcp` inoltra
  `^~ /.well-known/oauth-` e `^~ /oauth/` (connettore OAuth, stessi header; `^~` impedisce che la fallback della SPA li catturi).
- nginx ha anche `^~ /api/hooks/` (webhook degli inneschi, vedi "Inneschi"): `access_log off`, `error_log /dev/stderr crit`, `client_max_body_size 256k`, perché il segreto sta
  nel percorso; non togliere le due direttive (la CI le controlla).
- Botcave Nodo (vedi "Botcave Nodo (app per Mac)"): il job `build-nodo` (`macos-latest`, dopo `test` e prima di `build`, anche su `feat/**`) controlla che la versione del nodo
  sia alzata se `artifacts/casello-nodo/src` differisce da `main` (solo sui push dei branch diversi da `main`), esegue i test di `casello-nodo`, installa Rosetta se manca
  (per la prova x64) e `scripts/build-app.sh` e passa `docker/nodo-downloads/` (zip, binario, manifest) ai job delle immagini come artefatto `nodo-downloads`: `casello-web` serve la cartella da
  `/downloads/nodo/`, `casello-api` copia solo `nodo-manifest.json` in `/app/nodo/` (in locale la cartella ha solo `.gitkeep`, i file costruiti sono in `.gitignore`).
  nginx: `^~ /downloads/nodo/` (cache di 1 anno, il manifest 1 ora; `Cache-Control` senza `always`, così un 404 non resta in cache), `= /nodes/pair` e `^~ /api/account/node-pairings/` con `access_log off` (il codice di abbinamento sta
  nella query o nel percorso; la seconda anche con `error_log /dev/stderr crit`, controllata dalla CI). API e nodo pubblicati vanno sempre insieme.
- Healthcheck di `casello-api`: `GET /api/healthz` sulla porta 3000. È nel `HEALTHCHECK` di
  `docker/api.Dockerfile` (con `node`, l'immagine slim non ha curl/wget); su Coolify impostarlo anche
  in Health Check (path `/api/healthz`, porta 3000), altrimenti Coolify non lo usa per il deploy.
- `POST /api/agents/:id/runs` ha un rate limit in memoria (`runTriggerRateLimit`, `middlewares/rate-limit.ts`): 60/min per token con
  qualunque token personale `cas_…`, 10 run/minuto per IP con sessione o pannello incorporato:
  l'IP reale arriva da `trust proxy` = 2 (Traefik di Coolify + nginx di `casello-web`).
- Schema DB: le modifiche arrivano in produzione SOLO con gli script SQL in `docs/migrations/`, applicati
  al DB Neon con `psql -v ON_ERROR_STOP=1 -f docs/migrations/<file>.sql` (prima del deploy dell'API
  che li usa: cioè PRIMA del merge, perché il merge deploya da solo). MAI `drizzle-kit push` in produzione: cancellerebbe dati (es. la vecchia tabella `tools`
  convertita dalla migrazione). Ogni modifica a `lib/db/src/schema/` va riportata in
  `docs/schema-casello.sql` (usato anche dai test) e in uno script di `docs/migrations/`, e va segnalata nella PR.
  Se uno script elimina tabelle o colonne che la versione in produzione usa ancora, si divide in due: la parte
  additiva prima del merge, quella distruttiva (`…-post.sql`) dopo il deploy.

## Flusso di lavoro

1. Ogni lavoro parte da una GitHub Issue; branch `feat/<slug-issue>`.
2. `pnpm run typecheck` verde prima del commit; commit piccoli, messaggi in italiano, tipo `feat(casello): ...`.
3. PR verso `main` con: cosa cambia, come si è provato, eventuali modifiche allo schema DB o alle variabili.
4. Il merge su `main` deploya in produzione da solo: niente merge di lavoro a metà.

## Gotchas

- Dopo ogni modifica a `openapi.yaml` rieseguire il codegen e committare anche i file generati.
- Non aggiungere `artifacts/casello` ai `references` del `tsconfig.json` di root (leaf package).
- `pnpm-workspace.yaml` ha `minimumReleaseAge`: una versione npm uscita da meno di un giorno non si installa.
- `vite.config.ts` del frontend pretende `PORT` e `BASE_PATH` anche solo per buildare.
- La console ha Vitest (`pnpm --filter @workspace/casello run test`); `pnpm run build` della console costruisce due entrate (`vite.config.ts` e `vite.loader.config.ts`, il caricatore `botcave.js`).
- `docker/nginx.conf` non esiste più: è `docker/nginx.conf.template` (envsubst dell'entrypoint di nginx; `$uri` e simili restano intatti). Una CSP in una `location`
  con `add_header` propri non eredita quelle esterne: si ripete dove serve.
- Ogni modifica a `artifacts/casello-nodo/src` richiede di alzare `version` in `artifacts/casello-nodo/package.json`: i file pubblicati hanno la versione nel nome e la
  cache immutable. Il job `build-nodo` fallisce sui push dei branch diversi da `main` se `src` differisce da `main` e la versione è la stessa.
- I residui di Replit sono stati rimossi; restano solo i plugin `@replit/*` di `artifacts/mockup-sandbox`.
