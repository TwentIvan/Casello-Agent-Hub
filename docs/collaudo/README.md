# Repository di collaudo di Botcave

`collaudo.yml` è il workflow del modello `TwentIvan/botcave-modello-collaudo`: va copiato in `.github/workflows/collaudo.yml` del repository di collaudo con una PR a parte.

- Lo avvia Botcave (`workflow_dispatch`) con gli input `collaudo` (numero) e `codice` (monouso, mascherato nel primo passo).
- Scarica da `https://casello.fantamister.cloud/downloads/collaudo/` il manifest e il programma `casello-collaudo`, ne verifica lo sha256 con `sha256sum -c` e lo avvia.
- Playwright è fissato alla versione `PLAYWRIGHT_VERSION` del workflow (Chromium con le dipendenze di sistema; il pacchetto è installato nella stessa cartella del programma, perché l'import ESM non usa `NODE_PATH`).
- Postgres 16 come servizio (`postgres`/`postgres`/`postgres`, porta 5432): è la `DATABASE_URL` che il programma usa di default.
- Permessi del workflow: nessuno (`permissions: {}`); il codice monouso arriva solo in `COLLAUDO_CODICE`.
