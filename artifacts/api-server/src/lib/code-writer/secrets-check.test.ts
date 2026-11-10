import { describe, expect, it } from "vitest";
import { checkCommit, findCredential, redactCredentials } from "./secrets-check";

describe("secrets-check", () => {
  it("riconosce token e PEM", () => {
    expect(findCredential(`token = ghp_${"a1B2".repeat(9)}`)).toBe(true);
    expect(findCredential("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe(true);
    expect(findCredential(`k = AKIA${"A".repeat(16)}`)).toBe(true);
  });
  it("non scambia hash o UUID", () => {
    expect(findCredential("integrity: sha512-Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4==")).toBe(false);
    expect(findCredential("id 123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(findCredential("sk-short")).toBe(false);
  });
  it("oscura", () => {
    expect(redactCredentials(`a ghp_${"x".repeat(30)} b`)).toBe("a *** b");
  });
  it("checkCommit", () => {
    expect(checkCommit(new Map())).toMatch(/nessuna modifica/);
    expect(checkCommit(new Map([["a.bin", "a\0"]]))).toMatch(/UTF-8/);
    expect(checkCommit(new Map([["a.ts", `ghp_${"x".repeat(20)}`]]))).toMatch(/credenziale/);
    expect(checkCommit(new Map([["a.ts", null]]))).toBeNull();
    const many = new Map<string, string | null>();
    for (let i = 0; i < 51; i++) many.set(`f${i}`, "x");
    expect(checkCommit(many)).toMatch(/troppi/);
    const big = new Map<string, string | null>();
    for (let i = 0; i < 6; i++) big.set(`f${i}`, "x".repeat(1_000_000));
    expect(checkCommit(big)).toMatch(/troppo grande/);
  });
});
