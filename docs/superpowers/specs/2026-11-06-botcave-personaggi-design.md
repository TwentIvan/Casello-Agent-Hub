# Botcave · Alfred e Lucius richiamabili nelle aree

Data: 2026-11-06 · Stato: proposta, da approvare · Nome in codice: Casello

## 1. Scopo

Alfred e Lucius sono due chatbot, ognuno con le proprie competenze, richiamabili nelle diverse aree della console Botcave.

- **Alfred**, il maggiordomo: squadre al lavoro, coda «Da confermare», bollettino, run. Si parla con lui anche a voce (`/alfred`,
  Gemini Live, invariato), e da ora anche per iscritto.
- **Lucius**, l'ingegnere del laboratorio: analisi, piano, definizione di agenti, skill, modelli di squadra e squadre.

Successo: da ogni pagina della mappa (§3) l'utente chiama il personaggio giusto con un pulsante, il personaggio sa già su cosa
si sta lavorando, le proposte si applicano solo con un clic dell'utente e la spesa resta sotto tetti espliciti, anche per
personaggio.

Decisioni prese con Ivan:

| Tema | Scelta |
|---|---|
| Alfred scritto | sì: chat testuale con un modello normale; la voce resta su `/alfred` |
| Dove si chiamano | un pulsante per area (nessun pannello globale) |
| Conversazioni | misto: Lucius per oggetto (come oggi), Alfred un filo unico che sa da quale pagina scrivi |
| Decisioni di Alfred in chat | sì, con una scheda: decide il clic su Approva/Rifiuta |
| Lucius nelle aree nuove | legge, consiglia e propone schede (agenti, skill, modelli di squadra) |
| Costi | modello per personaggio in Account e tetto mensile facoltativo per personaggio |
| Collegamento tra i due | passaggio di consegne: scheda «Chiedo a Lucius / Chiedo ad Alfred» con la domanda già scritta |
| Architettura | motore unico per le conversazioni nuove; chat del piano e chat di squadra restano sulle loro tabelle (adattatori) |

Contesto: con il ramo `feat/botcave-barra-logo` la barra in alto non mostra più i segni dei personaggi; il microfono apre Alfred
a voce e il menu è un solo elenco. Questa spec non cambia la barra.

## 2. Stato di partenza

- Chat del piano (`lib/plan-chat/`, pagina `/apps/:id/plan`): conversazioni per app, schede `add|update|discard` che diventano
  `analysis_items` con `origin = chat` e `conversation_id` → `plan_conversations`.
- Chat di squadra (`lib/team-chat/`, `components/teams/lucius-panel.tsx`): conversazioni per squadra, schede `role_identity` e
  `role_instructions`, accettazione con impronta (`target_hash`) e `saveInstance` con `guard`.
- Ciclo comune `runPlanTurn` (`lib/plan-chat/turn.ts`), memorie e storico dei personaggi (`lib/memory/`), riassunti in
  `summaries.ts`.
- Alfred: solo voce (`lib/alfred/`), strumenti del centralino (`lib/teams/centralino.ts`) con doppio passo per le decisioni.

## 3. Interfaccia e mappa delle aree

### 3.1 Pulsante e pannello

- Nelle pagine della mappa, in alto a destra nel contenuto, un pulsante con il segno del personaggio (`marks.tsx`): «Chiedi a
  Lucius» o «Chiedi ad Alfred». La scheda squadra ha entrambi.
- Il clic apre un pannello laterale a destra (`Sheet` di shadcn/ui): a schermo intero sul telefono, ~440 px su desktop; la
  pagina non si sposta e non c'è scorrimento orizzontale a 1280 px.
- Contenuto del pannello: segno e nome del personaggio, argomento («Agente · Supporto clienti», «Area Skill»…), elenco delle
  conversazioni dell'argomento con «Nuova» (per Alfred «Ricomincia»), chat con le schede, campo di scrittura (≤ 8 000
  caratteri), costo della conversazione, modello con `ModelPicker`.
