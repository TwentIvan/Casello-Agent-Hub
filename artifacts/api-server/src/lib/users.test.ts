import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, githubInstallationsTable, userIdentitiesTable, usersTable } from "@workspace/db";
import {
  IdentityConflictError,
  ensureUserByEmail,
  isAllowed,
  linkIdentity,
  listIdentities,
  resolveLogin,
  unlinkIdentity,
} from "./users";

// Utenti e identità sul Postgres di prova (PGlite del global setup)

const savedAllowed = process.env.ALLOWED_EMAILS;

const google = (sub: string, email: string) => ({
  provider: "google" as const,
  providerUserId: sub,
  emails: [email],
  primaryEmail: email,
  username: null,
  name: "Ivan",
  picture: "https://img.example/ivan.png",
});

const github = (id: string, emails: string[], username = "ivan-gh") => ({
  provider: "github" as const,
  providerUserId: id,
  emails,
  primaryEmail: emails[0]!,
  username,
  name: null,
  picture: null,
});

async function identitiesOf(userId: number) {
  return db.select().from(userIdentitiesTable).where(eq(userIdentitiesTable.userId, userId));
}

beforeEach(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  if (savedAllowed === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = savedAllowed;
});

describe("isAllowed", () => {
  it("confronta le email in minuscolo con ALLOWED_EMAILS letta a ogni chiamata", () => {
    process.env.ALLOWED_EMAILS = " Ivan@Example.com , altro@example.com";
    expect(isAllowed(["IVAN@example.COM"])).toBe(true);
    expect(isAllowed(["nessuno@example.com", "altro@example.com"])).toBe(true);
    expect(isAllowed(["nessuno@example.com"])).toBe(false);
    expect(isAllowed([])).toBe(false);
  });

  it("lista vuota: non entra nessuno", () => {
    process.env.ALLOWED_EMAILS = "";
    expect(isAllowed(["ivan@example.com"])).toBe(false);
    delete process.env.ALLOWED_EMAILS;
    expect(isAllowed(["ivan@example.com"])).toBe(false);
  });
});

describe("resolveLogin", () => {
  it("crea l'utente al primo accesso e lo ritrova al secondo", async () => {
    const first = await resolveLogin(google("sub-1", "Ivan@Example.com"));
    expect(first).toMatchObject({ email: "ivan@example.com", name: "Ivan", picture: "https://img.example/ivan.png" });
    expect(first.lastLoginAt).toBeInstanceOf(Date);

    const second = await resolveLogin(google("sub-1", "ivan@example.com"));
    expect(second.id).toBe(first.id);
    expect(second.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(first.lastLoginAt!.getTime());
    expect(await db.select().from(usersTable)).toHaveLength(1);
    expect(await identitiesOf(first.id)).toHaveLength(1);
  });

  it("identità GitHub nuova con l'email di un utente Google: stesso utente, due identità", async () => {
    const user = await resolveLogin(google("sub-1", "ivan@example.com"));
    // La primaria non corrisponde, una delle secondarie sì
    const again = await resolveLogin(github("42", ["altra@example.com", "IVAN@example.com"]));
    expect(again.id).toBe(user.id);
    const ids = await identitiesOf(user.id);
    expect(ids.map((i) => i.provider).sort()).toEqual(["github", "google"]);
    expect(ids.find((i) => i.provider === "github")).toMatchObject({ providerUserId: "42", username: "ivan-gh" });
    expect(await db.select().from(usersTable)).toHaveLength(1);
  });

  it("senza identità né email note crea l'utente con l'email primaria", async () => {
    const user = await resolveLogin(github("7", ["Prima@example.com", "seconda@example.com"]));
    expect(user.email).toBe("prima@example.com");
  });

  it("l'utente trovato per email ha già un altro account dello stesso provider → conflitto", async () => {
    await resolveLogin(github("1", ["ivan@example.com"], "primo"));
    const err = await resolveLogin(github("2", ["ivan@example.com"], "secondo")).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityConflictError);
    expect((err as Error).message).toBe("hai già un altro account GitHub collegato: scollegalo prima");
    expect(await db.select().from(userIdentitiesTable)).toHaveLength(1);
  });
});

