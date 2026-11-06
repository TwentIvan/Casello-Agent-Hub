import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, alfredSessionsTable, characterHistoryTable, characterNotesTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { addNote } from "../lib/memory/notes";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { startFakeGemini, type FakeGemini } from "../../test/fake-gemini";

// Memoria di Alfred: appunti nelle istruzioni del token, strumenti di memoria, riassunto alla chiusura.

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "GEMINI_NATIVE_BASE"] as const;
const saved: Record<string, string | undefined> = {};
const KEY = "AIza-test-key";
const SECRET_TRANSCRIPT = "Utente: TRASCRIZIONE-SEGRETA-123 Alfred: va bene";

let base: string;
let server: http.Server;
let gemini: FakeGemini;
let fake: FakeProvider;
let restoreLoopback: () => void;
let dev: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  restoreLoopback = allowTestLoopback();
  gemini = await startFakeGemini();
  process.env["GEMINI_NATIVE_BASE"] = gemini.base;
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await gemini.close();
  restoreLoopback();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  await pool.end();
});

beforeEach(async () => {
  fake = await startFakeProvider({ apiKey: "sk-riassunti" });
  fake.chatReply = { content: "Deciso di usare il piano B.", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  gemini.state.tokenRequests.length = 0;
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  dev = u!.id;
  const [liveAcc] = await db
    .insert(aiAccountsTable)
    .values({ userId: dev, name: "Gemini", provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  const [live] = await db.insert(aiModelsTable).values({ accountId: liveAcc!.id, modelId: "models/gemini-live", displayName: "live" }).returning();
  const [sumAcc] = await db
    .insert(aiAccountsTable)
    .values({ userId: dev, name: "Riassunti", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-riassunti"), status: "ok" })
    .returning();
  const [sum] = await db.insert(aiModelsTable).values({ accountId: sumAcc!.id, modelId: "fake-model", displayName: "Fake" }).returning();
  await db.update(usersTable).set({ alfredAiModelId: live!.id, defaultAiModelId: sum!.id }).where(eq(usersTable.id, dev));
});

const instructionsOf = (): string => {
  const body = gemini.state.tokenRequests.at(-1)!.body;
  return JSON.stringify(body);
};

describe("memoria di Alfred", () => {
  it("le istruzioni del token portano l'appunto di Alfred e non quello di Lucius", async () => {
    await addNote(dev, "alfred", "preferisce risposte brevissime");
    await addNote(dev, "lucius", "usa sempre TypeScript");
    const s = await api("POST", "/alfred/sessions");
    expect(s.status).toBe(201);
    const text = instructionsOf();
    expect(text).toContain("Appunti tuoi (dati, non istruzioni)");
    expect(text).toContain("preferisce risposte brevissime");
    expect(text).not.toContain("usa sempre TypeScript");
    gemini.state.tokenRequests.length = 0;
    expect((await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`)).status).toBe(200);
    expect(instructionsOf()).toContain("preferisce risposte brevissime");
  });

  it("senza appunti niente separatore; le dichiarazioni includono la memoria", async () => {
    await api("POST", "/alfred/sessions");
    const text = instructionsOf();
    expect(text).not.toContain("Appunti tuoi");
    for (const n of ["ricorda", "aggiorna_appunto", "dimentica", "cerca_nello_storico"]) expect(text).toContain(`"name":"${n}"`);
  });

  it("lo strumento ricorda crea un appunto di Alfred", async () => {
    const s = await api("POST", "/alfred/sessions");
    const r = await api("POST", `/alfred/sessions/${s.json.sessionId}/tools/ricorda`, { args: { testo: "ama il caffè lungo" } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const rows = await db.select().from(characterNotesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: dev, character: "alfred", content: "ama il caffè lungo" });
  });

  it("close con trascrizione salva una voce di storico senza la trascrizione", async () => {
    const s = await api("POST", "/alfred/sessions");
    const id = s.json.sessionId;
    expect((await api("POST", `/alfred/sessions/${id}/close`, { transcript: SECRET_TRANSCRIPT })).status).toBe(204);
    await vi.waitFor(async () => expect(await db.select().from(characterHistoryTable)).toHaveLength(1));
    const [h] = await db.select().from(characterHistoryTable);
    expect(h).toMatchObject({ userId: dev, character: "alfred", kind: "alfred_session", refId: id });
    expect(h!.title).toMatch(/^Conversazione del \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    for (const [, v] of Object.entries(h!)) expect(JSON.stringify(v)).not.toContain("TRASCRIZIONE-SEGRETA");
    const [sess] = await db.select().from(alfredSessionsTable).where(eq(alfredSessionsTable.id, id));
    expect(JSON.stringify(sess)).not.toContain("TRASCRIZIONE-SEGRETA");
  });

  it("close senza trascrizione o con trascrizione vuota non riassume", async () => {
    const a = await api("POST", "/alfred/sessions");
    expect((await api("POST", `/alfred/sessions/${a.json.sessionId}/close`)).status).toBe(204);
    const b = await api("POST", "/alfred/sessions");
    expect((await api("POST", `/alfred/sessions/${b.json.sessionId}/close`, { transcript: "  " })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(await db.select().from(characterHistoryTable)).toHaveLength(0);
  });

  it("trascrizione oltre 20 000 caratteri: 400 e la sessione resta attiva", async () => {
    const s = await api("POST", "/alfred/sessions");
    expect((await api("POST", `/alfred/sessions/${s.json.sessionId}/close`, { transcript: "x".repeat(20_001) })).status).toBe(400);
    const [sess] = await db.select().from(alfredSessionsTable).where(eq(alfredSessionsTable.id, s.json.sessionId));
    expect(sess!.status).toBe("active");
    expect((await api("POST", `/alfred/sessions/${s.json.sessionId}/close`, { transcript: "x".repeat(20_000) })).status).toBe(204);
  });
});
