# Pannello unico di Alfred: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** console e app ospiti mostrano lo stesso pannello di Botcave (Alfred con la voce, Da confermare, Bollettino,
Lucius), costruito da un solo insieme di componenti in `components/panel/`.

**Architecture:** un `PanelProvider` con un riduttore puro tiene stato e scheda; un ambiente (`console` | `embed`) decide
collegamenti, contesto di Alfred, Lucius e Da confermare. Un `AlfredVoiceProvider` tiene l'unica istanza della voce. La
console monta il pannello in uno `Sheet`, l'embed a piena altezza nell'iframe.

**Tech Stack:** React 18, wouter, TanStack Query (hook Orval), Tailwind + shadcn/ui, Vitest (ambiente `node`, solo
`src/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-11-09-botcave-pannello-unico-design.md`

## Global Constraints

- Solo `artifacts/casello`: nessuna modifica all'API, a `openapi.yaml`, al DB o alle variabili; nessuna migrazione.
- Solo hook generati da Orval, mai fetch a mano.
- Nessun colore fuori dai token (niente esadecimali né classi di palette Tailwind), niente ombre, stati con `Led`.
- Niente scorrimento orizzontale a 1280 px; pannello ~440 px su desktop (`sm:max-w-[440px]`), a schermo intero sul telefono.
- Testi in italiano, pulsanti che dicono cosa fanno, niente punti esclamativi. Commenti in italiano, identificatori in inglese.
- Protocollo `postMessage`, caricatore `botcave.js`, collegamento OAuth dell'embed: invariati.
- `pnpm run typecheck` e `pnpm --filter @workspace/casello run test` verdi prima di ogni commit; commit `feat(casello): …`
  con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Due sessioni vocali nella stessa scheda (pannello + `/alfred`): deve esistere una sola chiamata a `useAlfredVoice` in
  tutta la console e una nell'iframe (verifica con `grep` nel Task 5).
- Passaggio di consegne verso Lucius sullo stesso argomento della pagina: nessuna sostituzione, nessun «Torna a…»
  (test `handoff verso Lucius sull'argomento della pagina non sostituisce` nel Task 1).
- Cambio di pagina con il pannello aperto dopo un passaggio di consegne: il pannello si chiude e la sostituzione sparisce
  (test `navigate chiude e toglie la sostituzione` nel Task 1).
- Pagina smontata che lascia il suo `hasUnsavedChanges` al pannello: dopo lo smontaggio l'avviso non deve più comparire
  (`usePanelSubject` azzera il controllo nel cleanup, Task 3).
- Badge del menu e contatore della caverna disallineati dopo una decisione dal pannello: entrambi leggono
  `getGetDashboardStatsQueryKey()`, che `PendingActionItem` e `ActionDialog` già invalidano (verifica a mano, Task 6).

---

### Task 1: Logica pura del pannello

**Files:**
- Create: `artifacts/casello/src/components/panel/tabs.ts`
- Create: `artifacts/casello/src/components/panel/panel-state.ts`
- Create: `artifacts/casello/src/components/panel/page-subject.ts` (spostando `pageFromPath`, `handoffTarget`,
  `LUCIUS_SUBJECTS`, `positiveInt` da `components/characters/handoff-context.tsx`, invariati; `handoff-context.tsx` per ora
  li reimporta da qui)
- Test: `artifacts/casello/src/components/panel/panel-state.test.ts`, `artifacts/casello/src/components/panel/page-subject.test.ts`

**Interfaces:**
- Produces:
  - `tabs.ts`: `type PanelTab = EmbedTab` (da `embed/protocol.ts`), `TAB_LABELS: Record<PanelTab, string>`
    (`Alfred`, `Da confermare`, `Bollettino`, `Lucius`), `TAB_ORDER: readonly PanelTab[]` (`alfred, pending, bulletin, lucius`).
  - `panel-state.ts`:
    ```ts
    export interface PanelState {
      open: boolean;
      tab: PanelTab;
      /** Bozza da mettere nel campo della scheda `draftTab`; `nonce` cresce a ogni passaggio di consegne. */
      draft: { tab: PanelTab; text: string } | null;
      nonce: number;
      pageLucius: ChatTarget | null;
      override: ChatTarget | null;
    }
    export type PanelAction =
      | { type: "open"; tab?: PanelTab } | { type: "close" } | { type: "selectTab"; tab: PanelTab }
      | { type: "handoff"; target: ChatTarget; draft: string } | { type: "setPageSubject"; lucius: ChatTarget | null }
      | { type: "navigate" } | { type: "clearOverride" };
    export const INITIAL_PANEL_STATE: PanelState; // chiuso, scheda alfred, tutto null, nonce 0
    export function panelReducer(state: PanelState, action: PanelAction): PanelState;
    export function luciusTarget(state: PanelState): ChatTarget | null; // override ?? pageLucius
    ```
  - `page-subject.ts`: `pageFromPath(path: string): PageContext`, `handoffTarget(payload, currentPage)` come oggi.

- [ ] **Step 1: Scrivi i test che falliscono** in `panel-state.test.ts`:
  - `open senza scheda apre sulla scheda corrente`; `open con scheda la seleziona`; `close chiude e lascia la scheda`.
  - `handoff verso Alfred`: da `{tab: "lucius"}` con `{kind:"alfred", page:{page:"console"}}` e `"ciao"` → `open: true`,
    `tab: "alfred"`, `draft: {tab:"alfred", text:"ciao"}`, `nonce` +1, `override` invariato.
  - `handoff verso Lucius su un altro argomento sostituisce`: `pageLucius` = `{kind:"plan", appId:1}`, target
    `{kind:"character", subjectType:"agent", subjectId:"5", title:""}` → `tab: "lucius"`, `override` = target,
    `luciusTarget(state)` = target.
  - `handoff verso Lucius sull'argomento della pagina non sostituisce`: target `{kind:"plan", appId:1}` uguale a `pageLucius`
    (confronto con `targetKey`) → `override: null`.
  - `navigate chiude e toglie la sostituzione`: → `open: false`, `override: null`, `draft: null`, `pageLucius` invariato.
  - `setPageSubject cambia l'argomento senza toccare la sostituzione`; `clearOverride` → `luciusTarget` = `pageLucius`.
  In `page-subject.test.ts`: `pageFromPath` per `/`, `/teams`, `/teams/7`, `/runs/3`, `/pending-actions`, `/agents` →
  `dashboard`, `teams`, `{team,"7"}`, `{run,"3"}`, `pending_actions`, `console`; `handoffTarget` per `to: alfred`,
  `plan` con id valido e non valido (`"abc"` → null), `team`, `agent`, `to` sconosciuto → null.
- [ ] **Step 2: Esegui** `pnpm --filter @workspace/casello run test` → FAIL (moduli mancanti).
- [ ] **Step 3: Implementa** `tabs.ts`, `panel-state.ts` (confronto degli argomenti con `targetKey` di
  `components/characters/adapters.ts`) e `page-subject.ts`; in `handoff-context.tsx` togli le copie e reimporta.
- [ ] **Step 4: Esegui** test e `pnpm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(casello): stato puro del pannello unico e argomento della pagina`.

### Task 2: Voce condivisa

**Files:**
- Create: `artifacts/casello/src/components/panel/voice-context.tsx`

**Interfaces:**
- Consumes: `useAlfredVoice()`, `AlfredVoice` da `components/alfred/use-alfred-voice.ts`.
- Produces: `AlfredVoiceProvider({children})` (chiama `useAlfredVoice()` una volta e la mette nel contesto),
  `useSharedAlfredVoice(): AlfredVoice` (senza provider lancia `Error("AlfredVoiceProvider mancante")`).

- [ ] **Step 1: Implementa** il file (nessun test: è solo un contesto; lo coprono typecheck e prova a mano).
- [ ] **Step 2: Esegui** `pnpm run typecheck` → PASS.
- [ ] **Step 3: Commit** `feat(casello): voce di Alfred condivisa in un provider`.

### Task 3: Provider, ambiente, schede e corpo del pannello

**Files:**
- Create: `artifacts/casello/src/components/panel/panel-context.tsx`
- Create: `artifacts/casello/src/components/panel/panel-link.tsx`
- Create: `artifacts/casello/src/components/panel/botcave-panel.tsx`
- Create: `artifacts/casello/src/components/panel/tabs/alfred-tab.tsx`, `pending-tab.tsx`, `bulletin-tab.tsx`,
  `lucius-tab.tsx` (con `git mv` da `embed/tabs/`, poi adattati)
- Modify: `artifacts/casello/src/embed/tab-content.tsx` (temporaneo: importa le schede dal nuovo percorso; si elimina nel Task 4)

**Interfaces:**
- Consumes: Task 1 (`panelReducer`, `luciusTarget`, `TAB_*`, `PanelTab`), Task 2 (`useSharedAlfredVoice`).
- Produces:
  ```ts
  export type PanelEnv =
    | { surface: "console" }
    | { surface: "embed"; appSlug: string; appName: string | null; hostContext: HostContextMsg | null; onClose(): void };
  export function PanelProvider(props: { env: PanelEnv; children: ReactNode }): JSX.Element;
  export function usePanel(): {
    state: PanelState; env: PanelEnv;
    openPanel(tab?: PanelTab): void; closePanel(): void; selectTab(tab: PanelTab): void;
    handoff(target: ChatTarget, draft: string): void; clearOverride(): void;
    /** Contesto di Alfred: pageFromPath(location) nella console, alfredPageContext(appSlug, hostContext) nell'embed. */
    alfredPage: PageContext;
    hasUnsavedChanges(): boolean;
  };
  export function usePanelSubject(opts: { lucius: ChatTarget | null; hasUnsavedChanges?: () => boolean }): void;
  export function PanelLink(props: { path: string; className?: string; children: ReactNode }): JSX.Element;
  export function BotcavePanel(): JSX.Element;
  ```
- Regole di `PanelProvider`: con `surface: "console"` osserva `useLocation()` e su ogni cambio dispatcha `navigate`;
  `hasUnsavedChanges` sta in un ref (non nel riduttore). `usePanelSubject` dispatcha `setPageSubject` quando cambia
  `targetKey(lucius)` (o `null`), aggiorna il ref del controllo a ogni render e nel cleanup dello smontaggio dispatcha
  `setPageSubject(null)` e azzera il ref. Nell'embed `closePanel` chiama `env.onClose()`.
- `PanelLink`: console → `<Link href={path}>` di wouter; embed → `<a href={consoleUrl(window.location.origin, path)} target="_blank" rel="noopener">`.
- `BotcavePanel`: l'intestazione della `Shell` di oggi (segno, `tablist` con `TAB_ORDER`/`TAB_LABELS`, «Chiudi» →
  `closePanel()`) e il `tabpanel` con la scheda di `state.tab`. Classi del contenitore: `flex h-full min-h-0 flex-col bg-surface-1 text-ink`.
