// Utenti e identità esterne (Google, GitHub): chi entra (isAllowed), a quale utente corrisponde un
// login (resolveLogin), collegamento e scollegamento di un account GitHub all'utente corrente.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, githubInstallationsTable, userIdentitiesTable, usersTable, type User } from "@workspace/db";
import { isUniqueViolation } from "./pg-errors";

export type IdentityProvider = "google" | "github";

/** Identità restituita dal provider al login, con le email già verificate. */
export interface LoginIdentity {
  provider: IdentityProvider;
  providerUserId: string;
  /** Email verificate dell'account (la primaria compresa). */
  emails: string[];
  primaryEmail: string;
  username: string | null;
  name: string | null;
  picture: string | null;
}

/** Conflitto tra identità: account già di un altro utente, o unico accesso da non togliere. */
export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConflictError";
  }
}

const ALREADY_LINKED = "account GitHub già collegato a un altro utente";
const ONLY_IDENTITY = "non puoi scollegare l'unico accesso del tuo account";
const PROVIDER_TAKEN = "l'utente ha già un altro account collegato per questo provider";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Unica regola d'accesso: vero se una delle email (verificate) è in ALLOWED_EMAILS. La variabile si
 * legge a ogni chiamata; una lista vuota non fa entrare nessuno.
 */
export function isAllowed(emails: string[]): boolean {
  const allowed = new Set(
    (process.env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map(normalize)
      .filter(Boolean),
  );
  return emails.some((email) => allowed.has(normalize(email)));
}

/** Email in minuscolo, senza doppioni, la primaria per prima. */
function candidateEmails(identity: LoginIdentity): string[] {
  return [...new Set([identity.primaryEmail, ...identity.emails].map(normalize).filter(Boolean))];
}

async function insertIdentity(tx: Tx, userId: number, identity: LoginIdentity): Promise<void> {
  try {
    // Savepoint: un vincolo violato non deve invalidare la transazione esterna prima del rilancio
    await tx.transaction(async (inner) => {
      await inner.insert(userIdentitiesTable).values({
        userId,
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        email: normalize(identity.primaryEmail),
        username: identity.username,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, "user_identities_provider_user_unique")) throw new IdentityConflictError(ALREADY_LINKED);
    if (isUniqueViolation(err, "user_identities_user_provider_unique")) throw new IdentityConflictError(PROVIDER_TAKEN);
    throw err;
  }
}

/**
 * Utente di un login: identità già nota → il suo utente; altrimenti l'utente con una delle email
 * (la primaria per prima), a cui si collega l'identità; altrimenti un utente nuovo con l'email
 * primaria. Aggiorna lastLoginAt (e nome/foto se il provider li fornisce). Tutto in una transazione.
 */
export async function resolveLogin(identity: LoginIdentity): Promise<User> {
  return db.transaction(async (tx) => {
    const [known] = await tx
      .select({ userId: userIdentitiesTable.userId })
      .from(userIdentitiesTable)
      .where(
        and(
          eq(userIdentitiesTable.provider, identity.provider),
          eq(userIdentitiesTable.providerUserId, identity.providerUserId),
        ),
      );

    let userId: number;
    if (known) {
      userId = known.userId;
      // L'account può aver cambiato login o email primaria dall'ultima volta
      await tx
        .update(userIdentitiesTable)
        .set({ username: identity.username, email: normalize(identity.primaryEmail) })
        .where(
          and(
            eq(userIdentitiesTable.provider, identity.provider),
            eq(userIdentitiesTable.providerUserId, identity.providerUserId),
          ),
        );
    } else {
      const emails = candidateEmails(identity);
      const matches = await tx
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.email, emails));
      const match = emails.map((email) => matches.find((u) => u.email === email)).find(Boolean);
      if (match) {
        userId = match.id;
      } else {
        const [created] = await tx
          .insert(usersTable)
          .values({ email: normalize(identity.primaryEmail), name: identity.name, picture: identity.picture })
          .returning({ id: usersTable.id });
        userId = created!.id;
      }
      await insertIdentity(tx, userId, identity);
    }

    const [user] = await tx
      .update(usersTable)
      .set({
        lastLoginAt: new Date(),
        name: identity.name ?? sql`${usersTable.name}`,
        picture: identity.picture ?? sql`${usersTable.picture}`,
      })
      .where(eq(usersTable.id, userId))
      .returning();
    return user!;
  });
}

/**
 * Collega un'identità all'utente corrente. Già di un altro utente → IdentityConflictError, nessuna
 * modifica; già sua → aggiorna username ed email.
 */
export async function linkIdentity(userId: number, identity: LoginIdentity): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: userIdentitiesTable.id, userId: userIdentitiesTable.userId })
      .from(userIdentitiesTable)
      .where(
        and(
          eq(userIdentitiesTable.provider, identity.provider),
          eq(userIdentitiesTable.providerUserId, identity.providerUserId),
        ),
      );
    if (existing && existing.userId !== userId) throw new IdentityConflictError(ALREADY_LINKED);
    if (existing) {
      await tx
        .update(userIdentitiesTable)
        .set({ username: identity.username, email: normalize(identity.primaryEmail) })
        .where(eq(userIdentitiesTable.id, existing.id));
      return;
    }
    // Un altro account dello stesso provider già collegato: va scollegato prima (vincolo unico)
    await insertIdentity(tx, userId, identity);
  });
}

/**
 * Scollega l'identità GitHub e cancella le installazioni GitHub dell'utente. Non si può togliere
 * l'unica identità: l'utente resterebbe senza modo di entrare.
 */
export async function unlinkIdentity(userId: number, provider: "github"): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock sulla riga dell'utente: due scollegamenti concorrenti non possono lasciarlo senza identità
    await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
    const identities = await tx
      .select({ provider: userIdentitiesTable.provider })
      .from(userIdentitiesTable)
      .where(eq(userIdentitiesTable.userId, userId));
    const linked = identities.some((i) => i.provider === provider);
    if (linked && identities.length === 1) throw new IdentityConflictError(ONLY_IDENTITY);
    await tx
      .delete(userIdentitiesTable)
      .where(and(eq(userIdentitiesTable.userId, userId), eq(userIdentitiesTable.provider, provider)));
    await tx.delete(githubInstallationsTable).where(eq(githubInstallationsTable.userId, userId));
  });
}

/**
 * Trova o crea l'utente con questa email (sessioni della fase 1 e utente di sviluppo). Nome e foto
 * riempiono solo i campi ancora vuoti.
 */
export async function ensureUserByEmail(email: string, name?: string | null, picture?: string | null): Promise<User> {
  const [user] = await db
    .insert(usersTable)
    .values({ email: normalize(email), name: name ?? null, picture: picture ?? null })
    .onConflictDoUpdate({
      target: usersTable.email,
      set: {
        name: sql`coalesce(${usersTable.name}, excluded.name)`,
        picture: sql`coalesce(${usersTable.picture}, excluded.picture)`,
      },
    })
    .returning();
  return user!;
}

export async function listIdentities(
  userId: number,
): Promise<{ provider: string; username: string | null; email: string | null }[]> {
  return db
    .select({
      provider: userIdentitiesTable.provider,
      username: userIdentitiesTable.username,
      email: userIdentitiesTable.email,
    })
    .from(userIdentitiesTable)
    .where(eq(userIdentitiesTable.userId, userId))
    .orderBy(userIdentitiesTable.provider);
}
