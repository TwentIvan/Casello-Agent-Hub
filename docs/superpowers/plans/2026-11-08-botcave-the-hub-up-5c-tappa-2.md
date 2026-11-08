# The Hub Up 5c, tappa 2 (via i doppioni) — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** togliere da The Hub Up lo smistamento email interno, il brief interno, l'instradamento a spinta verso Botcave e il codice
morto della documentazione dei trasporti, lasciando email e brief agli inneschi di Botcave.

**Architecture:** solo rimozioni nel repository AbapCrm, più lo spostamento di `extractAnalysisText` in un file proprio. Nessuna
migrazione, nessuna variabile, nessuna modifica a Botcave.

**Tech Stack:** Node/Express, TypeScript, Drizzle, React (client), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-botcave-the-hub-up-5c-tappa-2-design.md` (repository Casello-Agent-Hub).

## Global Constraints

- Repository: AbapCrm (`TwentIvan/AbapCrm`), branch `feat/5c-tappa-2-via-i-doppioni` da `origin/main`, cartella di lavoro
  `/Users/Ivan/Projects/AbapCrm-org-scope` (ha `node_modules` collegato).
- Commenti, documentazione e messaggi di commit in italiano; identificatori in inglese.
- `npx vitest run` verde; `npx tsc` con al massimo gli errori di `main` (128 all'8 novembre 2026), nessuno nuovo in file toccati.
- Nessuna migrazione, nessuna variabile nuova, nessuna modifica al comportamento delle route non citate.
- Commit con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Messaggio creato da `POST /api/messages`, da una chat incollata o da IMAP: viene salvato e restituito come prima, solo senza
  analisi in background (nessuna eccezione nuova, stesso status 201).
- `POST /api/messages/:id/analyze-project` (agente 2) continua a funzionare: usa `extractAnalysisText` dal nuovo file.
- Esecuzione THU AI fino alla fine e registrazione dei pattern: nessun riferimento rimasto a `triggerBriefUpdate`, nessuna promessa
  orfana.
- Avvio del server senza variabili `BOTCAVE_*`: nessun avviso né errore.
- Pagina Messaggi: compila e mostra ancora confidenza e motivo del collegamento.

---

### Task 1: `extractAnalysisText` in `server/message-text.ts`

**Files:**
- Create: `server/message-text.ts`, `server/message-text.test.ts`
- Modify: `server/routes.ts` (import di riga 46), `server/imap-service.ts` (import di riga 4)

**Interfaces:**
- Produces: `export function extractAnalysisText(message: { body?: string | null; htmlBody?: string | null }): string` in
  `server/message-text.ts`, corpo identico a quello di `server/ai-service.ts:19-35` (stessi import: `EmailForwardCleaner`, `cheerio`).

- [ ] **Step 1: test** `server/message-text.test.ts`:
  - `extractAnalysisText({ body: "  ciao  " })` → `"ciao"`;
  - `extractAnalysisText({ body: "", htmlBody: null })` → `""`;
  - `extractAnalysisText({ body: "x", htmlBody: "<p>testo piu lungo</p>" })` contiene `"testo piu lungo"`;
  - `extractAnalysisText({ body: "testo semplice molto piu lungo dell'html", htmlBody: "<p>corto</p>" })` →
    `"testo semplice molto piu lungo dell'html"`.
- [ ] **Step 2:** `npx vitest run server/message-text.test.ts` → FAIL (modulo mancante).
- [ ] **Step 3:** crea `server/message-text.ts` con la funzione spostata (import relativi, non `@shared`, come `message-list.ts`);
  togli la funzione da `ai-service.ts`, che finché esiste la importa da `./message-text` (si elimina nel Task 2); aggiorna gli import di
  `routes.ts` e `imap-service.ts`.
- [ ] **Step 4:** `npx vitest run` → verde; `npx tsc 2>&1 | grep -c "error TS"` ≤ 128.
- [ ] **Step 5:** commit `refactor(messaggi): extractAnalysisText in un file proprio`.

### Task 2: via smistamento email interno, documentazione dei trasporti e `ai-service.ts`

**Files:**
- Delete: `server/ai-service.ts`
- Modify: `server/imap-service.ts` (blocco «Run AI analysis», circa righe 528-549), `server/routes.ts` (analisi in background dopo
  `createMessage` nella normalizzazione delle chat, circa 4391, e in `POST /api/messages`, circa 4419; route
  `POST /api/messages/:id/analyze` e `…/apply-suggestion`, circa 4526-4560; route `POST /api/intervention-documents/generate`, circa
  8711; import di `aiService`), `client/src/pages/messages-page.tsx` (interfacce `AISuggestion`/`AnalysisResult` se non usate altrove,
  `analyzeMutation`, `applySuggestionMutation`, `handleAnalyze`, `handleApplySuggestion`)

**Interfaces:**
- Consumes: `extractAnalysisText` da `server/message-text.ts` (Task 1).

- [ ] **Step 1:** togli i blocchi elencati; le due route che creano messaggi restano con `res.status(201).json(message)`.
  In `imap-service.ts` NON toccare ancora il ramo «Smistamento su Botcave» (Task 4).
- [ ] **Step 2:** `grep -rn "aiService\|ai-service\|analyzeMessage\|updateMessageWithSuggestion\|generateDocumentation\|apply-suggestion\|/analyze\`" server client/src`
  → nessun risultato (tranne `analyze-project`).
- [ ] **Step 3:** `npx vitest run` verde; `npx tsc` ≤ 128 e nessun errore in `routes.ts`, `imap-service.ts`, `messages-page.tsx`
  diverso da quelli di `main` (confronta `npx tsc | grep <file>` con `main`).
- [ ] **Step 4:** commit `feat(messaggi): via lo smistamento email interno (ora lo fa Botcave)`.

### Task 3: via il brief interno

**Files:**
- Delete: `server/context-maintainer.ts`, `server/context-maintainer.test.ts`
- Modify: `server/ai-task-executor.ts` (import di riga 12; chiamata circa 1748; blocco «Phase 5: trigger background brief update»
  circa 2036-2042, tolto per intero compresa la `db.select`)

- [ ] **Step 1:** togli file e chiamate.
- [ ] **Step 2:** `grep -rn "triggerBriefUpdate\|context-maintainer" server` → nessun risultato.
- [ ] **Step 3:** `npx vitest run` verde; `npx tsc` ≤ 128, nessun errore nuovo in `ai-task-executor.ts`.
- [ ] **Step 4:** commit `feat(brief): via l'aggiornamento interno del brief (ora lo fa Botcave)`.

