# Botcave · The Hub Up 5c, tappa 2: via i doppioni

Data: 8 novembre 2026. Repository toccato: AbapCrm (The Hub Up). Botcave non cambia.

## 1. Obiettivo

Togliere da The Hub Up gli agenti AI interni che ora fa Botcave con gli inneschi (vedi "Inneschi" in `CLAUDE.md`), più il codice
morto, così che una mail nuova o un brief abbiano un solo autore: l'agente di Botcave, con le scritture in «Da confermare».

Criteri di fine:
- in The Hub Up nessun codice chiama più `analyzeMessage`, `updateMessageWithSuggestion`, `generateDocumentation` o
  `triggerBriefUpdate`; la cartella `server/botcave/` non esiste;
- una mail importata non riceve più collegamenti automatici da The Hub Up; la collega solo lo Smistatore di Botcave (agente 12,
  innesco «Nuove email»), dopo l'approvazione in «Da confermare»;
- il brief di progetto lo scrive solo il Curatore del brief di Botcave (agente 17, innesco «Task completati»);
- test verdi, nessun errore di tipo nuovo, nessuna migrazione, nessuna variabile nuova.

## 2. Contesto

Le tappe della 5c (proposta in `2026-11-07-botcave-the-hub-up-5b-design.md` §5, ordine deciso l'8 novembre 2026):

| Tappa | Cosa |
|---|---|
| 1 | Coda delle run, ambito `runs`, Responsabile di prodotto (fatta) |
| **2** | **Via i doppioni (questa spec)** |
| 3 | Server MCP di The Hub Up (`/mcp`), strumenti CRM e SAP con livelli |
| 4 | Agente di progetto e discussione delle proposte su Botcave |
| 5 | THU AI su Botcave (Esecutore ABAP; immagini e limiti per agente in Botcave) |
| 6 | Smontaggio finale: gateway AI, chiavi, pagine «Modelli AI»/«AI Analytics», `ai_pending_actions`, pattern → skill o memoria |

Inneschi in produzione dall'8 novembre 2026: «Nuove email» (id 1, agente 12, `list_messages` con `summary: true`, ogni 2 minuti) e
«Task completati» (id 2, agente 17, `list_tasks` con filtro `status = completed` e versione `completedAt`, ogni 5 minuti). Entrambi
gli agenti hanno la conferma delle scritture accesa.

Il collegamento a spinta della tappa 1 lato The Hub Up (`server/botcave/`, variabili `BOTCAVE_*`) non è mai stato configurato in
produzione e gli inneschi lo sostituiscono per email e brief.

## 3. Cosa si toglie (AbapCrm)

### 3.1 Smistamento email interno (agente 1 dell'inventario)

- `server/imap-service.ts`: il blocco «Run AI analysis» dopo il salvataggio della mail (`analyzeMessage` +
  `updateMessageWithSuggestion`, attivo solo con `OPENAI_API_KEY`) e il ramo «Smistamento su Botcave» che lo precede.
- `server/routes.ts`: le stesse chiamate in background in `POST /api/messages` e nella normalizzazione delle chat (la route che crea un
  messaggio da una chat incollata); le route `POST /api/messages/:id/analyze` e `POST /api/messages/:id/apply-suggestion`.
- `client/src/pages/messages-page.tsx`: `analyzeMutation`, `applySuggestionMutation`, i loro gestori e il pulsante che li usa.
- Restano le colonne `messages.projectId/taskId/partnerId/confidenceScore/matchingReason/isManuallyVerified` e la loro
  visualizzazione: sono dati, li scrive anche lo Smistatore di Botcave con i suoi tool.

### 3.2 Brief interno (agente 6)

- Eliminati `server/context-maintainer.ts` e `server/context-maintainer.test.ts`.
- `server/ai-task-executor.ts`: tolti l'import e le due chiamate a `triggerBriefUpdate` (fine dell'esecuzione e chiusura dopo la
  registrazione dei pattern ABAP usati).
- Restano la tabella `context_packs`, le route che la leggono e quelle usate dai tool `get_project_brief`, `get_organization_brief`,
  `update_project_brief`.
- Conseguenza accettata: fino alla tappa 5 un'esecuzione di THU AI non aggiorna più il brief da sola; lo aggiorna il Curatore quando il
  task viene completato.

### 3.3 Instradamento a spinta verso Botcave

- Eliminata la cartella `server/botcave/` (`config.ts`, `routing.ts`, `inputs.ts`, `client.ts`, `botcave.test.ts`).
- `server/index.ts`: tolto l'avviso di `readBotcaveConfig`.
- Variabili non più lette: `BOTCAVE_URL`, `BOTCAVE_TOKEN`, `BOTCAVE_ORGANIZATION_ID`, `BOTCAVE_USER_ID`, `BOTCAVE_AGENT_EMAIL`,
  `BOTCAVE_AGENT_BRIEF` (mai impostate su Coolify). Se la tappa 4 avrà bisogno di avviare run da un pulsante, il client si riscrive lì.

### 3.4 Documentazione dei trasporti (agente 7)

- `server/routes.ts`: tolta `POST /api/intervention-documents/generate` (nessuna pagina la chiama). Le altre route
  `intervention-documents` restano.

### 3.5 `ai-service.ts`

- Di `server/ai-service.ts` serve ancora solo `extractAnalysisText` (usata da `POST /api/messages/:id/analyze-project`, agente 2,
  tappa 4): si sposta, invariata, in `server/message-text.ts`; `ai-service.ts` si elimina con `AIService` e `aiService`.
- Test nuovo `server/message-text.test.ts` sul comportamento attuale: senza HTML restituisce il testo (senza spazi ai bordi); con HTML
  il testo ricavato dall'HTML se è lungo almeno quanto il testo semplice, altrimenti il testo semplice; entrambi vuoti → stringa vuota.

## 4. Cosa non cambia

- Agenti 2–5 (agente di progetto, discussione delle proposte, THU AI e sua chat) e il gateway AI (`server/ai-gateway.ts`).
- Schema del database: nessuna migrazione.
- Botcave: nessuna modifica di codice; agenti, tool e inneschi restano come sono.
- `replit.md` di AbapCrm: si aggiornano solo le righe che descrivono lo smistamento automatico, il brief automatico e l'instradamento
  verso Botcave.

## 5. Prove

- `npx vitest run`: verde (spariscono i test di `botcave/` e `context-maintainer`, si aggiunge `message-text.test.ts`).
- `npx tsc`: gli stessi errori di `main` (128 all'8 novembre 2026), nessuno nuovo.
- `grep` sul repository senza risultati per `analyzeMessage`, `updateMessageWithSuggestion`, `generateDocumentation`,
  `triggerBriefUpdate`, `BOTCAVE_`, `./botcave/`, `ai-service`.
- Dopo il deploy, con Ivan: arriva una mail (es. notifica di un work item DevOps); in The Hub Up non compare alcun collegamento automatico;
  entro 2 minuti parte la run dello Smistatore (scheda agente 12 → «Inneschi») e le sue proposte sono in «Da confermare».

## 6. Rischi

- **`OPENAI_API_KEY` in produzione**: se c'è, oggi lo smistamento interno collega le mail da solo; dopo il deploy smette. Effetto voluto.
- **Pulsante «Analizza» tolto**: chi lo usava perde l'analisi manuale; nei fatti restituiva sempre `[]` (route senza organizzazione).
- **Brief meno frequente fino alla tappa 5** (vedi 3.2).
- **`routes.ts` molto grande**: le rimozioni sono puntuali; il typecheck e la ricerca dei riferimenti sono la rete di sicurezza.
