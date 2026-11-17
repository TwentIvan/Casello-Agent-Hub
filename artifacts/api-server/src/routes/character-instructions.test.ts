import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  characterConversationsTable,
  characterInstructionProposalsTable,
  characterMessagesTable,
} from "@workspace/db";

// Istruzioni personali dei personaggi: route sull'app completa senza login (AUTH_DISABLED=true: utente dev@localhost).

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};
const BASE = "/account/character-instructions";

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  (await import("../middlewares/rate-limit")).resetInstructionWriteLimit();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("istruzioni personali dei personaggi", () => {
  it("get_without_rows_returns_version_zero", async () => {
    const r = await api("GET", `${BASE}/alfred`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ character: "alfred", version: 0, content: "", updatedAt: null });
  });

  it("unknown_character_404", async () => {
    for (const [m, p, b] of [
      ["GET", `${BASE}/barbara`, undefined],
      ["GET", `${BASE}/barbara/versions`, undefined],
      ["GET", `${BASE}/barbara/versions/1`, undefined],
      ["PUT", `${BASE}/barbara`, { content: "x", baseVersion: 0 }],
      ["POST", `${BASE}/barbara/restore`, { version: 1, baseVersion: 0 }],
    ] as const) {
      const r = await api(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json).toEqual({ error: "personaggio non trovato" });
    }
  });

  it("put_saves_then_conflict_on_stale_base", async () => {
    const put = await api("PUT", `${BASE}/lucius`, { content: "Rispondi breve", baseVersion: 0 });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({ character: "lucius", version: 1, content: "Rispondi breve" });
    expect(typeof put.json.updatedAt).toBe("string");
    const stale = await api("PUT", `${BASE}/lucius`, { content: "Altro", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: "le istruzioni sono cambiate: ricarica" });
    expect((await api("GET", `${BASE}/lucius`)).json).toMatchObject({ version: 1, content: "Rispondi breve" });
  });

  it("put_too_long_400", async () => {
    const r = await api("PUT", `${BASE}/alfred`, { content: "a".repeat(9_000), baseVersion: 0 });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "istruzioni troppo lunghe: al massimo 8 000 caratteri" });
  });

  it("put_invalid_body_400", async () => {
    expect((await api("PUT", `${BASE}/alfred`, { content: "x", baseVersion: -1 })).status).toBe(400);
  });

  it("versions_list_get_and_restore", async () => {
    await api("PUT", `${BASE}/alfred`, { content: "uno", baseVersion: 0 });
    await api("PUT", `${BASE}/alfred`, { content: "due", baseVersion: 1 });
    const list = await api("GET", `${BASE}/alfred/versions`);
    expect(list.status).toBe(200);
    expect(list.json.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list.json[0]).toMatchObject({ version: 2, source: "manual", length: 3 });
    const one = await api("GET", `${BASE}/alfred/versions/1`);
    expect(one.json).toMatchObject({ version: 1, source: "manual", content: "uno" });
    expect((await api("GET", `${BASE}/alfred/versions/9`)).status).toBe(404);
    const rest = await api("POST", `${BASE}/alfred/restore`, { version: 1, baseVersion: 2 });
    expect(rest.status, rest.text).toBe(200);
    expect(rest.json).toMatchObject({ version: 3, content: "uno" });
    expect((await api("GET", `${BASE}/alfred/versions/3`)).json.source).toBe("restore");
  });

  it("tokens: read ok, writes forbidden", async () => {
    const savedAllowed = process.env["ALLOWED_EMAILS"];
    try {
      process.env["ALLOWED_EMAILS"] = "token@example.com";
      const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
      const read = (await createApiToken(user!.id, "R", 30, ["api:read"])).token;
      const write = (await createApiToken(user!.id, "W", 30, ["api:read", "api:write"])).token;
      const agent = (await createApiToken(user!.id, "A", 30, ["agent"])).token;
      expect((await api("GET", `${BASE}/alfred`, undefined, read)).status).toBe(200);
      const put = await api("PUT", `${BASE}/alfred`, { content: "x", baseVersion: 0 }, write);
      expect(put.status).toBe(403);
      expect(put.json).toEqual({ error: "operazione disponibile solo con il login" });
      expect((await api("PUT", `${BASE}/alfred`, { content: "x", baseVersion: 0 }, agent)).status).toBe(403);
      expect((await api("POST", `${BASE}/alfred/restore`, { version: 1, baseVersion: 0 }, write)).status).toBe(403);
    } finally {
      if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
      else process.env["ALLOWED_EMAILS"] = savedAllowed;
    }
  });

  it("write_rate_limit_429", async () => {
    let last = 0;
    let body: unknown;
    for (let i = 0; i < 21; i++) {
      const r = await api("PUT", `${BASE}/lucius`, { content: `t${i}`, baseVersion: i });
      last = r.status;
      body = r.json;
    }
    expect(last).toBe(429);
    expect(body).toEqual({ error: "Troppe richieste: riprova tra poco" });
  });

  describe("proposte", () => {
    const PBASE = "/character-instruction-proposals";

    async function devConversation(ownerEmail = "dev@localhost") {
      await api("GET", `${BASE}/alfred`); // crea l'utente di sviluppo
      let [u] = await db.select().from(usersTable).where(eq(usersTable.email, ownerEmail));
      if (!u) [u] = await db.insert(usersTable).values({ email: ownerEmail, name: "Altro" }).returning();
      const [c] = await db
        .insert(characterConversationsTable)
        .values({ userId: u!.id, character: "lucius", subjectType: "skill", subjectId: "x", title: "" })
        .returning();
      const [m] = await db.insert(characterMessagesTable).values({ conversationId: c!.id, role: "assistant", content: "ok" }).returning();
      return { userId: u!.id, conversationId: c!.id, messageId: m!.id };
    }

    async function proposal(conv: { userId: number; conversationId: number; messageId: number }, baseVersion = 0) {
      const [p] = await db
        .insert(characterInstructionProposalsTable)
        .values({
          userId: conv.userId,
          character: "lucius",
          conversationKind: "character",
          conversationId: conv.conversationId,
          messageId: conv.messageId,
          content: "Sii breve",
          reason: "richiesta dell'utente",
          baseVersion,
        })
        .returning();
      return p!.id;
    }

    it("elenco e decisione con la sessione", async () => {
      const conv = await devConversation();
      const id = await proposal(conv);
      const list = await api("GET", `${PBASE}?conversationKind=character&conversationId=${conv.conversationId}`);
      expect(list.status, list.text).toBe(200);
      expect(list.json).toHaveLength(1);
      expect(list.json[0]).toMatchObject({ id, character: "lucius", content: "Sii breve", status: "pending", baseVersion: 0, currentContent: "", messageId: conv.messageId });
      expect(typeof list.json[0].createdAt).toBe("string");
      const ok = await api("POST", `${PBASE}/${id}/decision`, { action: "accept" });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json).toMatchObject({ id, status: "accepted", currentContent: "Sii breve" });
      const again = await api("POST", `${PBASE}/${id}/decision`, { action: "reject" });
      expect(again.status).toBe(409);
      expect(again.json).toEqual({ error: "proposta già decisa" });
    });

    it("scheda superata: 409", async () => {
      const conv = await devConversation();
      const id = await proposal(conv, 0);
      expect((await api("PUT", `${BASE}/lucius`, { content: "Altro testo", baseVersion: 0 })).status).toBe(200);
      const r = await api("POST", `${PBASE}/${id}/decision`, { action: "accept" });
      expect(r.status).toBe(409);
      const list = await api("GET", `${PBASE}?conversationKind=character&conversationId=${conv.conversationId}`);
      expect(list.json[0].status).toBe("stale");
    });

    it("conversazione o scheda di un altro utente: 404", async () => {
      const other = await devConversation("altro@example.com");
      const id = await proposal(other);
      const list = await api("GET", `${PBASE}?conversationKind=character&conversationId=${other.conversationId}`);
      expect(list.status).toBe(404);
      const dec = await api("POST", `${PBASE}/${id}/decision`, { action: "accept" });
      expect(dec.status).toBe(404);
    });

    it("parametri non validi: 400", async () => {
      expect((await api("GET", `${PBASE}?conversationKind=run&conversationId=1`)).status).toBe(400);
      expect((await api("GET", `${PBASE}?conversationKind=character`)).status).toBe(400);
      expect((await api("POST", `${PBASE}/1/decision`, { action: "boh" })).status).toBe(400);
    });

    it("token: lettura e decisione solo con il login", async () => {
      const savedAllowed = process.env["ALLOWED_EMAILS"];
      try {
        process.env["ALLOWED_EMAILS"] = "token@example.com";
        const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
        const write = (await createApiToken(user!.id, "W", 30, ["api:read", "api:write"])).token;
        const agent = (await createApiToken(user!.id, "A", 30, ["agent"])).token;
        for (const t of [write, agent]) {
          expect((await api("GET", `${PBASE}?conversationKind=character&conversationId=1`, undefined, t)).status).toBe(403);
          expect((await api("POST", `${PBASE}/1/decision`, { action: "accept" }, t)).status).toBe(403);
        }
      } finally {
        if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
        else process.env["ALLOWED_EMAILS"] = savedAllowed;
      }
    });

    it("decisione: 429 oltre 20 scritture al minuto", async () => {
      let last = 0;
      for (let i = 0; i < 21; i++) last = (await api("POST", `${PBASE}/999999/decision`, { action: "reject" })).status;
      expect(last).toBe(429);
    });
  });
});
