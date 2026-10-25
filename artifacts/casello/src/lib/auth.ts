import { ApiError } from "@workspace/api-client-react";

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** URL di login che, a login riuscito, riporta alla pagina corrente (senza il parametro "auth"). */
export function loginUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("auth");
  const returnTo = `${url.pathname}${url.search}`;
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
