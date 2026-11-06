import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, oauthClientsTable, pool } from "@workspace/db";
import { PluginConfigError, ensurePluginClientRow, pluginClient, pluginClients, pluginSecretMatches } from "./plugins";

const HASH = "5567ecdea32955e7db7b34381a0fe4c38003bfe44915795c6d67dd5c58d173e1"; // sha256 di "segreto"
const entry = (over: Record<string, unknown> = {}) => ({
  clientId: "hubup",
  name: "The Hub Up",
  redirectUri: "https://hubup.example/api/botcave/callback",
  secretSha256: HASH,
  ...over,
});
const setEnv = (v: unknown) => {
  process.env["OAUTH_PLUGIN_CLIENTS"] = typeof v === "string" ? v : JSON.stringify(v);
};
const saved = { plugins: process.env["OAUTH_PLUGIN_CLIENTS"], node: process.env["NODE_ENV"] };

beforeEach(() => {
  delete process.env["OAUTH_PLUGIN_CLIENTS"];
});
afterEach(() => {
  if (saved.plugins === undefined) delete process.env["OAUTH_PLUGIN_CLIENTS"];
  else process.env["OAUTH_PLUGIN_CLIENTS"] = saved.plugins;
  process.env["NODE_ENV"] = saved.node;
});
afterAll(async () => {
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});

describe("configurazione dei client plugin", () => {
  it("variabile assente o vuota → nessun client", () => {
    expect(pluginClients()).toEqual([]);
    setEnv("  ");
    expect(pluginClients()).toEqual([]);
  });

  it("voce valida: la trova per clientId", () => {
    setEnv([entry()]);
    expect(pluginClients()).toEqual([entry()]);
    expect(pluginClient("hubup")?.name).toBe("The Hub Up");
    expect(pluginClient("altro")).toBeNull();
  });

  it("ammette il loopback fuori produzione", () => {
    process.env["NODE_ENV"] = "test";
    setEnv([entry({ redirectUri: "http://localhost:5000/cb" })]);
    expect(pluginClients()).toHaveLength(1);
  });

  const invalid: [string, () => unknown][] = [
    ["JSON non valido", () => "{non json"],
    ["non array", () => ({ clientId: "hubup" })],
    ["11 voci", () => Array.from({ length: 11 }, (_, i) => entry({ clientId: `app-${i}` }))],
    ["clientId non valido", () => [entry({ clientId: "Hub_Up" })]],
    ["clientId ripetuto", () => [entry(), entry()]],
    ["redirectUri http non loopback", () => [entry({ redirectUri: "http://hubup.example/cb" })]],
    ["redirectUri con credenziali", () => [entry({ redirectUri: "https://u:p@hubup.example/cb" })]],
    ["redirectUri con frammento", () => [entry({ redirectUri: "https://hubup.example/cb#x" })]],
    ["secretSha256 di 63 caratteri", () => [entry({ secretSha256: HASH.slice(1) })]],
    ["name vuoto", () => [entry({ name: "" })]],
  ];
  for (const [label, make] of invalid) {
    it(`${label} → PluginConfigError senza il valore`, () => {
      setEnv(make() as string);
      try {
        pluginClients();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(PluginConfigError);
        expect((err as Error).message).toContain("OAUTH_PLUGIN_CLIENTS");
        expect((err as Error).message).not.toContain(HASH);
        expect((err as Error).message).not.toContain(HASH.slice(1));
      }
    });
  }

  it("loopback http rifiutato in produzione", () => {
    process.env["NODE_ENV"] = "production";
    setEnv([entry({ redirectUri: "http://localhost:5000/cb" })]);
    expect(() => pluginClients()).toThrow(PluginConfigError);
  });
});

describe("segreto del client", () => {
  it("combacia solo con quello giusto", () => {
    const c = entry();
    expect(pluginSecretMatches(c, "segreto")).toBe(true);
    expect(pluginSecretMatches(c, "sbagliato")).toBe(false);
    expect(pluginSecretMatches(c, "")).toBe(false);
  });
});

describe("riga di oauth_clients", () => {
  it("due chiamate con nome cambiato: una sola riga aggiornata", async () => {
    await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
    await ensurePluginClientRow(entry());
    const row = await ensurePluginClientRow(entry({ name: "Hub Up 2", redirectUri: "https://hubup.example/nuovo" }));
    expect(row.kind).toBe("plugin");
    const rows = await db.select().from(oauthClientsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: "hubup", kind: "plugin", name: "Hub Up 2", redirectUris: ["https://hubup.example/nuovo"] });
  });
});
