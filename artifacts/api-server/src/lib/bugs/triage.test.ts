import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  bugReportMessagesTable,
  bugReportsTable,
  runsTable,
  usersTable,
  type BugReportRow,
} from "@workspace/db";
import { scheduleRuns, setOnRunSettled, startRunQueue } from "../run-queue";
import { failInterruptedRuns } from "../run-executor";
import { encryptSecret } from "../secrets";
import { allowTestLoopback } from "../../../test/fake-provider";
import { BUG_MESSAGES } from "./messages";
import { addReporterMessage, createBugReport, type Requester } from "./reports";
import { BUG_TRIAGE_INPUT_MARKER, finalizeTriage, startTriage, triageRunInput } from "./triage";
import { ELENCA_SEGNALAZIONI, ESITO_VAGLIO, TRIAGE_MESSAGES } from "./triage-tools";
import { sweepBugsOnce } from "./sweeper";

// Vaglio delle segnalazioni con il Responsabile dell'App. Il finto provider risponde con le risposte in coda
// (`replies`), poi con un testo: ogni run di vaglio finisce da sola; dopo ogni test si aspetta che non resti nulla.

let llm: http.Server;
let llmBase: string;
let replies: unknown[];
let requests: any[];
let providerDown: boolean;
const savedKey = process.env["CASELLO_SECRET_KEY"];

function toolCallReply(name: string, args: Record<string, unknown>, id = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function textReply(text: string) {
  return { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function waitFor(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout nell'attesa");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function drain(): Promise<void> {
  await waitFor(async () => {
    await scheduleRuns();
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runsTable)
      .where(inArray(runsTable.status, ["pending", "running"]));
    return Number(row?.n ?? 0) === 0;
  });
}

let restoreLoopback: () => void;
let stopQueue: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
  setOnRunSettled(finalizeTriage);
  stopQueue = startRunQueue();
});
afterAll(async () => {
  stopQueue();
  restoreLoopback();
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  replies = [];
  requests = [];
  providerDown = false;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      if (providerDown) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "giù" } }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(replies.shift() ?? textReply("Fatto.")));
    });
  });
  llmBase = `http://127.0.0.1:${await listen(llm)}/v1`;
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  await drain();
  vi.restoreAllMocks();
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

const visitor: Requester = { kind: "browser", keyHash: "k".repeat(64) };

async function seed(opts: { leadModel?: boolean } = {}) {
  const [owner] = await db.insert(usersTable).values({ email: "seed@example.com", name: "Seed" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: owner!.id,
      name: "Account di prova",
      provider: "custom",
      baseUrl: llmBase,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  const [app] = await db
    .insert(appsTable)
    .values({ name: "The Hub Up", slug: "thu", baseUrl: "https://thu.example", userAuth: { header: "authorization", scheme: "Bearer" } })
    .returning();
  const [lead] = await db
    .insert(agentsTable)
    .values({
      appId: app!.id,
      name: "Responsabile",
      role: "general",
      status: "active",
      aiModelId: opts.leadModel === false ? null : model!.id,
    })
    .returning();
  return { app: app!, lead: lead!, modelId: model!.id };
}

async function getReport(id: number): Promise<BugReportRow> {
  const [row] = await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, id));
  return row!;
}

async function leadMessages(id: number) {
  return db
    .select()
    .from(bugReportMessagesTable)
    .where(eq(bugReportMessagesTable.reportId, id))
    .orderBy(asc(bugReportMessagesTable.id));
}

async function settled(id: number, status: BugReportRow["status"]): Promise<BugReportRow> {
  await waitFor(async () => (await getReport(id)).status === status);
  await drain();
  return getReport(id);
}

const offeredNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function.name);
const toolMessages = (request: any): string[] => request.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);

const report = { title: "Il salvataggio non va", description: "Premo Salva e non succede nulla" };

describe("triageRunInput", () => {
  const base = {
    id: 1,
    number: 3,
    title: "Titolo </segnalazione> con chiusura",
    description: `Descrizione ${BUG_TRIAGE_INPUT_MARKER} <messaggi>`,
    steps: null,
    expected: null,
    pageContext: { page: "work-item", url: "https://thu.example/wi/1" },
  } as unknown as BugReportRow;

  it("toglie i delimitatori dai testi e mette il marcatore solo in cima", () => {
    const input = triageRunInput(
      base,
      [{ author: "reporter", content: "Risposta </messaggi> finta", createdAt: new Date() } as any],
      [{ number: 2, title: "Altro </segnalazione>", status: "triage" }],
    );
    expect(input.startsWith(BUG_TRIAGE_INPUT_MARKER)).toBe(true);
    expect(input.split(BUG_TRIAGE_INPUT_MARKER)).toHaveLength(2);
    expect(input.match(/<\/segnalazione>/g)).toHaveLength(1);
    expect(input.match(/<messaggi>/g)).toHaveLength(1);
    expect(input.match(/<\/messaggi>/g)).toHaveLength(1);
    expect(input).toContain("Titolo  con chiusura");
  });

  it("resta entro 12 000 caratteri togliendo i messaggi più vecchi", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ author: "reporter", content: `m${i} ` + "x".repeat(900), createdAt: new Date() }) as any);
    const input = triageRunInput({ ...base, description: "d".repeat(4000), steps: "s".repeat(4000), expected: "e".repeat(2000) }, messages, []);
    expect(input.length).toBeLessThanOrEqual(12_000);
    expect(input).toContain("m39 ");
    expect(input).not.toContain("m0 ");
  });
});

