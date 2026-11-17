import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  bugReportMessagesTable,
  bugReportsTable,
  db,
  pendingActionsTable,
  pool,
  usersTable,
} from "@workspace/db";

vi.mock("../src/lib/bugs/triage", () => ({ startTriage: vi.fn(async () => {}) }));

import { createApiToken } from "../src/lib/api-tokens";
import { generateIdentitySecret } from "../src/lib/bugs/identity";
import { resetBugLimits } from "../src/middlewares/rate-limit";
import { encryptSecret } from "../src/lib/secrets";

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "EMBED_ALLOWED_ORIGINS"] as const;
const saved: Record<string, string | undefined> = {};
const ORIGIN = "https://hub-admin.example.com";
const SLUG = "hub-bug-admin";
const KEY = "K".repeat(43);

let base: string;
let server: http.Server;
let appId: number;

type Res = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : undefined };
}
const visitor = (path: string, key = KEY) =>
  fetch(`${base}/api${path}?app=${SLUG}&origin=${encodeURIComponent(ORIGIN)}`, { headers: { "x-botcave-browser-key": key } }).then(async (r) => ({
    status: r.status,
    json: await r.json(),
  }));

function jwt(secret: string, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: SLUG, aud: "botcave", sub: "u-9", name: "Ana", email: "ana@example.com", iat: now, exp: now + 300, ...over });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

async function newBug(over: Partial<typeof bugReportsTable.$inferInsert> = {}) {
  const [last] = await db.select({ n: bugReportsTable.number }).from(bugReportsTable).where(eq(bugReportsTable.appId, appId));
  const [row] = await db
    .insert(bugReportsTable)
    .values({
      appId,
      number: (last?.n ?? 0) + 1 + Math.floor(Math.random() * 1000),
      reporterKind: "browser",
      browserKeyHash: (await import("../src/lib/bugs/reports")).hashBrowserKey(KEY),
      ipPrefix: "1.2.3.0/24",
      title: "Non salva",
      description: "Il pulsante non fa nulla",
      ...over,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    EMBED_ALLOWED_ORIGINS: ORIGIN,
  });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.delete(appsTable).where(eq(appsTable.slug, SLUG));
  const [row] = await db.insert(appsTable).values({ name: "Hub admin", slug: SLUG, baseUrl: ORIGIN, bugReportsEnabled: true }).returning();
  appId = row!.id;
});

beforeEach(async () => {
  await db.delete(bugReportsTable);
  await db.update(appsTable).set({ bugReportsEnabled: true, bugReportsDailyLimit: 20, identitySecretEnc: null, identitySecretSetAt: null }).where(eq(appsTable.id, appId));
  resetBugLimits();
});

afterAll(async () => {
  await db.delete(bugReportsTable);
  await db.delete(appsTable).where(eq(appsTable.slug, SLUG));
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await pool.end();
});

describe("impostazioni", () => {
  it("GET e PATCH", async () => {
    const g = await api("GET", `/apps/${appId}/bug-settings`);
    expect(g.status).toBe(200);
    expect(g.json).toEqual({
      enabled: true,
      dailyLimit: 20,
      identitySecretSet: false,
      identitySecretSetAt: null,
      bugTeam: null,
      approverAvailable: false,
      todayCount: 0,
    });
    await newBug();
    const p = await api("PATCH", `/apps/${appId}/bug-settings`, { enabled: false, dailyLimit: 5 });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ enabled: false, dailyLimit: 5, todayCount: 1 });
  });

  it("approverAvailable vero con un modello per il Responsabile, anche senza squadra per i bug", async () => {
    const [user] = await db.insert(usersTable).values({ email: "approver-bug@example.com", name: "Approva" }).returning();
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId: user!.id, name: "Account", provider: "custom", baseUrl: "https://llm.example/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" })
      .returning();
    const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
    const [lead] = await db
      .insert(agentsTable)
      .values({ appId, name: "Responsabile", role: "general", status: "active", aiModelId: model!.id })
      .returning();
    try {
      const g = await api("GET", `/apps/${appId}/bug-settings`);
      expect(g.json).toMatchObject({ bugTeam: null, approverAvailable: true });
    } finally {
      await db.delete(agentsTable).where(eq(agentsTable.id, lead!.id));
      await db.delete(usersTable).where(eq(usersTable.id, user!.id));
    }
  });

  it("limite fuori 1..500 → 400, App inesistente → 404", async () => {
    expect((await api("PATCH", `/apps/${appId}/bug-settings`, { dailyLimit: 0 })).status).toBe(400);
    expect((await api("PATCH", `/apps/${appId}/bug-settings`, { dailyLimit: 501 })).status).toBe(400);
    expect((await api("GET", `/apps/99999999/bug-settings`)).status).toBe(404);
  });
});

