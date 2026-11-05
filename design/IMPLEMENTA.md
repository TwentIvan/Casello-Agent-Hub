# Implementare l'identità Botcave

Il prodotto finora chiamato «Casello» si chiama **Botcave**. Questa cartella `design/` è la fonte di verità per l'identità visiva: logo, colori, caratteri, spaziature, componenti e tono di voce. Questo documento dice cosa fare con essa.

## Prima di tutto

1. Leggi per intero `design/README.md`, il manuale di marca. Le regole lì scritte prevalgono su ogni scelta già presente nel codice.
2. Esplora il codice della console e della pagina di Alfred e prepara un **piano**: quali file tocchi, cosa sostituisci, in che ordine, cosa resta fuori. Mostralo e aspetta l'approvazione prima di modificare il codice.

## Cosa fare

1. **Token.** Importa `design/tokens.css` come primo foglio di stile globale, sia nella console sia nella pagina di Alfred. Sostituisci colori, font, spaziature e raggi scritti a mano con le variabili (`var(--surface-1)`, `var(--space-3)`, …). Non introdurre colori nuovi: se ne serve uno, proponi di aggiungerlo a `tokens.json` e rigenera `tokens.css`.
2. **Temi.** Chiaro e scuro: il tema segue il sistema, e si può forzare con `data-theme="light"` o `data-theme="dark"` sull'elemento `html`.
3. **Caratteri.** JetBrains Mono per titoli, etichette, numeri e codice; Space Grotesk per testi e controlli. Usa le classi `text-*` di `tokens.css` o le variabili `--font-mono` e `--font-sans`.
4. **Logo.** Usa solo i file SVG in `design/assets/Logo/`, senza ricomporli. Nell'intestazione della console: `botcave-logo-light.svg` in tema chiaro, `botcave-logo-dark.svg` in tema scuro. Sotto i 96 px di larghezza, solo il segno (`botcave-mark-*.svg`).
5. **Icone e app di Alfred.** Usa i file in `design/icons/`: `favicon.svg` e `favicon-32.png` per il browser, `apple-touch-icon.png` per l'iPhone, `icon-192.png`, `icon-512.png` e `icon-maskable-512.png` nel manifest. Nel manifest: `theme_color` e `background_color` `#151A21`.
6. **Componenti.** Implementa `Button`, `Led` e `ConfirmItem` secondo il `README.md` e il `preview.html` di ciascuno in `design/components/`, e sostituisci gli equivalenti esistenti. Il numero di ogni voce della coda deve restare stabile finché la voce è in coda, perché Alfred lo legge a voce.
7. **Alfred e Lucius.** Usa il segno in `design/assets/Alfred/` per l'icona di Alfred e il pulsante per parlargli, e quello in `design/assets/Lucius/` per l'architetto: le sue analisi, le proposte e la chat del piano. Allinea i testi di entrambi al tono descritto nel manuale.
8. **Testi dell'interfaccia.** Applica il tono di voce del manuale: pulsanti che dicono cosa fanno, niente punti esclamativi, numeri precisi.

## Cosa non fare

- Non rinominare identificatori nel codice, nomi di repository, URL, servizi, variabili d'ambiente o tabelle da «casello» a «botcave». Cambia solo i testi visibili all'utente. Se trovi punti dubbi, elencali e chiedi.
- Nessun riferimento a Batman: niente «Bat», «Wayne», «Gotham», né immagini o colori del suo simbolo.
- Non aggiungere librerie di interfaccia senza chiedere.
- Se un'operazione si blocca e l'utente può farla a mano, fermati e chiedila invece di insistere.

## Come verificare il risultato

- Nessun colore esadecimale scritto a mano fuori da `design/tokens.css` (cerca `#[0-9a-fA-F]{3,6}` nel codice dell'interfaccia).
- Tutte le schermate leggibili in tema chiaro e scuro.
- I LED restano fermi con la riduzione del movimento attiva.
- Il logo si vede nitido nell'intestazione e la favicon si riconosce nella scheda del browser.
- Aggiungendo la pagina di Alfred alla schermata Home dell'iPhone compare l'icona Botcave su fondo scuro.
- Mostra screenshot prima e dopo delle schermate principali.