- Schede:
  - `AlfredTab()`: voce da `useSharedAlfredVoice()`; `AlfredVoiceBar` di oggi con «Apri Account in Botcave» come
    `<PanelLink path="/account">`; solo con `surface: "console"` un `<PanelLink path="/alfred">A tutto schermo</PanelLink>`
    accanto al pulsante; sotto `CharacterChat` con `{kind: "alfred", page: alfredPage}`, `draft` se `state.draft?.tab === "alfred"`,
    `key={state.nonce}`, `hasUnsavedChanges`.
  - `PendingTab()`: console → `PendingActionItem` con `onOpenDetails={() => setSelected(a.number)}` più `ActionDialog`
    (come `pages/pending-actions.tsx`); embed → `consoleHref` come oggi.
  - `BulletinTab()`: collegamento alla squadra con `PanelLink path={`/teams/${id}`}`.
  - `LuciusTab()`: se `state.override` → riga in cima «Torna a <etichetta>» (`subjectLabel` della pagina, o «Torna
    indietro» se `pageLucius` è null; pulsante `link` → `clearOverride()`) e `CharacterChat` sull'override; altrimenti
    embed → logica di oggi sullo slug (`findAppBySlug`, «non è ancora registrata»); console → `pageLucius` oppure segno di
    Lucius + `Led idle` con «Lucius lavora su app, agenti, skill, modelli di squadra e squadre: apri una di queste pagine».
    `draft` e `key={state.nonce}` come per Alfred.
  - Etichetta per «Torna a…»: `targetLabel(target: ChatTarget): string` in `page-subject.ts` (`plan` → «piano dell'app»,
    `team` → «chat della squadra», `character` → `SUBJECT_LABELS[subjectType]` + titolo se presente); un test in
    `page-subject.test.ts` per i tre rami.