- Un solo componente, `CharacterChat` (`components/characters/`), con un adattatore per backend:
  - `characterAdapter`: conversazioni nuove (§4);
  - `teamChatAdapter`: chat di squadra di oggi (il `LuciusPanel` attuale diventa `CharacterChat` + questo adattatore);
  - `planChatAdapter`: chat del piano di oggi.
- La pagina `/apps/:id/plan` resta a pagina intera, con `CharacterChat` al posto della chat attuale.
- Il microfono nella barra resta l'accesso alla voce di Alfred (`/alfred`).
- Colori solo dai token, stati con i LED (`Led`: `work` durante un turno), nessun riferimento a Batman, testi con «Botcave».

### 3.2 Mappa

| Pagina | Personaggio | Argomento |
|---|---|---|
| Dashboard | Alfred | filo unico, pagina `dashboard` |
| Elenco Squadre | Alfred | filo unico, pagina `teams` |
| Scheda squadra | Alfred | filo unico, pagina `team` con l'id |
| Scheda squadra | Lucius | chat di squadra di oggi (`teamChatAdapter`) |
| Da confermare | Alfred | filo unico, pagina `pending_actions` |
| Run, dettaglio run | Alfred | filo unico, pagina `runs` o `run` con l'id |
| Scheda app | Lucius | chat del piano dell'app (`planChatAdapter`) |
| Pagina dell'analisi | Lucius | chat del piano dell'app dell'analisi (`planChatAdapter`) |
| Piano dell'app | Lucius | chat del piano (pagina intera) |
| Elenco Agenti | Lucius | `area_agents` |
| Scheda agente | Lucius | `agent` |
| Elenco Skill | Lucius | `area_skills` |
| Scheda skill | Lucius | `skill` |
| Elenco Modelli di squadra | Lucius | `area_team_templates` |
| Scheda modello di squadra | Lucius | `team_template` |
| Modelli AI, Account | nessuno | — |

## 4. Motore delle conversazioni nuove

### 4.1 Dati

Migrazione `docs/migrations/2026-11-personaggi.sql` (additiva e idempotente, niente `-post`), da applicare su Neon PRIMA del
merge, da segnalare nella PR e da riportare in `docs/schema-casello.sql`; schema Drizzle in `lib/db/src/schema/characters.ts`.

