import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";

// Template dell'indirizzo dei lavori nel servizio (apps.plugin_url_template), sull'app completa senza login

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const MESSAGE = "pluginUrlTemplate: indirizzo non valido: serve https e {refId} una sola volta";
const GOOD = "https://hub.example/tasks/{refId}/edit";

let base: string;
let server: http.Server;
let pluginUrlTemplateError: typeof import("./apps").pluginUrlTemplateError;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const create = (extra: Record<string, unknown>) =>
  api("POST", "/apps", { name: `App ${Math.random().toString(36).slice(2, 8)}`, baseUrl: "https://app.example.com", ...extra });

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  const { default: app } = await import("../app");
  ({ pluginUrlTemplateError } = await import("./apps"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps RESTART IDENTITY CASCADE");
});

describe("pluginUrlTemplate sulle app", () => {
  it("un template valido si salva e torna nel GET", async () => {
    const res = await create({ pluginUrlTemplate: GOOD });
    expect(res.status).toBe(201);
    expect(res.json.pluginUrlTemplate).toBe(GOOD);
    const got = await api("GET", `/apps/${res.json.id}`);
    expect(got.json.pluginUrlTemplate).toBe(GOOD);
  });

  it.each([
    ["http non locale", "http://hub.example/{refId}"],
    ["senza segnaposto", "https://hub.example/tasks/edit"],
    ["segnaposto ripetuto", "https://hub.example/{refId}/{refId}"],
    ["501 caratteri", `https://hub.example/${"a".repeat(501 - "https://hub.example/{refId}".length)}{refId}`],
    ["credenziali", "https://u:p@hub.example/{refId}"],
    ["segnaposto nell'origine", "https://{refId}.hub.example/x"],
  ])("%s → 400", async (_name, value) => {
    const res = await create({ pluginUrlTemplate: value });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: MESSAGE });
  });

  it("stringa vuota → null; PATCH aggiorna e toglie", async () => {
    const res = await create({ pluginUrlTemplate: "" });
    expect(res.status).toBe(201);
    expect(res.json.pluginUrlTemplate).toBeNull();
    const patched = await api("PATCH", `/apps/${res.json.id}`, { pluginUrlTemplate: GOOD });
    expect(patched.json.pluginUrlTemplate).toBe(GOOD);
    const bad = await api("PATCH", `/apps/${res.json.id}`, { pluginUrlTemplate: "https://hub.example/x" });
    expect(bad.status).toBe(400);
    const cleared = await api("PATCH", `/apps/${res.json.id}`, { pluginUrlTemplate: null });
    expect(cleared.json.pluginUrlTemplate).toBeNull();
  });

  it("http su localhost solo fuori produzione", () => {
    expect(pluginUrlTemplateError("http://localhost:3000/t/{refId}")).toBeNull();
    expect(pluginUrlTemplateError("http://127.0.0.1/t/{refId}")).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(pluginUrlTemplateError("http://localhost:3000/t/{refId}")).toBe(MESSAGE.replace("pluginUrlTemplate: ", ""));
    vi.unstubAllEnvs();
  });
});
