// Proposte di istruzioni personali nate in chat (Alfred scritto e Lucius): lo strumento `proponi_istruzioni_personali`,
// la lettura delle schede di una conversazione e la decisione dell'utente. Una proposta si applica solo con il clic.
// Nei log solo id, personaggio, versione e lunghezza: mai il testo delle istruzioni né la motivazione.

import { and, asc, eq } from "drizzle-orm";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import {
  db,
  characterConversationsTable,
  characterInstructionProposalsTable,
  planConversationsTable,
  teamChatConversationsTable,
  type CharacterInstructionProposal,
} from "@workspace/db";
import { logger } from "../logger";
import { looksLikeCredential } from "../memory/credentials";
import type { Character } from "../memory/types";
import {
  INSTRUCTION_MESSAGES,
  INSTRUCTION_REASON_MAX,
  InstructionError,
  getCurrentInstructions,
  normalizeInstructions,
  writeInstructionVersion,
} from "./personal-instructions";
import { toolFail, toolOk } from "./types";

export const INSTRUCTION_PROPOSAL_TOOL_NAME = "proponi_istruzioni_personali";

export const INSTRUCTION_PROPOSAL_TOOL: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: INSTRUCTION_PROPOSAL_TOOL_NAME,
    description:
      "Propone all'utente una nuova versione delle tue istruzioni personali, come scheda da accettare. Solo per una regola stabile chiesta dall'utente; una proposta per turno.",
    parameters: {
      type: "object",
      properties: {
        testo: {
          type: "string",
          description: "Testo completo nuovo delle istruzioni personali (al massimo 8 000 caratteri): le istruzioni attuali più la modifica.",
        },
        motivazione: { type: "string", description: "Perché la proponi, in breve (al massimo 1 000 caratteri)." },
      },
      required: ["testo", "motivazione"],
    },
  },
};

export function isInstructionProposalTool(name: string): boolean {
  return name === INSTRUCTION_PROPOSAL_TOOL_NAME;
}

/** Riga delle istruzioni di base (prima del blocco delle istruzioni personali). */
export const INSTRUCTION_PROPOSAL_RULE =
  "Le tue istruzioni personali, se ci sono, sono in fondo a queste istruzioni e le cambi solo proponendole con `proponi_istruzioni_personali`: usalo solo quando l'utente chiede una regola stabile («d'ora in poi», «sempre», «mai») o conferma di volerla; le preferenze piccole restano appunti della memoria. In `testo` metti il testo completo nuovo: le istruzioni attuali più la modifica. Al massimo una proposta per turno, con una `motivazione` breve: si applica solo con il clic dell'utente, quindi non dire che è fatta finché non l'ha accettata.";

export type InstructionConversationKind = "character" | "plan_chat" | "team_chat";

export interface InstructionProposalView {
  id: number;
  character: Character;
  content: string;
  reason: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  baseVersion: number;
  currentContent: string;
  messageId: number | null;
  createdAt: Date;
}

