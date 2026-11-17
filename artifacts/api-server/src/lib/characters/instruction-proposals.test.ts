import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  characterConversationsTable,
  characterInstructionsTable,
  characterInstructionProposalsTable,
  characterMessagesTable,
} from "@workspace/db";
import { INSTRUCTION_MESSAGES, InstructionError, getCurrentInstructions, saveInstructions } from "./personal-instructions";
import {
  INSTRUCTION_PROPOSAL_TOOL,
  INSTRUCTION_PROPOSAL_TOOL_NAME,
  InstructionProposer,
  decideInstructionProposal,
  instructionProposalTag,
  isInstructionProposalTool,
  listInstructionProposals,
  loadInstructionProposalStatuses,
} from "./instruction-proposals";
import { describeStep } from "../turn-progress/describe";

async function newUser() {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `ip-${Math.random().toString(36).slice(2, 10)}@example.com` })
    .returning();
  return u!.id;
}

async function newConversation(userId: number, character: "alfred" | "lucius" = "lucius") {
  const [c] = await db
    .insert(characterConversationsTable)
    .values({ userId, character, subjectType: character === "alfred" ? "alfred_thread" : "skill", subjectId: character === "alfred" ? null : "x", title: "" })
    .returning();
  const [m] = await db.insert(characterMessagesTable).values({ conversationId: c!.id, role: "assistant", content: "ok" }).returning();
  return { conversationId: c!.id, messageId: m!.id };
}

function proposer(userId: number, conv: { conversationId: number; messageId: number }, character: "alfred" | "lucius" = "lucius") {
  return new InstructionProposer({ userId, character, conversationKind: "character", conversationId: conv.conversationId, messageId: conv.messageId });
}

const args = (testo: unknown, motivazione: unknown = "regola chiesta dall'utente") => JSON.stringify({ testo, motivazione });
const parse = (s: string) => JSON.parse(s) as { ok: boolean; result?: { id: number }; error?: string };

async function rejects(p: Promise<unknown>, status: number, message: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(InstructionError);
  expect((err as InstructionError).status).toBe(status);
  expect((err as InstructionError).message).toBe(message);
}

const proposalRow = async (id: number) =>
  (await db.select().from(characterInstructionProposalsTable).where(eq(characterInstructionProposalsTable.id, id)))[0]!;

afterAll(async () => {
  await pool.end();
});

describe("strumento proponi_istruzioni_personali", () => {
  it("definizione: nome, testo e motivazione obbligatori; frase dell'avanzamento", () => {
    expect(INSTRUCTION_PROPOSAL_TOOL_NAME).toBe("proponi_istruzioni_personali");
    expect(INSTRUCTION_PROPOSAL_TOOL.function.name).toBe("proponi_istruzioni_personali");
    expect(INSTRUCTION_PROPOSAL_TOOL.function.parameters).toMatchObject({ required: ["testo", "motivazione"] });
    expect(isInstructionProposalTool("proponi_istruzioni_personali")).toBe(true);
    expect(isInstructionProposalTool("proponi_istruzioni")).toBe(false);
    expect(describeStep("proponi_istruzioni_personali", args("x"))).toBe("Propone una modifica alle sue istruzioni");
    expect(instructionProposalTag("accepted")).toBe("[scheda istruzioni personali: accepted]");
  });

  it("argomenti non validi o motivazione vuota o troppo lunga → badReason", async () => {
    const u = await newUser();
    const p = proposer(u, await newConversation(u));
    expect(parse(await p.run("non json"))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.badReason });
    expect(parse(await p.run(args("Sempre in euro", "  ")))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.badReason });
    expect(parse(await p.run(args("Sempre in euro", "x".repeat(1_001))))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.badReason });
    expect(parse(await p.run(args(42)))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.badReason });
  });

  it("testo uguale all'attuale (anche con spazi in fondo) → sameAsCurrent; credenziale → credential", async () => {
    const u = await newUser();
    await saveInstructions(u, "lucius", "Sempre il costo in euro", 0);
    const p = proposer(u, await newConversation(u));
    expect(parse(await p.run(args("Sempre il costo in euro  \n")))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.sameAsCurrent });
    expect(parse(await p.run(args("usa sk-abcdefghijklmnop1234 per entrare")))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.credential });
  });

  it("prima proposta: ok con id, versione base e messaggio; la seconda nello stesso turno → onePerTurn", async () => {
    const u = await newUser();
    await saveInstructions(u, "lucius", "Sempre il costo", 0);
    const conv = await newConversation(u);
    const p = proposer(u, conv);
    // Un errore non consuma la proposta del turno
    expect(parse(await p.run("non json")).ok).toBe(false);
    const r = parse(await p.run(args("Sempre il costo\nMai emoji")));
    expect(r.ok).toBe(true);
    const row = await proposalRow(r.result!.id);
    expect(row).toMatchObject({
      userId: u,
      character: "lucius",
      conversationKind: "character",
      conversationId: conv.conversationId,
      messageId: conv.messageId,
      baseVersion: 1,
      content: "Sempre il costo\nMai emoji",
      reason: "regola chiesta dall'utente",
      status: "pending",
      decidedAt: null,
    });
    expect(parse(await p.run(args("Altro")))).toEqual({ ok: false, error: INSTRUCTION_MESSAGES.onePerTurn });
  });

  it("una proposta nuova rende stale le pending dello stesso utente e personaggio, non le altre", async () => {
    const u = await newUser();
    const other = await newUser();
    const convA = await newConversation(u);
    const convB = await newConversation(u);
    const convAlfred = await newConversation(u, "alfred");
    const convOther = await newConversation(other);
    const first = parse(await proposer(u, convA).run(args("Prima")));
    const alfred = parse(await proposer(u, convAlfred, "alfred").run(args("Di Alfred")));
    const foreign = parse(await proposer(other, convOther).run(args("Di un altro")));
    // Turno nuovo, in un'altra conversazione dello stesso utente
    const second = parse(await proposer(u, convB).run(args("Seconda")));
    expect(second.ok).toBe(true);
    expect((await proposalRow(first.result!.id)).status).toBe("stale");
    expect((await proposalRow(second.result!.id)).status).toBe("pending");
    expect((await proposalRow(alfred.result!.id)).status).toBe("pending");
    expect((await proposalRow(foreign.result!.id)).status).toBe("pending");
  });
});

