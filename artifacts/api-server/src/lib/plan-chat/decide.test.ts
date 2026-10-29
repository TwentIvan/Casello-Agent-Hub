import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  analysesTable,
  analysisItemsTable,
  appsTable,
  planConversationsTable,
  planMessagesTable,
  planProposalsTable,
  usersTable,
} from "@workspace/db";
import { ProposalConflictError, ProposalNotFoundError, decideProposal, itemHash } from "./decide";

// Decisione sulle proposte della chat, sul Postgres di prova (PGlite del global setup)

afterAll(async () => {
  await pool.end();
});

const completion = (title: string, evidence: unknown[] = []) => ({
  key: "k",
  phase: 1,
  area: "api",
  title,
  missing: "manca",
  evidence,
  goal: "obiettivo",
  dependsOn: [],
  files: [],
  effort: "S",
  doneWhen: "fatto",
  implementation: "come",
});

let userId: number;
let otherUserId: number;
let analysisId: number;
let conversationId: number;
let messageId: number;

beforeEach(async () => {
  await db.delete(analysisItemsTable);
  await db.delete(planProposalsTable);
  await db.delete(planMessagesTable);
  await db.delete(planConversationsTable);
  await db.delete(analysesTable);
  await db.delete(appsTable);
  await db.delete(usersTable);
  [{ id: userId }] = await db.insert(usersTable).values({ email: "a@x.it" }).returning({ id: usersTable.id });
  [{ id: otherUserId }] = await db.insert(usersTable).values({ email: "b@x.it" }).returning({ id: usersTable.id });
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://m.test" }).returning();
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId: app!.id, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
    .returning();
  analysisId = analysis!.id;
  const [conv] = await db.insert(planConversationsTable).values({ appId: app!.id, analysisId, userId, title: "t" }).returning();
  conversationId = conv!.id;
  const [msg] = await db.insert(planMessagesTable).values({ conversationId, role: "assistant", content: "ok" }).returning();
  messageId = msg!.id;
});

async function addItem(ref: string, position: number, payload: unknown = completion("Vecchio")) {
  const [row] = await db
    .insert(analysisItemsTable)
    .values({ analysisId, chapter: "completion", ref, position, payload, diff: "new", status: "pending" })
    .returning();
  return row!;
}

async function propose(v: Partial<typeof planProposalsTable.$inferInsert> & { kind: "add" | "update" | "discard" }) {
  const [row] = await db
    .insert(planProposalsTable)
    .values({ conversationId, messageId, chapter: "completion", rationale: "perché", ...v })
    .returning();
  return row!;
}

