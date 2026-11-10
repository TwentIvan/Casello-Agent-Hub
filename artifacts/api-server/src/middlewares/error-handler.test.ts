import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../lib/logger";
import { errorHandler } from "./error-handler";

// Il log di un errore non gestito porta metodo e percorso: il percorso si oscura come nel log delle richieste, perché il
// codice di abbinamento di un Mac e il segreto di un webhook stanno nel percorso.

const CODE = "ABCD-EFGH";
const HOOK_SECRET = "whs_segretissimo0123456789";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.all("/api/account/node-pairings/{*rest}", () => {
    throw new Error("guasto del DB");
  });
  app.all("/api/hooks/{*rest}", () => {
    throw new Error("guasto del DB");
  });
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

async function loggedUrl(method: string, path: string): Promise<{ status: number; logged: string }> {
  const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
  try {
    const res = await fetch(`${base}${path}`, { method });
    await res.text();
    expect(spy).toHaveBeenCalledTimes(1);
    const [obj, msg] = spy.mock.calls[0]! as unknown as [{ url: string }, string];
    expect(msg).toBe("Errore non gestito nella richiesta");
    return { status: res.status, logged: JSON.stringify(spy.mock.calls) + obj.url };
  } finally {
    spy.mockRestore();
  }
}

describe("errorHandler: percorso oscurato nel log", () => {
  it.each([
    ["GET", `/api/account/node-pairings/${CODE}`],
    ["POST", `/api/account/node-pairings/${CODE}/approve`],
    ["POST", `/api/account/node-pairings/${CODE}/deny?x=1`],
  ])("%s %s: logga /api/account/node-pairings/*** e mai il codice", async (method, path) => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    try {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status).toBe(500);
      const [obj] = spy.mock.calls[0]! as unknown as [{ url: string }];
      expect(obj.url.startsWith("/api/account/node-pairings/***")).toBe(true);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("ABCDEFGH");
    } finally {
      spy.mockRestore();
    }
  });

  it("webhook: logga /api/hooks/<id>/*** e mai il segreto", async () => {
    const { status, logged } = await loggedUrl("POST", `/api/hooks/42/${HOOK_SECRET}`);
    expect(status).toBe(500);
    expect(logged).toContain("/api/hooks/42/***");
    expect(logged).not.toContain(HOOK_SECRET);
  });
});
