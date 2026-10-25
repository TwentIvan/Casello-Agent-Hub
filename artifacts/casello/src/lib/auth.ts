import { ApiError } from "@workspace/api-client-react";

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Pagina corrente come returnTo, senza i parametri dell'esito del login ("auth", "provider", "github"). */
function currentReturnTo(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("auth");
  url.searchParams.delete("provider");
  url.searchParams.delete("github");
  return encodeURIComponent(`${url.pathname}${url.search}`);
}

/** URL di login con Google che, a login riuscito, riporta alla pagina corrente. */
export function loginUrl(): string {
  return `/api/auth/login?returnTo=${currentReturnTo()}`;
}

/** URL di login con GitHub che, a login riuscito, riporta alla pagina corrente. */
export function githubLoginUrl(): string {
  return `/api/auth/github/login?returnTo=${currentReturnTo()}`;
}

/** Collegamento di GitHub all'utente corrente: si torna alla pagina Account. */
export const GITHUB_LINK_URL = `/api/auth/github/link?returnTo=${encodeURIComponent("/account")}`;
