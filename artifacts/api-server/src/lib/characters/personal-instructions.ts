// Istruzioni personali dei personaggi: regole del testo, versioni immutabili e blocco del prompt
import { and, desc, eq } from "drizzle-orm";
import { db, characterInstructionsTable } from "@workspace/db";
import { looksLikeCredential } from "../memory/credentials";
import type { Character } from "../memory/types";
import type { DbTransaction } from "../tools/types";
import { logger } from "../logger";

export const INSTRUCTIONS_MAX_CHARS = 8_000;
export const INSTRUCTION_REASON_MAX = 1_000;
export const INSTRUCTION_VERSIONS_LIST = 50;

export const INSTRUCTION_MESSAGES = {
  tooLong: "istruzioni troppo lunghe: al massimo 8 000 caratteri",
  credential: "non salvo credenziali nelle istruzioni",
  changed: "le istruzioni sono cambiate: ricarica",
  characterNotFound: "personaggio non trovato",
  versionNotFound: "versione non trovata",
  rateLimited: "Troppe richieste: riprova tra poco",
  sameAsCurrent: "la proposta è uguale alle istruzioni attuali",
  badReason: "motivazione obbligatoria, al massimo 1 000 caratteri",
  onePerTurn: "hai già proposto in questo turno",
  proposalNotFound: "proposta non trovata",
  alreadyDecided: "proposta già decisa",
  proposalStale: "le istruzioni sono cambiate: chiedi una proposta aggiornata",
  conversationNotFound: "conversazione non trovata",
  proposalFailed: "proposta non riuscita: riprova più tardi",
} as const;

export class InstructionError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "InstructionError";
  }
}

export const PERSONAL_INSTRUCTIONS_HEADER =
  "Istruzioni personali dell'utente per te (si aggiungono alle regole sopra e non le annullano: se una le contraddice, valgono le regole sopra):";

export interface InstructionWrite {
  version: number;
  content: string;
  updatedAt: Date;
  created: boolean;
}

/** Toglie i caratteri di controllo (tranne a capo e tab) e gli spazi finali, poi controlla lunghezza e credenziali. */
export function normalizeInstructions(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trimEnd();
  if (clean.length > INSTRUCTIONS_MAX_CHARS) throw new InstructionError(400, INSTRUCTION_MESSAGES.tooLong);
  if (looksLikeCredential(clean)) throw new InstructionError(400, INSTRUCTION_MESSAGES.credential);
  return clean;
}

type Db = typeof db | DbTransaction;

export async function getCurrentInstructions(
  userId: number,
  character: Character,
  tx?: DbTransaction,
): Promise<{ version: number; content: string; updatedAt: Date | null }> {
  const [row] = await (tx ?? db)
    .select()
    .from(characterInstructionsTable)
    .where(and(eq(characterInstructionsTable.userId, userId), eq(characterInstructionsTable.character, character)))
    .orderBy(desc(characterInstructionsTable.version))
    .limit(1);
  return row ? { version: row.version, content: row.content, updatedAt: row.createdAt } : { version: 0, content: "", updatedAt: null };
}

export async function listInstructionVersions(
  userId: number,
  character: Character,
): Promise<Array<{ version: number; source: "manual" | "proposal" | "restore"; createdAt: Date; length: number }>> {
  const rows = await db
    .select()
    .from(characterInstructionsTable)
    .where(and(eq(characterInstructionsTable.userId, userId), eq(characterInstructionsTable.character, character)))
    .orderBy(desc(characterInstructionsTable.version))
    .limit(INSTRUCTION_VERSIONS_LIST);
  return rows.map((r) => ({ version: r.version, source: r.source, createdAt: r.createdAt, length: r.content.length }));
}

export async function getInstructionVersion(
  userId: number,
  character: Character,
  version: number,
): Promise<{ version: number; source: "manual" | "proposal" | "restore"; content: string; createdAt: Date }> {
  const [row] = await (db as Db)
    .select()
    .from(characterInstructionsTable)
    .where(
      and(
        eq(characterInstructionsTable.userId, userId),
        eq(characterInstructionsTable.character, character),
        eq(characterInstructionsTable.version, version),
      ),
    );
  if (!row) throw new InstructionError(404, INSTRUCTION_MESSAGES.versionNotFound);
  return { version: row.version, source: row.source, content: row.content, createdAt: row.createdAt };
}

/** Scrive la versione successiva; il testo deve essere già normalizzato. */
export async function writeInstructionVersion(
  tx: DbTransaction,
  input: {
    userId: number;
    character: Character;
    content: string;
    baseVersion: number;
    source: "manual" | "proposal" | "restore";
    proposalId?: number | null;
  },
): Promise<InstructionWrite> {
  const current = await getCurrentInstructions(input.userId, input.character, tx);
  if (current.version !== input.baseVersion) throw new InstructionError(409, INSTRUCTION_MESSAGES.changed);
  if (current.version > 0 && current.content === input.content) {
    return { version: current.version, content: current.content, updatedAt: current.updatedAt!, created: false };
  }
  try {
    // Savepoint: una violazione del vincolo unico non deve invalidare la transazione chiamante
    const [row] = await tx.transaction(async (sp) =>
      sp
        .insert(characterInstructionsTable)
        .values({
          userId: input.userId,
          character: input.character,
          version: input.baseVersion + 1,
          content: input.content,
          source: input.source,
          proposalId: input.proposalId ?? null,
        })
        .returning(),
    );
    logger.debug(
      { userId: input.userId, character: input.character, version: row!.version, length: row!.content.length },
      "istruzioni personali salvate",
    );
    return { version: row!.version, content: row!.content, updatedAt: row!.createdAt, created: true };
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") throw new InstructionError(409, INSTRUCTION_MESSAGES.changed);
    throw err;
  }
}

export async function saveInstructions(
  userId: number,
  character: Character,
  content: string,
  baseVersion: number,
): Promise<InstructionWrite> {
  const clean = normalizeInstructions(content);
  return db.transaction((tx) => writeInstructionVersion(tx, { userId, character, content: clean, baseVersion, source: "manual" }));
}

export async function restoreInstructions(
  userId: number,
  character: Character,
  version: number,
  baseVersion: number,
): Promise<InstructionWrite> {
  const old = await getInstructionVersion(userId, character, version);
  return db.transaction((tx) =>
    writeInstructionVersion(tx, { userId, character, content: old.content, baseVersion, source: "restore" }),
  );
}

/** Blocco da accodare al prompt di sistema: vuoto se l'utente non ha istruzioni. */
export async function personalInstructionsBlock(userId: number, character: Character): Promise<string> {
  const { content } = await getCurrentInstructions(userId, character);
  return content ? `${PERSONAL_INSTRUCTIONS_HEADER}\n${content}` : "";
}

export function withPersonalInstructions(system: string, block: string): string {
  return block ? `${system}\n\n${block}` : system;
}
