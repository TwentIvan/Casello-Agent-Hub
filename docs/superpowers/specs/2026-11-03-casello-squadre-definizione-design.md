# Casello: squadre di agenti — definizione (design)

Data: 2026-11-03. Sottoprogetto 3a della specifica «squadre di agenti in Casello» (bozza v0.2). Prima parte delle
squadre: si definiscono e si salvano; l'esecuzione arriva con il sottoprogetto 3b, i ruoli sul Mac con il 4.

## 1. Scopo e decisioni prese

Una squadra è un insieme di ruoli (es. PJM, Resource planner, Backend developer, Frontend developer) con un capo,
skill e strumenti, che si definisce una volta come **modello** riusabile e si applica a un lavoro concreto come
**istanza** (es. The Hub Up · WI 1174).

Decisioni:

- **Struttura a stella.** Un solo capo per squadra (es. il PJM): assegna i compiti, riceve sempre gli esiti, decide il
  passo successivo e, nell'esecuzione, sarà l'unico ad accodare azioni verso l'esterno. Gli altri ruoli eseguono e
  riferiscono al capo; non comunicano tra loro. Revisione e consulenza sono ruoli o compiti normali assegnati dal capo.
  Centralino (uno per utente) resta fuori dalle squadre e arriva con il 3b.
- **Skill codificate e versionate**, di due tipi: istruzioni di Casello e riferimenti a skill del nodo locale (es.
  `drg-sibilla`). Il ruolo non contiene testo di skill ma un manifesto di codici.
- **Squadra trasversale alle app:** ogni ruolo sceglie strumenti da qualunque app registrata; l'istanza è legata al
  lavoro di un servizio preciso.
- **Il modello è generico** (poche skill non specializzate); **l'istanza si specializza** (skill e istruzioni proprie).
  Entrambi si salvano e hanno viste separate.
- **Istanza = copia** del modello con le skill fissate a una versione; gli aggiornamenti del modello e delle skill
  sono **proposti** all'istanza e applicati solo su conferma, tutti o in parte.

Fuori ambito: esecuzione (capo che assegna compiti, compiti ed esiti, PLAN, eventi, bollettino, centralino su `/mcp`:
3b); esecuzione dei ruoli `node` e verifica delle skill presenti sul nodo (4); interfaccia in The Hub Up (5);
organizzazioni e policy dei dati (2).

## 2. Dati

### Skill

- `skills`: `id`, `code` (unico, `^[a-z0-9][a-z0-9._-]{1,63}$`), `name`, `description`, `kind` (`casello` | `node`),
  `current_version` (intero ≥ 1), `deprecated` (boolean), `created_at`, `updated_at`.
- `skill_versions`: `skill_id`, `version`, `content` (per `casello`: istruzioni, max 20 000 caratteri; per `node`: il
  nome della skill sul nodo, `^[a-zA-Z0-9:_-]{1,100}$`), `tool_hints` (elenco informativo di nomi di strumenti, solo
  `casello`), `created_at`; unico (`skill_id`, `version`). Le versioni sono immutabili: modificare una skill crea la
  versione `current_version + 1`. Massimo 200 versioni per skill.
- Una skill deprecata resta valida dove è già usata ma non si può aggiungere a ruoli nuovi o modificati.

### Modelli di squadra

- `team_templates`: `id`, `name` (unico tra i non archiviati), `description`, `version` (intero ≥ 1), `archived`,
  `created_at`, `updated_at`.
- `team_template_versions`: `template_id`, `version`, `manifest` (jsonb: l'elenco completo dei ruoli di quella
  versione nel formato della sezione «Manifesto»), `created_at`; unico (`template_id`, `version`). Ogni salvataggio
  del modello crea una versione nuova con il suo manifesto.
- I ruoli correnti si leggono dal manifesto della versione corrente (nessuna tabella separata per i ruoli del modello).

### Manifesto di un ruolo

```json
{
  "key": "backend",               // identificativo stabile del ruolo nella squadra, ^[a-z0-9_-]{1,40}$
  "name": "Backend developer",
  "task": "…",                    // compito, max 8 000 caratteri
  "isLead": false,
  "runsOn": "cloud",              // cloud | node
  "aiModelId": 85,                // obbligatorio se cloud, null se node
  "tools": [12, 40],              // id di app_tools, anche di app diverse
  "skills": ["sap.ricollaudo", "drg.sibilla"]   // codici (nel modello senza versione)
}
```

