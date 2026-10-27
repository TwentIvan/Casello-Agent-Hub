import { createHash, randomBytes } from "node:crypto";

// Token dell'agente locale: casuali (32 byte), mostrati una sola volta e salvati solo come SHA-256.
// Il prefisso dice a cosa serve: macchina (runner), personale (modalità C), lavoro (un solo lavoro).
export type TokenKind = "machine" | "personal" | "job";

const PREFIX: Record<TokenKind, string> = { machine: "csl_m_", personal: "csl_p_", job: "csl_j_" };
// 32 byte in base64url senza padding
const TOKEN_RE = /^(csl_[mpj]_)[A-Za-z0-9_-]{43}$/;

export function newToken(kind: TokenKind): { token: string; hash: string } {
  const token = PREFIX[kind] + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Tipo del token dal prefisso; null se la forma non è quella dei nostri token. */
export function tokenKind(token: string): TokenKind | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  return (Object.keys(PREFIX) as TokenKind[]).find((k) => PREFIX[k] === m[1]) ?? null;
}
