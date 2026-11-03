# Squadre di agenti — definizione: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** definire e salvare in Casello skill codificate e versionate, modelli di squadra (ruoli a stella con un capo)
e istanze legate a un lavoro, con aggiornamenti proposti e «Salva come modello», più le tre viste della console.

**Architecture:** un modulo `lib/teams/` con parti pure (schema del manifesto, regole, calcolo delle differenze) e
parti con DB (skill, modelli, istanze); il manifesto dei ruoli è jsonb versionato (`team_template_versions.manifest`,
`team_instances.roles`); route Express contract-first; console React con hook Orval.

**Tech Stack:** Express 5, Drizzle/Postgres (PGlite nei test), Zod, Vitest, OpenAPI + Orval, React + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-03-casello-squadre-definizione-design.md`

## Global Constraints

- Italiano per commenti, messaggi d'errore, UI e commit (`feat(casello): …`); identificatori in inglese.
- `pnpm run typecheck` verde prima di ogni commit; dopo ogni modifica a `openapi.yaml` codegen e commit dei generati.
- Ogni modifica a `lib/db/src/schema/` anche in `docs/schema-casello.sql` e in `docs/migrations/2026-11-squadre.sql`.
- Codice skill `^[a-z0-9][a-z0-9._-]{1,63}$`; contenuto `casello` max 20 000 caratteri; contenuto `node`
  `^[a-zA-Z0-9:_-]{1,100}$`; max 200 versioni per skill.
- Ruolo: `key` `^[a-z0-9_-]{1,40}$`, `task` max 8 000; 1..20 ruoli; 0..30 skill per ruolo (catalogo + specializzate).
- Istanza: `ref_type` `^[a-z0-9_-]{1,40}$`, `ref_id` max 100, `ref_title` max 300; stati `draft | active | closed`.
- Messaggi fissi: «una squadra ha esattamente un capo», «modello non disponibile», «la skill <code> gira solo sul
  nodo locale», «lo strumento <nome> non può essere usato da una squadra», «squadra chiusa».
- Con un token personale: GET → `api:read`, il resto `api:write` (regola già in `requireAuth`); nessuna route `sessionOnly`.
- Console senza scorrimento orizzontale a 1280 px; solo hook generati da Orval.

## Review Focus

- Salvare un modello due volte senza cambiare nulla: crea comunque una versione nuova (atteso, semplice) — ma le
  istanze non devono vedere aggiornamenti fittizi: il calcolo confronta i contenuti, non i numeri (test nel Task 6).
- Un ruolo rinominato (stessa `key`) non deve apparire come «ruolo tolto + ruolo aggiunto» (test nel Task 6).
- Un'istanza con una skill del catalogo deprecata dopo la copia: la riapertura e il salvataggio dell'istanza non devono
  fallire (test nel Task 5).
- Uno strumento usato da un ruolo che viene eliminato dal catalogo dell'app: la lettura del modello/istanza non deve
  rompersi, lo strumento appare come non disponibile (test nel Task 4).
- Applicazione degli aggiornamenti con id di voci non più validi (il modello è cambiato di nuovo nel frattempo): 409
  «aggiornamenti cambiati: ricarica» senza modifiche (test nel Task 6).

---

## File

- `lib/db/src/schema/` nuovi: `skills.ts`, `skill-versions.ts`, `team-templates.ts`, `team-template-versions.ts`,
  `team-instances.ts`, `team-instance-skills.ts` (+ indice); `docs/schema-casello.sql`; `docs/migrations/2026-11-squadre.sql`.
- `artifacts/api-server/src/lib/teams/`:
  - `manifest.ts` (puro): schemi Zod del ruolo di modello e di istanza, tipi.
  - `rules.ts`: `validateRoles` (regole §3, con accesso al DB per modelli, strumenti, skill).
  - `skills.ts`: catalogo e versioni.
  - `templates.ts`: modelli e versioni.
  - `instances.ts`: istanze, copia, skill specializzate, lettura arricchita.
  - `updates.ts`: calcolo (puro) e applicazione delle differenze.
  - `save-as-template.ts`.
- `artifacts/api-server/src/routes/`: `skills.ts`, `team-templates.ts`, `team-instances.ts`; registrazione in `routes/index.ts`.
- `lib/api-spec/openapi.yaml` + codegen.
- `artifacts/casello/src/`: `pages/skills.tsx`, `pages/skill-detail.tsx`, `pages/team-templates.tsx`,
  `pages/team-template-detail.tsx`, `pages/teams.tsx`, `pages/team-detail.tsx`; `components/teams/` (editor dei
  ruoli, scelta di skill e strumenti, riquadro aggiornamenti); `App.tsx` (route) e menu.
- `CLAUDE.md`.

---

### Task 1: Dati e migrazione

**Files:** schema Drizzle nuovi (sopra), `lib/db/src/schema/index.ts`, `docs/schema-casello.sql`,
`docs/migrations/2026-11-squadre.sql`, `artifacts/api-server/test/migration-squadre.test.ts`,
`artifacts/api-server/test/fixtures/schema-pre-squadre.sql` (copia dello schema prima del task).

**Interfaces:**
- Produces: `skillsTable` (`id`, `code` unico, `name`, `description`, `kind` enum `skill_kind` `casello|node`,
  `currentVersion` int default 1, `deprecated` bool default false, timestamps); `skillVersionsTable` (`id`, `skillId`
  cascade, `version`, `content` text, `toolHints` jsonb `string[]` default `[]`, `createdAt`; unico `skillId+version`);
  `teamTemplatesTable` (`id`, `name`, `description`, `version` int default 1, `archived` bool default false,
  timestamps; indice unico parziale su `name` dove `archived = false`); `teamTemplateVersionsTable` (`id`,
  `templateId` cascade, `version`, `manifest` jsonb, `createdAt`; unico `templateId+version`); `teamInstancesTable`
  (`id`, `name`, `templateId` set null, `templateVersion` int null, `refAppId` restrict, `refType`, `refId`,
  `refTitle`, `status` enum `team_instance_status` `draft|active|closed` default `draft`, `roles` jsonb default `[]`,
  `createdBy` set null, timestamps, `closedAt`; indice `refAppId+refType+refId`); `teamInstanceSkillsTable` (`id`,
  `instanceId` cascade, `code`, `name`, `kind` `skill_kind`, `content`, `toolHints` jsonb default `[]`, `updatedAt`;
  unico `instanceId+code`).

- [ ] **Step 1:** test della migrazione sul modello di `test/migration-token-api.test.ts`: dallo schema precedente,
  lo script due volte crea le sei tabelle, gli enum, l'indice parziale sul nome (due modelli non archiviati con lo
  stesso nome → violazione; uno archiviato + uno attivo → ok) e la FK `RESTRICT` su `ref_app_id` (eliminare un'app con
  un'istanza fallisce).
- [ ] **Step 2:** FAIL → script idempotente (`CREATE TYPE` in blocchi `DO` con controllo su `pg_type`,
  `CREATE TABLE/INDEX IF NOT EXISTS`), schema Drizzle e `docs/schema-casello.sql` → PASS; suite e typecheck verdi.
- [ ] **Step 3: Commit** `feat(casello): tabelle di skill, modelli di squadra e istanze`

### Task 2: Catalogo delle skill

**Files:** Create `artifacts/api-server/src/lib/teams/skills.ts` (+ test), `artifacts/api-server/src/routes/skills.ts`
(+ test); modify `routes/index.ts`, `lib/api-spec/openapi.yaml` (+ codegen).

**Interfaces:**
- Produces in `skills.ts`:
  - `SKILL_CODE = /^[a-z0-9][a-z0-9._-]{1,63}$/`, `NODE_SKILL_NAME = /^[a-zA-Z0-9:_-]{1,100}$/`,
    `MAX_SKILL_CONTENT = 20_000`, `MAX_SKILL_VERSIONS = 200`
  - `validateSkillContent(kind: SkillKind, content: string): string | null` (messaggio o null)
  - `createSkill(input: { code; name; description?; kind; content; toolHints? }): Promise<SkillView>`
  - `updateSkill(code: string, patch: { name?; description?; content?; toolHints? }): Promise<SkillView>` — `content`
    o `toolHints` → nuova versione nella stessa transazione (oltre 200 → 409 «troppe versioni: crea una skill nuova»)
  - `deprecateSkill(code: string): Promise<SkillView>`
  - `getSkill(code)`, `listSkills(filter: { kind?; q?; deprecated? })`, `listSkillVersions(code)`,
    `getSkillVersion(code, version)`
  - `SkillView = { code; name; description; kind; currentVersion; deprecated; content; toolHints; createdAt; updatedAt }`
    (content e toolHints della versione corrente)
  - `SkillError` con `status` (400 | 404 | 409) e messaggio
- Route e OpenAPI come spec §5 (operationId: `listSkills`, `createSkill`, `getSkill`, `updateSkill`, `deprecateSkill`,
  `listSkillVersions`, `getSkillVersion`); codice duplicato → 409 «codice già usato».

- [ ] **Step 1: test** — creazione v1; codice `Sap.X` → 400; `node` con contenuto `drg sibilla` → 400; PATCH solo
  `name` non crea versioni; PATCH `content` → v2 e la v1 resta identica; 201ª versione → 409; `deprecate` →
  `deprecated: true`; elenco filtrato per `kind` e `q` (su codice e nome); versione inesistente → 404.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): catalogo delle skill codificate e versionate`

