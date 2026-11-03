import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db, pool, appsTable, appToolsTable, pendingActionsTable, usersTable, type InsertAppTool } from "@workspace/db";
import { decryptSecret, encryptSecret } from "../secrets";
import type { CatalogTool } from "../tools/types";
import { MAX_PENDING_PER_USER, enqueueAction } from "./queue";

const saved = process.env["CASELLO_SECRET_KEY"];

let userA: number;
let userB: number;
let appId: number;
let tool: CatalogTool;

const SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, password: { type: "string", "x-sensitive": true } },
  required: ["id"],
};

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
  const [a] = await db.insert(usersTable).values({ email: "a@example.com", name: "A" }).returning();
  const [b] = await db.insert(usersTable).values({ email: "b@example.com", name: "B" }).returning();
  userA = a!.id;
  userB = b!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" })
    .returning();
  appId = app!.id;
  const [row] = await db
    .insert(appToolsTable)
    .values({
      appId,
      name: "set_password",
      kind: "http",
      identity: "user",
      level: "L2",
      status: "active",
      paramsSchema: SCHEMA,
      definition: { method: "PATCH", path: "/items/{id}", paramLocations: { id: "path", password: "body" } },
    } as InsertAppTool)
    .returning();
  tool = { ...row!, paramsSchema: SCHEMA, definition: row!.definition as CatalogTool["definition"] };
});

afterEach(() => {
  if (saved === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved;
});

// Il DB di prova è condiviso tra i file: lo si lascia vuoto
afterAll(async () => {
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
});

function enqueue(userId: number, overrides: { args?: Record<string, unknown>; recipient?: string; summary?: string } = {}) {
  return enqueueAction({
    userId,
    appId,
    agentId: null,
    runId: null,
    tool,
    args: overrides.args ?? { id: "42" },
    recipient: overrides.recipient ?? "Rosa",
    summary: overrides.summary ?? "Cambia la password di Rosa",
  });
}

async function rows() {
  return db.select().from(pendingActionsTable).orderBy(asc(pendingActionsTable.id));
}

describe("enqueueAction", () => {
  it("numera 1, 2, 3 per utente, indipendentemente tra utenti", async () => {
    expect(await enqueue(userA)).toEqual({ ok: true, number: 1 });
    expect(await enqueue(userA)).toEqual({ ok: true, number: 2 });
    expect(await enqueue(userB)).toEqual({ ok: true, number: 1 });
    expect(await enqueue(userA)).toEqual({ ok: true, number: 3 });
    const all = await rows();
    expect(all.map((r) => [r.userId, r.number, r.status])).toEqual([
      [userA, 1, "pending"],
      [userA, 2, "pending"],
      [userB, 1, "pending"],
      [userA, 3, "pending"],
    ]);
    expect(all[0]).toMatchObject({ appId, toolId: tool.id, recipient: "Rosa", summary: "Cambia la password di Rosa" });
  });

  it("due accodamenti concorrenti dello stesso utente → numeri 1 e 2", async () => {
    const results = await Promise.all([enqueue(userA), enqueue(userA)]);
    const numbers = results.map((r) => (r.ok ? r.number : 0)).sort();
    expect(numbers).toEqual([1, 2]);
  });

  it(`oltre ${MAX_PENDING_PER_USER} voci in attesa → «troppe azioni in attesa di conferma»`, async () => {
    expect(MAX_PENDING_PER_USER).toBe(50);
    await db.insert(pendingActionsTable).values(
      Array.from({ length: 50 }, (_, i) => ({
        userId: userA,
        number: i + 1,
        appId,
        toolId: tool.id,
        argsEnc: encryptSecret("{}"),
        argsPublic: {},
        recipient: "x",
        summary: "x",
      })),
    );
    expect(await enqueue(userA)).toEqual({ ok: false, message: "troppe azioni in attesa di conferma" });
    // Le voci già decise non contano
    await db.update(pendingActionsTable).set({ status: "done" }).where(eq(pendingActionsTable.number, 1));
    expect(await enqueue(userA)).toEqual({ ok: true, number: 51 });
    // Il limite è per utente
    expect(await enqueue(userB)).toEqual({ ok: true, number: 1 });
  });

  it("testo con un segnaposto → «testo non pronto: …», nessuna voce", async () => {
    const out = await enqueue(userA, { summary: "Riunione il [data da concordare] con @marco" });
    expect(out).toEqual({
      ok: false,
      message: 'testo non pronto: segnaposto "[data da concordare]"; menzione "@marco" non nel destinatario',
    });
    expect(await rows()).toEqual([]);
  });

  it("argomento x-sensitive: *** in args_public, in chiaro dopo decryptSecret(args_enc)", async () => {
    await enqueue(userA, { args: { id: "42", password: "segreta-123" } });
    const [row] = await rows();
    expect(row!.argsPublic).toEqual({ id: "42", password: "***" });
    expect(row!.argsEnc).not.toContain("segreta-123");
    expect(JSON.parse(decryptSecret(row!.argsEnc))).toEqual({ id: "42", password: "segreta-123" });
  });

  it("argomento x-sensitive con @ o <…>: non controllato né citato, la voce si crea", async () => {
    expect(await enqueue(userA, { args: { id: "42", password: "Pa@ss1<abc>" } })).toEqual({ ok: true, number: 1 });
    const out = await enqueue(userA, { args: { id: "42", password: "Pa@ss1<abc>" }, summary: "TODO" });
    expect(out).toEqual({ ok: false, message: 'testo non pronto: segnaposto "TODO"' });
  });
});