La `key` permette di riconoscere lo stesso ruolo tra versioni diverse (rinominare il ruolo non lo rende «nuovo»).

### Istanze

- `team_instances`: `id`, `name`, `template_id` (`SET NULL`), `template_version` (versione copiata o ultima
  applicata), `ref_app_id` (FK `apps`, `RESTRICT`), `ref_type` (`^[a-z0-9_-]{1,40}$`, es. `wi`), `ref_id` (testo, max
  100), `ref_title` (max 300), `status` (`draft` | `active` | `closed`), `created_by` (FK `users`, `SET NULL`),
  `created_at`, `updated_at`, `closed_at`; indice (`ref_app_id`, `ref_type`, `ref_id`).
- `team_instances.roles` (jsonb): manifesto dei ruoli dell'istanza, come quello del modello ma con le skill fissate:
  `"skills": [{ "code": "sap.ricollaudo", "version": 3 }]`, più `"localSkills": ["istanza.wi1174-contesto"]` per le skill
  specializzate.
- `team_instance_skills`: skill specializzate dell'istanza (`instance_id`, `code` con lo stesso formato del catalogo,
  unico per istanza, `name`, `kind`, `content`, `tool_hints`, `updated_at`). Non hanno versioni: appartengono solo
  all'istanza e si modificano in place.

## 3. Regole

Controllate a ogni salvataggio di un modello o di un'istanza; errore → 400 con il messaggio, nulla salvato:

- esattamente un ruolo con `isLead: true` («una squadra ha esattamente un capo»);
- `key` e `name` dei ruoli unici nella squadra; 1..20 ruoli; 0..30 skill per ruolo (catalogo + specializzate);
- `runsOn: cloud` → `aiModelId` di un modello di un account dell'utente («modello non disponibile»);
  `runsOn: node` → `aiModelId` null;
- skill `node` solo su ruoli `node` («la skill <code> gira solo sul nodo locale»);
- codici di skill esistenti e non deprecati, salvo quelli già presenti in quel ruolo nella versione precedente;
  per le istanze: `version` esistente per quel codice;
- strumenti: `app_tools` esistenti, `active` e con livello effettivo diverso da L3 («lo strumento <nome> non può
  essere usato da una squadra»), salvo quelli già presenti nel ruolo (uno strumento disattivato nel frattempo resta,
  segnalato in lettura come «non disponibile»);
- il lavoro di riferimento di un'istanza punta a un'app esistente.

## 4. Copia, aggiornamenti e «Salva come modello»

- **Creazione di un'istanza** da un modello: copia il manifesto della versione corrente, fissa ogni skill alla sua
  `current_version`, `template_version` = versione corrente, `status = draft`. Si può creare un'istanza anche senza
  modello (ruoli definiti da zero).
