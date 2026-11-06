import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { db, skillsTable, skillVersionsTable, type SkillRow } from "@workspace/db";
import { isUniqueViolation } from "../pg-errors";

// Catalogo delle skill con codice, versionate. `casello`: istruzioni salvate qui; `node`: nome della
// skill installata sul nodo locale. Le versioni sono immutabili: ogni modifica del contenuto o dei
// suggerimenti sugli strumenti crea la versione successiva.

export type SkillKind = SkillRow["kind"];

export const SKILL_CODE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const NODE_SKILL_NAME = /^[a-zA-Z0-9:_-]{1,100}$/;
export const MAX_SKILL_CONTENT = 20_000;
export const MAX_SKILL_VERSIONS = 200;

export const SKILL_MESSAGES = {
  duplicateCode: "codice già usato",
  invalidCode: "codice non valido: da 2 a 64 caratteri tra minuscole, cifre, '.', '_' e '-', iniziando da una lettera o cifra",
  notFound: "skill non trovata",
  versionNotFound: "versione non trovata",
  tooManyVersions: "troppe versioni: crea una skill nuova",
  emptyContent: "il contenuto non può essere vuoto",
  contentTooLong: `contenuto troppo lungo: massimo ${MAX_SKILL_CONTENT} caratteri`,
  invalidNodeName: "nome della skill sul nodo non valido: da 1 a 100 caratteri tra lettere, cifre, ':', '_' e '-'",
  hintsOnlyCasello: "i suggerimenti sugli strumenti valgono solo per le skill Botcave",
} as const;

export class SkillError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

export type SkillView = {
  code: string;
  name: string;
  description: string;
  kind: SkillKind;
  currentVersion: number;
  deprecated: boolean;
  content: string;
  toolHints: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type SkillVersionView = {
  code: string;
  version: number;
  content: string;
  toolHints: string[];
  createdAt: Date;
};

/** `db` o una transazione: permette a chi chiama di far partecipare le scritture alla propria transazione. */
export type Executor = Pick<typeof db, "select" | "insert" | "update" | "transaction">;

/** Messaggio d'errore in italiano se il contenuto non è valido per il tipo, altrimenti null. */
export function validateSkillContent(kind: SkillKind, content: string): string | null {
  if (kind === "node") return NODE_SKILL_NAME.test(content) ? null : SKILL_MESSAGES.invalidNodeName;
  if (content.trim().length === 0) return SKILL_MESSAGES.emptyContent;
  if (content.length > MAX_SKILL_CONTENT) return SKILL_MESSAGES.contentTooLong;
  return null;
}

function checkVersionInput(kind: SkillKind, content: string, toolHints: string[]): void {
  const error = validateSkillContent(kind, content);
  if (error) throw new SkillError(400, error);
  if (kind === "node" && toolHints.length > 0) throw new SkillError(400, SKILL_MESSAGES.hintsOnlyCasello);
}

type Joined = { skill: SkillRow; content: string; toolHints: string[] };

function toView({ skill, content, toolHints }: Joined): SkillView {
  return {
    code: skill.code,
    name: skill.name,
    description: skill.description,
    kind: skill.kind,
    currentVersion: skill.currentVersion,
    deprecated: skill.deprecated,
    content,
    toolHints,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

const currentJoin = and(
  eq(skillVersionsTable.skillId, skillsTable.id),
  eq(skillVersionsTable.version, skillsTable.currentVersion),
);

function selectCurrent(executor: Executor) {
  return executor
    .select({ skill: skillsTable, content: skillVersionsTable.content, toolHints: skillVersionsTable.toolHints })
    .from(skillsTable)
    .innerJoin(skillVersionsTable, currentJoin);
}

export async function getSkill(code: string, executor: Executor = db): Promise<SkillView> {
  const [row] = await selectCurrent(executor).where(eq(skillsTable.code, code)).limit(1);
  if (!row) throw new SkillError(404, SKILL_MESSAGES.notFound);
  return toView(row);
}

/** Come `getSkill`, ma null se la skill non esiste. */
export async function findSkill(code: string, executor: Executor = db): Promise<SkillView | null> {
  try {
    return await getSkill(code, executor);
  } catch (err) {
    if (err instanceof SkillError && err.status === 404) return null;
    throw err;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listSkills(filter: { kind?: SkillKind; q?: string; deprecated?: boolean } = {}): Promise<SkillView[]> {
  const conditions = [];
  if (filter.kind) conditions.push(eq(skillsTable.kind, filter.kind));
  if (filter.deprecated !== undefined) conditions.push(eq(skillsTable.deprecated, filter.deprecated));
  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(skillsTable.code, pattern), ilike(skillsTable.name, pattern)));
  }
  const rows = await selectCurrent(db)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(skillsTable.code));
  return rows.map(toView);
}

export async function createSkill(
  input: { code: string; name: string; description?: string; kind: SkillKind; content: string; toolHints?: string[] },
  executor: Executor = db,
): Promise<SkillView> {
  if (!SKILL_CODE.test(input.code)) throw new SkillError(400, SKILL_MESSAGES.invalidCode);
  const toolHints = input.toolHints ?? [];
  checkVersionInput(input.kind, input.content, toolHints);
  try {
    await executor.transaction(async (tx) => {
      const [skill] = await tx
        .insert(skillsTable)
        .values({ code: input.code, name: input.name, description: input.description ?? "", kind: input.kind })
        .returning({ id: skillsTable.id });
      await tx.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content: input.content, toolHints });
    });
  } catch (err) {
    if (isUniqueViolation(err, "skills_code_unique")) {
      throw new SkillError(409, SKILL_MESSAGES.duplicateCode);
    }
    throw err;
  }
  return getSkill(input.code, executor);
}