### Task 3: Manifesto e regole

**Files:** Create `artifacts/api-server/src/lib/teams/manifest.ts`, `rules.ts` (+ test).

**Interfaces:**
- Produces in `manifest.ts`:
  - `RoleKey = /^[a-z0-9_-]{1,40}$/`, `MAX_ROLES = 20`, `MAX_SKILLS_PER_ROLE = 30`, `MAX_TASK = 8000`
  - `TemplateRoleSchema` (Zod): `{ key; name (1..80); task (0..8000); isLead: boolean; runsOn: "cloud"|"node";
    aiModelId: number|null; tools: number[] (senza ripetizioni); skills: string[] (codici, senza ripetizioni) }`
  - `InstanceRoleSchema`: come sopra ma `skills: { code; version: number }[]` e `localSkills: string[]`
  - tipi `TemplateRole`, `InstanceRole`
- Produces in `rules.ts`:
  - `TEAM_MESSAGES` (i messaggi fissi delle Global Constraints più «ruoli con lo stesso nome», «ruoli con la stessa
    chiave», «troppi ruoli», «troppe skill nel ruolo <nome>», «skill <code> inesistente», «skill <code> deprecata»,
    «versione <v> della skill <code> inesistente», «skill specializzata <code> inesistente», «un ruolo sul nodo non ha
    un modello cloud»)
  - `validateRoles(input: { roles: TemplateRole[] | InstanceRole[]; mode: "template" | "instance"; userId: number;
    previous: (TemplateRole | InstanceRole)[] | null; localSkillCodes?: Map<string, SkillKind> }): Promise<void>` —
    lancia `TeamRuleError` (`status: 400`, `message`) alla prima violazione, nell'ordine di spec §3. Le eccezioni
    «già presente nel ruolo nella versione precedente» (skill deprecate, strumenti non più attivi o L3) si valutano
    con `previous`, per `key` del ruolo. Il modello si verifica con `chooseOwnModel(aiModelId, userId)` di
    `lib/ai/choice.ts` (errore → «modello non disponibile»).

