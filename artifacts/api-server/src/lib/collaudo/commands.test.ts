import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, releaseTestCommandsTable } from "@workspace/db";
import { seedReleaseTest } from "../../../test/collaudo-fixture";
import { enqueueCommand, nextCommand, releaseCommand, saveCommandResult, waitCommandResult, wakeRunner } from "./commands";

let testId: number;

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  ({ testId } = await seedReleaseTest({ status: "running" }));
});

afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

const row = async (id: number) => (await db.select().from(releaseTestCommandsTable).where(eq(releaseTestCommandsTable.id, id)))[0]!;

describe("coda dei comandi del collaudo", () => {
  it("enqueueCommand + nextCommand restituisce il comando e lo segna sent", async () => {
    const id = await enqueueCommand(testId, "shell", { command: "ls" });
    const next = await nextCommand(testId, 1_000);
    expect(next).toEqual({ id, kind: "shell", args: { command: "ls" } });
    expect((await row(id)).status).toBe("sent");
    // consegnato una volta sola
    expect(await nextCommand(testId, 0)).toBeNull();
  });

  it("i comandi arrivano nell'ordine di accodamento", async () => {
    const a = await enqueueCommand(testId, "shell", { n: 1 });
    const b = await enqueueCommand(testId, "browser", { n: 2 });
    expect((await nextCommand(testId, 0))?.id).toBe(a);
    expect((await nextCommand(testId, 0))?.id).toBe(b);
  });

  it("senza comandi torna null dopo l'attesa", async () => {
    const t0 = Date.now();
    expect(await nextCommand(testId, 150)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it("un comando accodato durante l'attesa sveglia nextCommand", async () => {
    const waiting = nextCommand(testId, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    const id = await enqueueCommand(testId, "shell", { command: "pwd" });
    const t0 = Date.now();
    expect((await waiting)?.id).toBe(id);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("wakeRunner senza comandi fa tornare subito null a nextCommand", async () => {
    const waiting = nextCommand(testId, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    wakeRunner(testId);
    expect(await waiting).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("saveCommandResult sveglia waitCommandResult", async () => {
    const id = await enqueueCommand(testId, "shell", { command: "ls" });
    const waiting = waitCommandResult(id, 5_000);
    await nextCommand(testId, 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(await saveCommandResult(testId, id, { ok: true, output: "file.txt" })).toBe(true);
    expect(await waiting).toEqual({ ok: true, output: "file.txt" });
    // risultato una volta sola
    expect(await saveCommandResult(testId, id, { ok: true, output: "altro" })).toBe(false);
  });

  it("un comando non consegnato o di un altro collaudo non accetta risultati", async () => {
    const id = await enqueueCommand(testId, "shell", {});
    expect(await saveCommandResult(testId, id, { ok: true, output: "x" })).toBe(false);
    await nextCommand(testId, 0);
    expect(await saveCommandResult(testId + 99, id, { ok: true, output: "x" })).toBe(false);
  });

  it("scaduto: expired e {ok:false, output: comando scaduto}", async () => {
    const id = await enqueueCommand(testId, "shell", {});
    expect(await waitCommandResult(id, 100)).toEqual({ ok: false, output: "comando scaduto" });
    expect((await row(id)).status).toBe("expired");
    // il runner non lo riceve più
    expect(await nextCommand(testId, 0)).toBeNull();
  });

  it("uscite ripulite dalle credenziali", async () => {
    const id = await enqueueCommand(testId, "shell", {});
    await nextCommand(testId, 0);
    await saveCommandResult(testId, id, { ok: false, output: `token ghp_${"a1".repeat(18)} fine` });
    const out = (await row(id)).output!;
    expect(out).toBe("token *** fine");
    expect(out).not.toContain("ghp_");
  });

  it("l'uscita si taglia a 8 000 caratteri", async () => {
    const id = await enqueueCommand(testId, "shell", {});
    await nextCommand(testId, 0);
    await saveCommandResult(testId, id, { ok: true, output: "riga di testo\n".repeat(2_000) });
    expect((await row(id)).output!.length).toBe(8_000);
  });

  it("con il segnale già annullato nextCommand non prende il comando", async () => {
    const id = await enqueueCommand(testId, "shell", {});
    const controller = new AbortController();
    controller.abort();
    expect(await nextCommand(testId, 1_000, controller.signal)).toBeNull();
    expect((await row(id)).status).toBe("pending");
  });

  it("releaseCommand riporta a pending un comando sent e lo riconsegna al next dopo", async () => {
    const id = await enqueueCommand(testId, "shell", { command: "ls" });
    expect((await nextCommand(testId, 0))?.id).toBe(id);
    expect(await releaseCommand(testId, id)).toBe(true);
    expect((await row(id)).status).toBe("pending");
    expect(await nextCommand(testId, 0)).toEqual({ id, kind: "shell", args: { command: "ls" } });
    // non tocca un comando già chiuso o di un altro collaudo
    await saveCommandResult(testId, id, { ok: true, output: "x" });
    expect(await releaseCommand(testId, id)).toBe(false);
  });

  it("un next in attesa si sveglia quando un comando viene rilasciato", async () => {
    const id = await enqueueCommand(testId, "shell", {});
    await nextCommand(testId, 0);
    const waiting = nextCommand(testId, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    await releaseCommand(testId, id);
    expect((await waiting)?.id).toBe(id);
  });
});
