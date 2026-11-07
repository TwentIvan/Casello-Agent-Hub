// Pagina di ritorno del popup di collegamento (/embed/callback): non monta React.
// Consegna code e state all'iframe che ha aperto il popup (stessa origine di Botcave) e chiude la finestra;
// lo state lo verifica l'iframe (completeConnect), che lo tiene nel suo sessionStorage.

const FAILED_TEXT = "Collegamento non completato: chiudi questa finestra e riprova";

function sameOriginOpener(): Window | null {
  const opener = window.opener as Window | null;
  if (!opener) return null;
  try {
    // Una finestra di un'altra origine solleva un'eccezione leggendo location.origin
    return opener.location.origin === window.location.origin ? opener : null;
  } catch {
    return null;
  }
}

// Il primo accesso con Google può staccare window.opener (Cross-Origin-Opener-Policy delle pagine di Google):
// il secondo popup troverà la sessione di Botcave e resterà sulla sua origine.
const RETRY_TEXT = "Accesso eseguito: chiudi questa finestra e premi di nuovo «Collega con Botcave».";

const DONE_TEXT = "Collegamento completato: puoi chiudere questa finestra";

function showText(text: string): void {
  const p = document.createElement("p");
  p.textContent = text;
  p.className = "p-6 text-body text-ink";
  const root = document.getElementById("root") ?? document.body;
  root.replaceChildren(p);
}

export function runCallback(): void {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const opener = sameOriginOpener();
  if (!code || !state) {
    showText(FAILED_TEXT);
    return;
  }
  if (!opener) {
    showText(RETRY_TEXT);
    return;
  }
  opener.postMessage({ botcave: 1, type: "connect", payload: { code, state } }, window.location.origin);
  window.close();
  // Se il browser non chiude la finestra, resta un'indicazione.
  setTimeout(() => showText(DONE_TEXT), 1000);
}
