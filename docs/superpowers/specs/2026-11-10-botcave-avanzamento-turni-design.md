# Botcave · Avanzamento visibile dei turni nelle chat

Data: 2026-11-10. Stato: approvata nel design, da rivedere per iscritto.

## 1. Perché

Da quando Lucius legge il codice (PR #79, #80) un turno può durare fino a 240 s e 12 giri. In una prova su The Hub Up Ivan ha
aspettato a lungo davanti a «Lucius sta pensando…» senza sapere se il lavoro avanzava. Obiettivo: mentre un turno è in corso la chat
mostra i passi che il personaggio sta facendo («Cerca "registerRoutes" nel codice», «Legge server/routes.ts»), come i messaggi di
attesa di Claude Code. Riuscito = in un turno lungo i passi compaiono e avanzano entro ~2 s da quando avvengono.

Fuori ambito: il turno rimasto «in corso» dopo un deploy (lo corregge un'altra sessione con un controllo dei turni scaduti),
le run degli agenti (hanno già la timeline dei passi), la voce di Alfred (Gemini Live).

## 2. Decisioni

- Chat coinvolte: chat del piano, conversazioni dei personaggi (filo di Alfred scritto, Lucius sugli argomenti), chat di squadra;
  in console e nel pannello incorporato (stesso componente `CharacterChat`).
- I passi stanno **solo in memoria** nel processo dell'API: nessuna migrazione. Dopo un riavvio il turno fallisce comunque, quindi
  non si perde nulla di utile. L'API gira in un solo container: se un giorno ne avesse più d'uno i passi andrebbero spostati nel DB.
- A turno finito i passi **spariscono**: restano la risposta e le schede.
- Resa: **elenco** degli ultimi passi, i fatti attenuati, quello in corso con il LED `work`, e il tempo trascorso.
- Esecutori: modello cloud, Claude Code sul nodo e ripiego dal nodo al cloud, tutti allo stesso modo.

## 3. Dove si aggancia

Le tre chat eseguono il turno con `runChatTurn` (`lib/node-turns/chat-turn.ts`) passando una sola funzione `runTool`. Il ciclo cloud
(`runPlanTurn`) la chiama per ogni tool call, e i turni sul nodo fanno passare le chiamate di Claude Code da `/mcp/turn` allo stesso
dispatcher (`delegateTurn` con `dispatch: input.runTool`). Il ripiego richiama `cloudTurn` con la stessa `runTool`. Quindi c'è un punto
unico: `runChatTurn` avvolge `runTool` e registra i passi.

## 4. Registro dei passi (`lib/turn-progress/`)

- `progress.ts`: mappa in memoria con chiave `<consumer>:<conversationId>` (`consumer` = `plan_chat` | `team_chat` | `character`,
  gli stessi valori di `ChatTurnInput.consumer`).
  - `beginTurnProgress(consumer, refId)`: nuova voce `{startedAt, steps: [], omitted: 0}`; sostituisce un'eventuale voce rimasta.
  - `startStep(consumer, refId, text)` → id del passo (`running`); `finishStep(consumer, refId, stepId)` → `done`. Su una voce
    inesistente (turno già finito) non fanno nulla.
  - Si tengono gli ultimi 8 passi (`PROGRESS_MAX_STEPS`); quelli tolti si contano in `omitted`. Al più 200 passi per turno
    contati (oltre, `omitted` resta fermo: il turno ha comunque limiti di giri).
  - `endTurnProgress(consumer, refId)`: toglie la voce.
  - `readTurnProgress(consumer, refId)`: copia `{startedAt, steps: [{text, status}], omitted}` o null.
- `runChatTurn`: `beginTurnProgress` all'inizio, `endTurnProgress` in un `finally` (anche su errore o eccezione), e `runTool`
  avvolta: `startStep(describeStep(call.name, call.arguments))`, poi `finishStep` quando lo strumento risponde, anche con un
  errore o un'eccezione (che risale come prima).
- Strumenti in parallelo (Claude Code può chiamarne più d'uno insieme): ogni chiamata ha il suo passo; più passi possono essere
  `running` insieme.

## 5. Testi dei passi (`lib/turn-progress/describe.ts`)

`describeStep(name, rawArgs): string`, funzione pura. Frase fissa in italiano per strumento; degli argomenti entra solo un elenco
chiuso di campi, ripuliti: JSON non valido o campo assente → la frase senza il campo. Pulizia del campo: caratteri di controllo e
a capo diventano spazi, spazi ripetuti ridotti, al più 80 caratteri (poi «…»); vuoto → frase senza il campo.

| Strumento | Testo |
|---|---|
| `leggi_file` | Legge `<percorso>` (con «, righe a–b» se presenti `daRiga`/`aRiga` interi) |
| `elenca_cartella` | Guarda la cartella `<percorso>` (radice se vuoto: «Guarda la radice del codice») |
| `cerca_nel_codice` | Cerca "`<testo>`" nel codice (con « in `<glob>`» se presente) |
| `read_item` | Rilegge la voce `<ref>` del piano |
| `read_app` | Legge l'app `<slug>` |
| `propose` | Prepara una scheda |
| `leggi_squadra` | Legge la squadra |
| `leggi_skill`, `leggi_versione_skill` | Legge la skill `<codice>` |
| `leggi_strumento`, `leggi_strumenti_app` | Legge gli strumenti dell'app |
| `leggi_agente` | Legge l'agente |
| `leggi_modello` | Legge il modello di squadra |
| `elenca_agenti` / `elenca_skill` / `elenca_modelli` | Scorre gli agenti / le skill / i modelli di squadra |
| `proponi_*` (tutti gli altri) | Prepara una scheda |
| `passa_a` | Prepara il passaggio di consegne |
| `ricorda`, `aggiorna_appunto` | Prende un appunto |
| `dimentica` | Toglie un appunto |
| `cerca_nello_storico` | Cerca negli incontri passati |
| `squadre_stato` | Controlla le squadre |
| `squadra_dettaglio` | Legge il dettaglio di una squadra |
| `bollettino` | Legge il bollettino |
| `coda_da_confermare` | Guarda la coda da confermare |
| `leggi_proposta` | Legge la proposta n. `<numero>` (intero) |
| `scrivi_al_capo` | Scrive al capo della squadra |
| `elenca_app` | Scorre le app |
| `chiedi_al_responsabile` | Chiede al Responsabile di `<app>` |
| `leggi_run` | Legge l'esito di una run |
| altro | Usa uno strumento |

Mai nei testi: contenuto del codice o dei risultati, testi delle schede, appunti, messaggi al capo o ai Responsabili, valori
`x-sensitive`, indirizzi delle app. Percorsi, testi cercati, glob, slug e codici delle skill sì (vengono dal modello, servono a capire
cosa fa). Lo `<app>` del codice (slug) non entra nei testi del codice: il percorso basta.

## 6. API (contract-first)

Schema nuovo `TurnProgress`:

```yaml
TurnProgress:
  type: object
  required: [startedAt, steps, omitted]
  properties:
    startedAt: { type: string, format: date-time }
    steps:
      type: array
      items:
        type: object
        required: [text, status]
        properties:
          text: { type: string }
          status: { type: string, enum: [running, done] }
    omitted: { type: integer, description: Passi precedenti non più elencati }
```

Campo facoltativo `progress` (`TurnProgress` o null) in `PlanConversationDetail`, `TeamChatConversationDetail` e
`CharacterConversationDetail` (vale anche per il filo di Alfred). Valorizzato solo con `turnStatus = running` e una voce nel
registro; altrimenti null. Le GET esistenti non cambiano altro; nessuna route nuova; ambiti e limiti invariati. Codegen Orval.

## 7. Console

- Gli adattatori (`character-adapters.ts`, `plan-team-adapters.tsx`) portano `progress` nel modello comune di `adapters.ts`.
- `character-chat.tsx`: al posto della riga «<nome> sta pensando…», il componente `TurnProgressView`:
  - se ci sono passi tolti, una riga attenuata «… e altri n passi»;
  - un passo per riga, i `done` in `text-ink-muted`, i `running` con `Led work`;
  - se nessun passo è `running`, l'ultima riga è «<nome> ragiona…» con `Led work` (senza passi: «<nome> sta pensando…», come oggi);
  - il tempo trascorso «· 42 s» (da `startedAt`, aggiornato ogni secondo; oltre 60 s «1 min 05 s»), in `font-mono`.
- La preparazione delle righe è una funzione pura (`turn-progress.ts`) con test Vitest. `aria-live="polite"` resta sul contenitore.
- Polling invariato (1,5 s). Niente scorrimento orizzontale: i testi vanno a capo (`break-words`).

## 8. Errori e casi limite

- Turno che finisce tra due letture: la GET successiva ha `turnStatus = idle` e `progress` null; la UI rilegge come oggi.
- `turnStatus = running` senza voce nel registro (turno appena avviato, o rimasto dopo un riavvio): `progress` null, la UI mostra
  «sta pensando…» come oggi.
- Eccezione in `describeStep`: impossibile per costruzione (try su `JSON.parse`, nessun accesso a proprietà non verificate); comunque
  il testo ripiega su «Usa uno strumento».
- Memoria: al più una voce per conversazione con turno in corso, 8 passi ciascuna; tolta nel `finally`.

## 9. Prove

- `describe.test.ts`: ogni riga della tabella, troncamento, a capo e controlli, JSON non valido, campi di tipo sbagliato, strumento
  sconosciuto, nessun argomento fuori elenco nel testo (es. `testo` di `scrivi_al_capo`).
- `progress.test.ts`: inizio/fine, finestra di 8 con `omitted`, passi su voce inesistente, sostituzione di una voce rimasta.
- `chat-turn` (cloud con modello finto): durante una tool call il registro ha il passo `running`, dopo `done`; a fine turno vuoto,
  anche con errore del modello e con eccezione di `runTool`.
- Route: GET della conversazione con turno in corso (registro valorizzato a mano) → `progress`; idle → null; per le tre chat.
- Console: `turn-progress.test.ts` sulle righe (passi tolti, «ragiona…», tempo).
- Nessuna migrazione, nessuna variabile nuova.
