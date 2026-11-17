import { describe, expect, it, vi } from "vitest";
import { fetchIdentity, identityPath, refreshDelayMs, tokenExpiry } from "./identity";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (payload: unknown) => `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;

describe("identityPath", () => {
  it("accetta solo percorsi relativi alla radice", () => {
    expect(identityPath("https://x")).toBeNull();
    expect(identityPath("//x")).toBeNull();
    expect(identityPath("api/id")).toBeNull();
    expect(identityPath("/a\\b")).toBeNull();
    expect(identityPath("/" + "a".repeat(500))).toBeNull();
    expect(identityPath(undefined)).toBeNull();
    expect(identityPath("/api/botcave/identity")).toBe("/api/botcave/identity");
  });
});

describe("tokenExpiry e refreshDelayMs", () => {
  it("legge exp senza verificarlo", () => {
    expect(tokenExpiry(jwt({ exp: 100 }))).toBe(100);
    expect(tokenExpiry("abc")).toBeNull();
    expect(tokenExpiry("a.!!!.c")).toBeNull();
    expect(tokenExpiry(jwt({ exp: "x" }))).toBeNull();
    expect(tokenExpiry(jwt({}))).toBeNull();
  });
  it("rinnova un minuto prima, minimo 5 s", () => {
    expect(refreshDelayMs(1000, 900_000)).toBe(40_000);
    expect(refreshDelayMs(1000, 999_000)).toBe(5_000);
    expect(refreshDelayMs(null, 0)).toBeNull();
  });
});

describe("fetchIdentity", () => {
  const res = (status: number, body?: string) => vi.fn().mockResolvedValue(new Response(body, { status }));
  it("200 con token", async () => {
    const f = res(200, JSON.stringify({ token: "a.b.c" }));
    expect(await fetchIdentity("/id", f as unknown as typeof fetch)).toBe("a.b.c");
    expect(f).toHaveBeenCalledWith("/id", expect.objectContaining({ credentials: "same-origin" }));
  });
  it("204 senza avviso", async () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fetchIdentity("/id", vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as never)).toBeNull();
    expect(w).not.toHaveBeenCalled();
    w.mockRestore();
  });
  it("altri casi: null con avviso, mai il token", async () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fetchIdentity("/id", res(500) as never)).toBeNull();
    expect(await fetchIdentity("/id", res(200, "no json") as never)).toBeNull();
    const long = "a".repeat(5000);
    expect(await fetchIdentity("/id", res(200, JSON.stringify({ token: long })) as never)).toBeNull();
    expect(await fetchIdentity("/id", res(200, JSON.stringify({ token: 5 })) as never)).toBeNull();
    expect(await fetchIdentity("/id", vi.fn().mockRejectedValue(new Error("x")) as never)).toBeNull();
    expect(w).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(w.mock.calls)).not.toContain(long);
    w.mockRestore();
  });
});