describe("segreto d'identità", () => {
  it("si mostra una volta sola e non compare nelle GET", async () => {
    const r = await api("POST", `/apps/${appId}/identity-secret`);
    expect(r.status).toBe(201);
    expect(r.json.secret).toMatch(/^bci_[A-Za-z0-9_-]{43}$/);
    const g = await api("GET", `/apps/${appId}/bug-settings`);
    expect(g.json.identitySecretSet).toBe(true);
    expect(g.json.identitySecretSetAt).not.toBeNull();
    expect(JSON.stringify(g.json)).not.toContain(r.json.secret);
    expect(JSON.stringify((await api("GET", `/apps/${appId}`)).json)).not.toContain(r.json.secret);
    const del = await api("DELETE", `/apps/${appId}/identity-secret`);
    expect(del.status).toBe(204);
    expect((await api("GET", `/apps/${appId}/bug-settings`)).json.identitySecretSet).toBe(false);
  });

  it("con un token personale api:write o agent → 403", async () => {
    await api("GET", `/apps/${appId}/bug-settings`);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
    for (const scopes of [["api:write"], ["agent"]] as const) {
      const { token } = await createApiToken(user!.id, "prova", 1, [...scopes]);
      const h = { authorization: `Bearer ${token}` };
      expect((await api("POST", `/apps/${appId}/identity-secret`, undefined, h)).status).toBe(403);
      expect((await api("DELETE", `/apps/${appId}/identity-secret`, undefined, h)).status).toBe(403);
    }
    expect((await db.select().from(appsTable).where(eq(appsTable.id, appId)))[0]!.identitySecretEnc).toBeNull();
  });
});

describe("prova dell'identità", () => {
  it("valido, altro segreto, senza segreto, rigenerato", async () => {
    const none = await api("POST", `/apps/${appId}/identity-test`, { token: "a.b.c" });
    expect(none.json).toMatchObject({ valid: false, reason: "no_secret", sub: null });

    const { json } = await api("POST", `/apps/${appId}/identity-secret`);
    const secret: string = json.secret;
    const token = jwt(secret);
    const ok = await api("POST", `/apps/${appId}/identity-test`, { token });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ valid: true, reason: null, sub: "u-9", name: "Ana", email: "ana@example.com" });
    expect(ok.json.expiresAt).toBeTruthy();

    const other = await api("POST", `/apps/${appId}/identity-test`, { token: jwt(generateIdentitySecret()) });
    expect(other.json).toMatchObject({ valid: false, reason: "invalid", sub: null });
    const expired = await api("POST", `/apps/${appId}/identity-test`, { token: jwt(secret, { iat: 1_000_000, exp: 1_000_300 }) });
    expect(expired.json).toMatchObject({ valid: false, reason: "expired" });

    await api("POST", `/apps/${appId}/identity-secret`);
    const after = await api("POST", `/apps/${appId}/identity-test`, { token });
    expect(after.json).toMatchObject({ valid: false, reason: "invalid" });
    expect(await db.select().from(bugReportsTable)).toHaveLength(0);
  });
});