/** Riga della cronologia che segue il messaggio dell'assistente che ha proposto. */
export function instructionProposalTag(status: string): string {
  return `[scheda istruzioni personali: ${status}]`;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Strumento `proponi_istruzioni_personali` di un turno: una proposta riuscita per turno. */
export class InstructionProposer {
  private proposed = false;

  constructor(
    private readonly ctx: {
      userId: number;
      character: Character;
      conversationKind: InstructionConversationKind;
      conversationId: number;
      messageId: number | null;
    },
  ) {}

  /** Stringa JSON `{ok: true, result: {id}}` o `{ok: false, error}`, mai eccezioni. */
  async run(rawArgs: string): Promise<string> {
    try {
      if (this.proposed) return toolFail(INSTRUCTION_MESSAGES.onePerTurn);
      const args = parseArgs(rawArgs);
      const reason = typeof args?.motivazione === "string" ? args.motivazione.trim() : "";
      if (!args) return toolFail(INSTRUCTION_MESSAGES.badReason);
      if (typeof args.testo !== "string") return toolFail(INSTRUCTION_MESSAGES.badText);
      if (reason.length === 0 || reason.length > INSTRUCTION_REASON_MAX) return toolFail(INSTRUCTION_MESSAGES.badReason);
      if (looksLikeCredential(reason)) return toolFail(INSTRUCTION_MESSAGES.credential);
      const content = normalizeInstructions(args.testo);
      const { userId, character } = this.ctx;
      const current = await getCurrentInstructions(userId, character);
      if (content === current.content) return toolFail(INSTRUCTION_MESSAGES.sameAsCurrent);
      const id = await db.transaction(async (tx) => {
        // Vale solo l'ultima proposta: le precedenti ancora aperte dello stesso utente e personaggio diventano superate
        await tx
          .update(characterInstructionProposalsTable)
          .set({ status: "stale", decidedAt: new Date() })
          .where(
            and(
              eq(characterInstructionProposalsTable.userId, userId),
              eq(characterInstructionProposalsTable.character, character),
              eq(characterInstructionProposalsTable.status, "pending"),
            ),
          );
        const [row] = await tx
          .insert(characterInstructionProposalsTable)
          .values({
            userId,
            character,
            conversationKind: this.ctx.conversationKind,
            conversationId: this.ctx.conversationId,
            messageId: this.ctx.messageId,
            baseVersion: current.version,
            content,
            reason,
          })
          .returning({ id: characterInstructionProposalsTable.id });
        return row!.id;
      });
      this.proposed = true;
      logger.info({ proposalId: id, userId, character, baseVersion: current.version, length: content.length }, "istruzioni personali proposte");
      return toolOk({ id });
    } catch (err) {
      if (err instanceof InstructionError) return toolFail(err.message);
      logger.warn({ errName: err instanceof Error ? err.name : typeof err }, "proposta di istruzioni personali non riuscita");
      return toolFail(INSTRUCTION_MESSAGES.proposalFailed);
    }
  }
}

/** Stati delle schede di una conversazione, per messaggio dell'assistente, nell'ordine delle proposte. */
export async function loadInstructionProposalStatuses(kind: InstructionConversationKind, conversationId: number): Promise<Map<number, string[]>> {
  const rows = await db
    .select({ messageId: characterInstructionProposalsTable.messageId, status: characterInstructionProposalsTable.status })
    .from(characterInstructionProposalsTable)
    .where(and(eq(characterInstructionProposalsTable.conversationKind, kind), eq(characterInstructionProposalsTable.conversationId, conversationId)))
    .orderBy(asc(characterInstructionProposalsTable.id));
  const map = new Map<number, string[]>();
  for (const r of rows) {
    if (r.messageId === null) continue;
    map.set(r.messageId, [...(map.get(r.messageId) ?? []), r.status]);
  }
  return map;
}

async function conversationOwner(kind: InstructionConversationKind, conversationId: number): Promise<number | null> {
  const table =
    kind === "character" ? characterConversationsTable : kind === "plan_chat" ? planConversationsTable : teamChatConversationsTable;
  const [row] = await db.select({ userId: table.userId }).from(table).where(eq(table.id, conversationId));
  return row?.userId ?? null;
}

function viewOf(row: CharacterInstructionProposal, currentContent: string): InstructionProposalView {
  return {
    id: row.id,
    character: row.character,
    content: row.content,
    reason: row.reason,
    status: row.status,
    baseVersion: row.baseVersion,
    currentContent,
    messageId: row.messageId,
    createdAt: row.createdAt,
  };
}

async function toView(row: CharacterInstructionProposal): Promise<InstructionProposalView> {
  return viewOf(row, (await getCurrentInstructions(row.userId, row.character)).content);
}

/** Schede di istruzioni personali di una conversazione dell'utente; conversazione altrui o inesistente → 404. */
export async function listInstructionProposals(
  userId: number,
  kind: InstructionConversationKind,
  conversationId: number,
): Promise<InstructionProposalView[]> {
  if ((await conversationOwner(kind, conversationId)) !== userId) {
    throw new InstructionError(404, INSTRUCTION_MESSAGES.conversationNotFound);
  }
  const rows = await db
    .select()
    .from(characterInstructionProposalsTable)
    .where(
      and(
        eq(characterInstructionProposalsTable.userId, userId),
        eq(characterInstructionProposalsTable.conversationKind, kind),
        eq(characterInstructionProposalsTable.conversationId, conversationId),
      ),
    )
    .orderBy(asc(characterInstructionProposalsTable.id));
  // Il testo attuale è lo stesso per tutte le schede dello stesso personaggio
  const currentByCharacter = new Map<Character, string>();
  const views: InstructionProposalView[] = [];
  for (const row of rows) {
    if (!currentByCharacter.has(row.character)) {
      currentByCharacter.set(row.character, (await getCurrentInstructions(userId, row.character)).content);
    }
    views.push(viewOf(row, currentByCharacter.get(row.character)!));
  }
  return views;
}

class StaleProposal extends Error {}

/**
 * Accetta o rifiuta una scheda dell'utente. Accettare scrive la versione successiva delle istruzioni (origine `proposal`);
 * se le istruzioni sono cambiate dopo la proposta la scheda diventa `stale` e la risposta è 409.
 */
export async function decideInstructionProposal(
  userId: number,
  proposalId: number,
  action: "accept" | "reject",
): Promise<InstructionProposalView> {
  const [found] = await db.select().from(characterInstructionProposalsTable).where(eq(characterInstructionProposalsTable.id, proposalId));
  if (!found || found.userId !== userId) throw new InstructionError(404, INSTRUCTION_MESSAGES.proposalNotFound);
  const pendingOnly = and(eq(characterInstructionProposalsTable.id, proposalId), eq(characterInstructionProposalsTable.status, "pending"));

  if (action === "reject") {
    const [row] = await db
      .update(characterInstructionProposalsTable)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(pendingOnly)
      .returning();
    if (!row) throw new InstructionError(409, INSTRUCTION_MESSAGES.alreadyDecided);
    logger.info({ proposalId, userId, character: row.character }, "proposta di istruzioni personali rifiutata");
    return toView(row);
  }

  try {
    const row = await db.transaction(async (tx) => {
      const [accepted] = await tx
        .update(characterInstructionProposalsTable)
        .set({ status: "accepted", decidedAt: new Date() })
        .where(pendingOnly)
        .returning();
      if (!accepted) throw new InstructionError(409, INSTRUCTION_MESSAGES.alreadyDecided);
      const current = await getCurrentInstructions(userId, accepted.character, tx);
      if (current.version !== accepted.baseVersion) throw new StaleProposal();
      try {
        const written = await writeInstructionVersion(tx, {
          userId,
          character: accepted.character,
          content: accepted.content,
          baseVersion: accepted.baseVersion,
          source: "proposal",
          proposalId,
        });
        logger.info({ proposalId, userId, character: accepted.character, version: written.version, length: written.content.length }, "proposta di istruzioni personali accettata");
      } catch (err) {
        // Una versione scritta nel frattempo da un'altra richiesta: la proposta è superata
        if (err instanceof InstructionError && err.status === 409) throw new StaleProposal();
        throw err;
      }
      return accepted;
    });
    return toView(row);
  } catch (err) {
    if (!(err instanceof StaleProposal)) throw err;
    // La transazione è annullata: lo stato `stale` si scrive a parte, così resta
    await db.update(characterInstructionProposalsTable).set({ status: "stale", decidedAt: new Date() }).where(pendingOnly);
    logger.info({ proposalId, userId, character: found.character }, "proposta di istruzioni personali superata");
    throw new InstructionError(409, INSTRUCTION_MESSAGES.proposalStale);
  }
}
