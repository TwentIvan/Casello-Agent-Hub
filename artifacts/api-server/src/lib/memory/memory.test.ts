import { afterAll, describe, expect, it } from "vitest";
import { db, pool, usersTable, characterHistoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { looksLikeCredential } from "./credentials";
import { MEMORY_MESSAGES, MemoryError } from "./types";
import { addNote, deleteNote, listNotes, updateNote } from "./notes";
import { addHistory, deleteHistory, listHistory, recentHistoryTitles, searchHistory } from "./history";
import { memoryContextBlock } from "./context";

async function newUser() {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `mem-${Math.random().toString(36).slice(2, 10)}@example.com` })
    .returning();
  return u!.id;
}

const entry = (userId: number, refId: number, over: Partial<Parameters<typeof addHistory>[0]> = {}) => ({
  userId,
  character: "lucius" as const,
  kind: "plan_conversation" as const,
  refId,
  title: `Titolo ${refId}`,
  summary: `Riassunto ${refId}`,
  aiModelId: null,
  tokensUsed: 0,
  costUsd: null,
  ...over,
});

async function rejects(p: Promise<unknown>, status: number, message: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).status).toBe(status);
  expect((err as MemoryError).message).toBe(message);
}

afterAll(async () => {
  await pool.end();
});

describe("looksLikeCredential", () => {
  it("riconosce prefissi noti e token lunghi", () => {
    expect(looksLikeCredential("sk-proj-abc123")).toBe(true);
    expect(looksLikeCredential("la chiave è ghp_abcdef")).toBe(true);
    expect(looksLikeCredential("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksLikeCredential("a".repeat(8) + "0123456789abcdef0123456789abcdef0123")).toBe(true);
    expect(looksLikeCredential("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });
  it("non segnala frasi normali, parole lunghe o uuid", () => {
    expect(looksLikeCredential("Preferisce consegne precipitevolissimevolmente rapide")).toBe(false);
    expect(looksLikeCredential("id 123e4567-e89b-12d3-a456-426614174000 della squadra")).toBe(false);
    expect(looksLikeCredential("Lavora su The Hub Up il lunedì")).toBe(false);
  });
});

describe("appunti", () => {
  it("isolamento tra personaggi e utenti", async () => {
    const a = await newUser();
    const b = await newUser();
    const note = await addNote(a, "lucius", "  Preferisce risposte brevi  ", "chat:1");
    expect(note.content).toBe("Preferisce risposte brevi");
    expect(note.ref).toBe("chat:1");
    expect(await listNotes(a, "alfred")).toEqual([]);
    expect(await listNotes(b, "lucius")).toEqual([]);
    await rejects(updateNote(a, "alfred", note.id, "x"), 404, MEMORY_MESSAGES.notFound);
    await rejects(deleteNote(b, "lucius", note.id), 404, MEMORY_MESSAGES.notFound);
    const upd = await updateNote(a, "lucius", note.id, "Preferisce risposte lunghe");
    expect(upd.content).toBe("Preferisce risposte lunghe");
    await deleteNote(a, "lucius", note.id);
    expect(await listNotes(a, "lucius")).toEqual([]);
  });

  it("valida testo vuoto, lungo e credenziali", async () => {
    const u = await newUser();
    await rejects(addNote(u, "alfred", "   "), 400, MEMORY_MESSAGES.empty);
    await rejects(addNote(u, "alfred", "x".repeat(301)), 400, MEMORY_MESSAGES.tooLong);
    await rejects(addNote(u, "alfred", "sk-proj-abcdef"), 400, MEMORY_MESSAGES.credential);
    await rejects(addNote(u, "alfred", "0123456789abcdef0123456789abcdef01234567"), 400, MEMORY_MESSAGES.credential);
    const ok = await addNote(u, "alfred", "x".repeat(300));
    await rejects(updateNote(u, "alfred", ok.id, "ghp_abcdef"), 400, MEMORY_MESSAGES.credential);
  });

  it("il cinquantunesimo appunto è rifiutato, anche in concorrenza", async () => {
    const u = await newUser();
    for (let i = 0; i < 48; i++) await addNote(u, "alfred", `appunto ${i}`);
    const results = await Promise.allSettled([addNote(u, "alfred", "uno"), addNote(u, "alfred", "due"), addNote(u, "alfred", "tre")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    await rejects(addNote(u, "alfred", "oltre"), 409, MEMORY_MESSAGES.full);
    expect(await listNotes(u, "alfred")).toHaveLength(50);
    // l'altro personaggio ha il suo conto
    await addNote(u, "lucius", "ok");
  });
});

describe("storico", () => {
  it("la stessa voce si sostituisce", async () => {
    const u = await newUser();
    await addHistory(entry(u, 7, { title: "Vecchio" }));
    await addHistory(entry(u, 7, { title: "Nuovo", summary: "s".repeat(2000) }));
    const rows = await listHistory(u, "lucius");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Nuovo");
    expect(rows[0]!.summary).toHaveLength(1500);
    await addHistory(entry(u, 8, { title: "t".repeat(200) }));
    expect((await listHistory(u, "lucius")).find((r) => r.refId === 8)!.title).toHaveLength(120);
  });

  it("oltre 500 voci si toglie la più vecchia", async () => {
    const u = await newUser();
    const base = Date.now() - 1_000_000;
    await db.insert(characterHistoryTable).values(
      Array.from({ length: 500 }, (_, i) => ({
        ...entry(u, i + 1),
        costUsd: null,
        createdAt: new Date(base + i * 1000),
      })),
    );
    await addHistory(entry(u, 9999));
    const rows = await db.select().from(characterHistoryTable).where(eq(characterHistoryTable.userId, u));
    // la più vecchia è eliminata in modo logico (il costo resta), le voci attive sono 500
    expect(rows).toHaveLength(501);
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(500);
    expect(rows.find((r) => r.refId === 1)!.deletedAt).not.toBeNull();
    expect(rows.find((r) => r.refId === 9999)!.deletedAt).toBeNull();
    expect((await listHistory(u, "lucius")).some((r) => r.refId === 1)).toBe(false);
  });

  it("parole che sembrano credenziali in titolo e riassunto diventano ***", async () => {
    const u = await newUser();
    await addHistory(entry(u, 1, { title: "Chiave sk-proj-abc123 data", summary: "Usa ghp_abcdef e " + "a".repeat(8) + "0123456789abcdef0123456789abcdef0123 ok" }));
    const [row] = await listHistory(u, "lucius");
    expect(row!.title).toBe("Chiave *** data");
    expect(row!.summary).toBe("Usa *** e *** ok");
  });

  it("una voce eliminata sparisce da elenchi, ricerca e contesto; un riassunto nuovo la riattiva", async () => {
    const u = await newUser();
    await addHistory(entry(u, 1, { title: "Uno", summary: "consegna", tokensUsed: 5, costUsd: 0.01 }));
    const [e] = await listHistory(u, "lucius");
    await deleteHistory(u, "lucius", e!.id);
    expect(await listHistory(u, "lucius")).toEqual([]);
    expect(await searchHistory(u, "lucius", "consegna")).toEqual([]);
    expect(await recentHistoryTitles(u, "lucius")).toEqual([]);
    expect(await memoryContextBlock(u, "lucius")).toBe("");
    const [raw] = await db.select().from(characterHistoryTable).where(eq(characterHistoryTable.userId, u));
    expect(raw).toMatchObject({ title: "", summary: "", tokensUsed: 5 });
    expect(raw!.deletedAt).not.toBeNull();
    await rejects(deleteHistory(u, "lucius", e!.id), 404, MEMORY_MESSAGES.notFound);
    await addHistory(entry(u, 1, { title: "Di nuovo", summary: "x", tokensUsed: 5, costUsd: 0.02 }));
    const [back] = await db.select().from(characterHistoryTable).where(eq(characterHistoryTable.userId, u));
    expect(back!.deletedAt).toBeNull();
    expect(Number(back!.costUsd)).toBeCloseTo(0.03, 6);
    expect(await listHistory(u, "lucius")).toHaveLength(1);
  });

  it("ricerca, recenti, elimina e isolamento", async () => {
    const u = await newUser();
    const other = await newUser();
    await addHistory(entry(u, 1, { title: "Uno", summary: "Parlato della consegna del lunedì" }));
    await addHistory(entry(u, 2, { title: "Due" }));
    await addHistory(entry(u, 3, { title: "Tre" }));
    await addHistory(entry(u, 4, { title: "Quattro" }));
    const found = await searchHistory(u, "lucius", "consegna");
    expect(found.map((r) => r.refId)).toEqual([1]);
    expect(await searchHistory(other, "lucius", "consegna")).toEqual([]);
    expect(await searchHistory(u, "alfred", "consegna")).toEqual([]);
    expect(await searchHistory(u, "lucius", "")).toHaveLength(4);
    expect((await recentHistoryTitles(u, "lucius")).map((r) => r.title)).toEqual(["Quattro", "Tre", "Due"]);
    expect(await listHistory(u, "lucius", "consegna")).toHaveLength(1);
    const id = found[0]!.id;
    await rejects(deleteHistory(other, "lucius", id), 404, MEMORY_MESSAGES.notFound);
    await deleteHistory(u, "lucius", id);
    expect(await searchHistory(u, "lucius", "consegna")).toEqual([]);
  });
});

describe("memoryContextBlock", () => {
  it("vuoto senza dati, poi con appunti e titoli", async () => {
    const u = await newUser();
    expect(await memoryContextBlock(u, "lucius")).toBe("");
    const n = await addNote(u, "lucius", "Preferisce il tono diretto");
    await addHistory(entry(u, 1, { title: "Piano di Mister" }));
    const block = await memoryContextBlock(u, "lucius");
    expect(block).toContain("Appunti (id · testo)");
    expect(block).toContain(`${n.id} · Preferisce il tono diretto`);
    expect(block).toContain("Conversazioni recenti (titoli)");
    expect(block).toContain("Piano di Mister");
    expect(await memoryContextBlock(u, "alfred")).toBe("");
  });

  it("ogni appunto e titolo su una riga sola", async () => {
    const u = await newUser();
    await addNote(u, "lucius", "prima riga\n\nseconda   riga\r\nterza");
    await addHistory(entry(u, 1, { title: "Titolo\ncon\ta capo" }));
    const block = await memoryContextBlock(u, "lucius");
    expect(block).toContain(" · prima riga seconda riga terza\n");
    expect(block).toContain("Titolo con a capo");
    expect(block.split("\n")).toHaveLength(5);
  });
});
