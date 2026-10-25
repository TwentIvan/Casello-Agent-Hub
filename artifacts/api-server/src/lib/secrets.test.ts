import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSecretKey, decryptSecret, encryptSecret } from "./secrets";

const VALID_KEY = "0123456789abcdef".repeat(4);

describe("secrets", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env["CASELLO_SECRET_KEY"];
    process.env["CASELLO_SECRET_KEY"] = VALID_KEY;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env["CASELLO_SECRET_KEY"];
    else process.env["CASELLO_SECRET_KEY"] = previous;
  });

  it("cifra e decifra", () => {
    const enc = encryptSecret("segreto");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe("segreto");
    expect(encryptSecret("segreto")).not.toBe(enc);
  });

  it("rifiuta un testo manomesso", () => {
    const parts = encryptSecret("segreto").split(":");
    const ct = parts[3]!;
    parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("chiave mancante", () => {
    delete process.env["CASELLO_SECRET_KEY"];
    expect(() => assertSecretKey()).toThrow(/CASELLO_SECRET_KEY/);
  });

  it("chiave non valida", () => {
    process.env["CASELLO_SECRET_KEY"] = "abc";
    expect(() => assertSecretKey()).toThrow(/CASELLO_SECRET_KEY/);
  });
});
