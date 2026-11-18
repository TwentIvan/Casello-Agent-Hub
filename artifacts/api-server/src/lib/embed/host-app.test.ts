import type { Request } from "express";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, appsTable, pool } from "@workspace/db";
import { HttpError } from "../ai/node-account";
import { embedHostApp, requireHostApp } from "./host-app";

// App ospite del token del pannello incorporato: la prima App (per id) con l'origine del client.

const HUB = "https://hubup.example";

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await db.insert(appsTable).values([
    { name: "Botcave", slug: "casello", baseUrl: "http://casello.example" },
    { name: "The Hub Up", slug: "thu", baseUrl: `${HUB}/app` },
    { name: "Doppione", slug: "thu-bis", baseUrl: HUB },
  ]);
});
afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

const session = { auth: { kind: "session" } } as unknown as Request;
const embed = (origin: string) =>
  ({ auth: { kind: "token", tokenId: null, grantId: 1, scopes: ["api:read", "api:write"], via: "embed", embedOrigin: origin } }) as unknown as Request;

async function notFound(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(404);
  expect((err as HttpError).message).toBe("App non trovata");
}

describe("embedHostApp", () => {
  it("due App con la stessa origine: quella con id minore", async () => {
    expect((await embedHostApp(HUB))?.slug).toBe("thu");
  });
  it("origine senza App: null", async () => {
    expect(await embedHostApp("https://altra.example")).toBeNull();
  });
});

describe("requireHostApp", () => {
  it("sessione: App per slug, senza slug casello", async () => {
    expect((await requireHostApp(session, "thu")).slug).toBe("thu");
    expect((await requireHostApp(session, undefined)).slug).toBe("casello");
  });
  it("sessione con un'App inesistente: 404", async () => {
    await notFound(requireHostApp(session, "nessuna"));
  });
  it("embed: App ospite senza slug o con lo slug giusto, 404 per le altre", async () => {
    expect((await requireHostApp(embed(HUB), undefined)).slug).toBe("thu");
    expect((await requireHostApp(embed(HUB), "thu")).slug).toBe("thu");
    await notFound(requireHostApp(embed(HUB), "casello"));
    await notFound(requireHostApp(embed(HUB), "thu-bis"));
  });
  it("embed di un'origine senza App: 404", async () => {
    await notFound(requireHostApp(embed("https://altra.example"), undefined));
  });
});
