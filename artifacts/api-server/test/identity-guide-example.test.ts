import { describe, expect, it } from "vitest";
// @ts-expect-error esempio JavaScript senza tipi
import { signBotcaveToken } from "../../../docs/integrazione/esempi/botcave-identity.mjs";
import { verifyIdentityToken } from "../src/lib/bugs/identity";

const SECRET = "bci_esempio-di-segreto-della-guida";
const NOW = new Date("2026-11-17T10:00:00Z");

describe("esempio della guida all'integrazione", () => {
  it("firma un token che Botcave verifica", () => {
    const token = signBotcaveToken({ id: "u-42", name: "Ada", email: "ada@example.com" }, { secret: SECRET, appSlug: "mia-app", now: NOW });
    const r = verifyIdentityToken(token, SECRET, "mia-app", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.sub).toBe("u-42");
      expect(r.identity.name).toBe("Ada");
      expect(r.identity.expiresAt.getTime()).toBe(NOW.getTime() + 300_000);
    }
  });

  it("rifiuta una durata oltre 600 secondi", () => {
    expect(() => signBotcaveToken({ id: "u-42" }, { secret: SECRET, appSlug: "mia-app", ttlSeconds: 601, now: NOW })).toThrow();
  });

  it("con un altro segreto la verifica fallisce", () => {
    const token = signBotcaveToken({ id: "u-42" }, { secret: SECRET, appSlug: "mia-app", now: NOW });
    expect(verifyIdentityToken(token, "bci_altro", "mia-app", NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});
