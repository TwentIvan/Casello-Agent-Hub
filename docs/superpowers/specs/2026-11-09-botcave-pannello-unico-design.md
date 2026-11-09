# Botcave: un solo pannello di Alfred, nella console e nelle app ospiti

Data: 9 novembre 2026. Stato: approvato a voce con Ivan, da rileggere per iscritto.

## 1. Obiettivo

Da qualunque app, console di Botcave compresa, Alfred apre **lo stesso pannello**: quattro schede (Alfred con la voce
dentro, Da confermare, Bollettino, Lucius) e un solo insieme di componenti condiviso tra la console e la pagina `/embed`
del plugin. La pagina `/alfred` resta come voce a tutto schermo per il telefono.

Oggi nella console ci sono tre cose separate: il pulsante «Chiedi ad Alfred» (`CharacterButton`) che apre un pannello con
la sola chat scritta, il microfono nella barra della caverna che porta a `/alfred`, e Lucius con il suo pulsante per
argomento. Il pannello incorporato nelle app ospiti ha invece le quattro schede, la voce nella scheda Alfred e il contatore.

Vincoli: lavoro solo della console (`artifacts/casello`), nessuna modifica all'API, nessuna migrazione, nessuna variabile
nuova. Identità di `design/` (token, LED per gli stati, niente ombre), niente scorrimento orizzontale a 1280 px.

## 2. Decisioni

| Tema | Scelta |
|---|---|
| Lucius nella console | Diventa la scheda Lucius del pannello e **segue la pagina**: ogni pagina dichiara il suo argomento |
| Pulsante unico | Nella barra della caverna, al posto del microfono, con il contatore delle voci da confermare |
| Voce | **Una sola** per tutta la console: la condividono la scheda Alfred e la pagina `/alfred` |
| «Chiedi ad Alfred» nelle pagine | Tolti: li sostituisce il pulsante nella caverna (Alfred sa già la pagina da `pageFromPath`) |
| «Chiedi a Lucius» nelle pagine | Restano come scorciatoia: aprono il pannello sulla scheda Lucius |
| Passaggio di consegne | Diventa un cambio di scheda con la domanda già scritta, non un secondo pannello |

## 3. Architettura

### 3.1 Componenti condivisi (`artifacts/casello/src/components/panel/`)

- `botcave-panel.tsx` (`BotcavePanel`): intestazione con il segno Botcave, le quattro schede (`role="tablist"`, etichette
  con `truncate`) e «Chiudi»; sotto, il contenuto della scheda attiva (`role="tabpanel"`, `min-w-0`, `overflow-x-hidden`).
  È l'attuale `Shell` di `embed/embed-app.tsx` senza le parti dell'ospite.
- `tabs/` (`alfred-tab.tsx`, `pending-tab.tsx`, `bulletin-tab.tsx`, `lucius-tab.tsx`, spostati da `embed/tabs/`) e
  `tabs.ts` con `PanelTab` (`alfred | pending | bulletin | lucius`, lo stesso insieme di `EmbedTab` del protocollo),
  `TAB_LABELS` e `TAB_ORDER`.
- `panel-context.tsx`: `PanelProvider` e gli hook del pannello (§3.3); contiene l'**ambiente** (§3.2).
- `panel-state.ts`: logica pura dello stato del pannello (riduttore), con i test.
- `page-subject.ts`: logica pura spostata da `components/characters/handoff-context.tsx`: `pageFromPath` e
  `handoffTarget` (invariate), con i test.
- `voice-context.tsx`: `AlfredVoiceProvider` (una sola istanza di `useAlfredVoice`) e `useSharedAlfredVoice()`.

`CharacterChat`, gli adattatori (`adapters.ts`, `character-adapters.ts`, `plan-team-adapters.tsx`), le schede delle proposte
e `use-alfred-voice.ts` restano dove sono e non cambiano comportamento.

### 3.2 Ambiente: l'unica differenza tra console ed embed

`PanelProvider` riceve un ambiente:

| | Console | Embed |
|---|---|---|
| Collegamenti alla console (`PanelLink`) | `<Link>` interno di wouter | nuova scheda (`target="_blank"`, `rel="noopener"`), `consoleUrl` |
| Contesto di Alfred | pagina della console: `pageFromPath(location)` | pagina ospite: `alfredPageContext(appSlug, hostContext)` |
| Argomento di Lucius della pagina | dichiarato dalla pagina (§4) | chat del piano dell'App con lo slug di `data-app` (come oggi; «non è ancora registrata» se manca) |
| Da confermare | «Apri i dettagli» apre il dialogo della voce (`ActionDialog`), come la pagina «Da confermare»: anche i piani si approvano dal pannello | invariato: piani e voci con token utente → «Apri in Botcave» |
| «Chiudi» | chiude lo `Sheet` | manda `close` al caricatore |
| Dove si mostra | `Sheet` a destra, ~440 px su desktop, a schermo intero sul telefono | a piena altezza nell'iframe |

