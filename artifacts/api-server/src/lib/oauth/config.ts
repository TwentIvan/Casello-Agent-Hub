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

/**
 * `scope` ammesso: lista separata da spazi (i valori sconosciuti si ignorano). Per i client `embed` deve contenere
 * `embed` e non `mcp`; per gli altri `mcp` e non `embed`: i due ambiti non si mescolano.
 */
export function scopeAllowed(value: unknown, kind: "dcr" | "metadata" | "embed" = "dcr"): boolean {
  if (typeof value !== "string") return false;
  const list = value.split(/\s+/);
  return kind === "embed" ? list.includes("embed") && !list.includes("mcp") : list.includes("mcp") && !list.includes("embed");
}