### Task 4: via `server/botcave/` e documentazione

**Files:**
- Delete: `server/botcave/` (tutta)
- Modify: `server/imap-service.ts` (import righe 5-7 e `buildEmailRunInput` se importato; ramo «Smistamento su Botcave»),
  `server/index.ts` (import di riga 5 e avviso di riga 147), `replit.md`

- [ ] **Step 1:** togli cartella, import e rami.
- [ ] **Step 2:** `replit.md`, sezione delle funzioni AI: aggiungi una riga «**Botcave**: lo smistamento delle email nuove e
  l'aggiornamento dei brief di progetto li fanno gli agenti di Botcave con gli inneschi di sorveglianza (`GET /api/messages?summary=true`,
  `GET /api/tasks`); The Hub Up non li esegue più al suo interno.»
- [ ] **Step 3:** `grep -rn "BOTCAVE_\|botcave/\|getBotcaveConfig\|startBotcaveRun" server client/src` → nessun risultato.
- [ ] **Step 4:** `npx vitest run` verde; `npx tsc` ≤ 128.
- [ ] **Step 5:** commit `chore(botcave): via l'instradamento a spinta, sostituito dagli inneschi`.

### Task 5: verifica finale e PR

- [ ] **Step 1:** `npx vitest run`, `npx tsc | grep -c "error TS"` e i grep dei Task 2–4 insieme; `git diff --stat origin/main`.
- [ ] **Step 2:** push del branch; link compare precompilato (senza `gh`) verso `main` con: cosa cambia, come si è provato, «nessuna
  migrazione, nessuna variabile», prova dopo il deploy (spec §5).
