import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, appsTable, appToolsTable, pendingActionsTable, usersTable, type InsertAppTool } from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { CatalogTool } from "../tools/types";
import { startFakeMcp, type FakeMcp } from "../../../test/fake-mcp";
import { allowTestLoopback } from "../../../test/fake-provider";
import { approveAction, failInterruptedActions, rejectAction, sensitiveValues } from "./decide";
import { enqueueAction } from "./queue";

const SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, password: { type: "string", "x-sensitive": true } },
  required: ["id"],
};
const saved = process.env["CASELLO_SECRET_KEY"];
let restoreLoopback: () => void;
let fake: FakeMcp | null;
let userA: number;
let userB: number;
let appId: number;
let toolId: number;

async function startFake(text = "fatto") {
  fake = await startFakeMcp({ tools: [{ name: "set_password", text }] });
  return fake;
}

async function seedApp(mcpUrl: string | null) {
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
  const [a] = await db.insert(usersTable).values({ email: "a@example.com", name: "A" }).returning();
  const [b] = await db.insert(usersTable).values({ email: "b@example.com", name: "B" }).returning();
  userA = a!.id;
  userB = b!.id;
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      mcpUrl,
      userAuth: { header: "Authorization", scheme: "Bearer" },
      serviceAuth: { header: "X-Service-Key", scheme: null },
      serviceSecretEnc: encryptSecret("segreto-servizio"),
    })
    .returning();
  appId = app!.id;
}

async function seedTool(identity: "user" | "service", extra: Partial<InsertAppTool> = {}) {
  const [row] = await db
    .insert(appToolsTable)
    .values({
      appId,
      name: "set_password",
      kind: "mcp",
      identity,
      level: "L2",
      status: "active",
      paramsSchema: SCHEMA,
      definition: { mcpName: "set_password" },
      ...extra,
    } as InsertAppTool)
    .returning();
  toolId = row!.id;
  return { ...row!, paramsSchema: SCHEMA, definition: row!.definition as CatalogTool["definition"] } as CatalogTool;
}

async function enqueue(tool: CatalogTool, userId = userA, args: Record<string, unknown> = { id: "42", password: "segreta-123" }) {
  const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args, recipient: "Rosa", summary: "Cambia la password di Rosa" });
  if (!out.ok) throw new Error(out.message);
  return out.number;
}

const rowOf = async (userId: number, number: number) =>
  (await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.userId, userId)))
    .find((r) => r.number === number)!;

beforeEach(() => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  restoreLoopback = allowTestLoopback();
  fake = null;
});