- `character_conversations`: `id`, `user_id` → users, `character` (enum `character` già esistente: `alfred`|`lucius`), `subject_type` (testo
  con CHECK sui valori di §4.2), `subject_id` (testo, null per i fili generali), `subject_title` (titolo dell'oggetto al momento
  della creazione, mostrato se l'oggetto sparisce), `ai_model_id` → ai_models `SET NULL`, `title` (≤ 80, dal primo messaggio),
  `tokens_used`, `cost_usd` (null = parziale), `turn_status` (`planTurnStatusEnum`), `archived_at`, `summarized_at`,
  `created_at`, `updated_at`. Indici: (`user_id`, `character`, `subject_type`, `subject_id`); indice unico parziale su
  (`user_id`) dove `subject_type = 'alfred_thread' AND archived_at IS NULL`.
- `character_messages`: `conversation_id` (cascade), `role`, `content`, `error`, `tokens`, `page_context` jsonb (solo messaggi
  dell'utente: `{page, id?}`), `created_at`.
- `character_proposals`: `conversation_id` e `message_id` (cascade), `kind` (testo con CHECK sui tipi di §5), `payload` jsonb,
  `rationale` (≤ 1 000), `target_hash`, `status` (`planProposalStatusEnum`: `pending|accepted|rejected|stale`), `decided_at`,
  `created_at`.
- `users`: `alfred_chat_ai_model_id`, `lucius_ai_model_id` (→ ai_models `SET NULL`), `alfred_monthly_budget_usd`,
  `lucius_monthly_budget_usd` (numeric, null = nessun tetto).
- Enum `character_history_kind`: aggiunto il valore `character_chat` (`ALTER TYPE … ADD VALUE IF NOT EXISTS`, fuori da una
  transazione esplicita).

### 4.2 Argomenti e registro

Registro in `artifacts/api-server/src/lib/characters/subjects/`, un file per argomento, con un'interfaccia comune:

```ts
interface SubjectHandler {
  character: "alfred" | "lucius";
  type: SubjectType;
  // Esiste ed è accessibile all'utente? Titolo da mostrare. null → 404 o «argomento eliminato»
  resolve(userId: number, subjectId: string | null): Promise<{ title: string } | null>;
  // Messaggi `user` di dati per il contesto (mai segreti né indirizzi delle app)
  context(userId: number, subjectId: string | null, pageContext: PageContext | null): Promise<string[]>;
  tools: ChatCompletionFunctionTool[];
  runTool(call: ChatToolCall, ctx: TurnContext): Promise<string>;
  proposalKinds: ProposalKind[];
}
```

| `subject_type` | Personaggio | `subject_id` | Contesto |
|---|---|---|---|
| `alfred_thread` | Alfred | null | squadre attive (una riga ciascuna), voci in coda (conteggio), bollettino non letto (conteggio), pagina del messaggio con l'oggetto (squadra, run) |
| `agent` | Lucius | id agente | agente (prompt, ruolo, stato, modello), tool collegati (nome, livello, stato), catalogo dei tool dell'app (nomi e livelli) |
| `skill` | Lucius | codice | skill (tipo, versione corrente, contenuto, `tool_hints`, deprecata), numero di versioni |
| `team_template` | Lucius | id modello | ruoli del manifesto con skill e strumenti (`describeRoles`) |
| `area_agents` | Lucius | null | elenco degli agenti per app (nome, ruolo, stato) |
| `area_skills` | Lucius | null | elenco delle skill (codice, tipo, versione, deprecata) |
| `area_team_templates` | Lucius | null | elenco dei modelli (nome, numero di ruoli, versione) |

Per l'app e l'analisi Lucius usa la chat del piano esistente (§3.2), perché le voci del piano nate in chat dipendono da
`plan_conversations`.

Oggetto eliminato: le conversazioni restano leggibili con `subject_title` e l'indicazione «eliminato»; nuovi messaggi → 409
«argomento eliminato».

### 4.3 Turno

- `lib/characters/run-turn.ts`: `startCharacterTurn` / `executeCharacterTurn` ricalcano `startTeamChatTurn`: un turno alla volta
  per conversazione (UPDATE condizionato `idle` → `running`, altrimenti `TurnBusyError`), messaggio assistente vuoto,
  esecuzione in background, polling dalla console, all'avvio i turni rimasti `running` chiusi con `INTERRUPTED_TURN_MESSAGE`.
- Ciclo: `runPlanTurn` con `PLAN_TURN_LIMITS` (6 giri, 40 000 token, 120 s) e gli strumenti dell'argomento + `MEMORY_TOOLS`
  del personaggio + `passa_a`.
- Istruzioni di sistema per personaggio (`lib/characters/instructions.ts`): ruolo e tono (italiano, numeri precisi, niente
  punti esclamativi), cosa spetta all'altro personaggio, regola per le schede. Dati, memoria e pagina arrivano come messaggi
  `user` etichettati come dati, mai nel prompt di sistema.
- Contesto ~30 000 token: la cronologia si riduce come nella chat di squadra.
- Limite di 10 messaggi/min per utente e personaggio (`consumeCharacterMessage`, 429), separato dai contatori delle chat del
  piano e di squadra.
- Filo di Alfred: `GET /api/characters/alfred/thread` restituisce (o crea) la conversazione aperta; «Ricomincia» la archivia
  (`archived_at`) e ne apre una nuova; quella archiviata va nello storico con il riassunto.

### 4.4 Strumenti

**Alfred scritto** (sopra `lib/teams/centralino.ts`, solo dati dell'utente):
`squadre_stato`, `squadra_dettaglio`, `bollettino` (segna letti, come a voce), `coda_da_confermare`, `scrivi_al_capo`
(limite condiviso `consumeTeamMessage`, 10/min), `leggi_run` (stato, esito, errore, durata, costo di una run dell'utente;
argomenti oscurati, niente passi completi), `proponi_decisione` (§5.2), `passa_a`, strumenti di memoria (`alfred`).
Niente `prepara_decisione` / `conferma_decisione`: in chat decide il clic.

**Lucius**, per argomento:
- `agent`: `leggi_agente`, `leggi_strumenti_app` (catalogo dell'app: nome, tipo, livello, stato, schema dei parametri con i
  `x-sensitive` oscurati da `maskSchema`), `leggi_skill`, `proponi_prompt_agente`, `proponi_strumenti_agente`.
- `skill`: `leggi_skill`, `leggi_versione_skill`, `proponi_contenuto_skill`.
- `team_template`: `leggi_modello`, `leggi_skill`, `leggi_strumenti_app`, `proponi_ruoli_modello`.
- `area_*`: elenchi con ricerca dell'area e lo strumento di creazione dell'area (`proponi_nuovo_agente`,
  `proponi_nuova_skill`, `proponi_nuovo_modello`).
- Tutti: `passa_a`, strumenti di memoria (`lucius`).

Risultati degli strumenti: `ok: false` con messaggio fisso, mai eccezioni; mai segreti né indirizzi delle app.

## 5. Schede

### 5.1 Schede di Lucius

| `kind` | Argomento | Payload | Applicazione |
|---|---|---|---|
| `agent_prompt` | `agent` | `{systemPrompt}` | come `PATCH /api/agents/:id` |
| `agent_tools` | `agent` (solo ruolo `area`) | `{toolIds}` | regole di `PUT /api/agents/:id/tools` |
| `skill_content` | `skill` | `{content, toolHints?}` | `updateSkill`: nuova versione |
| `template_roles` | `team_template` | `{roles}` | `saveTemplate`: nuova versione, `validateRoles` |
| `agent_create` | `area_agents` | `{appId, name, systemPrompt, toolIds?}` | come `POST /api/agents`, stato `draft`, modello con `resolveAgentModel` |
| `skill_create` | `area_skills` | `{code, name, description, kind, content}` | `createSkill` |
| `template_create` | `area_team_templates` | `{name, description, roles}` | `createTemplate` |

- Ogni scheda di modifica porta `target_hash`, l'impronta SHA-256 dello stato su cui è nata. Le schede di creazione non la
  portano: un nome o un codice già usato dà l'errore di regola (409).
- `POST /api/character-proposals/:id/decision` `{action: accept|reject}` (come la chat di squadra):
  - accettare ricontrolla l'impronta dentro la transazione, con la riga dell'oggetto bloccata (`FOR UPDATE`), applica e marca
    la scheda `accepted` nella stessa transazione;
  - impronta diversa o oggetto sparito → scheda `stale` e 409 «l'oggetto è cambiato: chiedi a Lucius una proposta aggiornata»;
  - errori di regola (validazione, nome usato, strumento non usabile) passano col loro stato e messaggio, la scheda resta `pending`;
  - scheda già decisa → 409; rifiutare la marca `rejected`, senza effetti.
- Validazioni lette dal pool fuori dalla transazione di scrittura, come nel resto del codice.
- Al massimo 10 schede per turno, motivazione ≤ 1 000 caratteri.
- Console: se la pagina sotto il pannello ha modifiche non salvate (editor del prompt, della skill, dei ruoli), prima di
  accettare compare l'avviso che andrebbero perse (`hasUnsavedChanges`, come nella scheda squadra). Dopo l'accettazione si
  invalidano le query dell'oggetto.

### 5.2 Scheda di Alfred `decision`

- `proponi_decisione {numero, decisione: approva|rifiuta, nota?}` (`nota` ≤ 500, solo con rifiuta). La scheda salva anche tipo,
  squadra e sintesi della voce letti in quel momento; `target_hash` = impronta di stato e sintesi della voce.
- Clic su «Approva» o «Rifiuta» → `approveAction` / `rejectAction` con il limite di 20/min (`consumeActionDecision`).
- Voce non più `pending` o sintesi cambiata → `stale`, 409 «la voce è cambiata: ricarica la coda».
- Voce che richiede il token utente (`needsUserToken`): la scheda non offre «Approva» e rimanda alla pagina Da confermare.
- Con un token personale serve `api:write`.

### 5.3 Passaggio di consegne `handoff`

- Strumento `passa_a {argomento, oggetto?, domanda}` (il destinatario è sempre l'altro personaggio): l'argomento è uno di quelli
  dell'altro personaggio (per Lucius anche `plan` con l'id dell'app e `team` per la chat di squadra; per Alfred il filo unico), la domanda
  ≤ 2 000 caratteri.
- Produce una scheda `handoff` («Chiedo a Lucius» / «Chiedo ad Alfred») senza effetti sul server. Il clic apre il pannello
  dell'altro personaggio sull'argomento, con la domanda già scritta nel campo e non inviata. Nessuna chiamata tra modelli e
  nessun costo in più.
- Le istruzioni di ciascuno dicono in una riga cosa spetta all'altro e quando usare `passa_a`.

## 6. Modelli e costi

- Modello per personaggio: `GET|PUT /api/account/characters` (solo login, `sessionOnly`)
  `{alfredChatAiModelId, luciusAiModelId, alfredMonthlyBudgetUsd, luciusMonthlyBudgetUsd}`; un modello che non è dei propri
  account → 400. Il modello di Alfred a voce resta `users.alfred_ai_model_id` (`/api/account/alfred`).
- Una conversazione nuova parte dal modello del personaggio, poi dal modello predefinito dell'utente se è ancora di un suo
  account; il modello resta modificabile nella conversazione. Senza modello: il turno si chiude con il messaggio d'errore
  dell'assistente «Scegli un modello per la conversazione».
- Le chat del piano e di squadra, quando si apre una conversazione nuova, propongono il modello di Lucius al posto del
  predefinito.
- Spesa per personaggio (`lib/budget.ts`, mese di calendario in ora italiana):
  - Alfred: `alfred_sessions`, `character_conversations` con `character = alfred`, `character_history` di Alfred;
  - Lucius: `plan_conversations`, `team_chat_conversations`, `character_conversations` con `character = lucius`,
    `character_history` di Lucius. Le analisi dell'architetto restano fuori: hanno i loro tetti.
- Le conversazioni nuove (costo cumulativo, nel mese dell'ultimo aggiornamento) contano anche nella spesa di utente, modello e
  account, come le chat di squadra.
- Ordine dei controlli prima di ogni turno (e prima di ogni sessione a voce di Alfred): personaggio, modello, account AI,
  utente. Tetto raggiunto: nuove sessioni e messaggi rispondono 409 con il motivo («tetto di spesa di Alfred raggiunto», «tetto
  di spesa di Lucius raggiunto»); i riassunti dello storico si saltano (`summarized_at` scritto comunque).
- Console: in Account la carta «Alfred» diventa «Personaggi», con Alfred (voce, modello scritto, tetto) e Lucius (modello,
  tetto); avviso dall'80% come gli altri tetti; costo cumulato visibile in ogni conversazione.

## 7. Memoria e storico

- Ogni turno riceve `memoryContextBlock` del personaggio. Alfred a voce e scritto condividono appunti e storico, non il filo:
  la voce non legge la chat scritta.
- Lo sweeper delle memorie (`startMemorySweeper`) riassume anche le `character_conversations` ferme da 30 minuti con turno
  `idle` e quelle archiviate, con il tipo `character_chat` e le regole di `summaries.ts` (modello predefinito, 30 s, 1 000 token,
  trascrizione ≤ 20 000).

## 8. Route

Tutte sotto `/api`, nel contratto `openapi.yaml` con codegen Orval; dati dell'utente (altrui → 404); con un token personale
gli ambiti per metodo.

- `GET /api/characters/alfred/thread`, `POST /api/characters/alfred/thread/restart`
- `GET|POST /api/character-conversations` (filtri `character`, `subjectType`, `subjectId`; il POST verifica l'argomento)
- `GET|PATCH|DELETE /api/character-conversations/:id` (`PATCH`: modello e titolo)
- `POST /api/character-conversations/:id/messages` (`{content, pageContext?}`, 202)
- `POST /api/character-proposals/:id/decision`
- `GET|PUT /api/account/characters`

## 9. Errori

Messaggi fissi in italiano (`CHARACTER_MESSAGES`), mai il testo del DB o del provider:
argomento non trovato (404), «argomento eliminato» (409), turno in corso (409), messaggio vuoto o troppo lungo (400), troppi
messaggi (429), tetto raggiunto (409 col motivo), scheda già decisa o non più attuale (409), errori di regola con il messaggio
della regola.

## 10. Prove

- API (Vitest + PGlite, schema da `docs/schema-casello.sql`):
  - registro: accesso agli argomenti, contesto senza segreti né indirizzi delle app, strumenti per argomento;
  - turno: un turno alla volta, chiusura al riavvio, limite 10/min per personaggio;
  - schede di Lucius: applicazione per ogni tipo, `stale` per impronta cambiata, errori di regola con scheda `pending`,
    accettazioni concorrenti (una sola vince);
  - scheda `decision`: approvazione, rifiuto con nota, voce già decisa, token utente richiesto, limite 20/min, ambito `api:write`;
  - `handoff`: nessun effetto sul server;
  - tetti per personaggio: somma delle fonti, ordine dei controlli, messaggi;
  - filo di Alfred: uno aperto per utente, «Ricomincia», riassunto dell'archiviato.
- Console: typecheck; prova manuale di ogni pagina della mappa a 1280 px e sul telefono, nei due temi.

## 11. Fuori ambito

- Spostare le chat del piano e di squadra sulle tabelle nuove.
- Lucius in Modelli AI e Account.
- La voce dentro il pannello; Alfred a voce che legge il filo scritto.
- Schede per le azioni L2 dei tool delle app.
- Organizzazioni e policy dei dati (sottoprogetto 2).

## 12. Consegna

- Ramo `feat/botcave-personaggi`, dopo il merge di `feat/botcave-barra-logo`.
- PR con la migrazione da applicare PRIMA del merge (SQL completo in chat) e l'aggiornamento di `CLAUDE.md` (nuova sezione
  «Alfred e Lucius nelle aree»).

## 13. Differenze dal codice (parte API)

- Corpo della decisione sulle schede: `{action: accept|reject}`, come `/team-chat-proposals/:id/decision`.
- `POST …/messages` controlla il tetto del personaggio già nella route (409 col motivo), come le chat del piano e di squadra;
  il turno lo ricontrolla e, se nel frattempo è raggiunto, chiude con un messaggio d'errore dell'assistente.
- Un filo di Alfred archiviato è in sola lettura (409 «conversazione archiviata»); il filo aperto non si elimina (409).
- Il contesto del filo di Alfred non chiama modelli: elenco semplice delle squadre attive dell'utente (al massimo 30 righe).
- `leggi_run`: una run appartiene a chi possiede l'account AI del suo modello; run con modello eliminato = «run non trovata».
- `PlanConversationCreate.aiModelId` è facoltativo: senza modello si usa il modello di Lucius.
- Sessione vocale di Alfred: il tetto di Alfred si controlla dopo «senza modello» e «modello non usabile», prima degli altri tetti.
- Scheda `decision`: la scheda si prenota (`pending` → `accepted`) prima di decidere la voce; se il processo cade in mezzo, la voce
  resta in coda e si decide dalla pagina Da confermare.
