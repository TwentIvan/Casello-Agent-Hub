# Responsabile di prodotto di Botcave stesso · piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un ambito di token `agent` che legge e scrive su `/api` ma non decide mai al posto dell'utente, e un catalogo di tool
verificato per l'App 4 «Casello», così che il suo agente `general` lavori su Botcave con un segreto di servizio.

**Architecture:** la regola sta in `hasScopeFor` (`lib/auth.ts`) con un elenco di route vietate; la creazione del token la rende
esclusiva (`lib/api-tokens.ts`). Il catalogo è un file JSON nel repository, controllato da un test contro `openapi.yaml`, le regole delle
definizioni e le route vietate; lo si applica in produzione a mano dopo il merge.

**Tech Stack:** Express 5, Vitest con PGlite, OpenAPI + Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-09-botcave-responsabile-di-se-stesso-design.md`

## Global Constraints

- Commenti, documentazione e messaggi di commit in italiano; identificatori in inglese; commit `feat(casello): …` con la riga
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nei testi visibili «Botcave», mai «Casello»; niente punti esclamativi.
- Nessuna migrazione: `api_tokens.scopes` è `text[]`.
- Messaggi fissi: 403 «il token non ha l'ambito per questa operazione» (`TOKEN_MESSAGES.scope`); 400 «l'ambito agent non si combina con
  altri ambiti».
- Dopo la modifica a `openapi.yaml`: `pnpm --filter @workspace/api-spec run codegen` e commit dei file generati.
- Prima di ogni commit: `pnpm run typecheck` verde.

## Review Focus

1. Route di decisione con id non numerico o barra finale (`/pending-actions/abc/approve`, `/pending-actions/1/approve/`): devono restare
   vietate a `agent` (le regex non ancorano solo `\d+`; Express ignora la barra finale) → test nel Task 1.
2. `HEAD` e `OPTIONS` con `agent`: HEAD ammesso come GET; OPTIONS non è una scrittura da permettere senza motivo → trattato come scrittura
   (ammessa salvo route vietate), nessun test aggiuntivo oltre HEAD.
3. Token `agent` sulle route `sessionOnly`: devono restare 403 «solo con il login», non diventare accessibili → test nel Task 1.
4. Combinazione `agent` + altro ambito arrivata da un client vecchio della console: 400 esplicito, non un token silenziosamente più potente
   → test nel Task 1.
5. Tool del catalogo che punta a una route con parametro di percorso scritto in un altro modo (`{toolId}` contro `{id}`): il confronto con
   OpenAPI deve normalizzare i segnaposto → test nel Task 3.

---

### Task 1: ambito `agent` nel server

**Files:**
- Modify: `artifacts/api-server/src/lib/api-tokens.ts` (`TOKEN_SCOPES`, `PERSONAL_TOKEN_SCOPES`, `createApiToken`)
- Modify: `artifacts/api-server/src/lib/auth.ts` (nuovo `AGENT_DENIED_ROUTES`, `hasScopeFor`)
- Modify: `lib/api-spec/openapi.yaml` (`ApiTokenScope`: enum e descrizione) + codegen
- Test: `artifacts/api-server/src/lib/api-tokens.test.ts`, `artifacts/api-server/src/routes/token-access.test.ts`

**Interfaces:**
- Produces: `TokenScope` include `"agent"`; `export const AGENT_DENIED_ROUTES: ReadonlyArray<{ method: "POST" | "PUT" | "PATCH"; path: RegExp }>`
  in `lib/auth.ts`, usato anche dal Task 3; `hasScopeFor(method, path, scopes)` invariata nella firma.

- [ ] **Step 1: test di creazione** in `api-tokens.test.ts`:
  - `createApiToken(userId, "Botcave", 365, ["agent"])` → `row.scopes` `["agent"]`;
  - `["agent", "api:read"]` e `["agent", "mcp"]` → `ApiTokenInputError("l'ambito agent non si combina con altri ambiti")`;
  - aggiornare il messaggio atteso esistente in «ambiti non validi: scegline almeno uno tra mcp, api:read, api:write, runs, agent».
- [ ] **Step 2: test di accesso** in `token-access.test.ts`, nuovo `describe("ambito agent")` con `tokenWith(["agent"])`:
  - `GET /apps` 200, `HEAD /apps` non 403, `POST /apps` (corpo valido come nel test di `api:write`) 201;
  - ognuna di queste → 403 `{ error: MESSAGES.scope }`: `POST /pending-actions/1/approve`, `POST /pending-actions/1/reject`,
    `POST /pending-actions/abc/approve`, `POST /pending-actions/1/approve/`, `POST /plan-proposals/1/decision`,
    `POST /team-chat-proposals/1/decision`, `POST /character-proposals/1/decision`, `PATCH /analysis-items/1`, `PUT /team-instances/1/plan`;
  - le stesse con `tokenWith(["api:write"])` → non 403 (le route vivono: 404 o 400 vanno bene);
  - ogni route dell'elenco `sessionOnly` del test esistente con `agent` → 403 `MESSAGES.sessionOnly`;
  - `approva` su `/mcp` con `agent` → 401 (come il test «solo runs su /mcp → 401»).
- [ ] **Step 3: eseguire** `pnpm --filter @workspace/api-server run test -- api-tokens token-access`: falliscono (ambito sconosciuto).
- [ ] **Step 4: implementare.**
  - `api-tokens.ts`: `"agent"` in coda a `TOKEN_SCOPES` e `PERSONAL_TOKEN_SCOPES`; in `createApiToken`, dopo il controllo esistente,
    `scopes.includes("agent") && scopes.length > 1` → l'errore del Global Constraints. Aggiornare il commento degli ambiti.
  - `auth.ts`: `AGENT_DENIED_ROUTES` con le route della spec §4, percorsi con segmenti `[^/]+` e barra finale facoltativa
    (es. `/^\/pending-actions\/[^/]+\/(approve|reject)\/?$/`); in `hasScopeFor`, prima della regola `runs`:
    se `scopes.includes("agent")` → `true` per GET/HEAD, altrimenti `!AGENT_DENIED_ROUTES.some(r => r.method === method && r.path.test(path))`.
    Aggiornare il commento di `hasScopeFor` e quello di `requireAuth`.
  - `openapi.yaml`: `enum: [mcp, api:read, api:write, runs, agent]`, descrizione con «agent = lettura e scrittura su /api tranne le
    decisioni dell'utente (coda, schede, revisione dell'architetto, PLAN); da solo, segreto di servizio dell'App di Botcave». Codegen.
- [ ] **Step 5: eseguire** gli stessi test e `pnpm run typecheck`: verdi.
- [ ] **Step 6: commit** `feat(casello): ambito agent dei token personali, senza decisioni dell'utente`.

