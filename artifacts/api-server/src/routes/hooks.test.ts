import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  agentTriggersTable,
  runsTable,
  triggerSeenItemsTable,
  usersTable,
  type AgentTrigger,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { MAX_PENDING_PER_AGENT } from "../lib/run-queue";

// Webhook in entrata (spec §5) sull'app Express completa (porta 0). Lo scheduler delle run non parte: le run
// create restano `pending`. Il logger è un pino che scrive in memoria, per verificare che il segreto non finisca
// nei log. Le tabelle si svuotano SENZA ripartire con gli id: il limite di 60/min è in memoria per id d'innesco.

const logLines = vi.hoisted(() => [] as string[]);

vi.mock("../lib/logger", async () => {
  const { default: pino } = await import("pino");
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  const logger = pino({ level: "trace", redact: actual.LOG_REDACT_PATHS }, { write: (line: string) => void logLines.push(line) });
  return { ...actual, logger };
});

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let secrets: typeof import("../lib/triggers/secrets");
// IP del client (X-Forwarded-For, con `trust proxy` come in produzione): uno nuovo per test, così il limite per IP
// di un test non tocca gli altri.
let clientIp = "";
let ipCounter = 0;
const nextIp = (): string => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  const { default: app } = await import("../app");
  app.set("trust proxy", 1);
  secrets = await import("../lib/triggers/secrets");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  clientIp = nextIp();
  logLines.length = 0;
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
});

type Seed = {
  agent?: Partial<typeof agentsTable.$inferInsert>;
  trigger?: Partial<typeof agentTriggersTable.$inferInsert>;
};

/** Agente attivo con modello e innesco webhook attivo; restituisce anche il segreto in chiaro dell'URL. */
async function seed(opts: Seed = {}): Promise<{ trigger: AgentTrigger; agentId: number; secret: string }> {
  const [owner] = await db.insert(usersTable).values({ email: "webhook@example.com", name: "Webhook" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: owner!.id,
      name: "Account di prova",
      provider: "custom",
      baseUrl: "https://provider.invalid/v1",
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "modello-base", displayName: "Base" })
    .returning();
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" }).returning();
  const [agent] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Smistatore", role: "area", status: "active", model: "modello-base", aiModelId: model!.id, ...opts.agent })
    .returning();
  const { secret, hash } = secrets.generateWebhookSecret();
  const [trigger] = await db
    .insert(agentTriggersTable)
    .values({ agentId: agent!.id, kind: "webhook", name: "GitHub", status: "active", secretHash: hash, ...opts.trigger })
    .returning();
  return { trigger: trigger!, agentId: agent!.id, secret };
}

async function hook(
  id: number | string,
  secret: string,
  body: string | Buffer,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  const res = await fetch(`${base}/api/hooks/${id}/${secret}`, { method: "POST", headers: { "x-forwarded-for": clientIp, ...headers }, body });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json: json as Record<string, unknown> | undefined, retryAfter: res.headers.get("retry-after") };
}

async function triggerRuns(triggerId: number) {
  return db.select().from(runsTable).where(eq(runsTable.triggerId, triggerId)).orderBy(asc(runsTable.id));
}

async function keys(triggerId: number): Promise<string[]> {
  const rows = await db
    .select({ k: triggerSeenItemsTable.itemKey })
    .from(triggerSeenItemsTable)
    .where(eq(triggerSeenItemsTable.triggerId, triggerId));
  return rows.map((r) => r.k);
}

async function getTrigger(id: number): Promise<AgentTrigger> {
  const [row] = await db.select().from(agentTriggersTable).where(eq(agentTriggersTable.id, id));
  return row!;
}