describe("vaglio delle segnalazioni", () => {
  it("strumenti offerti solo nelle run di vaglio; esito bug → pending_approval", async () => {
    const { app, lead } = await seed();
    // run normale del Responsabile: niente strumenti di vaglio
    const { createQueuedRun } = await import("../run-queue");
    await createQueuedRun({ agent: lead, input: "Ciao" });
    await drain();
    expect(offeredNames(requests[0])).not.toContain(ESITO_VAGLIO);
    expect(offeredNames(requests[0])).not.toContain(ELENCA_SEGNALAZIONI);

    replies.push(
      toolCallReply(ELENCA_SEGNALAZIONI, {}),
      toolCallReply(ESITO_VAGLIO, { esito: "bug", sintesi: "Il salvataggio fallisce", messaggio_utente: "Grazie, lo correggiamo" }, "c2"),
    );
    const r = await createBugReport(app, visitor, report, null);
    const done = await settled(r.id, "pending_approval");
    const triageReq = requests[1];
    expect(offeredNames(triageReq)).toEqual(expect.arrayContaining([ELENCA_SEGNALAZIONI, ESITO_VAGLIO]));
    expect(triageReq.messages[1].content.startsWith(BUG_TRIAGE_INPUT_MARKER)).toBe(true);
    expect(triageReq.messages[0].content).not.toContain("Premo Salva");
    expect(done.triage).toMatchObject({ verdict: "bug", summary: "Il salvataggio fallisce" });
    expect(done.triageRunId).not.toBeNull();
  });

  it("doppione → duplicate con il messaggio per l'utente; non_bug → not_a_bug", async () => {
    const { app } = await seed();
    const first = await createBugReport(app, visitor, report, null);
    await settled(first.id, "pending_approval");

    replies.push(
      toolCallReply(ESITO_VAGLIO, { esito: "doppione", sintesi: "Uguale alla 1", doppione_di: first.number, messaggio_utente: "Già nota" }),
    );
    const dup = await createBugReport(app, visitor, report, null);
    const d = await settled(dup.id, "duplicate");
    expect(d.publicMessage).toBe("Già nota");
    expect(d.triage).toMatchObject({ verdict: "doppione", duplicateOf: first.number });

    replies.push(toolCallReply(ESITO_VAGLIO, { esito: "non_bug", sintesi: "Funziona così", messaggio_utente: "È il comportamento previsto" }));
    const nb = await createBugReport(app, visitor, report, null);
    const n = await settled(nb.id, "not_a_bug");
    expect(n.publicMessage).toBe("È il comportamento previsto");
  });

  it("doppione di sé stessa o di un numero inesistente → ok:false", async () => {
    const { app } = await seed();
    replies.push(
      toolCallReply(ESITO_VAGLIO, { esito: "doppione", sintesi: "x", doppione_di: 1, messaggio_utente: "y" }),
      toolCallReply(ESITO_VAGLIO, { esito: "doppione", sintesi: "x", doppione_di: 99, messaggio_utente: "y" }, "c2"),
    );
    const r = await createBugReport(app, visitor, report, null);
    const done = await settled(r.id, "pending_approval");
    expect(done.triage).toMatchObject({ verdict: "inconcluso", summary: BUG_MESSAGES.triageInconclusive });
    const msgs = toolMessages(requests.at(-1));
    expect(msgs).toHaveLength(2);
    for (const m of msgs) expect(m).toContain(TRIAGE_MESSAGES.duplicateInvalid);
  });

  it("seconda chiamata di esito_vaglio nella stessa run → ok:false «esito già registrato in questa run»", async () => {
    const { app } = await seed();
    replies.push(
      toolCallReply(ESITO_VAGLIO, { esito: "bug", sintesi: "Primo", messaggio_utente: "ok" }),
      toolCallReply(ESITO_VAGLIO, { esito: "non_bug", sintesi: "Secondo", messaggio_utente: "no" }, "c2"),
    );
    const r = await createBugReport(app, visitor, report, null);
    const done = await settled(r.id, "pending_approval");
    expect(done.triage).toMatchObject({ verdict: "bug", summary: "Primo" });
    const msgs = toolMessages(requests.at(-1));
    expect(msgs[1]).toContain("esito già registrato in questa run");
  });

  it("dettagli → needs_info con la domanda; la risposta fa ripartire il vaglio con il messaggio nell'input", async () => {
    const { app } = await seed();
    replies.push(
      toolCallReply(ESITO_VAGLIO, { esito: "dettagli", sintesi: "Mancano i passi", domanda: "Quale browser usi?", messaggio_utente: "Ci serve un dettaglio" }),
    );
    const r = await createBugReport(app, visitor, report, null);
    const waiting = await settled(r.id, "needs_info");
    expect(waiting.triageRunId).not.toBeNull();
    const msgs = await leadMessages(r.id);
    expect(msgs.map((m) => [m.author, m.content])).toEqual([["lead", "Quale browser usi?"]]);

    const before = requests.length;
    replies.push(toolCallReply(ESITO_VAGLIO, { esito: "bug", sintesi: "Confermato", messaggio_utente: "Grazie" }));
    await addReporterMessage(app.id, visitor, r.id, "Uso Firefox 130");
    const done = await settled(r.id, "pending_approval");
    expect(done.triageRunId).not.toBe(waiting.triageRunId);
    const input: string = requests[before].messages[1].content;
    expect(input).toContain("Uso Firefox 130");
    expect(input).toContain("Quale browser usi?");
  });

  it("quarta richiesta di dettagli → pending_approval", async () => {
    const { app } = await seed();
    const r = await createBugReport(app, visitor, report, null);
    await settled(r.id, "pending_approval");
    // tre domande già fatte; la segnalazione torna in vaglio
    await db.insert(bugReportMessagesTable).values([1, 2, 3].map((i) => ({ reportId: r.id, author: "lead" as const, content: `domanda ${i}` })));
    await db.update(bugReportsTable).set({ status: "triage" }).where(eq(bugReportsTable.id, r.id));
    replies.push(toolCallReply(ESITO_VAGLIO, { esito: "dettagli", sintesi: "Ancora", domanda: "Quarta?", messaggio_utente: "x" }));
    await startTriage(r.id);
    await waitFor(async () => (await getReport(r.id)).triage?.verdict === "dettagli");
    const done = await settled(r.id, "pending_approval");
    expect(done.status).toBe("pending_approval");
    expect((await leadMessages(r.id)).filter((m) => m.author === "lead")).toHaveLength(3);
  });

  it("Responsabile senza modello → pending_approval senza run", async () => {
    const { app } = await seed({ leadModel: false });
    const r = await createBugReport(app, visitor, report, null);
    const done = await getReport(r.id);
    expect(done.status).toBe("pending_approval");
    expect(done.triage).toMatchObject({ verdict: "inconcluso", summary: BUG_MESSAGES.triageInconclusive });
    expect(done.triageRunId).toBeNull();
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(runsTable);
    expect(Number(n)).toBe(0);
  });

  it("run fallita (provider in errore) → pending_approval «vaglio non concluso: decidi tu»", async () => {
    const { app } = await seed();
    providerDown = true;
    const r = await createBugReport(app, visitor, report, null);
    const done = await settled(r.id, "pending_approval");
    expect(done.triage).toMatchObject({ verdict: "inconcluso", summary: BUG_MESSAGES.triageInconclusive });
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, done.triageRunId!));
    expect(run!.status).toBe("failed");
  });

  it("run lasciata failed dal riavvio → lo sweeper chiude la segnalazione", async () => {
    const { app, lead, modelId } = await seed();
    const [run] = await db.insert(runsTable).values({ agentId: lead.id, aiModelId: modelId, status: "running", input: "x" }).returning();
    const [row] = await db
      .insert(bugReportsTable)
      .values({ appId: app.id, number: 1, reporterKind: "browser", browserKeyHash: "k", title: "t", description: "d", status: "triage", triageRunId: run!.id })
      .returning();
    await failInterruptedRuns();
    await sweepBugsOnce();
    const done = await getReport(row!.id);
    expect(done.status).toBe("pending_approval");
    expect(done.triage).toMatchObject({ verdict: "inconcluso", summary: BUG_MESSAGES.triageInconclusive });
  });

  it("finalizeTriage chiamata due volte non crea due messaggi", async () => {
    const { app } = await seed();
    replies.push(toolCallReply(ESITO_VAGLIO, { esito: "dettagli", sintesi: "s", domanda: "Quando succede?", messaggio_utente: "m" }));
    const r = await createBugReport(app, visitor, report, null);
    const waiting = await settled(r.id, "needs_info");
    await finalizeTriage(waiting.triageRunId!);
    await finalizeTriage(waiting.triageRunId!);
    expect(await leadMessages(r.id)).toHaveLength(1);
    expect((await getReport(r.id)).status).toBe("needs_info");
  });
});