- [ ] **Step 1: Scrivi il test** di `targetLabel` → FAIL.
- [ ] **Step 2: Implementa** i file sopra; `CharacterChat` per ora resta su `useHandoff`.
- [ ] **Step 3: Esegui** test e typecheck → PASS.
- [ ] **Step 4: Commit** `feat(casello): pannello unico a schede condiviso tra console ed embed`.

### Task 4: Montaggio nelle due superfici e passaggio di consegne

**Files:**
- Modify: `artifacts/casello/src/components/characters/character-chat.tsx` (`useHandoff` + `pageFromPath(location)` →
  `const { handoff, alfredPage } = usePanel()` e `handoffTarget(p.payload, alfredPage)`; togli `useLocation` se non serve
  più; con `layout="sheet"` togli `pr-12` dall'intestazione: la X dello `Sheet` non c'è più)
- Modify: `artifacts/casello/src/components/ui/sheet.tsx` (prop `hideClose?: boolean` su `SheetContent` che non rende
  `SheetPrimitive.Close`)
- Modify: `artifacts/casello/src/App.tsx` (dentro `AuthGate`: `AlfredVoiceProvider` > `PanelProvider env={{surface:"console"}}` >
  `AppShell` + `ConsolePanelSheet`, al posto di `HandoffProvider`)
