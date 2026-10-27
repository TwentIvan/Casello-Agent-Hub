import { describe, expect, it } from "vitest";
import { hashToken, newToken, tokenKind } from "./tokens";

describe("token dell'agente locale", () => {
  it.each([
    ["machine", "csl_m_"],
    ["personal", "csl_p_"],
    ["job", "csl_j_"],
  ] as const)("token %s: prefisso %s e 43 caratteri base64url", (kind, prefix) => {
    const { token, hash } = newToken(kind);
    expect(token.startsWith(prefix)).toBe(true);
    expect(token.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashToken(token));
    expect(tokenKind(token)).toBe(kind);
  });

  it("due token sono diversi", () => {
    expect(newToken("job").token).not.toBe(newToken("job").token);
  });

  it("hashToken è deterministico: SHA-256 esadecimale", () => {
    expect(hashToken("csl_m_abc")).toBe(hashToken("csl_m_abc"));
    expect(hashToken("csl_m_abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("csl_m_abc")).not.toBe(hashToken("csl_m_abd"));
    // SHA-256 di "abc"
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("tokenKind rifiuta stringhe estranee", () => {
    for (const s of ["", "abc", "csl_x_" + "a".repeat(43), "csl_m_corto", "csl_m_" + "a".repeat(44), "Bearer csl_m_" + "a".repeat(43)]) {
      expect(tokenKind(s)).toBeNull();
    }
  });
});