### 3.3 Stato del pannello

`PanelProvider` tiene: aperto/chiuso, scheda attiva, bozza per la scheda (con un contatore `nonce` che fa rimontare la
chat quando arriva una bozza nuova), argomento di Lucius della pagina, argomento di Lucius sostituito da un passaggio di
consegne, `hasUnsavedChanges` della pagina. Hook:

- `usePanel()` → `openPanel(tab?)`, `closePanel()`, `handoff(target, draft)`.
- `usePanelSubject({ lucius, hasUnsavedChanges? })` → la pagina dichiara l'argomento di Lucius e il controllo delle
  modifiche non salvate; si toglie quando la pagina si smonta.

Riduttore puro (`panel-state.ts`), azioni: `open {tab?}`, `close`, `selectTab`, `handoff {target, draft}`,
`setPageSubject`, `navigate` (cambio di pagina), `clearOverride`.

### 3.4 Montaggio

- **Console**: in `App.tsx` `AlfredVoiceProvider` e `PanelProvider` (ambiente console) prendono il posto di
  `HandoffProvider`, dentro l'`AuthGate` (al logout si smontano e la voce si ferma). Il pannello è uno `Sheet` con
  `BotcavePanel`.
- **Embed**: la `Shell` di `embed-app.tsx` diventa `AlfredVoiceProvider` + `PanelProvider` (ambiente embed) +
  `BotcavePanel` in linea. Restano in `embed/`: collegamento OAuth (`auth.ts`, `callback.ts`), `use-host.ts`,
  `protocol.ts`, `use-badge.ts`, `theme.ts`, caricatore. La richiesta `open {tab}` dell'ospite chiama `openPanel(tab)`.

### 3.5 Cosa si toglie

`components/characters/character-sheet.tsx`, `components/characters/handoff-context.tsx` (la logica pura va in
`page-subject.ts`, `useHandoff` diventa `usePanel().handoff`), `embed/tab-content.tsx`, `embed/tabs/`. `CharacterButton`
resta solo come «Chiedi a Lucius» (`LuciusButton`, §4.2).

## 4. Lucius che segue la pagina

### 4.1 Argomento per pagina

| Pagina | Argomento di Lucius |
|---|---|
| Agenti, Skill, Modelli di squadra (elenchi) | `area_agents`, `area_skills`, `area_team_templates` |
| Scheda agente, skill, modello di squadra | `agent`, `skill`, `team_template` sull'oggetto |
| Scheda app, pagina dell'analisi, piano `/apps/:id/plan` | chat del piano dell'app (`kind: "plan"`) |
| Scheda squadra | chat di squadra (`kind: "team"`) |
| Dashboard, Squadre, Da confermare, Run, dettaglio run, Modelli AI, Account, `/alfred` | nessuno |

Sulle pagine senza argomento la scheda Lucius mostra il segno di Lucius e il LED `idle` con «Lucius lavora su app,
agenti, skill, modelli di squadra e squadre: apri una di queste pagine». Sulla pagina del piano la scheda mostra la stessa
chat della pagina (stesso backend, stesse conversazioni).

### 4.2 Pulsanti nelle pagine

- I `CharacterButton` con Alfred (Dashboard, Squadre, scheda squadra, Da confermare, Run, dettaglio run) si tolgono.
- I `CharacterButton` con Lucius diventano `LuciusButton` («Chiedi a Lucius», stesso aspetto di oggi): aprono il pannello
  sulla scheda Lucius. L'argomento non lo passano più loro: lo dichiara la pagina con `usePanelSubject`.
- `hasUnsavedChanges` lo dichiarano la scheda agente (prompt e caselle degli strumenti), la scheda squadra e la scheda
  modello di squadra con `usePanelSubject`; vale per entrambe le schede del pannello (prima di accettare una scheda
  compare l'avviso, come oggi).

### 4.3 Navigazione

Cambiando pagina il pannello si chiude, come oggi (lo `Sheet` copre la pagina; un collegamento cliccato dal pannello porta
a vedere quella pagina) e l'argomento sostituito da un passaggio di consegne si toglie. Alla riapertura la scheda Lucius è
sull'argomento della pagina nuova; la scheda attiva resta l'ultima scelta, salvo aperture con una scheda esplicita
(pulsante nella caverna → Alfred, «Chiedi a Lucius» → Lucius).

### 4.4 Passaggio di consegne

La scheda `handoff` di una conversazione (`passa_a`) chiama `usePanel().handoff(target, draft)`:

- verso Alfred: scheda Alfred con la domanda nel campo, non inviata;
- verso Lucius: scheda Lucius con la domanda nel campo; se il bersaglio è diverso dall'argomento della pagina, la scheda
  usa quello del passaggio finché non si cambia pagina, con in cima «Torna a <argomento della pagina>» (o «Torna
  indietro» se la pagina non ne ha uno) che lo toglie.

Vale uguale nell'embed (oggi lì il passaggio apre uno `Sheet` dentro l'iframe).

