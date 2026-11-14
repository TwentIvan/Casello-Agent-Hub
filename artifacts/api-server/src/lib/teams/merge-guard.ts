import type { Request } from "express";

/**
 * Il Responsabile di Botcave (token d'ambito `agent`) non concede il merge: un ruolo che prima non aveva `code: merge`
 * non lo riceve con quel token (un merge su `main` è un deploy in produzione). Lo concede solo l'utente.
 */
export const AGENT_MERGE_DENIED = "il token non ha l'ambito per questa operazione: solo l'utente concede il merge a un ruolo";

type RoleCodes = readonly { key: string; code?: string | null }[];

export function mergeGrantAllowed(req: Request, roles: RoleCodes | undefined, previous: RoleCodes): boolean {
  if (req.auth?.kind !== "token" || !req.auth.scopes.includes("agent") || !roles) return true;
  const had = new Set(previous.filter((r) => r.code === "merge").map((r) => r.key));
  return !roles.some((r) => r.code === "merge" && !had.has(r.key));
}
