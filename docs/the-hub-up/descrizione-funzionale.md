The Hub Up è il CRM di Ivan per i progetti SAP/ABAP, in produzione su https://hubup.fantamister.cloud (repository TwentIvan/AbapCrm, Express + React, Postgres).

Entità principali, tutte divise per organizzazione:
- partner e contatti;
- progetti, sottoprogetti e milestone;
- task, con i work item di Azure DevOps (`externalMetadata.workItemId`);
- commenti;
- trattative, offerte, ordini di vendita;
- ore e timer, calendario;
- messaggi, cioè email via IMAP e chat;
- proposte, piani di risorse;
- sistemi SAP e trasporti.

Accesso per i client esterni: header `Authorization: Bearer thu_…`. È un token personale creato in Account → «Token API», legato a un utente e a un'organizzazione. Con il token sono vietate (403) le route di:
- accesso, utenti e organizzazioni;
- credenziali e VPN;
- posta;
- configurazione AI e MCP;
- companion.

The Hub Up non ha uno spec OpenAPI né un server MCP: le route stanno in `server/routes.ts`.

Funzioni AI che The Hub Up svolge oggi al suo interno, da sostituire con agenti di Botcave (obiettivo del sottoprogetto 5c). Tutte usano `server/ai-gateway.ts`.

1. **Classificazione delle email** (`server/ai-service.ts`, `analyzeMessage`)
   - Quando: a ogni email arrivata via IMAP.
   - Cosa fa: propone il progetto, il task o il partner a cui collegare il messaggio. Con confidenza ≥ 0,7 collega da sola.
2. **Agente di progetto da email** (`server/ai-project-agent.ts`)
   - Quando: col pulsante «Analizza progetto» su un messaggio.
   - Input: l'email e i suoi allegati.
   - Cosa fa: crea una proposta in stato pending con partner, contatti, progetto e sottoprogetti, task con specifica, sistemi SAP, VPN e workflow.
   - Conferma umana: l'utente decide con «Applica» o «Rifiuta» (`/api/proposals/:id/apply`, `/reject`).
3. **Discussione della proposta**
   - Dove: chat in `/api/proposals/:id/discussions`, con la sintesi della decisione.
   - Cosa fa: può correggere la proposta.
4. **THU AI, esecutore dei task ABAP** (`server/ai-task-executor.ts`)
   - Input: il task, il work item DevOps con le immagini, i messaggi, i trasporti e il brief del progetto.
   - Cosa fa: produce analisi e file di codice e agisce su SAP tramite i server MCP configurati in The Hub Up.
   - Conferma umana: le scritture vanno in approvazione (`ai_pending_actions`); niente scritture su PRD.
5. **Chat di THU AI con le immagini del work item**: solo lettura.
6. **Aggiornamento del brief di progetto** (`server/context-maintainer.ts`, tabella `context_packs`)
   - Quando: dopo ogni esecuzione di THU AI, al massimo una volta ogni 10 minuti per progetto.
7. **Documentazione dei trasporti** (`generateDocumentation`): codice morto.

Obiettivo di questa registrazione:
- per ciascuna funzione da 1 a 6, un agente di Botcave dedicato che la svolga lavorando su The Hub Up con i suoi tool. Non agenti generici;
- l'elenco dei tool e degli endpoint che oggi mancano perché quegli agenti lavorino da fuori, tra cui:
  - leggere e scrivere il brief di progetto (`context_packs`) e il contesto assemblato di un task;
  - proporre o fare il collegamento di un messaggio;
  - leggere gli allegati di un messaggio;
  - creare e aggiornare una proposta senza applicarla;
  - registrare l'esito di un'esecuzione con l'analisi e i file generati.

Le scritture verso terzi e su SAP restano azioni che l'utente conferma.

Per arrivare a SAP è previsto, in seguito, un server MCP di The Hub Up che rilanci gli strumenti SAP con le credenziali che restano in The Hub Up.