describe("linkIdentity", () => {
  it("identità di un altro utente → IdentityConflictError e nessuna modifica", async () => {
    const owner = await resolveLogin(github("42", ["owner@example.com"], "owner-gh"));
    const other = await resolveLogin(google("sub-2", "other@example.com"));
    const before = await db.select().from(userIdentitiesTable).orderBy(userIdentitiesTable.id);

    const err = await linkIdentity(other.id, github("42", ["other@example.com"], "rinominato")).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityConflictError);
    expect((err as Error).message).toBe("account GitHub già collegato a un altro utente");
    expect(await db.select().from(userIdentitiesTable).orderBy(userIdentitiesTable.id)).toEqual(before);
    expect((await identitiesOf(owner.id))[0]).toMatchObject({ username: "owner-gh" });
  });

  it("l'utente ha già un altro account GitHub → IdentityConflictError e nessuna modifica", async () => {
    const user = await resolveLogin(google("sub-1", "ivan@example.com"));
    await linkIdentity(user.id, github("42", ["ivan@example.com"], "primo"));
    const err = await linkIdentity(user.id, github("43", ["ivan@example.com"], "secondo")).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityConflictError);
    expect((err as Error).message).toBe("hai già un altro account GitHub collegato: scollegalo prima");
    expect((await listIdentities(user.id)).find((i) => i.provider === "github")).toMatchObject({ username: "primo" });
  });

  it("identità Google di un altro utente: messaggio con il provider giusto", async () => {
    await resolveLogin(google("sub-1", "owner@example.com"));
    const other = await resolveLogin(github("42", ["other@example.com"]));
    const err = await linkIdentity(other.id, google("sub-1", "other@example.com")).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityConflictError);
    expect((err as Error).message).toBe("account Google già collegato a un altro utente");
  });

  it("collega una nuova identità e, se è già sua, aggiorna username ed email", async () => {
    const user = await resolveLogin(google("sub-1", "ivan@example.com"));
    await linkIdentity(user.id, github("42", ["gh@example.com"], "vecchio"));
    await linkIdentity(user.id, github("42", ["nuova@example.com"], "nuovo"));
    expect(await listIdentities(user.id)).toEqual([
      { provider: "google", username: null, email: "ivan@example.com" },
      { provider: "github", username: "nuovo", email: "nuova@example.com" },
    ]);
  });
});

describe("unlinkIdentity", () => {
  it("rifiuta di scollegare l'unica identità se l'email non è ammessa", async () => {
    process.env.ALLOWED_EMAILS = "altro@example.com";
    const user = await resolveLogin(github("42", ["ivan@example.com"]));
    const err = await unlinkIdentity(user.id, "github").catch((e) => e);
    expect(err).toBeInstanceOf(IdentityConflictError);
    expect((err as Error).message).toBe("non puoi scollegare l'unico accesso del tuo account");
    expect(await identitiesOf(user.id)).toHaveLength(1);
  });

  it("utente senza identità ma con email ammessa (ensureUserByEmail) può scollegare GitHub", async () => {
    process.env.ALLOWED_EMAILS = "ivan@example.com";
    const user = await ensureUserByEmail("ivan@example.com");
    await linkIdentity(user.id, github("42", ["ivan@example.com"]));
    await unlinkIdentity(user.id, "github");
    expect(await listIdentities(user.id)).toEqual([]);
  });

  it("scollega GitHub ed elimina le installazioni dell'utente", async () => {
    const user = await resolveLogin(google("sub-1", "ivan@example.com"));
    await linkIdentity(user.id, github("42", ["ivan@example.com"]));
    await db.insert(githubInstallationsTable).values({
      userId: user.id,
      installationId: 1001,
      accountLogin: "ivan-gh",
      accountType: "User",
      repositorySelection: "all",
    });
    await unlinkIdentity(user.id, "github");
    expect(await listIdentities(user.id)).toEqual([{ provider: "google", username: null, email: "ivan@example.com" }]);
    expect(await db.select().from(githubInstallationsTable)).toHaveLength(0);
  });
});

describe("ensureUserByEmail", () => {
  it("crea l'utente una volta sola, con l'email in minuscolo", async () => {
    const a = await ensureUserByEmail("Dev@Localhost", "Sviluppo locale", null);
    const b = await ensureUserByEmail("dev@localhost");
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ email: "dev@localhost", name: "Sviluppo locale", picture: null });
    expect(await listIdentities(a.id)).toEqual([]);
  });
});
