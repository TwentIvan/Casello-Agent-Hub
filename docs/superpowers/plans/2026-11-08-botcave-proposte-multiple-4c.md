# Botcave · Proposte multiple 4c (The Hub Up) — piano

Spec: `docs/superpowers/specs/2026-11-08-botcave-proposte-multiple-design.md` §6. La 4a è su `main` (PR #68); la 4b non c'è ancora,
quindi la prova reale salta discussione e nuova versione.

## Ricognizione (AbapCrm, `origin/main` 0635d47)

- `PUT /api/partners/:id` esiste ma con il token `thu_…`:
  - passa `req.body` intero a `storage.updatePartner`: con un token si possono riscrivere `organizationId`, `userId`, `id`, date;
  - prova l'organizzazione dell'header, poi ripiega su **qualunque** organizzazione in cui il partner è dell'utente, senza
    verificare che sia nel perimetro della richiesta (`getOrganizationIdsForFilter`).
- `POST /api/contacts` esiste; con un token l'ereditarietà dell'organizzazione dal padre è spenta (`if (req.apiToken) return next()`),
  quindi un contatto con `partnerId` di un'altra organizzazione dell'utente finirebbe nell'organizzazione dell'header (Personal)
  e il partner non viene verificato.
- `GET /api/tasks` non restituisce `externalWorkItemId` né `externalSystem` (colonne già in `tasks`).
- La console di The Hub Up manda `userId` nel `PUT` del partner (cambio del proprietario): le regole nuove valgono **solo con un token**,
  la sessione resta com'era.

## Task

1. **AbapCrm · regole pure** (`server/partner-contact-scope.ts` + test Vitest con import relativi):
   - `sanitizeTokenPartnerUpdate(body)`: oggetto semplice senza `id`, `userId`, `organizationId`, `createdAt`, `updatedAt`; altrimenti null;
   - `tokenPartnerOrganization(deps, {partnerId, userId, organizationIds})`: organizzazione del partner (dell'utente) se è nel perimetro, altrimenti null;
   - `tokenContactOrganization(deps, {partnerId, organizationId, organizationIds})`: senza partner l'organizzazione della richiesta;
     con partner quella del partner se nel perimetro, altrimenti null.
2. **AbapCrm · route** (`server/routes.ts`): con `req.apiToken` il `PUT` del partner usa le due funzioni (404 fuori perimetro, 400 corpo
   non valido), il `POST` dei contatti mette il contatto nell'organizzazione del partner (400 «partner non trovato» fuori perimetro);
   `GET /api/tasks` aggiunge `externalWorkItemId` ed `externalSystem`.
3. **AbapCrm · verifica**: `npx vitest run`, `npx tsc --noEmit` senza errori nuovi (128 su `main`), push del branch
   `feat/botcave-4c-partner-contatti` e link compare precompilato.
4. **Botcave · configurazione in produzione** (ogni passo solo dopo il sì di Ivan, rileggendo prima lo stato):
   - tool `update_partner` (`PUT /api/partners/{id}`) e `create_contact` (`POST /api/contacts`), L2, identità `service`, attivi;
   - `externalWorkItemId`, `externalSystem` nei `responseFields` di `list_tasks`;
   - istruzioni dello Smistatore (agente 12) e del Responsabile (`general` dell'app 3), mostrate a Ivan per intero con il diff.
   I tool di partner e contatti servono solo dopo il deploy della PR di AbapCrm.
5. **Prova reale con Ivan**: notifica DevOps inoltrata → Smistatore segnala → Responsabile `proponi` → voce «Proposta» in console,
   pannello in The Hub Up e Alfred → approvazione parziale → esito per passo verificato in The Hub Up.

## Note

- Con il token «tutte» `POST /api/tasks` e `POST /api/projects` scrivono nell'organizzazione dell'header (Personal), anche con un
  progetto padre di un'altra organizzazione: comportamento esistente, fuori da questo piano; da riportare a Ivan.
