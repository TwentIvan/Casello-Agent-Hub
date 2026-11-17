import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCurrentUser, listEmbedBugs, setAuthTokenGetter } from "@workspace/api-client-react";
import { bugRequestInit, embedTokenGetter, isVisitorBugUrl, withIdentityRetry } from "./visitor-request";

function apiError(status: number): ApiError {
  return new ApiError(new Response(null, { status }), null, { method: "GET", url: "/api/embed/bugs" });
}

describe("bugRequestInit", () => {
  it("con l'identità manda entrambi gli header", () => {
    const headers = new Headers(bugRequestInit("k".repeat(43), "a.b.c").headers);
    expect(headers.get("X-Botcave-Browser-Key")).toBe("k".repeat(43));
    expect(headers.get("X-Botcave-Identity")).toBe("a.b.c");
  });
  it("senza identità non ha l'header d'identità", () => {
    const headers = new Headers(bugRequestInit("k".repeat(43), null).headers);
    expect(headers.get("X-Botcave-Browser-Key")).toBe("k".repeat(43));
    expect(headers.has("X-Botcave-Identity")).toBe(false);
  });
});

describe("withIdentityRetry", () => {
  it("401 poi successo: una sola ripresa con l'identità nuova", async () => {
    const call = vi.fn().mockRejectedValueOnce(apiError(401)).mockResolvedValueOnce("ok");
    const refresh = vi.fn().mockResolvedValue("nuova");
    await expect(withIdentityRetry(call, refresh, "vecchia")).resolves.toBe("ok");
    expect(call.mock.calls).toEqual([["vecchia"], ["nuova"]]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("401 due volte: l'errore si propaga, senza altri tentativi", async () => {
    const call = vi.fn().mockRejectedValue(apiError(401));
    const refresh = vi.fn().mockResolvedValue("nuova");
    await expect(withIdentityRetry(call, refresh, null)).rejects.toMatchObject({ status: 401 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("404: nessuna ripresa", async () => {
    const call = vi.fn().mockRejectedValue(apiError(404));
    const refresh = vi.fn();
    await expect(withIdentityRetry(call, refresh, null)).rejects.toMatchObject({ status: 404 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("successo al primo colpo: nessuna richiesta d'identità", async () => {
    const call = vi.fn().mockResolvedValue(3);
    const refresh = vi.fn();
    await expect(withIdentityRetry(call, refresh, "t")).resolves.toBe(3);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("isVisitorBugUrl", () => {
  it("riconosce le route del visitatore, relative o assolute", () => {
    expect(isVisitorBugUrl("/api/embed/bugs?app=hubup&origin=x")).toBe(true);
    expect(isVisitorBugUrl("/api/embed/bugs/12/messages?app=a")).toBe(true);
    expect(isVisitorBugUrl("https://casello.fantamister.cloud/api/embed/bugs/seen?app=a")).toBe(true);
  });
  it("le altre no", () => {
    expect(isVisitorBugUrl("/api/embed/config?origin=x")).toBe(false);
    expect(isVisitorBugUrl("/api/apps/4/bugs")).toBe(false);
    expect(isVisitorBugUrl("/api/embed/bugsx")).toBe(false);
    expect(isVisitorBugUrl("/api/pending-actions")).toBe(false);
  });
});

describe("embedTokenGetter", () => {
  afterEach(() => {
    setAuthTokenGetter(null);
    vi.unstubAllGlobals();
  });

  it("le chiamate del visitatore partono senza il token di Botcave, le altre con", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const get = vi.fn(() => "cao_t");
    setAuthTokenGetter(embedTokenGetter(get));

    await listEmbedBugs({ app: "hubup", origin: "https://hubup.example" }, bugRequestInit("k".repeat(43), null));
    const visitor = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(visitor.has("authorization")).toBe(false);
    expect(visitor.get("x-botcave-browser-key")).toBe("k".repeat(43));
    expect(get).not.toHaveBeenCalled();

    await getCurrentUser();
    expect(new Headers(fetchMock.mock.calls[1]![1]!.headers).get("authorization")).toBe("Bearer cao_t");
  });
});
