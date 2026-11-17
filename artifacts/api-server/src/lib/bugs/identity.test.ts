import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_MESSAGES,
  generateIdentitySecret,
  verifyIdentityToken,
} from "./identity";

const SECRET = "bci_test-secret-di-prova";
const SLUG = "hubup";
const NOW = new Date("2026-11-17T10:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);

const b64 = (v: unknown) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function sign(
  payload: unknown,
  opts: { header?: unknown; secret?: string; rawPayload?: string } = {},
): string {
  const header = b64(opts.header ?? { alg: "HS256", typ: "JWT" });
  const body = b64(opts.rawPayload ?? payload);
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: SLUG,
  aud: "botcave",
  sub: "user-42",
  name: "Mario Rossi",
  email: "mario@example.com",
  iat: nowS,
  exp: nowS + 300,
  ...over,
});

const check = (t: string) => verifyIdentityToken(t, SECRET, SLUG, NOW);

describe("verifyIdentityToken", () => {
  it("accetta un token valido", () => {
    const r = check(sign(claims({ extra: "ignorato" })));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.sub).toBe("user-42");
      expect(r.identity.name).toBe("Mario Rossi");
      expect(r.identity.email).toBe("mario@example.com");
      expect(r.identity.expiresAt.getTime()).toBe((nowS + 300) * 1000);
    }
  });

  it("name ed email sono facoltativi", () => {
    const r = check(sign(claims({ name: undefined, email: undefined })));
    expect(r.ok && r.identity.name).toBe(null);
    expect(r.ok && r.identity.email).toBe(null);
  });

  it("rifiuta alg none, HS512 e assente", () => {
    for (const header of [{ alg: "none" }, { alg: "HS512" }, { typ: "JWT" }, { alg: "hs256" }]) {
      expect(check(sign(claims(), { header }))).toEqual({ ok: false, reason: "invalid" });
    }
    const unsigned = `${b64({ alg: "none" })}.${b64(claims())}.`;
    expect(check(unsigned)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rifiuta un typ diverso da JWT", () => {
    expect(check(sign(claims(), { header: { alg: "HS256", typ: "X" } }))).toEqual({ ok: false, reason: "invalid" });
  });

  it("rifiuta firma alterata o altro segreto", () => {
    const t = sign(claims());
    const bad = t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA");
    expect(check(bad)).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims(), { secret: "altro" }))).toEqual({ ok: false, reason: "invalid" });
    expect(check(t.split(".").slice(0, 2).join(".") + ".abc")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rifiuta payload alterato con la firma vecchia", () => {
    const [h, , s] = sign(claims()).split(".");
    expect(check(`${h}.${b64(claims({ sub: "admin" }))}.${s}`).ok).toBe(false);
  });

  it("controlla iss e aud", () => {
    expect(check(sign(claims({ iss: "altra" })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ iss: undefined })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ aud: "altro" })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ aud: undefined })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ aud: ["x", "botcave"] }))).ok).toBe(true);
    expect(check(sign(claims({ aud: ["x"] }))).ok).toBe(false);
  });

  it("controlla exp e iat con 60 s di tolleranza", () => {
    expect(check(sign(claims({ iat: nowS - 500, exp: nowS - 61 })))).toEqual({ ok: false, reason: "expired" });
    expect(check(sign(claims({ iat: nowS - 500, exp: nowS - 60 }))).ok).toBe(true);
    expect(check(sign(claims({ iat: nowS + 61, exp: nowS + 200 })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ iat: nowS + 60, exp: nowS + 200 }))).ok).toBe(true);
    expect(check(sign(claims({ iat: nowS, exp: nowS + 601 })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ iat: nowS, exp: nowS + 600 }))).ok).toBe(true);
    expect(check(sign(claims({ exp: "domani" })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ iat: undefined })))).toEqual({ ok: false, reason: "invalid" });
  });

  it("controlla i limiti di sub, name ed email", () => {
    expect(check(sign(claims({ sub: "" })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ sub: 7 })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ sub: "a".repeat(201) })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ sub: "a".repeat(200) }))).ok).toBe(true);
    expect(check(sign(claims({ name: "n".repeat(101) })))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims({ email: "e".repeat(255) })))).toEqual({ ok: false, reason: "invalid" });
  });

  it("rifiuta formati non validi", () => {
    expect(check(sign(claims()).split(".").slice(0, 2).join("."))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(claims()) + ".x")).toEqual({ ok: false, reason: "invalid" });
    expect(check("")).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(null, { rawPayload: "{non json" }))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(null, { rawPayload: "[1]" }))).toEqual({ ok: false, reason: "invalid" });
    expect(check(sign(null, { rawPayload: "null" }))).toEqual({ ok: false, reason: "invalid" });
    const long = sign(claims({ name: "x" }), {}) + "a".repeat(4100);
    expect(long.length).toBeGreaterThan(4096);
    expect(check(long)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rifiuta base64url non canonico o con caratteri estranei", () => {
    const [h, p, s] = sign(claims()).split(".");
    expect(check(`${h}.${p}+.${s}`).ok).toBe(false);
    expect(check(`${h}.${p}=.${s}`).ok).toBe(false);
    expect(check(`${h}.${p}.${s}=`).ok).toBe(false);
    expect(check(`${h} .${p}.${s}`).ok).toBe(false);
  });

  it("rifiuta un segreto vuoto", () => {
    expect(verifyIdentityToken(sign(claims(), { secret: "" }), "", SLUG, NOW).ok).toBe(false);
  });
});

describe("generateIdentitySecret", () => {
  it("ha il formato bci_ + 43 caratteri base64url", () => {
    const s = generateIdentitySecret();
    expect(s).toMatch(/^bci_[A-Za-z0-9_-]{43}$/);
    expect(generateIdentitySecret()).not.toBe(s);
  });
});

describe("messaggi", () => {
  it("sono fissi", () => {
    expect(IDENTITY_MESSAGES).toEqual({ invalid: "identità non valida", expired: "identità scaduta" });
  });
});