- **Aggiornamenti disponibili** (`GET /api/team-instances/:id/updates`), calcolati confrontando l'istanza con la
  versione corrente del modello e con le versioni correnti delle skill; ogni voce ha un `id` stabile e un tipo:
  - `role_added` / `role_removed` (per `key`), `role_changed` (compito, luogo, modello o strumenti diversi da quelli
    della versione del modello da cui l'istanza è partita, mostrando valore attuale e nuovo);
  - `skill_added` / `skill_removed` in un ruolo (rispetto al manifesto del modello);
  - `skill_version` (versione più recente di una skill del catalogo usata dall'istanza, anche se il modello non è
    cambiato).
  Le modifiche fatte a mano nell'istanza non generano voci: si confronta con la versione del modello copiata
  (`template_version`), così un campo che l'istanza ha cambiato e il modello no non viene proposto.
- **Applicazione** (`POST …/updates/apply` con l'elenco degli `id`): in una transazione, applica solo le voci scelte;
  la regola del capo e le altre del §3 valgono sul risultato (errore → nulla applicato). Se sono state applicate voci
  del modello e nessuna voce del modello resta in sospeso, `template_version` diventa la versione corrente. Le istanze
  `closed` non si aggiornano (409 «squadra chiusa»).
- **Salva come modello** (`POST …/save-as-template`, `{ mode: "new" | "new_version", name?, promoteSkills?: string[] }`):
  `new` crea un modello con i ruoli dell'istanza (skill del catalogo senza versione; le specializzate elencate in
  `promoteSkills` diventano skill del catalogo con un codice nuovo indicato dall'utente, le altre vengono tolte);
  `new_version` crea la versione successiva del modello d'origine (409 se l'istanza non ha modello o il modello è
  archiviato).

## 5. API

Contract-first in `openapi.yaml`; con un token personale valgono gli ambiti per metodo (`api:read` / `api:write`).

- Skill: `GET /api/skills` (filtri `kind`, `q`, `deprecated`), `POST /api/skills` (codice, nome, tipo, contenuto
  della versione 1), `GET /api/skills/:code`, `PATCH /api/skills/:code` (nome/descrizione senza nuova versione;
  `content`/`toolHints` → nuova versione), `POST /api/skills/:code/deprecate`, `GET /api/skills/:code/versions`,
  `GET /api/skills/:code/versions/:version`.
- Modelli: `GET /api/team-templates` (`archived`), `POST /api/team-templates`, `GET /api/team-templates/:id` (con i
  ruoli della versione corrente e il conteggio delle istanze), `PUT /api/team-templates/:id` (nome, descrizione e
  ruoli insieme, tutto o niente, nuova versione), `GET /api/team-templates/:id/versions/:version`,
  `DELETE /api/team-templates/:id` (cancella se non ha istanze, altrimenti archivia e risponde con lo stato).
- Istanze: `GET /api/team-instances` (filtri `status`, `appId`, `refType`, `refId`), `POST /api/team-instances`
  (`templateId?`, nome, lavoro di riferimento, ruoli se senza modello), `GET /api/team-instances/:id`,
  `PUT /api/team-instances/:id` (nome, titolo del lavoro, ruoli, skill specializzate, stato `draft`↔`active`),
  `POST /api/team-instances/:id/close`, `GET …/updates`, `POST …/updates/apply`, `POST …/save-as-template`.
- In lettura, ogni strumento di un ruolo è restituito con app, nome, livello effettivo e `available` (false se non è
  più `active` o è diventato L3); ogni skill con codice, versione, tipo, nome e `deprecated`.

## 6. Console

Tre voci nuove nel menu, viste separate; niente scorrimento orizzontale a 1280 px.

- **Skill:** elenco con filtro per tipo e ricerca; scheda con contenuto della versione corrente, storico delle
  versioni, confronto tra due versioni, «Nuova versione», «Depreca».
- **Modelli di squadra:** elenco (con archiviati a parte); scheda con i ruoli, il capo evidenziato, e per ogni ruolo
  compito, luogo, modello, strumenti (app · nome · livello) e skill come manifesto leggibile; editor dei ruoli
  (aggiungi, togli, scegli il capo, skill e strumenti con ricerca); «Nuova squadra da questo modello».
- **Squadre** (istanze): elenco per stato e app; scheda con il lavoro di riferimento, i ruoli, le skill specializzate
  (editor), il riquadro «Aggiornamenti disponibili» con le voci da spuntare e «Applica», «Salva come modello»,
  «Attiva» / «Chiudi».

## 7. Dati di produzione

`docs/migrations/2026-11-squadre.sql`, additiva e idempotente, PRIMA del merge: tabelle `skills`, `skill_versions`,
`team_templates`, `team_template_versions`, `team_instances`, `team_instance_skills`, enum necessari. Nessuna modifica a
tabelle esistenti; niente `-post`. Riportata in `docs/schema-casello.sql`.

## 8. Test

- Skill: creazione, codice non valido, PATCH che crea N+1 senza toccare le versioni precedenti, limite di 200 versioni,
  deprecazione (resta dove usata, rifiutata in un ruolo nuovo), `node` con contenuto non valido.
- Modelli: salvataggio tutto o niente con ogni regola del §3 e il suo messaggio; ogni salvataggio crea una versione con
  il manifesto; archiviazione al posto della cancellazione se ci sono istanze.
- Istanze: copia con versioni fissate; istanza senza modello; ricerca per lavoro di riferimento; skill specializzate
  con codice unico per istanza.
- Aggiornamenti: ogni tipo di voce; una modifica fatta a mano nell'istanza non genera voci; applicazione parziale;
  applicazione che lascerebbe la squadra senza capo → 400 senza modifiche; `template_version` aggiornata solo se non
  restano voci del modello; istanza chiusa → 409.
- Salva come modello: `new` con promozione di skill specializzate, `new_version`, istanza senza modello → 409.
- Strumento disattivato o diventato L3 dopo il salvataggio: resta nel ruolo con `available: false`.
- Migrazione idempotente.
- Prova nel browser delle tre viste a 1280 px.