### Task 2: console e documentazione dell'ambito

**Files:**
- Modify: `artifacts/casello/src/components/account/api-tokens-section.tsx`
- Modify: `CLAUDE.md` (sezione "Token personali su `/api`" e riga di stato)

**Interfaces:**
- Consumes: `ApiTokenScope` generato con `agent` (Task 1).

- [ ] **Step 1: casella.** `SCOPE_LABELS.agent = "Agente di Botcave (segreto di servizio)"`, `"agent"` in coda a `SCOPE_ORDER`; nuovo stato
  `agentScope`; con `agentScope` vero gli altri controlli si disattivano e `scopes` vale `["agent"]`; spuntare un altro ambito lo spegne.
  Sotto la casella il testo «Legge e scrive su Botcave, ma non approva né rifiuta nulla: da usare come segreto di servizio dell'App Botcave.»
  Nel riquadro del token appena creato, `agent` conta come accesso all'API (`hasApi`).
- [ ] **Step 2: verifica.** `pnpm --filter @workspace/casello run test` e `pnpm run typecheck` verdi; avvio con `AUTH_DISABLED=true pnpm run dev`
  (con `ALLOWED_EMAILS` che include `dev@localhost`), Account → «Token personali» → crea un token «agent»: elenco con l'etichetta giusta, nessuno
  scorrimento orizzontale a 1280 px.
- [ ] **Step 3: CLAUDE.md.** Ambito `agent` nell'elenco degli ambiti (route vietate, esclusivo, 401 su `/mcp`); il paragrafo «Casello come app
  di sé stesso» diventa: App 4, `internal_base_url` `http://localhost:3000`, autenticazione di servizio `Authorization` `Bearer`, tool `service`,
  segreto = token `agent`, catalogo in `docs/botcave-self/catalogo-tool.json`.
- [ ] **Step 4: commit** `feat(casello): ambito agent nella console e nella documentazione`.

### Task 3: catalogo dei tool e suo controllo

**Files:**
- Create: `docs/botcave-self/catalogo-tool.json`
- Create: `artifacts/api-server/test/botcave-self-catalog.test.ts`

**Interfaces:**
- Consumes: `AGENT_DENIED_ROUTES` (Task 1); `TOOL_NAME`, `parseDefinition`, `checkParamsSchema`, `checkPathPlaceholders` da
  `src/lib/tools/definition.ts`.