- [ ] **Step 1: test** — uno per regola, ciascuno con il messaggio esatto: zero capi, due capi, nomi doppi, chiavi
  doppie, 21 ruoli, 31 skill, `cloud` senza modello, `cloud` con modello di un altro utente, `node` con `aiModelId`,
  skill `node` su ruolo `cloud`, codice inesistente, skill deprecata in un ruolo nuovo (errore) e già presente in
  `previous` per la stessa `key` (ok), strumento `disabled` nuovo (errore) e già presente in `previous` (ok), strumento
  con override L3 (errore), istanza con versione inesistente, `localSkills` non presente in `localSkillCodes`.
- [ ] **Step 2:** FAIL → implementare → PASS; typecheck.
- [ ] **Step 3: Commit** `feat(casello): manifesto dei ruoli e regole delle squadre`

### Task 4: Modelli di squadra

**Files:** Create `artifacts/api-server/src/lib/teams/templates.ts` (+ test), `routes/team-templates.ts` (+ test);
modify `routes/index.ts`, `openapi.yaml` (+ codegen).

**Interfaces:**
- Consumes: `TemplateRoleSchema`, `validateRoles` (Task 3); skill (Task 2).
- Produces in `templates.ts`:
  - `createTemplate(userId, input: { name; description?; roles: TemplateRole[] }): Promise<TemplateView>` (v1)
  - `saveTemplate(userId, id, input: { name; description?; roles }): Promise<TemplateView>` — tutto o niente, versione+1
    con il manifesto
  - `getTemplate(id)`, `listTemplates({ archived })`, `getTemplateVersion(id, version): Promise<TemplateRole[]>`
  - `deleteTemplate(id): Promise<{ deleted: boolean; archived: boolean }>`
  - `describeRoles(roles: TemplateRole[] | InstanceRole[]): Promise<RoleView[]>` — arricchisce per la lettura:
    strumenti `{ id; appId; appName; name; level; available }` (strumento cancellato dal catalogo →
    `{ id, name: "strumento eliminato", available: false }`), skill `{ code; version?; name; kind; deprecated }`,
    modello `{ id; name } | null`. Usata anche dalle istanze.
  - `TemplateView = { id; name; description; version; archived; instanceCount; roles: RoleView[]; createdAt; updatedAt }`
