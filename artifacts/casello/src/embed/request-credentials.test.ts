import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser, setAuthTokenGetter, setRequestCredentials } from "@workspace/api-client-react";

// Il pannello incorporabile non deve mai mandare il cookie di sessione di Botcave: sugli host dello stesso sito
// il cookie SameSite=Lax arriverebbe all'API anche dall'iframe.
describe("credenziali delle richieste del client generato", () => {
  afterEach(() => {
    setRequestCredentials(null);
    setAuthTokenGetter(null);
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("predefinito (console): nessuna opzione credentials, il browser manda il cookie", async () => {
    const fetchMock = stubFetch();
    await getCurrentUser();
    expect(fetchMock.mock.calls[0]![1]!.credentials).toBeUndefined();
  });

  it("con setRequestCredentials(\"omit\") ogni richiesta parte senza cookie, con il token se c'è", async () => {
    const fetchMock = stubFetch();
    setRequestCredentials("omit");
    setAuthTokenGetter(() => "cao_t");
    await getCurrentUser();
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cao_t");
  });
});
