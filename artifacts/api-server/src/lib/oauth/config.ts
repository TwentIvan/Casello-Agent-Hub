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

/** `resource` di un client plugin: l'API (`<issuer>/api`), ignorando un `/` finale. */
export function sameApiResource(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\/+$/, "") === `${oauthBase().issuer}/api`;
}

/** `scope` di un client plugin: valori tutti tra gli ambiti api e almeno uno. */
export function pluginScopeAllowed(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(/\s+/).filter((v) => v !== "");
  return parts.length > 0 && parts.every((v) => v === "api:read" || v === "api:write");
}

/** `scope` ammesso: lista separata da spazi che contiene `mcp` (i valori sconosciuti si ignorano). */
export function scopeAllowed(value: unknown): boolean {
  return typeof value === "string" && value.split(/\s+/).includes("mcp");
}
