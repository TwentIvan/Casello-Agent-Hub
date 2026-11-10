# Avanzamento visibile dei turni — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mentre un turno di chat (piano, personaggi, squadra) è in corso, la console mostra i passi che il personaggio sta facendo.

**Architecture:** registro in memoria `lib/turn-progress/` alimentato da `runChatTurn`, che avvolge `runTool` (punto unico per cloud, nodo e
ripiego); le tre GET delle conversazioni espongono `progress`; `CharacterChat` lo rende come elenco con LED.

**Tech Stack:** Express 5, Vitest, OpenAPI + Orval, React + Tailwind (token Botcave).

**Spec:** `docs/superpowers/specs/2026-11-10-botcave-avanzamento-turni-design.md`

## Global Constraints

- Nessuna migrazione, nessuna variabile nuova.
- Testi in italiano, frasi fisse della tabella §5 della spec; campi degli argomenti ripuliti e tagliati a 80 caratteri più «…».
- Mai nei testi: contenuto del codice o dei risultati, testi delle schede, appunti, messaggi, valori sensibili, indirizzi.
- Finestra di 8 passi (`PROGRESS_MAX_STEPS`), conteggio fino a 200 (`PROGRESS_MAX_COUNTED`).
- Console: niente colori a mano (solo token), stati con `Led`, numeri in `font-mono`, nessuno scorrimento orizzontale.
- `pnpm run typecheck` verde prima di ogni commit; commit in italiano `feat(casello): …` con la riga Co-Authored-By.

## Review Focus

- Eccezione di `runTool` (es. errore DB nello strumento): il passo deve diventare `done` e il registro svuotarsi a fine turno → test in Task 2.
- Turno che fallisce prima di qualsiasi strumento (modello senza credito): registro vuoto dopo → test in Task 2.
- Argomenti con a capo/caratteri di controllo o lunghi migliaia di caratteri (regex del modello): una riga ≤ 81 caratteri → test in Task 1.
- Argomenti di tipo sbagliato (`percorso: 42`, `daRiga: "3"`): frase senza il campo, niente eccezione → test in Task 1.
- Turno ripartito sulla stessa conversazione con una voce rimasta: la voce nuova sostituisce la vecchia → test in Task 1.

---

### Task 1: registro e testi dei passi

**Files:**
- Create: `artifacts/api-server/src/lib/turn-progress/describe.ts`, `describe.test.ts`, `progress.ts`, `progress.test.ts`