afterEach(async () => {
  restoreLoopback();
  await fake?.close();
  if (saved === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
});

describe("approveAction", () => {
  it("identità service: esegue gli argomenti originali (anche i sensibili) una volta e chiude done", async () => {
    const mcp = await startFake("password cambiata");
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    const out = await approveAction(userA, n, {});

    expect(out.ok).toBe(true);
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]!.args).toEqual({ id: "42", password: "segreta-123" });
    expect(mcp.calls[0]!.headers["x-service-key"]).toBe("segreto-servizio");
    const row = await rowOf(userA, n);
    expect(row).toMatchObject({ status: "done", result: "password cambiata", errorMessage: null, decidedBy: userA });
    expect(row.decidedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
  });

  it("due approvazioni concorrenti: una ok, una 409, una sola chiamata al servizio", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    const results = await Promise.all([approveAction(userA, n, {}), approveAction(userA, n, {})]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toEqual({ ok: false, status: 409, message: "azione già decisa" });
    expect(mcp.calls).toHaveLength(1);
  });

  it("identità user senza token: 400 e voce ancora pending; con token l'header arriva al servizio", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("user"));

    expect(await approveAction(userA, n, {})).toEqual({ ok: false, status: 400, message: "serve il token dell'utente dell'app" });
    expect((await rowOf(userA, n)).status).toBe("pending");
    expect(mcp.calls).toHaveLength(0);

    const out = await approveAction(userA, n, { userToken: "token-rosa" });
    expect(out.ok).toBe(true);
    expect(mcp.calls[0]!.headers["authorization"]).toBe("Bearer token-rosa");
    const row = await rowOf(userA, n);
    expect(row.status).toBe("done");
    expect(JSON.stringify(row)).not.toContain("token-rosa");
  });

  it("tool diventato L3 con una deroga, disabilitato o ui: 409 e voce ancora pending", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const tool = await seedTool("service");
    const n = await enqueue(tool);

    await db.update(appToolsTable).set({ levelOverride: "L3" }).where(eq(appToolsTable.id, toolId));
    const msg = "lo strumento non può più essere eseguito da Botcave";
    expect(await approveAction(userA, n, {})).toEqual({ ok: false, status: 409, message: msg });
    await db.update(appToolsTable).set({ levelOverride: null, status: "disabled" }).where(eq(appToolsTable.id, toolId));
    expect(await approveAction(userA, n, {})).toEqual({ ok: false, status: 409, message: msg });
    expect((await rowOf(userA, n)).status).toBe("pending");
    expect(mcp.calls).toHaveLength(0);
  });

  it("app senza più mcpUrl: voce failed col messaggio del client, risposta ok con la voce", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));
    await db.update(appsTable).set({ mcpUrl: null }).where(eq(appsTable.id, appId));

    const out = await approveAction(userA, n, {});

    expect(out.ok && out.action.status).toBe("failed");
    expect(out.ok && out.action.errorMessage).toBe("l'app non ha un server MCP configurato");
    expect(mcp.calls).toHaveLength(0);
  });

  it("server MCP spento: failed «server MCP non raggiungibile»", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));
    await mcp.close();
    fake = null;

    const out = await approveAction(userA, n, {});

    expect(out.ok && out.action).toMatchObject({ status: "failed", errorMessage: "server MCP non raggiungibile" });
    expect((await rowOf(userA, n)).finishedAt).not.toBeNull();
  });

  it("errore del tool: failed con il contenuto dell'errore; nessun valore sensibile in result o error_message", async () => {
    const mcp = await startFakeMcp({
      tools: [{ name: "set_password", text: "rifiutata: segreta-123 non valida", isError: true }],
    });
    fake = mcp;
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    const out = await approveAction(userA, n, {});

    expect(out.ok && out.action.status).toBe("failed");
    expect(out.ok && out.action.errorMessage).toBe("rifiutata: *** non valida");
    expect(JSON.stringify(await rowOf(userA, n))).not.toContain("segreta-123");
  });

  it("esito ok con valore sensibile nel risultato: oscurato", async () => {
    const mcp = await startFake("impostata a segreta-123");
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    const out = await approveAction(userA, n, {});

    expect(out.ok && out.action.result).toBe("impostata a ***");
  });

  // Il servizio ha già eseguito l'azione: se poi fallisce la scrittura dell'esito non è «errore interno»
  function failUpdates(failing: number[]) {
    const real = db.update.bind(db);
    let n = 0;
    return vi.spyOn(db, "update").mockImplementation(((table: Parameters<typeof db.update>[0]) => {
      n += 1;
      if (failing.includes(n)) throw new Error("db giù: password segreta-123");
      return real(table);
    }) as typeof db.update);
  }

  it("scrittura dell'esito fallita dopo la chiamata: voce failed con esito incerto, non errore interno", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));
    const spy = failUpdates([2]); // 1 = prenotazione, 2 = esito

    const out = await approveAction(userA, n, {});
    spy.mockRestore();

    expect(mcp.calls).toHaveLength(1);
    expect(out.ok && out.action).toMatchObject({ status: "failed", errorMessage: "esito incerto: verifica sul servizio" });
  });

  it("anche la scrittura di ripiego fallisce: 500 fisso, voce executing (incerta al prossimo avvio)", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));
    const spy = failUpdates([2, 3]);

    const out = await approveAction(userA, n, {});
    spy.mockRestore();

    expect(out).toEqual({ ok: false, status: 500, message: "errore interno: esito dell'azione non registrato" });
    expect((await rowOf(userA, n)).status).toBe("executing");
    expect(await failInterruptedActions()).toBe(1);
    expect(await rowOf(userA, n)).toMatchObject({ status: "failed", errorMessage: "esito incerto: verifica sul servizio" });
  });

  it("escludi non vuoto su una voce action: 400 e voce ancora pending", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    expect(await approveAction(userA, n, { exclude: ["p1"] })).toEqual({ ok: false, status: 400, message: "passi da escludere non validi" });
    expect((await rowOf(userA, n)).status).toBe("pending");
    expect(mcp.calls).toHaveLength(0);
    expect((await approveAction(userA, n, { exclude: [] })).ok).toBe(true);
  });

  it("voce di un altro utente o inesistente: 404; già decisa: 409", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    expect(await approveAction(userB, n, {})).toEqual({ ok: false, status: 404, message: "azione non trovata" });
    expect(await approveAction(userA, 99, {})).toEqual({ ok: false, status: 404, message: "azione non trovata" });
    await approveAction(userA, n, {});
    expect(await approveAction(userA, n, {})).toEqual({ ok: false, status: 409, message: "azione già decisa" });
  });
});

describe("rejectAction", () => {
  it("rifiuta con nota e non chiama il servizio; poi 409; altro utente 404", async () => {
    const mcp = await startFake();
    await seedApp(mcp.url);
    const n = await enqueue(await seedTool("service"));

    expect(await rejectAction(userB, n, null)).toEqual({ ok: false, status: 404, message: "azione non trovata" });
    const out = await rejectAction(userA, n, "no, grazie");
    expect(out.ok).toBe(true);
    expect(await rowOf(userA, n)).toMatchObject({ status: "rejected", decisionNote: "no, grazie", decidedBy: userA });
    expect(await rejectAction(userA, n, null)).toEqual({ ok: false, status: 409, message: "azione già decisa" });
    expect(await approveAction(userA, n, {})).toEqual({ ok: false, status: 409, message: "azione già decisa" });
    expect(mcp.calls).toHaveLength(0);
  });
});

describe("failInterruptedActions", () => {
  it("le voci executing diventano failed con esito incerto; le altre restano", async () => {
    await seedApp(null);
    const tool = await seedTool("service");
    const n1 = await enqueue(tool);
    const n2 = await enqueue(tool);
    await db.update(pendingActionsTable).set({ status: "executing" }).where(eq(pendingActionsTable.number, n1));

    expect(await failInterruptedActions()).toBe(1);

    expect(await rowOf(userA, n1)).toMatchObject({ status: "failed", errorMessage: "esito incerto: verifica sul servizio" });
    expect((await rowOf(userA, n1)).finishedAt).not.toBeNull();
    expect((await rowOf(userA, n2)).status).toBe("pending");
  });
});

describe("sensitiveValues", () => {
  it("raccoglie i valori marcati, anche annidati", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string", "x-sensitive": true },
        c: { type: "object", properties: { d: { type: "string", "x-sensitive": true } } },
      },
    };
    expect(sensitiveValues(schema, { a: "x", b: "uno", c: { d: "due" } })).toEqual(["uno", "due"]);
  });
});
