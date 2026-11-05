# Led

Indicatore di stato di squadre, agenti e voci: un pixel quadrato da 8 px con l'etichetta accanto. Cinque stati: in attesa (`led-idle`, fisso), al lavoro (`accent`, pulsa lentamente), serve una decisione (`accent`, lampeggia), concluso (`success`), bloccato (`danger`). Il LED non ha mai raggio e non è mai da solo: l'etichetta in `body-sm` con colore `ink-muted` porta l'informazione anche a chi non distingue i colori. Con la riduzione del movimento attiva i LED restano fissi. Chi lo usa fornisce lo stato e l'etichetta.
