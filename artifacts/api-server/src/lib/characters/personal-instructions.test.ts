import { afterAll, describe, expect, it } from "vitest";
import { db, pool, usersTable, characterInstructionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  INSTRUCTION_MESSAGES,
  InstructionError,
  PERSONAL_INSTRUCTIONS_HEADER,
  getCurrentInstructions,
  getInstructionVersion,
  listInstructionVersions,
  normalizeInstructions,
  personalInstructionsBlock,
  restoreInstructions,
  saveInstructions,
  withPersonalInstructions,
} from "./personal-instructions";

async function newUser() {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `pi-${Math.random().toString(36).slice(2, 10)}@example.com` })
    .returning();
  return u!.id;
}

async function rejects(p: Promise<unknown>, status: number, message: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(InstructionError);
  expect((err as InstructionError).status).toBe(status);
  expect((err as InstructionError).message).toBe(message);
}

afterAll(async () => {
  await pool.end();
});

describe("normalizeInstructions", () => {
  it("toglie i controlli tranne a capo e tab e gli spazi finali", () => {
    expect(normalizeInstructions("a\u0007b\n\tc  ")).toBe("ab\n\tc");
  });
  it("rispetta il limite di 8 000 caratteri dopo la pulizia", () => {
    expect(() => normalizeInstructions("a".repeat(8_001))).toThrow(INSTRUCTION_MESSAGES.tooLong);
    expect(normalizeInstructions("a".repeat(8_000) + "   ")).toBe("a".repeat(8_000));
  });
  it("rifiuta le credenziali", () => {
    expect(() => normalizeInstructions("usa sk-abcdefghijklmnop1234 per entrare")).toThrow(INSTRUCTION_MESSAGES.credential);
  });
});

describe("versioni delle istruzioni", () => {
  it("salva, ignora i doppioni, controlla la base e ripristina", async () => {
    const u = await newUser();
    expect(await getCurrentInstructions(u, "lucius")).toEqual({ version: 0, content: "", updatedAt: null });

    const v1 = await saveInstructions(u, "lucius", "Dimmi sempre il costo", 0);
    expect(v1).toMatchObject({ version: 1, content: "Dimmi sempre il costo", created: true });

    const same = await saveInstructions(u, "lucius", "Dimmi sempre il costo  \n", 1);
    expect(same).toMatchObject({ version: 1, created: false });

    await rejects(saveInstructions(u, "lucius", "altro", 0), 409, INSTRUCTION_MESSAGES.changed);

    const v2 = await saveInstructions(u, "lucius", "Rispondi breve", 1);
    expect(v2.version).toBe(2);

    const v3 = await restoreInstructions(u, "lucius", 1, 2);
    expect(v3).toMatchObject({ version: 3, content: "Dimmi sempre il costo", created: true });
    const rows = await db
      .select()
      .from(characterInstructionsTable)
      .where(and(eq(characterInstructionsTable.userId, u), eq(characterInstructionsTable.version, 3)));
    expect(rows[0]!.source).toBe("restore");

    await rejects(restoreInstructions(u, "lucius", 9, 3), 404, INSTRUCTION_MESSAGES.versionNotFound);

    const v4 = await saveInstructions(u, "lucius", "", 3);
    expect(v4).toMatchObject({ version: 4, content: "" });
    expect(await personalInstructionsBlock(u, "lucius")).toBe("");
  });

  it("due salvataggi concorrenti sulla stessa base: uno solo vince", async () => {
    const u = await newUser();
    await saveInstructions(u, "lucius", "uno", 0);
    const results = await Promise.allSettled([
      saveInstructions(u, "lucius", "due A", 1),
      saveInstructions(u, "lucius", "due B", 1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(InstructionError);
    expect(lost.reason.status).toBe(409);
    const rows = await db
      .select()
      .from(characterInstructionsTable)
      .where(and(eq(characterInstructionsTable.userId, u), eq(characterInstructionsTable.version, 2)));
    expect(rows).toHaveLength(1);
  });

  it("separa utenti e personaggi e elenca dalla più recente", async () => {
    const u = await newUser();
    const other = await newUser();
    await saveInstructions(u, "lucius", "per Lucius", 0);
    await saveInstructions(u, "lucius", "per Lucius, più lungo", 1);
    expect((await getCurrentInstructions(u, "alfred")).version).toBe(0);
    expect(await personalInstructionsBlock(u, "alfred")).toBe("");
    expect(await personalInstructionsBlock(other, "lucius")).toBe("");
    expect(await personalInstructionsBlock(u, "lucius")).toBe(`${PERSONAL_INSTRUCTIONS_HEADER}\nper Lucius, più lungo`);

    const list = await listInstructionVersions(u, "lucius");
    expect(list.map((v) => v.version)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ source: "manual", length: "per Lucius, più lungo".length });
    expect(await getInstructionVersion(u, "lucius", 1)).toMatchObject({ version: 1, content: "per Lucius", source: "manual" });
    await rejects(getInstructionVersion(u, "lucius", 7), 404, INSTRUCTION_MESSAGES.versionNotFound);
  });
});

describe("withPersonalInstructions", () => {
  it("aggiunge il blocco solo se c'è", () => {
    expect(withPersonalInstructions("sys", "")).toBe("sys");
    expect(withPersonalInstructions("sys", "blocco")).toBe("sys\n\nblocco");
  });
});
