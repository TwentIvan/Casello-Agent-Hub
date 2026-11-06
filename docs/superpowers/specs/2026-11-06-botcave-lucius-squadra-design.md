# Lucius sulla squadra e memorie dei personaggi — design

Data: 2026-11-06. Stato: da approvare.

## Obiettivo

Lucius, l'ingegnere del laboratorio, aiuta a definire gli agenti di una squadra: conversa sulla squadra (ne legge l'intera
definizione), chiede come istruire i ruoli e propone per ogni ruolo un'**identità** e un **file di istruzioni** in Markdown,
che l'utente accetta come schede. Alfred e Lucius hanno ciascuno una **memoria propria** per utente, con uno storico che
non appesantisce le conversazioni.

Fuori ambito: chat di Lucius sui modelli di squadra (solo sulle istanze), memoria condivisa tra i due personaggi, memoria
nelle analisi dell'architetto (lavoro a fasi, non conversazione), modifica automatica di strumenti o skill del catalogo.

## 1. Come si definisce un agente (pratica consigliata)

Un ruolo ha due livelli di testo, con scopi diversi:

- **Identità** (il campo oggi chiamato «Compito», `roles[].task`, max 8 000): chi è il ruolo e qual è il suo mandato stabile,
  in poche righe. Si legge nell'editor dei ruoli e nel prompt di sistema. Nel codice e nei dati il campo resta `task`; cambiano
  solo l'etichetta («Identità») e la riga del prompt («Identità del ruolo:» al posto di «Istruzioni del ruolo:»). Il
  compito vero, quello che il capo assegna, resta nel PLAN (`assegna_compito`).
- **Istruzioni del ruolo** (file Markdown): il manuale operativo, una skill specializzata della squadra con codice
  `ruolo-<key>` (stesse regole delle skill specializzate: tipo `casello`, max 20 000 caratteri), collegata al ruolo. Vale per
  i ruoli `cloud` (entra nel prompt come le altre skill) e per i ruoli `node` (il nodo la riceve già nel pacchetto e la scrive
  in `casello-compito.md`: nessuna modifica a `casello-nodo`).

Struttura del file di istruzioni, la stessa che Lucius usa e che `prompts` verifica con un esempio:

```markdown
---
name: <key del ruolo>
description: <una frase: quando il capo deve scegliere questo ruolo>
---
# <Nome del ruolo>

## Identità
## Responsabilità            (cosa fa; cosa NON fa e lascia ad altri ruoli)
## Cosa ricevi                (dal capo: compito, PLAN, allegati)
## Cosa consegni              (forma dell'esito con `riferisci`: stato, esito ≤ 300, dettaglio)
## Come lavori                (procedura in passi)
## Strumenti                  (quali usare e quando; livelli L2 = vanno in coda all'utente)
## Limiti e quando fermarti   (quando riferire `blocked`, cosa non fare mai)
## Criteri di qualità         (quando il lavoro è fatto)
## Esempi                     (facoltativo)
```

Il frontmatter è quello dei sub-agent di Claude Code: il file scaricato si può copiare in `.claude/agents/`.

## 2. Chat di Lucius sulla squadra

**Dove**: scheda squadra, pannello «Lucius» (segno di Lucius, come la chat del piano). Disponibile per squadre `draft` e
`active`; squadra chiusa → sola lettura (409 «squadra chiusa» sui messaggi e sulle decisioni).

**Dati** (migrazione additiva `docs/migrations/2026-11-lucius-squadra.sql`):

- `team_chat_conversations` (`team_instance_id` CASCADE, `user_id`, `ai_model_id` SET NULL, `title` ≤ 80, `tokens_used`,
  `cost_usd`, `turn_status` `idle|running`, `summarized_at`, date): come `plan_conversations`.
- `team_chat_messages` (`role` `user|assistant`, `content`, `error`, `tokens`).
- `team_chat_proposals` (`kind` `role_identity|role_instructions`, `role_key`, `payload` jsonb `{text}` / `{markdown}`,
  `rationale`, `target_hash` = SHA-256 del valore attuale al momento della proposta, `status` `pending|accepted|rejected|stale`,
  `decided_at`).

