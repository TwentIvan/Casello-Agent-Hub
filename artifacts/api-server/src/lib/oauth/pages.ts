import type { Response } from "express";
import { pluginClients } from "./plugins";
import brandTokens from "../../../../../design/tokens.json";

/** Escape per il testo e per gli attributi HTML. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Colori di Botcave dalla fonte di verità (design/tokens.json, incluso nel bundle): nessun colore scritto a mano.
// I font restano quelli di sistema: la CSP della pagina non ammette risorse esterne.
type TokenValue = string | { light: string; dark: string };
const TOKENS = new Map<string, TokenValue>(
  (brandTokens.color.tokens as { name: string; value: TokenValue }[]).map((t) => [t.name, t.value]),
);

function tokenValue(name: string, theme: "light" | "dark"): string {
  const raw = TOKENS.get(name);
  if (raw === undefined) throw new Error(`token mancante: ${name}`);
  const value = typeof raw === "string" ? raw : raw[theme];
  const ref = /^\{(.+)\}$/.exec(value);
  return ref ? tokenValue(ref[1]!, theme) : value;
}

const USED = ["surface-0", "surface-1", "surface-2", "ink", "ink-muted", "border", "border-strong", "accent", "on-accent", "focus"];
const vars = (theme: "light" | "dark") => USED.map((n) => `--${n}:${tokenValue(n, theme)}`).join(";");

const STYLE = `
:root{${vars("light")}}
@media (prefers-color-scheme:dark){:root{${vars("dark")}}}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--surface-0);color:var(--ink);margin:0;padding:24px}
main{max-width:440px;margin:40px auto;background:var(--surface-1);border:1px solid var(--border);border-radius:8px;padding:24px}
h1{font-family:ui-monospace,Menlo,monospace;font-weight:500;font-size:20px;line-height:28px;margin:0 0 12px}
p{line-height:1.5;margin:0 0 12px}
.brand{font-family:ui-monospace,Menlo,monospace;font-weight:500;font-size:14px;color:var(--ink-muted);margin:0 0 16px}
.muted{color:var(--ink-muted);font-size:14px}
.row{display:flex;gap:8px;margin-top:24px}
button{flex:1;font:500 14px/20px system-ui,-apple-system,sans-serif;padding:8px 16px;border-radius:4px;border:1px solid var(--border-strong);background:var(--surface-2);color:var(--ink);cursor:pointer}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button.primary{background:var(--accent);color:var(--on-accent);border-color:transparent}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><p class="brand">Botcave</p>${body}</main></body></html>`;
}

/** Pagina di consenso: chi chiede (nome e host del ritorno), cosa potrà fare, con quale account. */
export function consentPage(p: { clientName: string; redirectHost: string; userEmail: string; csrf: string; kind: "connector" | "plugin" }): string {
  const intro =
    p.kind === "plugin"
      ? `<h1>Collegare ${esc(p.clientName)} a Botcave?</h1>
<p>${esc(p.clientName)} potrà usare Botcave per tuo conto: vedere e gestire app, squadre, modelli e skill, scrivere ai capi, approvare e rifiutare le voci da confermare. Non potrà cambiare chiavi, tetti di spesa, token né account collegati.</p>`
      : `<h1>Collegare ${esc(p.clientName)} · ${esc(p.redirectHost)} a Botcave?</h1>
<p>Potrà vedere le tue squadre e il bollettino, scrivere ai capi, approvare e rifiutare le voci da confermare ed eseguire le analisi di Lucius.</p>`;
  return layout(
    "Collega Botcave",
    `${intro}
<p class="muted">Account: ${esc(p.userEmail)}</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<div class="row"><button type="submit" name="decision" value="deny">Annulla</button><button type="submit" name="decision" value="allow" class="primary">Consenti</button></div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout("Botcave", `<h1>Non è stato possibile collegare l'app</h1><p>${esc(message)}</p>`);
}

/**
 * Invia una pagina HTML con intestazioni restrittive. `form-action` elenca anche i ritorni ammessi perché
 * Chrome controlla anche i redirect che seguono l'invio del form.
 */
export function sendPage(res: Response, status: number, html: string): void {
  res.status(status);
  // I ritorni dei client plugin configurati: Chrome controlla anche i redirect che seguono l'invio del form
  let pluginOrigins = "";
  try {
    pluginOrigins = [...new Set(pluginClients().map((c) => new URL(c.redirectUri).origin))].map((o) => ` ${o}`).join("");
  } catch {
    // configurazione non valida: nessun ritorno in più
  }
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*${pluginOrigins}`,
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
}
