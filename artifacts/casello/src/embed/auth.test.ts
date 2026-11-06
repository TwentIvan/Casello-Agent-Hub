import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTokens,
  completeConnect,
  configureAuth,
  connectMessage,
  getAccessToken,
  loadTokens,
  saveTokens,
  startConnect,
  type StorageLike,
} from "./auth";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function brokenStorage(): StorageLike {
  const fail = () => {
    throw new Error("SecurityError");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let local: ReturnType<typeof memoryStorage>;
let session: ReturnType<typeof memoryStorage>;
let now: number;
const fetchMock = vi.fn<typeof fetch>();
const openMock = vi.fn<(url: string, name: string, features: string) => unknown>();

beforeEach(() => {
  local = memoryStorage();
  session = memoryStorage();
  now = 1_000_000;
  fetchMock.mockReset();
  openMock.mockReset();
  configureAuth({
    fetch: fetchMock,
    open: openMock,
    local: () => local,
    session: () => session,
    origin: () => "http://localhost:3000",
    now: () => now,
  });
  clearTokens();
});

describe("startConnect", () => {
  it("apre il popup con scope embed, PKCE S256 e ritorno su /embed/callback", async () => {
    openMock.mockReturnValue({});
    await startConnect("embed:https://hubup.example");
    expect(openMock).toHaveBeenCalledTimes(1);
    const [rawUrl, name, features] = openMock.mock.calls[0]!;
    expect(name).toBe("botcave-connect");
    expect(features).toBe("popup,width=480,height=640");
    const url = new URL(rawUrl, "http://localhost:3000");
    expect(url.pathname).toBe("/oauth/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("embed:https://hubup.example");
    expect(q.get("redirect_uri")).toBe("http://localhost:3000/embed/callback");
    expect(q.get("scope")).toBe("embed");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(q.get("resource")).toBe("http://localhost:3000/mcp");
  });

  it("rifiuta con popup_blocked se il popup non si apre", async () => {
    openMock.mockReturnValue(null);
    await expect(startConnect("embed:https://hubup.example")).rejects.toThrow("popup_blocked");
  });
});

describe("completeConnect", () => {
  it("state diverso ⇒ state_mismatch, nessuna fetch", async () => {
    openMock.mockReturnValue({});
    await startConnect("embed:https://hubup.example");
    await expect(completeConnect("codice", "altro-state")).rejects.toThrow("state_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scambia il codice con code_verifier e salva i token", async () => {
    openMock.mockReturnValue({});
    await startConnect("embed:https://hubup.example");
    const url = new URL(openMock.mock.calls[0]![0], "http://localhost:3000");
    const state = url.searchParams.get("state")!;
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "cao_a", refresh_token: "car_r", expires_in: 3600, scope: "embed" }),
    );
    const tokens = await completeConnect("codice", state);
    expect(tokens.access).toBe("cao_a");
    expect(tokens.expiresAt).toBe(now + 3600_000);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("/oauth/token");
    const body = new URLSearchParams(String(init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("codice");
    expect(body.get("client_id")).toBe("embed:https://hubup.example");
    expect(body.get("redirect_uri")).toBe("http://localhost:3000/embed/callback");
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(loadTokens()?.refresh).toBe("car_r");
    // Lo state si usa una volta sola
    await expect(completeConnect("codice", state)).rejects.toThrow("state_mismatch");
  });
});

describe("getAccessToken", () => {
  it("senza token risponde null", async () => {
    expect(await getAccessToken()).toBeNull();
  });

  it("token ancora valido: nessun rinnovo", async () => {
    saveTokens({ access: "cao_a", refresh: "car_r", expiresAt: now + 600_000, clientId: "embed:x" });
    expect(await getAccessToken()).toBe("cao_a");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token che scade tra 30 s: un solo rinnovo con due chiamate concorrenti", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now + 30_000, clientId: "embed:x" });
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const a = getAccessToken();
    const b = getAccessToken();
    resolve(jsonResponse(200, { access_token: "cao_new", refresh_token: "car_new", expires_in: 3600 }));
    expect(await a).toBe("cao_new");
    expect(await b).toBe("cao_new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("car_old");
    expect(body.get("client_id")).toBe("embed:x");
    expect(loadTokens()?.refresh).toBe("car_new");
  });

  it("invalid_client ⇒ null e storage vuoto", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now + 30_000, clientId: "embed:x" });
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_client" }));
    expect(await getAccessToken()).toBeNull();
    expect(loadTokens()).toBeNull();
    expect(local.data.size).toBe(0);
  });

  it("invalid_grant ⇒ null e storage vuoto", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now - 1, clientId: "embed:x" });
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    expect(await getAccessToken()).toBeNull();
    expect(loadTokens()).toBeNull();
  });

  it("errore di rete: token conservati", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now + 30_000, clientId: "embed:x" });
    fetchMock.mockRejectedValue(new TypeError("network"));
    expect(await getAccessToken()).toBe("cao_old");
    expect(loadTokens()?.refresh).toBe("car_old");
  });
});

describe("storage non disponibile", () => {
  it("tiene i token in memoria per la sessione", () => {
    configureAuth({ local: () => brokenStorage(), session: () => brokenStorage() });
    saveTokens({ access: "cao_a", refresh: "car_r", expiresAt: now + 600_000, clientId: "embed:x" });
    expect(loadTokens()?.access).toBe("cao_a");
    clearTokens();
    expect(loadTokens()).toBeNull();
  });
});

describe("connectMessage", () => {
  it("accetta solo il popup aperto, dalla stessa origine, con la forma giusta", async () => {
    const popup = {};
    openMock.mockReturnValue(popup);
    await startConnect("embed:x");
    const data = { botcave: 1, type: "connect", payload: { code: "c", state: "s" } };
    expect(connectMessage({ origin: "http://localhost:3000", source: popup, data })).toEqual({ code: "c", state: "s" });
    expect(connectMessage({ origin: "https://evil.example", source: popup, data })).toBeNull();
    expect(connectMessage({ origin: "http://localhost:3000", source: {}, data })).toBeNull();
    expect(
      connectMessage({ origin: "http://localhost:3000", source: popup, data: { botcave: 1, type: "connect", payload: { code: 1 } } }),
    ).toBeNull();
  });
});