**Contesto del modello** (mai segreti né indirizzi delle app): squadra (nome, lavoro di riferimento, stato, modello d'origine e
versione), ruoli completi (key, nome, identità, luogo, modello, capo), per ogni ruolo gli strumenti (nome, app, descrizione,
livello effettivo, `available`) e le skill (catalogo alla versione fissata e specializzate, con il contenuto), PLAN se esiste
(obiettivo, vincoli, compiti), appunti della memoria di Lucius (§3) come messaggio `user` di dati. Prompt di sistema in
`lib/team-chat/context.ts`: Lucius, tono del manuale, «lei», chiede prima di proporre quando mancano informazioni
(obiettivo del ruolo, confini con gli altri ruoli, forma dell'esito), una scheda per ruolo alla volta.

**Strumenti di Lucius** (`lib/team-chat/tools.ts`, risultati `ok: false` con messaggio fisso): `leggi_squadra`,
`leggi_skill` (`code`, versione fissata o specializzata), `leggi_strumento` (`id`: definizione e schema dei parametri,
oscurati i `x-sensitive`), `proponi_identita` (`roleKey`, `testo` ≤ 8 000, `motivazione` ≤ 1 000),
`proponi_istruzioni` (`roleKey`, `markdown` ≤ 20 000, `motivazione`; il Markdown deve avere il frontmatter con `name` =
`roleKey`, altrimenti «il file deve iniziare con il frontmatter del ruolo»), più gli strumenti di memoria (§3). Ruolo
inesistente → «ruolo <key> inesistente». Al più 10 proposte per turno.

**Decisione** (`POST /api/team-chat-proposals/:id/decision` `{decision: accept|reject}`): accettare applica in una
transazione con la squadra bloccata, con le stesse regole di `PUT /api/team-instances/:id` (`validateRoles`, fuori dalla
transazione di scrittura come sempre):
- `role_identity` → `roles[key].task = text`;
- `role_instructions` → crea o sostituisce la skill specializzata `ruolo-<key>` e la aggiunge a `localSkills` del ruolo se
  manca (conta nel limite di 30 skill per ruolo e 100 per istanza).
Se il valore attuale non ha più lo hash della proposta → la proposta diventa `stale` e risponde 409 «la squadra è cambiata:
chiedi a Lucius una proposta aggiornata». La storia delle versioni del file è nelle proposte accettate (con data e autore).

**Turno**: in background come la chat del piano (`run-turn.ts`), polling dalla console; limiti 6 giri, 40 000 token, 120 s;
messaggio ≤ 8 000 caratteri; contesto ~30 000 token (la cronologia si riduce); 10 messaggi/min per utente (contatore
proprio). Modello: scelto alla creazione della conversazione tra i propri account (default: modello predefinito). Costi nella
spesa di utente, modello e account (`lib/budget.ts`), tetti controllati prima di ogni turno (409 col motivo). All'avvio i turni
rimasti `running` si chiudono falliti.

**Route**: `GET|POST /api/team-instances/:id/team-chat-conversations`, `GET|DELETE /api/team-chat-conversations/:id`,
`POST …/:id/messages`, `POST /api/team-chat-proposals/:id/decision`; scarico `GET /api/team-instances/:id/roles/:key/instructions.md`
(testo del file, `Content-Disposition: attachment`, 404 se il ruolo non ha istruzioni) e `GET …/roles-export.zip` (un `.md` per
ruolo con istruzioni; zip senza compressione scritto da un piccolo writer proprio, niente dipendenze nuove). Ambiti per metodo
come le altre route delle squadre.

**Console**: pannello «Lucius» nella scheda squadra (conversazioni, messaggi, schede con anteprima del Markdown e confronto con
il valore attuale, «Accetta»/«Rifiuta»), nell'editor dei ruoli l'etichetta «Identità» e, per ogni ruolo con istruzioni, «Scarica
.md»; in testa «Scarica tutti i ruoli (.zip)». Niente scorrimento orizzontale a 1280 px.

## 3. Memorie di Alfred e Lucius

Ogni personaggio ha la propria memoria per utente; nessuno dei due legge quella dell'altro (strumenti e route filtrano per
`character`). Due livelli, pensati per restare leggeri:

