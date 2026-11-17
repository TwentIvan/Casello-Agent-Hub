import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, appsTable, bugReportMessagesTable, bugReportsTable, type App } from "@workspace/db";

vi.mock("./triage", () => ({ startTriage: vi.fn(async () => {}) }));

import { startTriage } from "./triage";
import { BUG_MESSAGES } from "./messages";
import {
  addReporterMessage,
  cleanBugText,
  cleanPageUrl,
  createBugReport,
  getForRequester,
  listForRequester,
  markSeen,
  setStatus,
  type Requester,
} from "./reports";

let counter = 0;
async function newApp(over: Partial<typeof appsTable.$inferInsert> = {}): Promise<App> {
  counter++;
  const [row] = await db
    .insert(appsTable)
    .values({ name: `Bug App ${counter}`, slug: `bug-app-${Date.now()}-${counter}`, baseUrl: "https://example.com", ...over })
    .returning();
  return row!;
}

const ana: Requester = { kind: "identity", sub: "u-1", name: "Ana", email: "ana@example.com" };
const input = { title: "Non salva", description: "Il pulsante non fa nulla" };

beforeEach(async () => {
  await db.delete(bugReportsTable);
  vi.mocked(startTriage).mockClear();
});
afterAll(async () => {
  await db.delete(bugReportsTable);
  await pool.end();
});

describe("cleanBugText e cleanPageUrl", () => {
  it("rifiuta vuoto, troppo lungo e caratteri di controllo", () => {
    expect(() => cleanBugText("  ", 200, true)).toThrow(BUG_MESSAGES.invalidText);
    expect(() => cleanBugText("a".repeat(201), 200, true)).toThrow(BUG_MESSAGES.invalidText);
    expect(() => cleanBugText("a\u0007b", 200, true)).toThrow(BUG_MESSAGES.invalidText);
    expect(cleanBugText("riga1\nriga2\tok", 200, true)).toBe("riga1\nriga2\tok");
    expect(cleanBugText("  ", 200, false)).toBeNull();
  });
  it("nasconde le credenziali", () => {
    expect(cleanBugText("la chiave è sk-" + "a1B2c3D4".repeat(5) + " boh", 200, true)).toBe("la chiave è *** boh");
  });
  it("tiene solo indirizzi http/https senza query né frammento", () => {
    expect(cleanPageUrl("https://a.it/x?tok=1#h")).toBe("https://a.it/x");
    expect(cleanPageUrl("javascript:alert(1)")).toBeNull();
    expect(cleanPageUrl("non un indirizzo")).toBeNull();
    expect(cleanPageUrl(undefined)).toBeNull();
    expect(cleanPageUrl("https://a.it/" + "x".repeat(600))).toBeNull();
  });
});

describe("createBugReport", () => {
  it("numera per App e avvia il vaglio", async () => {
    const a = await newApp();
    const b = await newApp();
    const r1 = await createBugReport(a, ana, input, "1.2.3.4");
    const r2 = await createBugReport(a, ana, input, "1.2.3.4");
    const r3 = await createBugReport(b, ana, input, null);
    expect([r1.number, r2.number, r3.number]).toEqual([1, 2, 1]);
    expect(r1.status).toBe("received");
    expect(r1.ipPrefix).toBe("1.2.3.0/24");
    expect(startTriage).toHaveBeenCalledWith(r1.id);
  });

  it("limita a 5 al giorno per richiedente e riparte il giorno dopo", async () => {
    const a = await newApp();
    for (let i = 0; i < 5; i++) await createBugReport(a, ana, input, null);
    await expect(createBugReport(a, ana, input, null)).rejects.toMatchObject({ status: 429, message: BUG_MESSAGES.dailyLimit });
    // un altro richiedente passa
    await createBugReport(a, { kind: "browser", keyHash: "h1" }, input, null);
    const tomorrow = new Date(Date.now() + 36 * 3_600_000);
    await expect(createBugReport(a, ana, input, null, tomorrow)).resolves.toBeTruthy();
  });

  it("limita per App", async () => {
    const a = await newApp({ bugReportsDailyLimit: 2 });
    await createBugReport(a, { kind: "browser", keyHash: "k1" }, input, null);
    await createBugReport(a, { kind: "browser", keyHash: "k2" }, input, null);
    await expect(createBugReport(a, { kind: "browser", keyHash: "k3" }, input, null)).rejects.toMatchObject({
      status: 429,
      message: BUG_MESSAGES.dailyLimit,
    });
  });

  it("controlla e ripulisce i testi", async () => {
    const a = await newApp();
    await expect(createBugReport(a, ana, { ...input, title: "" }, null)).rejects.toMatchObject({ status: 400 });
    await expect(createBugReport(a, ana, { ...input, title: "t".repeat(201) }, null)).rejects.toMatchObject({ status: 400 });
    await expect(createBugReport(a, ana, { ...input, title: "t\u0007" }, null)).rejects.toMatchObject({ status: 400 });
    const r = await createBugReport(
      a,
      ana,
      { ...input, description: "chiave sk-" + "a1B2c3D4".repeat(5), pageContext: { url: "https://a.it/p?x=1#y", page: "wi", id: "7" } },
      null,
    );
    expect(r.description).toBe("chiave ***");
    expect(r.pageContext).toEqual({ page: "wi", id: "7", url: "https://a.it/p" });
    expect(r.reporterName).toBe("Ana");
  });
});