- OpenAPI: operationId `listTeamTemplates`, `createTeamTemplate`, `getTeamTemplate`, `saveTeamTemplate`,
  `getTeamTemplateVersion`, `deleteTeamTemplate`; nome già usato tra i non archiviati → 409 «nome già usato».

- [ ] **Step 1: test** — creazione e lettura con `RoleView` arricchiti; salvataggio che crea v2 e lascia v1 leggibile;
  regola violata → 400 e nessuna versione nuova; strumento eliminato dall'app dopo il salvataggio → lettura ok con
  `available: false`; delete senza istanze → cancellato; con un'istanza (inserita a mano nel test) → archiviato.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): modelli di squadra con ruoli versionati`

### Task 5: Istanze

**Files:** Create `artifacts/api-server/src/lib/teams/instances.ts` (+ test), `routes/team-instances.ts` (+ test);
modify `routes/index.ts`, `openapi.yaml` (+ codegen).

**Interfaces:**
- Consumes: Task 3 e 4 (`describeRoles`, `getTemplateVersion`).
- Produces in `instances.ts`:
  - `createInstance(userId, input: { templateId?: number; name; ref: { appId; type; id; title? }; roles?: InstanceRole[] }):
    Promise<InstanceView>` — da modello: copia il manifesto della versione corrente fissando ogni skill alla sua
    `currentVersion`, `localSkills: []`; senza modello: `roles` obbligatori; modello archiviato → 409 «modello archiviato»
  - `saveInstance(userId, id, input: { name; refTitle?; roles: InstanceRole[]; localSkills: LocalSkillInput[];
    status?: "draft" | "active" }): Promise<InstanceView>` — tutto o niente; `LocalSkillInput = { code; name; kind;
    content; toolHints? }` sostituisce l'insieme delle skill specializzate; istanza `closed` → 409 «squadra chiusa»
  - `closeInstance(id)`, `getInstance(id)`, `listInstances(filter: { status?; appId?; refType?; refId? })`
  - `InstanceView = { id; name; status; template: { id; name; version } | null; ref: { appId; appName; type; id; title };
    roles: RoleView[] (con `localSkills`); localSkills: { code; name; kind; content; toolHints }[]; createdAt; updatedAt; closedAt }`
