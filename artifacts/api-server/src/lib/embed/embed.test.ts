import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, oauthClientsTable, pool } from "@workspace/db";
import { embedAllowedOrigins, embedCallbackUri, embedClientId, originOfEmbedClient } from "./origins";
import { ensureEmbedClients } from "./clients";
import { resolveClient } from "../oauth/clients";

const KEYS = ["EMBED_ALLOWED_ORIGINS", "NODE_ENV", "PUBLIC_APP_URL", "WEB_PORT"];
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env["PUBLIC_APP_URL"];
  delete process.env["WEB_PORT"];
  await pool.query("TRUNCATE oauth_clients, apps RESTART IDENTITY CASCADE");
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await pool.query("TRUNCATE oauth_clients, apps RESTART IDENTITY CASCADE");
});

describe("embedAllowedOrigins", () => {
  it("tiene solo origini https senza path, normalizzate e senza doppioni", () => {
    process.env["EMBED_ALLOWED_ORIGINS"] = "https://hubup.fantamister.cloud, https://hubup.fantamister.cloud/,ftp://x,https://a.example/path";
    expect(embedAllowedOrigins()).toEqual(["https://hubup.fantamister.cloud"]);
  });
  it("in produzione scarta localhost", () => {
    process.env["NODE_ENV"] = "production";
    process.env["EMBED_ALLOWED_ORIGINS"] = "http://localhost:5174";
    expect(embedAllowedOrigins()).toEqual([]);
  });
  it("fuori produzione ammette localhost e 127.0.0.1 con porta", () => {
    process.env["NODE_ENV"] = "test";
    process.env["EMBED_ALLOWED_ORIGINS"] = "http://localhost:5174,http://127.0.0.1:5175,http://localhost";
    expect(embedAllowedOrigins()).toEqual(["http://localhost:5174", "http://127.0.0.1:5175"]);
  });
  it("senza variabile è vuota", () => {
    delete process.env["EMBED_ALLOWED_ORIGINS"];
    expect(embedAllowedOrigins()).toEqual([]);
  });
  it("id del client e ritorno", () => {
    expect(embedClientId("https://a.example")).toBe("embed:https://a.example");
    expect(originOfEmbedClient("embed:https://a.example")).toBe("https://a.example");
    expect(originOfEmbedClient("https://a.example")).toBeNull();
    expect(embedCallbackUri()).toBe("http://localhost:5173/embed/callback");
  });
});

describe("client embed", () => {
  it("ensureEmbedClients crea una riga per origine senza doppioni", async () => {
    process.env["EMBED_ALLOWED_ORIGINS"] = "https://hubup.fantamister.cloud";
    await ensureEmbedClients();
    await ensureEmbedClients();
    const rows = await db.select().from(oauthClientsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: "embed:https://hubup.fantamister.cloud",
      kind: "embed",
      name: "hubup.fantamister.cloud",
      redirectUris: ["http://localhost:5173/embed/callback"],
    });
  });
  it("resolveClient restituisce il client solo se l'origine è ammessa", async () => {
    process.env["EMBED_ALLOWED_ORIGINS"] = "https://hubup.fantamister.cloud";
    await ensureEmbedClients();
    const dl = vi.fn(async () => null);
    expect((await resolveClient("embed:https://hubup.fantamister.cloud", dl))?.kind).toBe("embed");
    process.env["EMBED_ALLOWED_ORIGINS"] = "";
    expect(await resolveClient("embed:https://hubup.fantamister.cloud", dl)).toBeNull();
    expect(await resolveClient("embed:https://evil.example", dl)).toBeNull();
    expect(dl).not.toHaveBeenCalled();
  });
});