## 5. Alfred

### 5.1 Pulsante nella barra della caverna

Al posto del microfono in `CaveHeader` (`components/layout/app-shell.tsx`): segno di Alfred chiaro su scuro
(`AlfredMark tone="light"`), accanto il contatore se ci sono voci in attesa (mono su `bg-brand`, `text-on-brand`, come il
badge del menu) e il LED `work` mentre la voce è attiva. Etichetta accessibile «Apri Alfred» con, se ci sono, «, <n> voci
da confermare». Apre il pannello sulla scheda Alfred. Il numero è `pendingActions` di `GET /api/dashboard/stats`, con la
stessa chiave di query del badge del menu (30 s): i due restano allineati. Quando una voce si decide nel pannello si
invalidano la coda e le statistiche. Il badge su «Da confermare» nel menu resta.

### 5.2 Scheda Alfred

In cima la barra della voce del plugin (`AlfredVoiceBar`: «Parla con Alfred» / «Basta così», LED di stato, ultime battute
in un riquadro scorrevole) e il collegamento «A tutto schermo» verso `/alfred` (solo nella console: nell'embed la pagina
è della console e si aprirebbe altrove senza la voce in corso); sotto il filo scritto (`CharacterChat` con
`{kind: "alfred", page}`). Gli errori della voce restano quelli di oggi; «Apri Account» è un `PanelLink`.

### 5.3 Voce unica

`AlfredVoiceProvider` tiene l'unica istanza di `useAlfredVoice` della console (e dell'iframe). La pagina `/alfred` e la
scheda Alfred la leggono con `useSharedAlfredVoice()`: la stessa sessione, due grafiche. Avviata su `/alfred`, la voce
continua cambiando pagina e si ritrova nella scheda Alfred; si ferma con «Basta così», al logout (il provider si smonta)
o chiudendo la scheda del browser. Così non si aprono mai due sessioni vocali nella stessa scheda (il server ne tiene una
per utente e farebbe cadere la prima con «Alfred è stato aperto su un altro dispositivo»).

### 5.4 Pagina `/alfred`

Stessa grafica di oggi (pulsante grande, avviso del modello mancante, trascrizione) e stesso manifest per l'iPhone, sulla
voce condivisa.

## 6. Errori

Nessun errore nuovo: restano i messaggi di oggi della voce, delle schede (coda, bollettino, app non registrata) e di
`CharacterChat`. Un argomento di Lucius eliminato nel frattempo si comporta come oggi (conversazione in sola lettura,
409 «argomento eliminato»).

## 7. Prove

- Vitest (`pnpm --filter @workspace/casello run test`):
  - `panel-state.test.ts`: apertura con e senza scheda, chiusura, passaggio di consegne verso Alfred e verso Lucius
    (bozza, `nonce`), argomento sostituito e «Torna a…», `navigate` che chiude e toglie la sostituzione, argomento della
    pagina che cambia;
  - `page-subject.test.ts`: `pageFromPath` e `handoffTarget` (casi di oggi);
  - test esistenti dell'embed verdi (protocollo, tema, rinnovo del token, coda del caricatore, `panel-helpers`).
- `pnpm run typecheck` verde.
- Prova a mano in locale (`AUTH_DISABLED=true pnpm run dev`) sulla console e su `embed-demo.html`, a 1280 px e a
  larghezza telefono, in tema chiaro e scuro: contatore, quattro schede, voce che resta attiva cambiando pagina e
  scheda, Lucius che segue la pagina, passaggio di consegne nei due versi, approvazione di una voce dal pannello, nessuno
  scorrimento orizzontale.

## 8. Fuori ambito

Modifiche all'API e al protocollo `postMessage`; pannello affiancato invece che sovrapposto; chat del piano a pagina
intera (resta su `/apps/:id/plan`); un contatore del bollettino sul pulsante della caverna (resta il badge su «Squadre»).

## 9. Documentazione

Aggiornare in `CLAUDE.md`: «Identità Botcave» (pulsante di Alfred nella caverna al posto del microfono), «Alfred e Lucius
nelle aree» (pannello unico a schede, `components/panel/`, argomento dichiarato dalle pagine) e «Botcave incorporabile»
(schede in `components/panel/tabs/`).