describe("itemHash", () => {
  it("non dipende dall'ordine delle chiavi", () => {
    const a = itemHash({ payload: { x: 1, y: { b: 2, a: [1, { d: 1, c: 2 }] } }, status: "pending" });
    const b = itemHash({ payload: { y: { a: [1, { c: 2, d: 1 }], b: 2 }, x: 1 }, status: "pending" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(itemHash({ payload: { x: 1 }, status: "approved" })).not.toBe(itemHash({ payload: { x: 1 }, status: "pending" }));
  });
});

describe("decideProposal", () => {
  it("accettare add crea una voce approvata da chat in coda al capitolo", async () => {
    await addItem("completion:1", 3);
    const p = await propose({ kind: "add", payload: completion("Nuova", [{ file: "a.ts" }]) });
    const { proposal, item } = await decideProposal(p.id, userId, "accept");
    expect(proposal.status).toBe("accepted");
    expect(proposal.decidedAt).not.toBeNull();
    expect(proposal.itemId).toBe(item!.id);
    expect(item).toMatchObject({
      origin: "chat",
      conversationId,
      diff: "new",
      status: "approved",
      ref: `chat-${p.id}`,
      position: 4,
      analysisId,
      chapter: "completion",
      evidence: [{ file: "a.ts" }],
    });
    expect(item!.appliedAt).not.toBeNull();
  });

  it("accettare update aggiorna payload ed evidence", async () => {
    const it = await addItem("completion:1", 1);
    const p = await propose({
      kind: "update",
      payload: completion("Aggiornato", [{ file: "b.ts" }]),
      targetItemId: it.id,
      targetHash: itemHash(it),
    });
    const { proposal, item } = await decideProposal(p.id, userId, "accept");
    expect(proposal.status).toBe("accepted");
    expect(item!.id).toBe(it.id);
    expect((item!.payload as { title: string }).title).toBe("Aggiornato");
    expect(item!.evidence).toEqual([{ file: "b.ts" }]);
  });

  it("accettare discard scarta la voce", async () => {
    const it = await addItem("completion:1", 1);
    const p = await propose({ kind: "discard", targetItemId: it.id, targetHash: itemHash(it) });
    const { item } = await decideProposal(p.id, userId, "accept");
    expect(item!.status).toBe("discarded");
  });

  it("update su una voce cambiata diventa stale e lancia conflitto", async () => {
    const it = await addItem("completion:1", 1);
    const p = await propose({ kind: "update", payload: completion("N"), targetItemId: it.id, targetHash: itemHash(it) });
    await db.update(analysisItemsTable).set({ status: "approved" }).where(eq(analysisItemsTable.id, it.id));
    await expect(decideProposal(p.id, userId, "accept")).rejects.toThrow(
      "La voce è cambiata dopo la proposta: chiedi al bot di riproporla",
    );
    const [row] = await db.select().from(planProposalsTable).where(eq(planProposalsTable.id, p.id));
    expect(row!.status).toBe("stale");
    const [cur] = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.id, it.id));
    expect((cur!.payload as { title: string }).title).toBe("Vecchio");
  });

  it("discard su una voce eliminata diventa stale", async () => {
    const it = await addItem("completion:1", 1);
    const p = await propose({ kind: "discard", targetItemId: it.id, targetHash: itemHash(it) });
    await db.delete(analysisItemsTable).where(eq(analysisItemsTable.id, it.id));
    await expect(decideProposal(p.id, userId, "accept")).rejects.toBeInstanceOf(ProposalConflictError);
    const [row] = await db.select().from(planProposalsTable).where(eq(planProposalsTable.id, p.id));
    expect(row!.status).toBe("stale");
  });

  it("update su una voce chat approvata di un'analisi precedente della stessa app è accettato", async () => {
    const [conv] = await db.select().from(planConversationsTable);
    const [old] = await db
      .insert(analysesTable)
      .values({ appId: conv!.appId, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
      .returning();
    const [it] = await db
      .insert(analysisItemsTable)
      .values({ analysisId: old!.id, chapter: "completion", ref: "chat-old", position: 1, payload: completion("Vecchio"), diff: "new", status: "approved", origin: "chat" })
      .returning();
    const p = await propose({ kind: "update", payload: completion("Nuovo"), targetItemId: it!.id, targetHash: itemHash(it!) });
    const { proposal, item } = await decideProposal(p.id, userId, "accept");
    expect(proposal.status).toBe("accepted");
    expect((item!.payload as { title: string }).title).toBe("Nuovo");
  });

  it("target nell'analisi di un'altra app → stale e conflitto", async () => {
    const [other] = await db.insert(appsTable).values({ name: "Altra", slug: "altra", baseUrl: "http://a.test" }).returning();
    const [an] = await db
      .insert(analysesTable)
      .values({ appId: other!.id, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
      .returning();
    const [it] = await db
      .insert(analysisItemsTable)
      .values({ analysisId: an!.id, chapter: "completion", ref: "chat-x", position: 1, payload: completion("X"), diff: "new", status: "approved", origin: "chat" })
      .returning();
    const p = await propose({ kind: "discard", targetItemId: it!.id, targetHash: itemHash(it!) });
    await expect(decideProposal(p.id, userId, "accept")).rejects.toBeInstanceOf(ProposalConflictError);
    const [row] = await db.select().from(planProposalsTable).where(eq(planProposalsTable.id, p.id));
    expect(row!.status).toBe("stale");
    const [cur] = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.id, it!.id));
    expect(cur!.status).toBe("approved");
  });

  it("rifiutare segna la proposta rifiutata senza toccare le voci", async () => {
    const p = await propose({ kind: "add", payload: completion("Nuova") });
    const { proposal, item } = await decideProposal(p.id, userId, "reject");
    expect(proposal.status).toBe("rejected");
    expect(item).toBeNull();
    expect(await db.select().from(analysisItemsTable)).toHaveLength(0);
  });

  it("seconda decisione sulla stessa proposta → conflitto, nessuna voce duplicata", async () => {
    const p = await propose({ kind: "add", payload: completion("Nuova") });
    const res = await Promise.allSettled([decideProposal(p.id, userId, "accept"), decideProposal(p.id, userId, "accept")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(ProposalConflictError);
    expect(failed[0]!.reason.message).toBe("La proposta è già stata decisa");
    const items = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.ref, `chat-${p.id}`));
    expect(items).toHaveLength(1);
  });

  it("proposta di un altro utente → non trovata", async () => {
    const p = await propose({ kind: "add", payload: completion("Nuova") });
    await expect(decideProposal(p.id, otherUserId, "accept")).rejects.toBeInstanceOf(ProposalNotFoundError);
    await expect(decideProposal(999999, userId, "accept")).rejects.toBeInstanceOf(ProposalNotFoundError);
    const [row] = await db.select().from(planProposalsTable).where(eq(planProposalsTable.id, p.id));
    expect(row!.status).toBe("pending");
  });
});