describe("segnalazioni", () => {
  it("elenco con filtro di stato ed etichetta del segnalante", async () => {
    await newBug({ status: "in_progress" });
    await newBug({ reporterKind: "identity", reporterSub: "x", browserKeyHash: null, status: "received" });
    await newBug({ reporterKind: "identity", reporterSub: "y", reporterName: "Ana", browserKeyHash: null });
    const all = await api("GET", `/apps/${appId}/bugs`);
    expect(all.status).toBe(200);
    expect(all.json).toHaveLength(3);
    expect(all.json.map((b: { reporterLabel: string }) => b.reporterLabel).sort()).toEqual(["Ana", "Utente con identità", "Visitatore"]);
    const some = await api("GET", `/apps/${appId}/bugs?status=in_progress`);
    expect(some.json).toHaveLength(1);
    expect((await api("GET", `/apps/${appId}/bugs?status=boh`)).status).toBe(400);
  });

  it("dettaglio senza chiave del browser né prefisso IP, con email", async () => {
    const b = await newBug({ reporterKind: "identity", reporterSub: "s", reporterName: "Ana", reporterEmail: "ana@example.com", browserKeyHash: null });
    await db.insert(bugReportMessagesTable).values({ reportId: b.id, author: "lead", content: "Quale browser?" });
    const r = await api("GET", `/apps/${appId}/bugs/${b.number}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ number: b.number, reporterEmail: "ana@example.com", pendingActionNumber: null, issueNumber: null });
    expect(r.json.messages).toHaveLength(1);
    const text = JSON.stringify(r.json);
    expect(text).not.toContain("browserKeyHash");
    expect(text).not.toContain("ipPrefix");
    expect(text).not.toContain("1.2.3.0");
    expect((await api("GET", `/apps/${appId}/bugs/99999`)).status).toBe(404);
  });

  it("messaggio owner visibile al visitatore", async () => {
    const b = await newBug({ status: "in_progress" });
    const r = await api("POST", `/apps/${appId}/bugs/${b.number}/messages`, { content: "Ci stiamo lavorando" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ author: "owner", content: "Ci stiamo lavorando" });
    const v = await visitor(`/embed/bugs/${b.id}`);
    expect(v.json.messages.at(-1)).toMatchObject({ author: "owner", content: "Ci stiamo lavorando" });
    expect((await api("POST", `/apps/${appId}/bugs/${b.number}/messages`, { content: "   " })).status).toBe(400);
  });

  it("close fixed con la frase fissa, poi 409", async () => {
    const b = await newBug({ status: "in_progress" });
    const r = await api("POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "fixed" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("fixed");
    expect(r.json.publicMessage).toBe("Corretta: la correzione è stata unita e sarà disponibile con il prossimo aggiornamento dell'app.");
    const again = await api("POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "not_a_bug" });
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "segnalazione già chiusa" });
  });

  it("close not_a_bug senza messaggio usa l'etichetta; messaggio owner su segnalazione chiusa → 409", async () => {
    const b = await newBug({ status: "received" });
    const r = await api("POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "not_a_bug", message: "   " });
    expect(r.json.publicMessage).toBe("Non è un problema");
    const m = await api("POST", `/apps/${appId}/bugs/${b.number}/messages`, { content: "ciao" });
    expect(m.status).toBe(409);
    expect(m.json).toEqual({ error: "segnalazione chiusa" });
  });

  it("close con voce in esecuzione → 409 e segnalazione invariata", async () => {
    await api("GET", `/apps/${appId}/bug-settings`);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
    const b = await newBug({ status: "pending_approval" });
    const [item] = await db
      .insert(pendingActionsTable)
      .values({ userId: user!.id, number: 910_000 + b.number, kind: "bug", status: "executing", appId, argsEnc: encryptSecret("{}"), argsPublic: { reportId: b.id }, recipient: "Hub admin", summary: "Bug" })
      .returning();
    await db.update(bugReportsTable).set({ pendingActionId: item!.id }).where(eq(bugReportsTable.id, b.id));
    const r = await api("POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "fixed" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "approvazione in corso: riprova tra poco" });
    const [after] = await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, b.id));
    expect(after!.status).toBe("pending_approval");
    await db.delete(bugReportsTable).where(eq(bugReportsTable.id, b.id));
    await db.delete(pendingActionsTable).where(eq(pendingActionsTable.id, item!.id));
  });

  it("token agent: lettura sì, close/messages/PATCH impostazioni → 403; sessione sì", async () => {
    await api("GET", `/apps/${appId}/bug-settings`);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
    const { token } = await createApiToken(user!.id, "agente", 1, ["agent"]);
    const h = { authorization: `Bearer ${token}` };
    const b = await newBug({ status: "in_progress" });
    expect((await api("GET", `/apps/${appId}/bugs`, undefined, h)).status).toBe(200);
    expect((await api("GET", `/apps/${appId}/bug-settings`, undefined, h)).status).toBe(200);
    const denied = "il token non ha l'ambito per questa operazione";
    for (const [m, path, body] of [
      ["POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "fixed" }],
      ["POST", `/apps/${appId}/bugs/${b.number}/messages`, { content: "x" }],
      ["PATCH", `/apps/${appId}/bug-settings`, { enabled: false }],
    ] as const) {
      const r = await api(m, path, body, h);
      expect(r.status).toBe(403);
      expect(r.json.error).toBe(denied);
    }
    expect((await api("POST", `/apps/${appId}/bugs/${b.number}/messages`, { content: "x" })).status).toBe(201);
    expect((await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, b.id)))[0]!.status).toBe("in_progress");
  });

  it("close not_a_bug con messaggio proprio", async () => {
    const b = await newBug({ status: "received" });
    const r = await api("POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "not_a_bug", message: "È voluto così" });
    expect(r.json).toMatchObject({ status: "not_a_bug", publicMessage: "È voluto così" });
  });

  it("close rifiuta la voce in coda ancora pending", async () => {
    await api("GET", `/apps/${appId}/bug-settings`);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
    const b = await newBug({ status: "pending_approval" });
    const [item] = await db
      .insert(pendingActionsTable)
      .values({
        userId: user!.id,
        number: 900_000 + b.number,
        kind: "bug",
        appId,
        argsEnc: encryptSecret("{}"),
        argsPublic: { reportId: b.id, number: b.number },
        recipient: "Hub admin",
        summary: "Bug",
      })
      .returning();
    await db.update(bugReportsTable).set({ pendingActionId: item!.id }).where(eq(bugReportsTable.id, b.id));
    const r = await api("POST", `/apps/${appId}/bugs/${b.number}/close`, { status: "not_a_bug" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("not_a_bug");
    const [after] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, item!.id));
    expect(after).toMatchObject({ status: "rejected", decisionNote: "chiusa dall'amministratore" });
    await db.delete(pendingActionsTable).where(eq(pendingActionsTable.id, item!.id));
  });
});
