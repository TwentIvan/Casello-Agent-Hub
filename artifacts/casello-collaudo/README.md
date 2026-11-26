# casello-collaudo

Programma del runner di collaudo di Botcave. Gira su un runner di GitHub Actions (Ubuntu), avviato dal workflow del
repository di collaudo, e fa solo connessioni in uscita verso Botcave (`/api/collaudo/*`).

## Uso

```
COLLAUDO_CODICE=<codice monouso> node casello-collaudo.mjs --url https://casello.fantamister.cloud --collaudo <id>
```

Il codice monouso arriva solo dalla variabile `COLLAUDO_CODICE` (mai dagli argomenti) e si toglie dall'ambiente appena letto.
`--version` stampa la versione.

## Cosa fa

1. Scambia il codice con il token del collaudo (`claim`) e copia il codice dell'App allo sha (`git init` + `fetch --depth 1`;
   il token di lettura passa solo nell'ambiente di `git` come header `http.extraheader`, mai negli argomenti né su disco).
2. Modalità `full`: chiede i comandi a Botcave (`next`, attesa lunga), li esegue e manda i risultati, fino al 410
   «collaudo consegnato». `ping` ogni 30 s.
   - `shell`: `bash -lc` nella copia del repository, cartella dentro il repository, al più 300 s (SIGTERM, poi SIGKILL dopo
     5 s), uscita tagliata a 8 000 caratteri; `background` lascia acceso il processo e risponde dopo 5 s con id e prime righe.
     L'ambiente dei comandi non porta il codice né variabili con token o segreti.
   - `browser`: Chromium di Playwright (importato a runtime: lo installa il workflow) con registrazione video; `snapshot` è
     l'albero di accessibilità (al più 12 000 caratteri); `screenshot` carica l'immagine e risponde con l'id del file.
3. Modalità `relight`: esegue la ricetta salvata (installazione, build, schema, servizi in background, attesa del
   `readyPath` fino a 5 minuti), senza agente.
4. Carica il video, apre un quick tunnel di Cloudflare sulla porta dell'App (`cloudflared` di una release fissa, verificato
   con sha256) per 30 minuti, manda l'indirizzo con `tunnel` e chiude con `report`.

Un 401 su qualunque chiamata vuol dire collaudo chiuso o annullato: il programma si ferma senza report.

## Comandi

- `pnpm --filter @workspace/casello-collaudo run test`
- `pnpm --filter @workspace/casello-collaudo run build` → `dist/casello-collaudo.mjs`