- OpenAPI: operationId `listTeamInstances`, `createTeamInstance`, `getTeamInstance`, `saveTeamInstance`, `closeTeamInstance`.

- [ ] **Step 1: test** — copia da modello con versioni fissate e `templateVersion`; istanza senza modello; ricerca per
  `appId+refType+refId`; skill specializzata usata in un ruolo e codice doppio → 400; skill del catalogo deprecata
  dopo la copia: `saveInstance` con gli stessi ruoli → ok; chiusura e salvataggio dopo la chiusura → 409; app di
  riferimento inesistente → 400.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): istanze di squadra legate a un lavoro`

### Task 6: Aggiornamenti proposti

**Files:** Create `artifacts/api-server/src/lib/teams/updates.ts` (+ test); modify `routes/team-instances.ts`,
`openapi.yaml` (+ codegen).

**Interfaces:**
- Consumes: Task 3, 4, 5.
- Produces in `updates.ts`:
  - `computeUpdates(input: { base: TemplateRole[] | null; current: TemplateRole[] | null; instance: InstanceRole[];
    skillVersions: Map<string, number> }): UpdateItem[]` — **puro**. `base` = manifesto della `templateVersion`
    dell'istanza, `current` = manifesto della versione corrente (entrambi null senza modello). Voci del modello solo
    dove `current` differisce da `base` (confronto di contenuto per `key`, non di numeri di versione); voci
    `skill_version` per ogni skill del catalogo dell'istanza con `version < skillVersions.get(code)`.
  - `UpdateItem = { id: string; type: "role_added" | "role_removed" | "role_changed" | "skill_added" | "skill_removed"
    | "skill_version"; roleKey: string; roleName: string; field?: "name" | "task" | "isLead" | "runsOn" | "aiModelId" |
    "tools"; from?: unknown; to?: unknown; skillCode?: string; fromVersion?: number; toVersion?: number }`;
    `id` deterministico: `${type}:${roleKey}[:${field|skillCode}]`
  - `applyUpdates(userId, instanceId, ids: string[]): Promise<InstanceView>` — ricalcola le voci, se un id non è tra
    quelle attuali → 409 «aggiornamenti cambiati: ricarica» senza modifiche; applica in una transazione, valida con
    `validateRoles` (mode `instance`, `previous` = ruoli prima dell'applicazione); `templateVersion` = versione corrente
    se dopo l'applicazione non restano voci di tipo diverso da `skill_version`; istanza chiusa → 409.
- Route `GET /api/team-instances/:id/updates` → `{ items: UpdateItem[] }`, `POST …/updates/apply` `{ ids: string[] }`
  (1..100, senza ripetizioni); operationId `getTeamInstanceUpdates`, `applyTeamInstanceUpdates`.

- [ ] **Step 1: test di `computeUpdates`** — nessuna voce se `current` è uguale a `base` anche con numeri di versione
  diversi; ruolo rinominato (stessa key) → una sola `role_changed` `field: "name"`; ruolo aggiunto/tolto; compito
  cambiato nel modello → `role_changed task`; compito cambiato solo nell'istanza → nessuna voce; skill aggiunta e tolta
  nel modello; skill con versione nuova → `skill_version` 2→3; istanza senza modello → solo `skill_version`.
- [ ] **Step 2: test di `applyUpdates`** — applicazione parziale; voce che toglierebbe l'unico capo → 400 «una squadra
  ha esattamente un capo» e nessuna modifica; id non più valido → 409; `templateVersion` aggiornata solo se non restano
  voci del modello; istanza chiusa → 409.
- [ ] **Step 3:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 4: Commit** `feat(casello): aggiornamenti delle istanze proposti dal modello e dalle skill`

### Task 7: Salva come modello

**Files:** Create `artifacts/api-server/src/lib/teams/save-as-template.ts` (+ test); modify `routes/team-instances.ts`,
`openapi.yaml` (+ codegen).

**Interfaces:**
- Consumes: Task 2 (`createSkill`), 4 (`createTemplate`, `saveTemplate`), 5.
- Produces: `saveInstanceAsTemplate(userId, instanceId, input: { mode: "new" | "new_version"; name?: string;
  promote?: { localCode: string; code: string }[] }): Promise<TemplateView>` — tutto in una transazione:
  le skill specializzate in `promote` diventano skill del catalogo (v1) con il codice nuovo e sostituiscono il codice
  locale nei ruoli; quelle non promosse vengono tolte dai ruoli; le skill del catalogo perdono la versione; `new`
  richiede `name`; `new_version` → 409 «l'istanza non ha un modello» o «modello archiviato».
- Route `POST /api/team-instances/:id/save-as-template`, operationId `saveTeamInstanceAsTemplate`.

- [ ] **Step 1: test** — `new` con una skill promossa (presente nel catalogo e nel ruolo del modello) e una non
  promossa (assente); `new_version` crea la versione successiva del modello d'origine; senza modello → 409; codice di
  promozione già usato → 409 e nulla creato.
- [ ] **Step 2:** FAIL → implementare → PASS; codegen; typecheck.
- [ ] **Step 3: Commit** `feat(casello): salva una squadra come modello`

### Task 8: Console — Skill

**Files:** Create `artifacts/casello/src/pages/skills.tsx`, `pages/skill-detail.tsx`, `components/teams/skill-*.tsx`;
modify `App.tsx` (route `/skills`, `/skills/:code`) e il menu (`components/layout/`).

- [ ] **Step 1:** elenco con filtro per tipo e ricerca, «Nuova skill»; scheda con contenuto corrente, versioni,
  confronto tra due versioni (due colonne affiancate del testo, senza librerie nuove), «Nuova versione», «Depreca»;
  errori dell'API mostrati come arrivano.
- [ ] **Step 2:** `pnpm run typecheck` e build (`PORT=3000 BASE_PATH=/`) verdi.
- [ ] **Step 3: Commit** `feat(casello): catalogo delle skill nella console`

### Task 9: Console — Modelli di squadra e Squadre

**Files:** Create `pages/team-templates.tsx`, `pages/team-template-detail.tsx`, `pages/teams.tsx`,
`pages/team-detail.tsx`, `components/teams/` (editor dei ruoli condiviso tra modello e istanza, scelta di skill con
ricerca, scelta di strumenti con app · nome · livello, riquadro aggiornamenti, dialogo «Salva come modello»);
modify `App.tsx` (route `/team-templates`, `/team-templates/:id`, `/teams`, `/teams/:id`) e menu.

- [ ] **Step 1:** come spec §6: ruoli in schede impilate (non tabelle larghe), capo evidenziato, strumenti e skill con
  i segnali `non disponibile` / `deprecata`, «Nuova squadra da questo modello» (nome e lavoro di riferimento: app,
  tipo, identificativo, titolo), riquadro «Aggiornamenti disponibili» con le voci da spuntare e «Applica», «Salva come
  modello», «Attiva» / «Chiudi».
- [ ] **Step 2:** typecheck e build verdi.
- [ ] **Step 3: prova nel browser** a 1280 px con un DB in memoria: creare due skill, un modello con tre ruoli, una
  squadra dal modello, modificare il modello e applicare un aggiornamento, «Salva come modello»; nessuno scorrimento
  orizzontale.
- [ ] **Step 4: Commit** `feat(casello): modelli di squadra e squadre nella console`

### Task 10: Documentazione

**Files:** `CLAUDE.md`.

- [ ] **Step 1:** nuova sezione «Squadre (definizione)»: spec, concetti (skill codificate e versionate, modello con
  manifesto versionato, istanza con skill fissate e specializzate, aggiornamenti proposti, salva come modello), regole
  e limiti, route, migrazione `docs/migrations/2026-11-squadre.sql` (PRIMA del merge), cosa arriva nei sottoprogetti 3b
  e 4; «Dove stanno le cose» con `lib/teams/` e le route; elenco delle tabelle dello schema.
- [ ] **Step 2: Commit** `docs(casello): squadre nel CLAUDE.md`
