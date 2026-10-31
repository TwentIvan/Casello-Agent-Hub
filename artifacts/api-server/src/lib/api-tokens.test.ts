import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, apiTokensTable, usersTable } from "@workspace/db";
import { ApiTokenInputError, type TokenScope, authenticateApiToken, createApiToken, listApiTokens, revokeApiToken } from "./api-tokens";

// Token personali sul Postgres di prova (PGlite del global setup)

const savedAllowed = process.env.ALLOWED_EMAILS;
const DAY = 86_400_000;

let userId: number;

beforeEach(async () => {
  process.env.ALLOWED_EMAILS = "ivan@example.com";
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com" }).returning();
  userId = user!.id;
});

afterAll(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  if (savedAllowed === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = savedAllowed;
});

describe("createApiToken", () => {
  it("crea un token cas_ che autentica l'utente", async () => {
    const { token, row } = await createApiToken(userId, "  Portatile  ", 30);
    expect(token).toMatch(/^cas_[A-Za-z0-9_-]{43}$/);
    expect(row.name).toBe("Portatile");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(await authenticateApiToken(token)).toEqual({ userId, tokenId: row.id, scopes: ["mcp"] });
  });

  it("default mcp", async () => {
    const { row } = await createApiToken(userId, "Portatile", 30);
    expect(row.scopes).toEqual(["mcp"]);
  });

  it("ambiti multipli salvati in ordine di TOKEN_SCOPES", async () => {
    const { row } = await createApiToken(userId, "Portatile", 30, ["api:write", "mcp"]);
    expect(row.scopes).toEqual(["mcp", "api:write"]);
  });

  it("vuoto, ripetuto o sconosciuto → ApiTokenInputError", async () => {
    for (const scopes of [[], ["mcp", "mcp"], ["admin"]]) {
      await expect(createApiToken(userId, "x", 30, scopes as TokenScope[])).rejects.toThrow(
        new ApiTokenInputError("ambiti non validi: scegline almeno uno tra mcp, api:read, api:write"),
      );
    }
  });

  it("nel DB c'è solo l'hash: il token in chiaro non compare in nessuna colonna", async () => {
    const { token } = await createApiToken(userId, "Portatile", 30);
    const [row] = await db.select().from(apiTokensTable);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rifiuta giorni fuori da 1-90 o non interi e nomi vuoti o troppo lunghi", async () => {
    for (const days of [0, 91, 1.5, Number.NaN]) {
      await expect(createApiToken(userId, "x", days)).rejects.toBeInstanceOf(ApiTokenInputError);
    }
    await expect(createApiToken(userId, "   ", 30)).rejects.toBeInstanceOf(ApiTokenInputError);
    await expect(createApiToken(userId, "a".repeat(101), 30)).rejects.toBeInstanceOf(ApiTokenInputError);
    await expect(createApiToken(userId, "a".repeat(100), 90)).resolves.toBeDefined();
  });
});

describe("authenticateApiToken", () => {
  it("authenticate restituisce gli ambiti", async () => {
    const { token, row } = await createApiToken(userId, "Portatile", 30, ["api:read", "api:write"]);
    expect(await authenticateApiToken(token)).toEqual({ userId, tokenId: row.id, scopes: ["api:read", "api:write"] });
  });

  it("null per un token sconosciuto", async () => {
    expect(await authenticateApiToken("cas_inesistente")).toBeNull();
  });

  it("null dopo la revoca", async () => {
    const { token, row } = await createApiToken(userId, "Portatile", 30);
    expect(await revokeApiToken(userId, row.id)).toBe(true);
    expect(await authenticateApiToken(token)).toBeNull();
    expect(await revokeApiToken(userId, row.id)).toBe(false);
  });

  it("null se scaduto rispetto all'orologio passato", async () => {
    const { token, row } = await createApiToken(userId, "Portatile", 1);
    expect(await authenticateApiToken(token, new Date(row.expiresAt.getTime() - 1000))).not.toBeNull();
    expect(await authenticateApiToken(token, new Date(row.expiresAt.getTime() + 1000))).toBeNull();
  });

  it("null se l'email dell'utente non è più ammessa", async () => {
    const { token } = await createApiToken(userId, "Portatile", 30);
    process.env.ALLOWED_EMAILS = "altro@example.com";
    expect(await authenticateApiToken(token)).toBeNull();
  });

  it("aggiorna lastUsedAt al massimo una volta al minuto", async () => {
    const { token, row } = await createApiToken(userId, "Portatile", 30);
    const t0 = new Date();
    await authenticateApiToken(token, t0);
    const first = (await db.select().from(apiTokensTable).where(eq(apiTokensTable.id, row.id)))[0]!.lastUsedAt;
    expect(first?.getTime()).toBe(t0.getTime());

    await authenticateApiToken(token, new Date(t0.getTime() + 30_000));
    const second = (await db.select().from(apiTokensTable).where(eq(apiTokensTable.id, row.id)))[0]!.lastUsedAt;
    expect(second?.getTime()).toBe(t0.getTime());

    const t2 = new Date(t0.getTime() + 61_000);
    await authenticateApiToken(token, t2);
    const third = (await db.select().from(apiTokensTable).where(eq(apiTokensTable.id, row.id)))[0]!.lastUsedAt;
    expect(third?.getTime()).toBe(t2.getTime());
  });
});

describe("listApiTokens e revokeApiToken", () => {
  it("elenca i più recenti prima, revocati compresi, e solo i propri", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const a = await createApiToken(userId, "A", 30);
    const b = await createApiToken(userId, "B", 30);
    await createApiToken(other!.id, "Altrui", 30);
    await revokeApiToken(userId, a.row.id);
    const list = await listApiTokens(userId);
    expect(list.map((t) => t.name)).toEqual(["B", "A"]);
    expect(list[1]!.revokedAt).not.toBeNull();
    expect(b.row.id).toBe(list[0]!.id);
  });

  it("non revoca il token di un altro utente", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const { row } = await createApiToken(other!.id, "Altrui", 30);
    expect(await revokeApiToken(userId, row.id)).toBe(false);
  });
});
