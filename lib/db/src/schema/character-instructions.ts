import { pgTable, serial, integer, text, timestamp, pgEnum, index, uniqueIndex, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { characterEnum } from "./character-memory";

export const characterInstructionSourceEnum = pgEnum("character_instruction_source", ["manual", "proposal", "restore"]);
export const instructionConversationKindEnum = pgEnum("instruction_conversation_kind", ["character", "plan_chat", "team_chat"]);
export const instructionProposalStatusEnum = pgEnum("instruction_proposal_status", ["pending", "accepted", "rejected", "stale"]);

// Proposte di nuove istruzioni personali nate da una chat: si accettano o si rifiutano con un clic
export const characterInstructionProposalsTable = pgTable(
  "character_instruction_proposals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    character: characterEnum("character").notNull(),
    conversationKind: instructionConversationKindEnum("conversation_kind").notNull(),
    conversationId: integer("conversation_id").notNull(),
    messageId: integer("message_id"),
    // Versione delle istruzioni su cui nasce la proposta (0 = nessuna)
    baseVersion: integer("base_version").notNull(),
    content: text("content").notNull(),
    reason: text("reason").notNull(),
    status: instructionProposalStatusEnum("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("character_instruction_proposals_conv_idx").on(table.conversationKind, table.conversationId)],
);

// Istruzioni personali di un personaggio per utente: una riga per versione, immutabile
export const characterInstructionsTable = pgTable(
  "character_instructions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    character: characterEnum("character").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    source: characterInstructionSourceEnum("source").notNull(),
    proposalId: integer("proposal_id").references((): AnyPgColumn => characterInstructionProposalsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("character_instructions_user_char_version_uniq").on(table.userId, table.character, table.version),
    check("character_instructions_version_check", sql`${table.version} >= 1`),
  ],
);

export type CharacterInstruction = typeof characterInstructionsTable.$inferSelect;
export type CharacterInstructionProposal = typeof characterInstructionProposalsTable.$inferSelect;