describe("decisione sulle proposte", () => {
  it("accept: versione attuale + 1 con origine proposal, proposta accepted con decidedAt", async () => {
    const u = await newUser();
    await saveInstructions(u, "lucius", "Uno", 0);
    const conv = await newConversation(u);
    const id = parse(await proposer(u, conv).run(args("Uno\nDue"))).result!.id;
    const view = await decideInstructionProposal(u, id, "accept");
    expect(view).toMatchObject({ id, character: "lucius", status: "accepted", content: "Uno\nDue", currentContent: "Uno\nDue", baseVersion: 1 });
    const [v2] = await db
      .select()
      .from(characterInstructionsTable)
      .where(and(eq(characterInstructionsTable.userId, u), eq(characterInstructionsTable.version, 2)));
    expect(v2).toMatchObject({ source: "proposal", proposalId: id, content: "Uno\nDue", character: "lucius" });
    expect((await proposalRow(id)).decidedAt).toBeInstanceOf(Date);
    await rejects(decideInstructionProposal(u, id, "reject"), 409, INSTRUCTION_MESSAGES.alreadyDecided);
  });

  it("reject: rejected senza versione; di un altro utente → 404", async () => {
    const u = await newUser();
    const other = await newUser();
    const id = parse(await proposer(u, await newConversation(u)).run(args("Nuova"))).result!.id;
    await rejects(decideInstructionProposal(other, id, "accept"), 404, INSTRUCTION_MESSAGES.proposalNotFound);
    await rejects(decideInstructionProposal(u, 999_999, "accept"), 404, INSTRUCTION_MESSAGES.proposalNotFound);
    const view = await decideInstructionProposal(u, id, "reject");
    expect(view.status).toBe("rejected");
    expect((await proposalRow(id)).decidedAt).toBeInstanceOf(Date);
    expect((await getCurrentInstructions(u, "lucius")).version).toBe(0);
    await rejects(decideInstructionProposal(u, id, "accept"), 409, INSTRUCTION_MESSAGES.alreadyDecided);
  });

  it("istruzioni cambiate a mano dopo la proposta → 409 proposalStale, proposta stale, nessuna versione", async () => {
    const u = await newUser();
    const id = parse(await proposer(u, await newConversation(u)).run(args("Dalla chat"))).result!.id;
    await saveInstructions(u, "lucius", "A mano", 0);
    await rejects(decideInstructionProposal(u, id, "accept"), 409, INSTRUCTION_MESSAGES.proposalStale);
    expect((await proposalRow(id)).status).toBe("stale");
    const current = await getCurrentInstructions(u, "lucius");
    expect(current).toMatchObject({ version: 1, content: "A mano" });
  });
});

describe("lettura delle proposte", () => {
  it("elenco della conversazione con il testo attuale; conversazione altrui o inesistente → 404", async () => {
    const u = await newUser();
    const other = await newUser();
    await saveInstructions(u, "lucius", "Attuali", 0);
    const conv = await newConversation(u);
    const id = parse(await proposer(u, conv).run(args("Attuali\nNuova"))).result!.id;
    const list = await listInstructionProposals(u, "character", conv.conversationId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      character: "lucius",
      content: "Attuali\nNuova",
      reason: "regola chiesta dall'utente",
      status: "pending",
      baseVersion: 1,
      currentContent: "Attuali",
      messageId: conv.messageId,
    });
    expect(list[0]!.createdAt).toBeInstanceOf(Date);
    await rejects(listInstructionProposals(other, "character", conv.conversationId), 404, INSTRUCTION_MESSAGES.conversationNotFound);
    await rejects(listInstructionProposals(u, "plan_chat", conv.conversationId), 404, INSTRUCTION_MESSAGES.conversationNotFound);
    await rejects(listInstructionProposals(u, "character", 999_999), 404, INSTRUCTION_MESSAGES.conversationNotFound);
  });

  it("stati per messaggio, nell'ordine delle proposte", async () => {
    const u = await newUser();
    const conv = await newConversation(u);
    const a = parse(await proposer(u, conv).run(args("A"))).result!.id;
    await decideInstructionProposal(u, a, "reject");
    parse(await proposer(u, conv).run(args("B")));
    const map = await loadInstructionProposalStatuses("character", conv.conversationId);
    expect(map.get(conv.messageId)).toEqual(["rejected", "pending"]);
    expect((await loadInstructionProposalStatuses("plan_chat", conv.conversationId)).size).toBe(0);
  });
});