**Interfaces:**
- Produces:
  - `describeStep(name: string, rawArgs: string): string`
  - `type TurnConsumer = "plan_chat" | "team_chat" | "character"`
  - `beginTurnProgress(c: TurnConsumer, refId: number): void`
  - `startStep(c, refId, text: string): number | null` (id del passo, null se la voce non c'è)
  - `finishStep(c, refId, stepId: number | null): void`
  - `endTurnProgress(c, refId): void`
  - `readTurnProgress(c, refId): TurnProgressView | null` con `TurnProgressView = { startedAt: string /* ISO */; steps: { text: string; status: "running" | "done" }[]; omitted: number }`
  - `PROGRESS_MAX_STEPS = 8`, `PROGRESS_MAX_COUNTED = 200`

- [ ] **Step 1: test di `describeStep`** (`describe.test.ts`), uno per riga della tabella §5 della spec, più:
  - `describeStep("leggi_file", '{"percorso":"server/routes.ts","daRiga":10,"aRiga":40}')` → `"Legge server/routes.ts, righe 10–40"`
  - `describeStep("leggi_file", '{"percorso":"a.ts","daRiga":"3"}')` → `"Legge a.ts"`
  - `describeStep("elenca_cartella", '{"percorso":""}')` → `"Guarda la radice del codice"`
  - `describeStep("cerca_nel_codice", '{"testo":"registerRoutes","glob":"src/**"}')` → `'Cerca "registerRoutes" nel codice in src/**'`
  - `describeStep("cerca_nel_codice", JSON.stringify({ testo: "a\nb\u0007" + "x".repeat(500) }))`: nessun `\n` né controllo, lunghezza del campo ≤ 81
  - `describeStep("leggi_file", '{"percorso":42}')` → `"Legge un file"`
  - `describeStep("leggi_file", "non json")` → `"Legge un file"`
  - `describeStep("scrivi_al_capo", '{"testo":"segreto"}')` non contiene `"segreto"`; idem `ricorda` con `{"testo":"x"}`
  - `describeStep("proponi_nuovo_agente", "{}")` → `"Prepara una scheda"`; `describeStep("boh", "{}")` → `"Usa uno strumento"`
  Le frasi senza campo (percorso assente): `leggi_file` «Legge un file», `elenca_cartella` «Guarda una cartella», `cerca_nel_codice`
  «Cerca nel codice», `leggi_skill` «Legge una skill», `read_item` «Rilegge una voce del piano», `read_app` «Legge un'app»,
  `leggi_proposta` «Legge una proposta», `chiedi_al_responsabile` «Chiede al Responsabile di prodotto».
- [ ] **Step 2:** `pnpm --filter @workspace/api-server exec vitest run src/lib/turn-progress` → FAIL (modulo assente).
- [ ] **Step 3:** implementa `describe.ts`: `JSON.parse` in try, campi letti solo se del tipo atteso (stringa; interi per righe e `numero`),
  `clean(s)` = controlli e a capo → spazio, spazi ridotti, trim, oltre 80 caratteri → primi 80 + «…»; tabella come mappa nome → funzione;
  prefisso `proponi_` → «Prepara una scheda»; tutto il corpo in try/catch con ripiego «Usa uno strumento».
- [ ] **Step 4: test del registro** (`progress.test.ts`): begin → read ha `steps: []`, `omitted: 0`, `startedAt` ISO; 10 `startStep` → 8 passi, `omitted: 2`,
  l'ultimo `running`; `finishStep` → `done`; `startStep` su voce inesistente → null e nessuna voce creata; begin su voce esistente → passi azzerati;
  end → read null; chiavi diverse per consumer (stesso refId su `plan_chat` e `character` indipendenti).
- [ ] **Step 5:** implementa `progress.ts` (Map con chiave `` `${c}:${refId}` ``, contatore degli id per voce; oltre `PROGRESS_MAX_COUNTED` passi `startStep` restituisce null senza toccare nulla).
- [ ] **Step 6:** test verdi; commit `feat(casello): registro e testi dei passi dei turni di chat`.

### Task 2: aggancio in `runChatTurn`

**Files:**
- Modify: `artifacts/api-server/src/lib/node-turns/chat-turn.ts` (funzione `runChatTurn`, righe 69-99)
- Test: `artifacts/api-server/src/lib/node-turns/chat-turn.test.ts`

**Interfaces:**
- Consumes: Task 1 (`beginTurnProgress`, `startStep`, `finishStep`, `endTurnProgress`, `describeStep`, `readTurnProgress`).
- Produces: nessuna firma nuova; `ChatTurnInput.consumer` resta `"character" | "plan_chat" | "team_chat"` (= `TurnConsumer`).

- [ ] **Step 1: test** in `chat-turn.test.ts` (modello finto come quelli esistenti):
  - `registra il passo durante lo strumento`: `runTool` che legge `readTurnProgress("character", 1)` e lo salva; dentro lo strumento c'è un passo `running` con testo `"Usa uno strumento"` (tool `leggi_prova`); dopo il turno `readTurnProgress` → null.
  - `passo done dopo lo strumento`: due tool call in due giri; nel secondo `runTool` il primo passo è `done`.
  - `registro vuoto se il modello fallisce`: `modelChat` rigetta con errore → `readTurnProgress` null.
  - `registro vuoto se runTool lancia`: `runTool` lancia → `runChatTurn` rigetta come prima e `readTurnProgress` null.
  - `nodo`: `delegateTurn` finto che chiama `input.dispatch({id:"x",name:"leggi_file",arguments:'{"percorso":"a.ts"}'})` e legge il registro → passo «Legge a.ts».
- [ ] **Step 2:** test FAIL.
- [ ] **Step 3:** in `runChatTurn` crea `tracked = { ...input, runTool: wrapped }` dove `wrapped(call)` fa `startStep(…, describeStep(call.name, call.arguments))`,
  attende `input.runTool(call)` e in `finally` `finishStep`; passa `tracked` a `cloudTurn`, a `delegateTurn` (`dispatch: tracked.runTool`) e al ripiego;
  `beginTurnProgress` all'inizio e `endTurnProgress` in un `finally` attorno a tutto il corpo.
- [ ] **Step 4:** test verdi (anche i test esistenti del file e `src/lib/plan-chat`, `src/lib/team-chat`, `src/lib/characters`).
- [ ] **Step 5:** commit `feat(casello): passi dei turni registrati da runChatTurn`.

### Task 3: `progress` nell'API

**Files:**
- Modify: `lib/api-spec/openapi.yaml` (schema `TurnProgress`; `progress` in `PlanConversationDetail`, `TeamChatConversationDetail`, `CharacterConversationDetail`, non in `required`)
- Generated: `lib/api-client-react/src/generated/`, schemi Zod (codegen)
- Modify: `artifacts/api-server/src/routes/plan-chat.ts` (~riga 229), `src/routes/team-chat.ts` (~riga 161), `src/routes/characters.ts` (~riga 82, dettaglio usato anche dal filo di Alfred)
- Test: `src/routes/plan-chat.test.ts`, `team-chat.test.ts`, `characters.test.ts`

**Interfaces:**
- Consumes: `readTurnProgress` (Task 1).
- Produces: tipo generato `TurnProgress` e campo `progress?: TurnProgress | null` nei tre dettagli (Task 4).

- [ ] **Step 1:** aggiungi lo schema esattamente come nella spec §6 (`progress: { oneOf/anyOf: [$ref TurnProgress, null] }` nello stile già usato dal file per i campi nullabili), poi `pnpm --filter @workspace/api-spec run codegen`.
- [ ] **Step 2: test** per ogni route: conversazione con `turnStatus` messo a `running` nel DB e `beginTurnProgress` + `startStep(…, "Legge a.ts")` → GET ha `progress.steps[0]` = `{text:"Legge a.ts", status:"running"}` e `omitted: 0`; con `turnStatus idle` (anche con voce nel registro) → `progress: null`; `running` senza voce → `progress: null`. Pulire il registro con `endTurnProgress` dopo ogni test.
- [ ] **Step 3:** test FAIL; poi in ogni route `progress: conv.turnStatus === "running" ? readTurnProgress("<consumer>", conv.id) : null`.
- [ ] **Step 4:** test verdi, `pnpm run typecheck`; commit `feat(casello): passi del turno nelle conversazioni (API)` con i file generati.

### Task 4: resa in console

**Files:**
- Create: `artifacts/casello/src/components/characters/turn-progress.ts`, `turn-progress.test.ts`, `turn-progress-view.tsx`
- Modify: `adapters.ts` (`ConvDetail.progress: TurnProgress | null`), `plan-team-adapters.tsx` (`mapCommon`), `character-adapters.ts` (`mapCharacterDetail`), `character-chat.tsx` (righe 276-280)

**Interfaces:**
- Consumes: `TurnProgress` generato (Task 3).
- Produces:
  - `progressLines(p: TurnProgress | null, name: string, nowMs: number): { lines: { text: string; state: "work" | "done" | "muted" }[]; elapsed: string }`
  - `formatElapsed(ms: number): string`
  - `TurnProgressView({ progress, name }: { progress: TurnProgress | null; name: string })`

- [ ] **Step 1: test** `turn-progress.test.ts`:
  - `progressLines(null, "Lucius", now)` → una riga `{text:"Lucius sta pensando…", state:"work"}`, `elapsed: ""`
  - passi `[done "Legge a.ts", running "Cerca \"x\" nel codice"]` → due righe `done`, `work`, nessuna riga «ragiona»
  - passi tutti `done` → ultima riga `{text:"Lucius ragiona…", state:"work"}`
  - `omitted: 3` → prima riga `{text:"… e altri 3 passi", state:"muted"}` (`omitted: 1` → «… e un altro passo»)
  - `formatElapsed(42_000)` → `"42 s"`, `formatElapsed(65_000)` → `"1 min 05 s"`, negativo → `"0 s"`
- [ ] **Step 2:** `pnpm --filter @workspace/casello run test` → FAIL.
- [ ] **Step 3:** implementa `turn-progress.ts`; `TurnProgressView` con un `setInterval` di 1 s per `nowMs` solo mentre è montato; righe `work` con `<Led state="work" label=… />`, `done` e `muted` in `text-ink-muted`, testo con `break-words`, tempo «· 42 s» in `font-mono` accanto all'ultima riga; contenitore `aria-live="polite"`.
- [ ] **Step 4:** adattatori: `progress: d.progress ?? null`; in `character-chat.tsx` sostituisci il blocco `{running && (…)}` con `{running && <TurnProgressView progress={data?.progress ?? null} name={name} />}`.
- [ ] **Step 5:** test verdi, `pnpm run typecheck`; commit `feat(casello): passi del turno nella chat`.

### Task 5: documentazione e verifica

**Files:**
- Modify: `CLAUDE.md` (riga di stato e una sezione breve «Avanzamento dei turni»; percorso `lib/turn-progress/` in «Dove stanno le cose»)

- [ ] **Step 1:** aggiorna CLAUDE.md (registro in memoria, `progress` nelle tre GET, nessuna migrazione, limite del container unico).
- [ ] **Step 2:** `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test` → tutto verde.
- [ ] **Step 3:** prova in console con `AUTH_DISABLED=true pnpm run dev` e un modello finto o reale: durante un turno compaiono i passi; a fine turno spariscono.
- [ ] **Step 4:** commit `docs(casello): avanzamento dei turni in CLAUDE.md`; PR con `gh` (nessuna modifica allo schema DB né alle variabili).
