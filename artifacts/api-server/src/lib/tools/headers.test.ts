import { describe, expect, it } from "vitest";
import { checkExtraHeaders, extraHeadersFor, normalizeExtraHeaders } from "./headers";
import type { AppConnection } from "./types";

const ORG = "3f1c2b7a-9d4e-4c1a-8b2f-0a1b2c3d4e5f";
const auth = { userAuthHeader: "Authorization", serviceAuthHeader: "X-Service-Key" };

describe("checkExtraHeaders", () => {
  it("valido: X-Organization-Id con un UUID e X-Organization-Scope", () => {
    expect(
      checkExtraHeaders(
        [
          { name: "X-Organization-Id", value: ORG },
          { name: "X-Organization-Scope", value: "all" },
        ],
        auth,
      ),
    ).toBeNull();
    expect(checkExtraHeaders([], auth)).toBeNull();
  });

  it("al massimo 10", () => {
    const headers = Array.from({ length: 11 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    expect(checkExtraHeaders(headers, auth)).toBe("al massimo 10 header fissi");
    expect(checkExtraHeaders(headers.slice(0, 10), auth)).toBeNull();
  });

  it("nome non valido o riservato", () => {
    expect(checkExtraHeaders([{ name: "X Org", value: "v" }], auth)).toBe("nome di header non valido");
    expect(checkExtraHeaders([{ name: "Host", value: "v" }], auth)).toBe("l'header \"Host\" è riservato");
    expect(checkExtraHeaders([{ name: "content-type", value: "v" }], auth)).toMatch(/riservato/);
    expect(checkExtraHeaders([{ name: "Mcp-Session-Id", value: "v" }], auth)).toMatch(/riservato/);
  });

  it("doppione senza distinguere le maiuscole", () => {
    expect(
      checkExtraHeaders(
        [
          { name: "X-Org", value: "a" },
          { name: "x-org", value: "b" },
        ],
        auth,
      ),
    ).toBe("nome di header ripetuto: x-org");
  });

  it("uguale a un header di autenticazione (utente o servizio)", () => {
    expect(checkExtraHeaders([{ name: "authorization", value: "v" }], auth)).toBe(
      "l'header authorization è già quello di autenticazione dell'app",
    );
    expect(checkExtraHeaders([{ name: "X-SERVICE-KEY", value: "v" }], auth)).toMatch(/autenticazione/);
    expect(checkExtraHeaders([{ name: "X-Service-Key", value: "v" }], { userAuthHeader: null })).toBeNull();
  });

  it("valore vuoto, troppo lungo, con a capo o controlli", () => {
    const msg = "valore dell'header X-Org non valido (1-500 caratteri visibili su una riga)";
    for (const value of ["", "a\r\nX-Evil: 1", "a\nb", "a\u0000b", "è", "a".repeat(501)]) {
      expect(checkExtraHeaders([{ name: "X-Org", value }], auth)).toBe(msg);
    }
    expect(checkExtraHeaders([{ name: "X-Org", value: "a".repeat(500) }], auth)).toBeNull();
  });

  it("credenziali rifiutate, senza il valore nel messaggio", () => {
    const msg = "non salvare credenziali negli header fissi: usa il segreto di servizio";
    for (const value of ["sk-abc123", "Bearer ghp_abcdef", "a8Fk29dLq0Zx7Wm3Np5Rt1Yv6Bc4Hj2Ks9Ue"]) {
      const error = checkExtraHeaders([{ name: "X-Org", value }], auth);
      expect(error).toBe(msg);
      expect(error).not.toContain(value);
    }
  });
});

describe("normalizeExtraHeaders", () => {
  it("toglie gli spazi ai bordi di nome e valore", () => {
    expect(normalizeExtraHeaders([{ name: " X-Org ", value: `  ${ORG}\t` }])).toEqual([{ name: "X-Org", value: ORG }]);
  });
});

describe("extraHeadersFor", () => {
  const base: AppConnection = {
    baseUrl: "https://app.example.com",
    internalBaseUrl: null,
    userAuth: { header: "Authorization", scheme: "Bearer" },
    serviceAuth: { header: "X-Service-Key", scheme: null },
    serviceSecretEnc: null,
    mcpUrl: null,
  };

  it("senza header fissi: nessuno", () => {
    expect(extraHeadersFor(base)).toEqual([]);
  });

  it("scarta a runtime nomi riservati, di autenticazione, doppioni e valori non validi", () => {
    const conn = {
      ...base,
      extraHeaders: [
        { name: "X-Org", value: ORG },
        { name: "accept", value: "text/html" },
        { name: "AUTHORIZATION", value: "Bearer finto" },
        { name: "x-service-key", value: "finto" },
        { name: "x-org", value: "doppione" },
        { name: "X-Evil", value: "a\r\nb" },
        { name: "Mcp-Protocol-Version", value: "1" },
      ],
    };
    expect(extraHeadersFor(conn)).toEqual([["X-Org", ORG]]);
  });
});