describe("visibilità", () => {
  it("il richiedente vede solo le proprie segnalazioni di quell'App", async () => {
    const a = await newApp();
    const b = await newApp();
    const r = await createBugReport(a, ana, input, null);
    const k: Requester = { kind: "browser", keyHash: "hh" };
    const rb = await createBugReport(a, k, input, null);

    expect(await getForRequester(a.id, ana, r.id)).not.toBeNull();
    expect(await getForRequester(a.id, { ...ana, sub: "altro" }, r.id)).toBeNull();
    expect(await getForRequester(a.id, k, r.id)).toBeNull();
    expect(await getForRequester(b.id, ana, r.id)).toBeNull();
    expect(await getForRequester(a.id, k, rb.id)).not.toBeNull();
    expect(await getForRequester(a.id, { kind: "browser", keyHash: "x" }, rb.id)).toBeNull();
    expect((await listForRequester(a.id, ana)).map((s) => s.id)).toEqual([r.id]);
    expect(await listForRequester(a.id, k)).toHaveLength(1);
  });

  it("unseen: vero dopo needs_info con messaggio lead, falso dopo markSeen o in triage", async () => {
    const a = await newApp();
    const r = await createBugReport(a, ana, input, null);
    expect((await listForRequester(a.id, ana))[0]!.unseen).toBe(false);
    await db.transaction((tx) => setStatus(tx, r.id, ["received"], "triage"));
    expect((await listForRequester(a.id, ana))[0]!.unseen).toBe(false);
    await db.insert(bugReportMessagesTable).values({ reportId: r.id, author: "lead", content: "Quale browser?" });
    await db.transaction((tx) => setStatus(tx, r.id, ["triage"], "needs_info"));
    let [s] = await listForRequester(a.id, ana);
    expect(s!.unseen).toBe(true);
    expect(s!.statusLabel).toBe("Serve una tua risposta");
    const detail = await getForRequester(a.id, ana, r.id);
    expect(detail!.messages.map((m) => m.author)).toEqual(["lead"]);
    expect(await markSeen(a.id, ana, [r.id])).toBe(1);
    [s] = await listForRequester(a.id, ana);
    expect(s!.unseen).toBe(false);
    expect(await markSeen(a.id, { ...ana, sub: "altro" }, [r.id])).toBe(0);
  });
});

describe("addReporterMessage", () => {
  it("in needs_info aggiunge il messaggio e rimette in triage", async () => {
    const a = await newApp();
    const r = await createBugReport(a, ana, input, null);
    await db.transaction((tx) => setStatus(tx, r.id, ["received"], "needs_info"));
    vi.mocked(startTriage).mockClear();
    const d = await addReporterMessage(a.id, ana, r.id, "Chrome 120");
    expect(d.status).toBe("triage");
    expect(d.messages.at(-1)).toMatchObject({ author: "reporter", content: "Chrome 120" });
    expect(startTriage).toHaveBeenCalledWith(r.id);
  });

  it("negli altri stati risponde 409", async () => {
    const a = await newApp();
    const r = await createBugReport(a, ana, input, null);
    await db.transaction((tx) => setStatus(tx, r.id, ["received"], "pending_approval"));
    await expect(addReporterMessage(a.id, ana, r.id, "ciao")).rejects.toMatchObject({ status: 409, message: BUG_MESSAGES.notWaiting });
    await expect(addReporterMessage(a.id, { ...ana, sub: "x" }, r.id, "ciao")).rejects.toMatchObject({ status: 404 });
  });
});

describe("setStatus", () => {
  it("è condizionato allo stato di partenza", async () => {
    const a = await newApp();
    const r = await createBugReport(a, ana, input, null);
    const ok = await db.transaction((tx) => setStatus(tx, r.id, ["received"], "triage", { publicMessage: "x" }));
    expect(ok!.status).toBe("triage");
    expect(ok!.publicMessage).toBe("x");
    expect(await db.transaction((tx) => setStatus(tx, r.id, ["received"], "fixed"))).toBeNull();
    const [row] = await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, r.id));
    expect(row!.status).toBe("triage");
  });
});