const sign = (key: string, body: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

describe("webhook in entrata", () => {
  it("segreto giusto: 202 con runId", async () => {
    const { trigger, secret } = await seed({ trigger: { instructions: "Smista l'evento" } });
    const res = await hook(trigger.id, secret, JSON.stringify({ action: "opened", number: 7 }));
    expect(res.status).toBe(202);
    const runs = await triggerRuns(trigger.id);
    expect(runs).toHaveLength(1);
    expect(res.json).toEqual({ runId: runs[0]!.id });
    expect(runs[0]!.triggerId).toBe(trigger.id);
    expect(runs[0]!.status).toBe("pending");
    expect(runs[0]!.input).toContain("<evento>");
    expect(runs[0]!.input).toContain("Evento ricevuto dal webhook «GitHub»");
    expect(runs[0]!.input!.startsWith("Smista l'evento")).toBe(true);
    const t = await getTrigger(trigger.id);
    expect(t.runsCreated).toBe(1);
    expect(t.lastPolledAt).not.toBeNull();
  });

  it("segreto sbagliato e id inesistente: stessa risposta 404", async () => {
    const { trigger, secret } = await seed();
    const wrong = await hook(trigger.id, `${secret}x`, "{}");
    const missing = await hook(trigger.id + 1000, secret, "{}");
    const notNumber = await hook("abc", secret, "{}");
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(notNumber.status).toBe(404);
    expect(wrong.json).toEqual({ error: "non trovato" });
    expect(missing.json).toEqual(wrong.json);
    expect(notNumber.json).toEqual(wrong.json);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
    expect((await getTrigger(trigger.id)).lastPolledAt).toBeNull();
  });

  it("firma valida su JSON con spazi e ordine delle chiavi originali", async () => {
    const { trigger, secret } = await seed({ trigger: { signingSecretEnc: encryptSecret("firma-segreta-abcdef") } });
    const body = '{ "zeta": 1,\n  "alfa" :  [ 2, 3 ] }';
    const res = await hook(trigger.id, secret, body, {
      "content-type": "application/json",
      "x-hub-signature-256": sign("firma-segreta-abcdef", body),
    });
    expect(res.status).toBe(202);
    // La firma calcolata sul JSON riserializzato non vale
    const reserialized = await hook(trigger.id, secret, body, {
      "content-type": "application/json",
      "x-hub-signature-256": sign("firma-segreta-abcdef", JSON.stringify(JSON.parse(body))),
    });
    expect(reserialized.status).toBe(401);
    expect(reserialized.json).toEqual({ error: "firma non valida" });
  });

  it("firma assente con segreto di firma impostato: 401", async () => {
    const { trigger, secret } = await seed({ trigger: { signingSecretEnc: encryptSecret("firma-segreta-abcdef") } });
    const res = await hook(trigger.id, secret, "{}");
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "firma non valida" });
    const malformed = await hook(trigger.id, secret, "{}", { "content-type": "application/json", "x-hub-signature-256": "sha256=zz" });
    expect(malformed.status).toBe(401);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("corpo di 300 KB: 413", async () => {
    const { trigger, secret } = await seed();
    const res = await hook(trigger.id, secret, JSON.stringify({ x: "a".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("application/xml: 415", async () => {
    const { trigger, secret } = await seed();
    const res = await hook(trigger.id, secret, "<a/>", { "content-type": "application/xml" });
    expect(res.status).toBe(415);
    const none = await hook(trigger.id, secret, Buffer.from("x"), {});
    expect(none.status).toBe(415);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("JSON non valido: 400", async () => {
    const { trigger, secret } = await seed();
    const res = await hook(trigger.id, secret, "{non json");
    expect(res.status).toBe(400);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("form urlencoded diventa oggetto", async () => {
    const { trigger, secret } = await seed({ trigger: { filter: { field: "tipo", equals: "ordine" } } });
    const res = await hook(trigger.id, secret, "tipo=ordine&codice=A%2012", { "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(202);
    const [run] = await triggerRuns(trigger.id);
    expect(run!.input).toContain('"codice": "A 12"');
    const ignored = await hook(trigger.id, secret, "tipo=reso", { "content-type": "application/x-www-form-urlencoded" });
    expect(ignored.json).toEqual({ ignored: true });
  });

  it("text/plain entra come testo", async () => {
    const { trigger, secret } = await seed();
    const res = await hook(trigger.id, secret, "Ciao Botcave\nseconda riga", { "content-type": "text/plain; charset=utf-8" });
    expect(res.status).toBe(202);
    const [run] = await triggerRuns(trigger.id);
    expect(run!.input).toContain("<evento>\nCiao Botcave\nseconda riga\n</evento>");
  });

  it("X-GitHub-Delivery ripetuto: 200 duplicate", async () => {
    const { trigger, secret } = await seed({ trigger: { dedupHeader: "X-GitHub-Delivery" } });
    const headers = { "content-type": "application/json", "x-github-delivery": "consegna-1" };
    expect((await hook(trigger.id, secret, '{"a":1}', headers)).status).toBe(202);
    const again = await hook(trigger.id, secret, '{"a":2}', headers);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ duplicate: true });
    expect(await triggerRuns(trigger.id)).toHaveLength(1);
    expect(await keys(trigger.id)).toEqual(["consegna-1"]);
    expect((await getTrigger(trigger.id)).runsCreated).toBe(1);
  });

  it("id_field e version_field sul corpo JSON", async () => {
    const { trigger, secret } = await seed({ trigger: { idField: "ordine.id", versionField: "stato" } });
    expect((await hook(trigger.id, secret, '{"ordine":{"id":7},"stato":"nuovo"}')).status).toBe(202);
    expect((await hook(trigger.id, secret, '{"ordine":{"id":"7"},"stato":"nuovo"}')).json).toEqual({ duplicate: true });
    expect((await hook(trigger.id, secret, '{"ordine":{"id":7},"stato":"pagato"}')).status).toBe(202);
    expect((await keys(trigger.id)).sort()).toEqual(["7\u001fnuovo", "7\u001fpagato"]);
  });

  it("filtro non soddisfatto: 200 ignored", async () => {
    const { trigger, secret } = await seed({ trigger: { filter: { field: "action", equals: "opened" }, idField: "id" } });
    const res = await hook(trigger.id, secret, '{"action":"closed","id":1}');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ignored: true });
    expect(await keys(trigger.id)).toEqual([]);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
    expect((await getTrigger(trigger.id)).lastPolledAt).not.toBeNull();
  });

  it("innesco in pausa: 409", async () => {
    const { trigger, secret } = await seed({ trigger: { status: "paused", dedupHeader: "X-Id" } });
    const res = await hook(trigger.id, secret, "{}", { "content-type": "application/json", "x-id": "e1" });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "innesco non attivo" });
    expect(await keys(trigger.id)).toEqual([]);
  });

  it("agente non attivo o senza modello: 409", async () => {
    const { trigger, secret } = await seed({ agent: { status: "inactive" } });
    expect((await hook(trigger.id, secret, "{}")).json).toEqual({ error: "innesco non attivo" });
    await db.update(agentsTable).set({ status: "active", aiModelId: null }).where(eq(agentsTable.id, trigger.agentId));
    expect((await hook(trigger.id, secret, "{}")).status).toBe(409);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("tetto raggiunto: 409 col messaggio del tetto, nessuna chiave", async () => {
    const { trigger, secret } = await seed({ agent: { monthlyBudgetUsd: "0" }, trigger: { dedupHeader: "X-Id" } });
    const res = await hook(trigger.id, secret, "{}", { "content-type": "application/json", "x-id": "e1" });
    expect(res.status).toBe(409);
    expect(String(res.json?.["error"])).toContain("Tetto di spesa mensile dell'agente raggiunto");
    expect(await keys(trigger.id)).toEqual([]);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("coda piena: 429 con Retry-After 60", async () => {
    const { trigger, agentId, secret } = await seed({ trigger: { dedupHeader: "X-Id" } });
    await pool.query(`INSERT INTO runs (agent_id, status, input) SELECT $1, 'pending', 'vecchia' FROM generate_series(1, $2)`, [
      agentId,
      MAX_PENDING_PER_AGENT,
    ]);
    const res = await hook(trigger.id, secret, "{}", { "content-type": "application/json", "x-id": "e1" });
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe("60");
    expect(await keys(trigger.id)).toEqual([]);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("61 richieste autenticate in un minuto: 429", async () => {
    const { trigger, secret } = await seed();
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof hook>> | undefined;
    for (let i = 0; i < 61; i++) {
      last = await hook(trigger.id, secret, "{}");
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 202)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect(last!.retryAfter).toBe("60");
    expect(await triggerRuns(trigger.id)).toHaveLength(60);
    // Un id non numerico non conta nel limite per innesco (da un altro IP: il limite per IP vale per tutti)
    clientIp = nextIp();
    for (let i = 0; i < 61; i++) expect((await hook("xyz", "whs_sbagliato", "{}")).status).toBe(404);
  });

  it("61 richieste con il segreto sbagliato non bloccano quella con il segreto giusto", async () => {
    const { trigger, secret } = await seed();
    for (let i = 0; i < 61; i++) {
      clientIp = nextIp();
      expect((await hook(trigger.id, "whs_sbagliato", "{}")).status).toBe(404);
    }
    clientIp = nextIp();
    expect((await hook(trigger.id, secret, '{"a":1}')).status).toBe(202);
  });

  it("121 richieste dallo stesso IP: 429 con Retry-After 60", async () => {
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof hook>> | undefined;
    for (let i = 0; i < 121; i++) {
      last = await hook(1_000_000 + i, "whs_sbagliato", "{}");
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 120).every((s) => s === 404)).toBe(true);
    expect(statuses[120]).toBe(429);
    expect(last!.retryAfter).toBe("60");
    clientIp = nextIp();
    expect((await hook(1_000_000, "whs_sbagliato", "{}")).status).toBe(404);
  });

  it("il segreto non compare nei log", async () => {
    const { trigger, secret } = await seed();
    expect((await hook(trigger.id, secret, '{"a":1}')).status).toBe(202);
    await hook(trigger.id, `${secret}x`, "{}");
    await hook(trigger.id, secret, JSON.stringify({ x: "a".repeat(300 * 1024) }));
    await hook(trigger.id, secret, "{rotto");
    await new Promise((r) => setTimeout(r, 50));
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((l) => l.includes(`/api/hooks/${trigger.id}/***`))).toBe(true);
    for (const line of logLines) {
      expect(line).not.toContain("whs_");
      expect(line).not.toContain('"a":1');
    }
  });
});

describe("funzioni del segreto", () => {
  it("redactHookPath su /api/hooks/3/whs_abc?x=1", () => {
    expect(secrets.redactHookPath("/api/hooks/3/whs_abc?x=1")).toBe("/api/hooks/3/***");
    expect(secrets.redactHookPath("/API/Hooks/3/whs_abc/altro")).toBe("/API/Hooks/3/***");
    expect(secrets.redactHookPath("/api/hooks/whs_abc")).toBe("/api/hooks/***");
    expect(secrets.redactHookPath("/api/runs/3")).toBe("/api/runs/3");
  });

  it("generateWebhookSecret, secretMatches e webhookUrl", () => {
    const { secret, hash } = secrets.generateWebhookSecret();
    expect(secret).toMatch(/^whs_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.secretMatches(secret, hash)).toBe(true);
    expect(secrets.secretMatches(`${secret}x`, hash)).toBe(false);
    expect(secrets.secretMatches(secret, "corto")).toBe(false);
    process.env["PUBLIC_APP_URL"] = "https://botcave.example/";
    expect(secrets.webhookUrl(5, secret)).toBe(`https://botcave.example/api/hooks/5/${secret}`);
  });
});
