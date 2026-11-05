import type { Response } from "express";

/** Escape per il testo e per gli attributi HTML. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
body{font-family:system-ui,-apple-system,sans-serif;background:#f6f6f7;color:#18181b;margin:0;padding:24px}
main{max-width:440px;margin:40px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 12px}
p{line-height:1.5;margin:0 0 12px}
.muted{color:#52525b;font-size:14px}
.row{display:flex;gap:12px;margin-top:20px}
button{flex:1;font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #d4d4d8;background:#fff;cursor:pointer}
button.primary{background:#18181b;color:#fff;border-color:#18181b}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#3f3f46}.muted{color:#a1a1aa}button{background:#27272a;color:#fafafa;border-color:#52525b}button.primary{background:#fafafa;color:#18181b;border-color:#fafafa}}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

/** Pagina di consenso: chi chiede (nome e host del ritorno), cosa potrà fare, con quale account. */
export function consentPage(p: { clientName: string; redirectHost: string; userEmail: string; csrf: string }): string {
  return layout(
    "Collega Casello",
    `<h1>Collegare ${esc(p.clientName)} · ${esc(p.redirectHost)} a Casello?</h1>
<p>Potrà vedere le tue squadre e il bollettino, scrivere ai capi, approvare e rifiutare le voci da confermare ed eseguire le analisi dell'architetto.</p>
<p class="muted">Account: ${esc(p.userEmail)}</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<div class="row"><button type="submit" name="decision" value="deny">Annulla</button><button type="submit" name="decision" value="allow" class="primary">Consenti</button></div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout("Casello", `<h1>Non è stato possibile collegare l'app</h1><p>${esc(message)}</p>`);
}

/**
 * Invia una pagina HTML con intestazioni restrittive. `form-action` elenca anche i ritorni ammessi perché
 * Chrome controlla anche i redirect che seguono l'invio del form.
 */
export function sendPage(res: Response, status: number, html: string): void {
  res.status(status);
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*",
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
}
