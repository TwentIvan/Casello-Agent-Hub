import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTokens,
  completeConnect,
  configureAuth,
  connectMessage,
  getAccessToken,
  loadTokens,
  onTokensChange,
  saveTokens,
  setEmbedClient,
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
    locks: () => null,
  });
  setEmbedClient("embed:x");
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
    setEmbedClient("embed:https://hubup.example");
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

describe("rinnovo concorrente tra schede", () => {
  it("invalid_grant dopo che un'altra scheda ha già ruotato: usa i token salvati, non li cancella", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now + 30_000, clientId: "embed:x" });
    fetchMock.mockImplementation(async () => {
      // Un'altra scheda vince la rotazione e salva la coppia nuova prima della nostra risposta
      local.data.set(
        "botcave-embed-tokens:embed:x",
        JSON.stringify({ access: "cao_other", refresh: "car_other", expiresAt: now + 3_600_000, clientId: "embed:x" }),
      );
      return jsonResponse(400, { error: "invalid_grant" });
    });
    expect(await getAccessToken()).toBe("cao_other");
    expect(loadTokens()?.refresh).toBe("car_other");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("i token dell'altra scheda sono anch'essi in scadenza: un nuovo rinnovo con il loro refresh", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now + 30_000, clientId: "embed:x" });
    fetchMock
      .mockImplementationOnce(async () => {
        local.data.set(
          "botcave-embed-tokens:embed:x",
          JSON.stringify({ access: "cao_other", refresh: "car_other", expiresAt: now + 10_000, clientId: "embed:x" }),
        );
        return jsonResponse(400, { error: "invalid_grant" });
      })
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "cao_3", refresh_token: "car_3", expires_in: 3600 }));
    expect(await getAccessToken()).toBe("cao_3");
    const body = new URLSearchParams(String(fetchMock.mock.calls[1]![1]!.body));
    expect(body.get("refresh_token")).toBe("car_other");
  });

  it("con navigator.locks il rinnovo avviene dentro il lock e rilegge i token", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now + 30_000, clientId: "embed:x" });
    const names: string[] = [];
    configureAuth({
      locks: () => ({
        request: async (name: string, cb: () => Promise<unknown>) => {
          names.push(name);
          // Mentre si aspettava il lock un'altra scheda ha rinnovato
          local.data.set(
            "botcave-embed-tokens:embed:x",
            JSON.stringify({ access: "cao_other", refresh: "car_other", expiresAt: now + 3_600_000, clientId: "embed:x" }),
          );
          return cb();
        },
      }),
    });
    expect(await getAccessToken()).toBe("cao_other");
    expect(names).toEqual(["botcave-embed-refresh:embed:x"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("token in scadenza ed errore temporaneo", () => {
  it("token d'accesso scaduto ed errore di rete: errore transitorio, token conservati", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now - 1, clientId: "embed:x" });
    fetchMock.mockRejectedValue(new TypeError("network"));
    await expect(getAccessToken()).rejects.toThrow("token_refresh_unavailable");
    expect(loadTokens()?.refresh).toBe("car_old");
  });

  it("token d'accesso scaduto e 500 dal server: errore transitorio, token conservati", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now - 1, clientId: "embed:x" });
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "server_error" }));
    await expect(getAccessToken()).rejects.toThrow("token_refresh_unavailable");
    expect(loadTokens()?.refresh).toBe("car_old");
  });

  it("con navigator.locks l'errore transitorio non fa ripetere il rinnovo fuori dal lock", async () => {
    saveTokens({ access: "cao_old", refresh: "car_old", expiresAt: now - 1, clientId: "embed:x" });
    configureAuth({ locks: () => ({ request: async (_name: string, cb: () => Promise<unknown>) => cb() }) });
    fetchMock.mockRejectedValue(new TypeError("network"));
    await expect(getAccessToken()).rejects.toThrow("token_refresh_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("spazio dei token per client", () => {
  it("chiave dello storage per client: due app ospiti sullo stesso sito non condividono i token", () => {
    saveTokens({ access: "cao_x", refresh: "car_x", expiresAt: now + 600_000, clientId: "embed:x" });
    expect(local.data.has("botcave-embed-tokens:embed:x")).toBe(true);
    expect(local.data.has("botcave-embed-tokens")).toBe(false);
    setEmbedClient("embed:y");
    expect(loadTokens()).toBeNull();
    setEmbedClient("embed:x");
    expect(loadTokens()?.access).toBe("cao_x");
  });

  it("token salvati con un clientId diverso da quello della chiave si ignorano", async () => {
    local.data.set(
      "botcave-embed-tokens:embed:x",
      JSON.stringify({ access: "cao_y", refresh: "car_y", expiresAt: now + 600_000, clientId: "embed:y" }),
    );
    expect(loadTokens()).toBeNull();
    expect(await getAccessToken()).toBeNull();
  });

  it("senza client scelto non ci sono token", async () => {
    saveTokens({ access: "cao_x", refresh: "car_x", expiresAt: now + 600_000, clientId: "embed:x" });
    setEmbedClient(null);
    expect(loadTokens()).toBeNull();
    expect(await getAccessToken()).toBeNull();
  });

  it("il cambio di client avvisa gli ascoltatori con i token del nuovo client", () => {
    saveTokens({ access: "cao_x", refresh: "car_x", expiresAt: now + 600_000, clientId: "embed:x" });
    setEmbedClient(null);
    const seen: (string | null)[] = [];
    const off = onTokensChange((t) => seen.push(t?.access ?? null));
    setEmbedClient("embed:x");
    off();
    expect(seen).toEqual(["cao_x"]);
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

  it("un secondo messaggio dopo quello accettato si ignora e non tocca i token", async () => {
    const popup = {};
    openMock.mockReturnValue(popup);
    await startConnect("embed:x");
    const data = { botcave: 1, type: "connect", payload: { code: "c", state: "s" } };
    expect(connectMessage({ origin: "http://localhost:3000", source: popup, data })).not.toBeNull();
    expect(connectMessage({ origin: "http://localhost:3000", source: popup, data })).toBeNull();
    saveTokens({ access: "cao_a", refresh: "car_r", expiresAt: now + 600_000, clientId: "embed:x" });
    await expect(completeConnect("c", "s")).rejects.toThrow("state_mismatch");
    expect(loadTokens()?.access).toBe("cao_a");
  });
});