- Create: `artifacts/casello/src/components/panel/console-panel-sheet.tsx` (`Sheet` aperto da `state.open`,
  `onOpenChange(false)` → `closePanel()`, `SheetContent side="right" hideClose className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]"`,
  `SheetTitle`/`SheetDescription` `sr-only` «Botcave» / «Pannello di Alfred e Lucius», dentro `BotcavePanel`)
- Modify: `artifacts/casello/src/embed/embed-app.tsx` (`Shell` → `AlfredVoiceProvider` > `PanelProvider env={{surface:"embed", appSlug, appName, hostContext, onClose: () => host.post({botcave:1, type:"close"})}}` > `BotcavePanel`;
  un componente figlio chiama `openPanel(openRequest.tab)` su ogni nuovo `openRequest`; `usePanelOpen`/`useBadge` restano;
  togli `HandoffProvider`)
- Delete: `components/characters/handoff-context.tsx`, `components/characters/character-sheet.tsx`, `embed/tab-content.tsx`
- Modify: `components/characters/character-button.tsx` → `LuciusButton()` («Chiedi a Lucius» con `LuciusMark`, `openPanel("lucius")`);
  rinomina il file in `lucius-button.tsx`

**Interfaces:**
- Consumes: Task 3 (`PanelProvider`, `usePanel`, `BotcavePanel`), Task 2 (`AlfredVoiceProvider`).
- Produces: `LuciusButton(): JSX.Element` (nessuna prop), usato dal Task 5.

- [ ] **Step 1: Applica** le modifiche; le pagine che usano ancora `CharacterButton` le converte il Task 5, quindi in questo
  task sostituisci gli import con `LuciusButton` dove il bersaglio era Lucius e togli i pulsanti con Alfred, senza ancora
  aggiungere `usePanelSubject` (lo fa il Task 5).
- [ ] **Step 2: Esegui** `pnpm run typecheck` e i test → PASS; `grep -rn "handoff-context\|CharacterSheet\|CharacterButton" artifacts/casello/src` → nessun risultato.
- [ ] **Step 3: Commit** `feat(casello): console ed embed montano lo stesso pannello`.

