/** Indirizzi assoluti del connettore, da PUBLIC_APP_URL (letta a ogni chiamata, così i test possono impostarla). */
export function oauthBase(): { issuer: string; resource: string } {
  const raw = process.env["PUBLIC_APP_URL"]?.trim();
  const issuer = (raw ? raw : `http://localhost:${process.env["WEB_PORT"] ?? 5173}`).replace(/\/+$/, "");
  return { issuer, resource: `${issuer}/mcp` };
}