/**
 * Nome e descrizione si cambiano senza nuova versione; `content` o `toolHints` creano la versione
 * successiva nella stessa transazione. La riga della skill si blocca (FOR UPDATE) per non assegnare lo
 * stesso numero di versione a due modifiche concorrenti.
 */
export async function updateSkill(
  code: string,
  patch: { name?: string; description?: string; content?: string; toolHints?: string[] },
  executor: Executor = db,
): Promise<SkillView> {
  await executor.transaction(async (tx) => {
    const [skill] = await tx.select().from(skillsTable).where(eq(skillsTable.code, code)).limit(1).for("update");
    if (!skill) throw new SkillError(404, SKILL_MESSAGES.notFound);

    const newVersion = patch.content !== undefined || patch.toolHints !== undefined;
    const set: Partial<typeof skillsTable.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;

    if (newVersion) {
      const [current] = await tx
        .select()
        .from(skillVersionsTable)
        .where(and(eq(skillVersionsTable.skillId, skill.id), eq(skillVersionsTable.version, skill.currentVersion)));
      if (!current) throw new SkillError(404, SKILL_MESSAGES.versionNotFound);
      const content = patch.content ?? current.content;
      const toolHints = patch.toolHints ?? current.toolHints;
      checkVersionInput(skill.kind, content, toolHints);
      if (skill.currentVersion >= MAX_SKILL_VERSIONS) throw new SkillError(409, SKILL_MESSAGES.tooManyVersions);
      const version = skill.currentVersion + 1;
      await tx.insert(skillVersionsTable).values({ skillId: skill.id, version, content, toolHints });
      set.currentVersion = version;
    }
    await tx.update(skillsTable).set(set).where(eq(skillsTable.id, skill.id));
  });
  return getSkill(code, executor);
}

export async function deprecateSkill(code: string): Promise<SkillView> {
  const updated = await db
    .update(skillsTable)
    .set({ deprecated: true, updatedAt: new Date() })
    .where(eq(skillsTable.code, code))
    .returning({ id: skillsTable.id });
  if (updated.length === 0) throw new SkillError(404, SKILL_MESSAGES.notFound);
  return getSkill(code);
}

export async function listSkillVersions(code: string): Promise<SkillVersionView[]> {
  const [skill] = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.code, code)).limit(1);
  if (!skill) throw new SkillError(404, SKILL_MESSAGES.notFound);
  const rows = await db
    .select()
    .from(skillVersionsTable)
    .where(eq(skillVersionsTable.skillId, skill.id))
    .orderBy(desc(skillVersionsTable.version));
  return rows.map((r) => ({ code, version: r.version, content: r.content, toolHints: r.toolHints, createdAt: r.createdAt }));
}

export async function getSkillVersion(code: string, version: number): Promise<SkillVersionView> {
  const [skill] = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.code, code)).limit(1);
  if (!skill) throw new SkillError(404, SKILL_MESSAGES.notFound);
  const [row] = await db
    .select()
    .from(skillVersionsTable)
    .where(and(eq(skillVersionsTable.skillId, skill.id), eq(skillVersionsTable.version, version)))
    .limit(1);
  if (!row) throw new SkillError(404, SKILL_MESSAGES.versionNotFound);
  return { code, version: row.version, content: row.content, toolHints: row.toolHints, createdAt: row.createdAt };
}