### Task 5: Pagine, pulsante nella caverna, `/alfred`

**Files:**
- Modify (con `usePanelSubject`, argomenti della tabella §4.1 della spec):
  `pages/agents.tsx`, `pages/skills.tsx`, `pages/team-templates.tsx` (aree), `pages/agent-detail.tsx` (`agent`,
  `hasUnsavedChanges: () => dirtyRef.current || toolsDirtyRef.current`), `pages/skill-detail.tsx` (`skill`),
  `pages/team-template-detail.tsx` (`team_template`, `hasUnsavedChanges: () => dirtyRef?.current ?? false`),
  `pages/app-detail.tsx`, `pages/analysis-detail.tsx`, `pages/app-plan.tsx` (`{kind:"plan", appId}`),
  `pages/team-detail.tsx` (`{kind:"team", instanceId, closed}`, `hasUnsavedChanges: () => dirtyRef.current`).
  Il bersaglio passato è quello che il `CharacterButton` di ogni pagina aveva prima (stessi `subjectId` e `title`); mentre la
  pagina carica, `lucius: null`.
- Modify: `components/layout/app-shell.tsx` (`CaveHeader`: al posto del `<Link href="/alfred"><Mic/>` un pulsante
  `variant="ghost"` con classi della barra di oggi, `AlfredMark size={20} tone="light"`, contatore se `pending > 0`
  (`font-mono bg-brand text-on-brand`, stesse classi del badge del menu senza `SidebarMenuBadge`), `Led state="work"` se
  `useSharedAlfredVoice().status !== "stopped"`, `aria-label` «Apri Alfred» o «Apri Alfred, <n> voci da confermare»,
  `onClick` → `openPanel("alfred")`; `pending` da `useGetDashboardStats` con `getGetDashboardStatsQueryKey()` e
  `refetchInterval: 30_000`; togli l'import di `Mic`)
- Modify: `pages/alfred.tsx` (`useAlfredVoice()` → `useSharedAlfredVoice()`)

**Interfaces:**
- Consumes: Task 3 (`usePanelSubject`, `usePanel`), Task 2 (`useSharedAlfredVoice`), Task 4 (`LuciusButton`).

- [ ] **Step 1: Applica** le modifiche.
- [ ] **Step 2: Verifica** `grep -rn "useAlfredVoice()" artifacts/casello/src` → una sola riga, in `components/panel/voice-context.tsx`.
- [ ] **Step 3: Esegui** typecheck e test → PASS.
- [ ] **Step 4: Commit** `feat(casello): le pagine guidano Lucius e Alfred si apre dalla caverna`.

### Task 6: Documentazione e prova a mano

**Files:**
- Modify: `CLAUDE.md` (sezioni indicate dal §9 della spec: «Identità Botcave», «Alfred e Lucius nelle aree», «Botcave
  incorporabile», più l'elenco dei file in «Dove stanno le cose»)

- [ ] **Step 1: Aggiorna** `CLAUDE.md`.
- [ ] **Step 2: Prova a mano** con `AUTH_DISABLED=true pnpm run dev` (serve `DATABASE_URL` di sviluppo) nel browser
  integrato, a 1280 px e con il preset mobile, tema chiaro e scuro: contatore nella caverna e badge del menu uguali dopo
  una decisione dal pannello; quattro schede; voce avviata su `/alfred` che resta attiva cambiando pagina e si ritrova
  nella scheda Alfred; Lucius sull'argomento di ogni pagina della tabella; passaggio di consegne nei due versi con «Torna
  a…»; nessuno scorrimento orizzontale (`document.documentElement.scrollWidth <= innerWidth`). `embed-demo.html`: quattro
  schede, «Chiudi», contatore. Se il DB di sviluppo non è disponibile, dirlo nella PR come non verificato.
- [ ] **Step 3: Esegui** `pnpm run typecheck` e `pnpm --filter @workspace/casello run test` → PASS.
- [ ] **Step 4: Commit** `docs(casello): pannello unico in CLAUDE.md`.