**Appunti** (`character_notes`: `user_id`, `character` `alfred|lucius`, `content` ≤ 300 caratteri, `ref` facoltativo, date):
fatti e preferenze stabili («preferisce sintesi brevi», «The Hub Up · WI 1174: il cliente vuole la consegna venerdì»). Al
più **50 per personaggio**: si caricano sempre per intero (≤ 15 000 caratteri, circa 4 000 token). Li scrive il personaggio
con `ricorda` (`testo`), li corregge con `aggiorna_appunto` (`id`, `testo`) e li toglie con `dimentica` (`id`); con 50 appunti
`ricorda` risponde «memoria piena: unisci o togli un appunto» e il personaggio consolida da sé. Niente consolidamento
automatico con un modello.

**Storico** (`character_history`: `user_id`, `character`, `kind` `alfred_session|plan_conversation|team_chat`, `ref_id`,
`title` ≤ 120, `summary` ≤ 1 500, `ai_model_id`, `tokens_used`, `cost_usd`, `created_at`): un riassunto per conversazione, mai i messaggi interi. Nel contesto entrano
solo i titoli degli ultimi 3; il resto si cerca a richiesta con `cerca_nello_storico` (`testo`: ricerca `ILIKE` su titolo e
riassunto, al più 5 risultati). Al più 500 voci per personaggio: oltre, si tolgono le più vecchie.

**Riassunti**: li scrive un modello economico, il modello predefinito dell'utente (se manca, nessun riassunto: lo storico
salta quella conversazione), 30 s, 1 000 token, costo nella spesa dell'utente, prompt fisso: decisioni prese, preferenze emerse,
punti aperti, in al più 1 500 caratteri.
- Lucius: conversazioni della chat del piano e della chat di squadra ferme da 30 minuti e non ancora riassunte (o con
  messaggi nuovi dopo l'ultimo riassunto, che si aggiorna), controllo ogni 10 minuti (`summarized_at`).
- Alfred: alla chiusura la pagina manda la trascrizione testuale (`POST /api/alfred/sessions/:id/close` con `transcript`
  facoltativo, ≤ 20 000 caratteri, mai salvato: solo il riassunto); le sessioni chiuse per inattività non hanno trascrizione
  e non si riassumono.

**Dove si usano**: Alfred riceve appunti e titoli recenti nelle istruzioni del token (`instructions.ts`, alla creazione e al
rinnovo) e ha `ricorda`, `aggiorna_appunto`, `dimentica`, `cerca_nello_storico` tra i suoi strumenti; Lucius li riceve come
messaggio `user` di dati nella chat del piano e nella chat di squadra, con gli stessi strumenti.

**Console**: Account → «Memorie», due schede (Alfred, Lucius) con il segno del personaggio: appunti (modifica, elimina,
aggiungi a mano) e storico (riassunti, elimina). Route `GET /api/memories/notes?character=`, `POST …/notes`, `PATCH|DELETE
…/notes/:id`, `GET /api/memories/history?character=&q=`, `DELETE …/history/:id`. Dati solo dell'utente (altrui → 404).

## 4. Errori, limiti, sicurezza

- Testi dell'utente e della squadra arrivano al modello come dati (`user`), mai nel prompt di sistema; il modello non vede
  segreti, token, indirizzi delle app.
- Memoria: niente segreti negli appunti (il prompt lo vieta; `ricorda`, e anche l'inserimento dalla console, rifiuta testi che
  assomigliano a chiavi, con un controllo nuovo `looksLikeCredential` (prefissi noti e stringhe lunghe senza spazi): «non salvo
  credenziali in memoria»).
- Messaggi d'errore fissi in italiano; mai il testo del DB o del provider.

## 5. Test

- Proposte: accettazione di identità e istruzioni, `stale` dopo una modifica, squadra chiusa, limite di skill per ruolo,
  frontmatter mancante, ruolo inesistente.
- Scarico `.md` e `.zip` (zip valido letto con il `zip-reader` dell'architetto).
- Memorie: isolamento tra personaggi e tra utenti, limite di 50 appunti, rifiuto delle credenziali, ricerca nello storico,
  riassunto con modello finto e senza modello predefinito, potatura oltre 500.
- Alfred: istruzioni del token con gli appunti; chiusura con trascrizione che produce un riassunto e non la salva.

## 6. Migrazione

`docs/migrations/2026-11-lucius-squadra.sql`, additiva e idempotente (niente `-post`): tabelle `team_chat_conversations`,
`team_chat_messages`, `team_chat_proposals`, `character_notes`, `character_history`; colonna `plan_conversations.summarized_at`.
Da applicare su Neon PRIMA del merge; riportata in `docs/schema-casello.sql`.
