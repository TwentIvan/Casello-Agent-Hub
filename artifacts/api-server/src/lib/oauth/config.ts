/** Indirizzi assoluti del connettore, da PUBLIC_APP_URL (letta a ogni chiamata, così i test possono impostarla). */
export function oauthBase(): { issuer: string; resource: string } {
  const raw = process.env["PUBLIC_APP_URL"]?.trim();
  const issuer = (raw ? raw : `http://localhost:${process.env["WEB_PORT"] ?? 5173}`).replace(/\/+$/, "");
  return { issuer, resource: `${issuer}/mcp` };
}

/** `resource` della richiesta uguale a quella del server, ignorando un `/` finale. */
export function sameResource(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\/+$/, "") === oauthBase().resource;
}

/** `scope` ammesso: lista separata da spazi che contiene `mcp` (i valori sconosciuti si ignorano). */
export function scopeAllowed(value: unknown): boolean {
  return typeof value === "string" && value.split(/\s+/).includes("mcp");
}