- Produces: il file, elenco di oggetti `{ name, description, kind: "http", identity: "service", level, status: "active", paramsSchema,
  definition: { method, path, paramLocations, responseFields? }, replaces?: string }`, letto a mano nel Task 4.

- [ ] **Step 1: test** `botcave-self-catalog.test.ts` (legge il JSON e `lib/api-spec/openapi.yaml` con il parser YAML già usato dal repository;
  se non c'è, estrarre i path con la regex `^  (/\S+):$` e i metodi dalle righe `^    (get|post|put|patch|delete):$`):
  - nomi unici e validi (`TOOL_NAME`); `parseDefinition("http", def).ok`; `checkParamsSchema(schema) === null`; `checkPathPlaceholders(def, schema) === null`;
  - `identity === "service"`, `kind === "http"`, `level` in `L0|L1|L2`;
  - metodo e path presenti in OpenAPI, confrontando i path con ogni `{segnaposto}` normalizzato a `{}` (gli `/api` del tool tolti);
  - `level === "L0"` solo con GET, salvo `test_trigger`;
  - nessuna route in `AGENT_DENIED_ROUTES` (path di prova costruito sostituendo i segnaposto con `1`);
  - nessuna route esclusa: regex sui prefissi `/account/`, `/ai/accounts`, `/node/`, `/alfred/`, `/embed/`, `/hooks/`, `/memories/`,
    `/characters/`, `/character-`, `/plan-conversations`, `/team-chat-`, `/github/`, `/auth/`, `/ai/estimate`, `/budget` con metodo ≠ GET,
    `/ai/models/{}` con PATCH, `/apps` e `/apps/{}` con POST/PATCH, `/apps/{}/agent-models`, `/attachments`, `/triggers/{}/secret`,
    `/triggers/{}/signing-secret`, e ogni DELETE;
  - l'insieme dei nomi coincide con quello della spec §5.1 e §5.2 più `resume_run` e `review_analysis_item` con `status: "disabled"`
    (unici tool `disabled`, senza vincolo di route vietata per `review_analysis_item`, di OpenAPI per `resume_run`).
- [ ] **Step 2: eseguire** `pnpm --filter @workspace/api-server run test -- botcave-self-catalog`: fallisce (file mancante).
- [ ] **Step 3: scrivere il catalogo.** Un oggetto per tool della spec §5.1-§5.2 con i livelli della tabella; parametri e posizioni presi
  dagli schemi di `openapi.yaml` della route (solo i campi utili, `description` in italiano); `path` con prefisso `/api`; `responseFields`
  sugli elenchi lunghi (run, eventi, compiti, catalogo dei modelli) per contenere la risposta; per i 21 tool esistenti che restano,
  `replaces` con il loro nome attuale (`get_app_overview`, `list_app_analyses` ecc. tengono il nome). Descrizioni che dicono cosa fa il tool
  e i limiti (es. `create_trigger`: «nasce in pausa»; `activate_team`: «la squadra lavora e spende con i tuoi account»).
- [ ] **Step 4: eseguire** il test e `pnpm run typecheck`: verdi.
- [ ] **Step 5: commit** `feat(casello): catalogo dei tool di Botcave come App di sé stesso`.

### Task 4: testi per la configurazione

**Files:**
- Create: `docs/botcave-self/configurazione.md`

- [ ] **Step 1: scrivere** i passi della spec §6 in ordine, ciascuno con la chiamata esatta (metodo, percorso, corpo JSON) da eseguire con la
  sessione di Ivan, più:
  - la descrizione funzionale proposta (≤ 12 000 caratteri, contenuti della spec §6.4);
  - il prompt nuovo dell'agente 5 «Responsabile di prodotto», nello stile del prompt dell'agente 4 di The Hub Up: legge prima di proporre,
    azioni collegate con `proponi`, non decide mai al posto dell'utente, minimo indispensabile, esito finale in una riga;
  - i due messaggi della prova reale (spec §7.3) e l'esito atteso.
- [ ] **Step 2: commit** `docs(casello): configurazione del Responsabile di prodotto di Botcave`.

### Task 5: verifica finale e PR

- [ ] **Step 1:** `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/casello run test`: tutti verdi
  (riportare i numeri).
- [ ] **Step 2:** push del branch `feat/botcave-responsabile-di-se-stesso` e link compare precompilato verso `main` (titolo e corpo nell'URL):
  cosa cambia, come si è provato, «nessuna migrazione, nessuna variabile nuova», configurazione da fare dopo il merge con
  `docs/botcave-self/configurazione.md`.
