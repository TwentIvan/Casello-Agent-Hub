import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  aiAccountsTable,
  aiModelsTable,
  appTestRecipesTable,
  appsTable,
  db,
  pool,
  releaseTestCommandsTable,
  releaseTestStepsTable,
  releaseTestsTable,
  teamInstancesTable,
  type InstanceRoleData,
} from "@workspace/db";
import { seedReleaseTest } from "../../../test/collaudo-fixture";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "../../../test/fake-provider";
import { ensureUser } from "../../../test/team-node-fixture";
import { encryptSecret } from "../secrets";
import { teamSpend } from "../teams/team-spend";
import { modelSpends } from "../budget";
import { nextCommand, saveCommandResult } from "./commands";
import { COLLAUDO_MESSAGES } from "./messages";
import { runReleaseTest } from "./run-test";

// Collaudatore con un provider finto e un runner finto in processo: legge i comandi con nextCommand e risponde con
// saveCommandResult.

const savedKey = process.env["CASELLO_SECRET_KEY"];
let fake: FakeProvider;
let script: FakeChatReply[];
let restoreLoopback: () => void;
let testId: number;
let appId: number;
let instanceId: number;
let aiModelId: number;
let runner: { stop: () => Promise<void>; received: { kind: string; args: unknown }[] };

const usage = { prompt_tokens: 1000, completion_tokens: 500 };
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage,
});
const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage });

const RECIPE = {
  install: ["npm ci"],
  build: [],
  services: [{ name: "web", command: "npm run dev", port: 3000, readyPath: "/" }],
  postgres: false,
  schema: [],
  env: { NODE_ENV: "development" },
  startUrl: "/",
  login: null,
};

const lead = (id: number): InstanceRoleData => ({
  key: "capo",
  name: "Capo",
  task: "Coordina.",
  isLead: true,
  runsOn: "cloud",
  aiModelId: id,
  tools: [],
  skills: [],
  localSkills: [],
});

/** Runner finto: risponde a ogni comando con «ok: <kind>». */
function startRunner(id: number) {
  const received: { kind: string; args: unknown }[] = [];
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const cmd = await nextCommand(id, 200, abort.signal);
      if (!cmd) continue;
      received.push({ kind: cmd.kind, args: cmd.args });
      await saveCommandResult(id, cmd.id, { ok: true, output: `ok: ${cmd.kind}` });
    }
  })();
  return {
    received,
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}

const testRow = async () => (await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId)))[0]!;

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(async () => {
  restoreLoopback();
  process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  script = [];
  fake = await startFakeProvider({ chatReply: () => script.shift() ?? text("fine") });
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
  const userId = await ensureUser("collaudo@example.com");
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Cloud", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("k-test"), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  aiModelId = model!.id;
  ({ testId, appId } = await seedReleaseTest({ status: "running" }));
  const [inst] = await db.select().from(teamInstancesTable).limit(1);
  instanceId = inst!.id;
  await db.update(teamInstancesTable).set({ roles: [lead(aiModelId)] }).where(eq(teamInstancesTable.id, instanceId));
  runner = startRunner(testId);
});

afterEach(async () => {
  await runner.stop();
  await fake.close();
});

describe("collaudatore", () => {
  it("shell, salva_ricetta e consegna con problemi", async () => {
    script = [
      call("shell", { command: "cat package.json" }),
      call("browser", { action: "open", url: "/" }),
      call("salva_ricetta", { ricetta: RECIPE }),
      call("consegna_collaudo", {
        esito: "problemi",
        resoconto: "Avviata e provata la home.",
        problemi: [{ compito: "t1", titolo: "Pulsante rotto", passi: "Apri /, premi Salva", atteso: "Salvato", ottenuto: "Errore 500" }],
        nonProvabile: ["Pagamenti: servizio esterno spento"],
      }),
    ];
    await runReleaseTest(testId);

    const row = await testRow();
    expect(row.status).toBe("running");
    expect(row.outcome).toBe("problems");
    expect(row.report).toBe("Avviata e provata la home.");
    expect(row.problems).toEqual([
      { task: "t1", title: "Pulsante rotto", steps: "Apri /, premi Salva", expected: "Salvato", actual: "Errore 500", screenshot: null },
    ]);
    expect(row.notTestable).toEqual(["Pagamenti: servizio esterno spento"]);
    expect(row.error).toBeNull();
    expect(row.aiModelId).toBe(aiModelId);
    expect(row.promptTokens).toBe(4000);
    expect(row.completionTokens).toBe(2000);
    // 4000 × 1 $/M + 2000 × 2 $/M
    expect(Number(row.costUsd)).toBeCloseTo(0.008, 6);

    expect(runner.received.map((c) => c.kind)).toEqual(["shell", "browser"]);
    expect(runner.received[0]!.args).toEqual({ command: "cat package.json" });

    const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
    expect(app!.testRecipeVersion).toBe(1);
    expect(app!.testRecipe).toEqual(RECIPE);
    const versions = await db.select().from(appTestRecipesTable).where(eq(appTestRecipesTable.appId, appId));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.source).toBe("agent");

    // L'uscita del comando arriva al modello come dato delimitato
    const last = fake.requests.at(-1)!.body as { messages: { role: string; content: string }[] };
    expect(last.messages.some((m) => m.role === "tool" && m.content.includes("<dati>\nok: shell\n</dati>"))).toBe(true);

    const steps = await db.select().from(releaseTestStepsTable).where(eq(releaseTestStepsTable.testId, testId)).orderBy(asc(releaseTestStepsTable.position));
    expect(steps.filter((s) => s.type === "tool").map((s) => s.toolName)).toEqual(["shell", "browser", "salva_ricetta", "consegna_collaudo"]);
    // Dopo la consegna il ciclo si ferma: nessuna chiamata al modello in più
    expect(fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(4);
  });

  it("resoconto e problemi ripuliti dalle credenziali (anche nei passi)", async () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
    script = [
      call("consegna_collaudo", {
        esito: "ok",
        resoconto: `Tutto bene, chiave ${key} vista nei log`,
        problemi: [{ titolo: "Chiave", passi: `usa ${key}`, atteso: "a", ottenuto: "b" }],
      }),
    ];
    await runReleaseTest(testId);
    const row = await testRow();
    expect(row.outcome).toBe("ok");
    expect(row.report).toBe("Tutto bene, chiave *** vista nei log");
    expect((row.problems as { steps: string }[])[0]!.steps).toBe("usa ***");
    const steps = await db.select().from(releaseTestStepsTable).where(eq(releaseTestStepsTable.testId, testId));
    expect(JSON.stringify(steps.map((s) => s.args))).not.toContain(key);
  });

  it("ricetta non valida: {ok:false} al modello e niente salvato", async () => {
    script = [
      call("salva_ricetta", { ricetta: { ...RECIPE, install: ["npm ci\nrm -rf /"] } }),
      call("consegna_collaudo", { esito: "non_avviabile", resoconto: "Non parte." }),
    ];
    await runReleaseTest(testId);
    const second = fake.requests.filter((r) => r.path === "/v1/chat/completions")[1]!.body as { messages: { role: string; content: string }[] };
    const toolMsg = second.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("ricetta non valida");
    const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
    expect(app!.testRecipeVersion).toBe(0);
    expect(app!.testRecipe).toBeNull();
    expect((await testRow()).outcome).toBe("not_startable");
  });

  it("shell con timeoutSec oltre 300: errore al modello, nessun comando", async () => {
    script = [call("shell", { command: "sleep 1000", timeoutSec: 600 }), call("consegna_collaudo", { esito: "ok", resoconto: "ok" })];
    await runReleaseTest(testId);
    expect(runner.received).toHaveLength(0);
    const cmds = await db.select().from(releaseTestCommandsTable).where(eq(releaseTestCommandsTable.testId, testId));
    expect(cmds).toHaveLength(0);
  });

  it("senza consegna: error notDelivered, costo registrato", async () => {
    script = [call("shell", { command: "ls" }), text("Ho finito.")];
    await runReleaseTest(testId);
    const row = await testRow();
    expect(row.outcome).toBeNull();
    expect(row.error).toBe(COLLAUDO_MESSAGES.notDelivered);
    expect(row.status).toBe("running");
    expect(Number(row.costUsd)).toBeGreaterThan(0);
  });

  it("il costo conta nella spesa della squadra e del modello", async () => {
    script = [call("consegna_collaudo", { esito: "ok", resoconto: "Provato." })];
    await runReleaseTest(testId);
    // 1000 × 1 $/M + 500 × 2 $/M
    expect((await teamSpend(instanceId)).spentUsd).toBeCloseTo(0.002, 6);
    expect((await modelSpends([aiModelId])).get(aiModelId)!.spentUsd).toBeCloseTo(0.002, 6);
  });

  it("oltre 15 giri senza ricetta: il risultato invita a consegnare non_avviabile", async () => {
    script = [
      ...Array.from({ length: 16 }, (_, i) => call("shell", { command: `echo ${i}` }, `c_${i}`)),
      call("consegna_collaudo", { esito: "non_avviabile", resoconto: "Non parte." }),
    ];
    await runReleaseTest(testId);
    const chats = fake.requests.filter((r) => r.path === "/v1/chat/completions");
    const toolMsgs = (i: number) => (chats[i]!.body as { messages: { role: string; content: string }[] }).messages.filter((m) => m.role === "tool");
    expect(toolMsgs(15).at(-1)!.content).not.toContain("Fase di avvio esaurita");
    expect(toolMsgs(16).at(-1)!.content).toContain("Fase di avvio esaurita");
  });

  it("capo senza modello: error e nessuna chiamata al modello", async () => {
    await db.update(teamInstancesTable).set({ roles: [{ ...lead(aiModelId), aiModelId: null }] }).where(eq(teamInstancesTable.id, instanceId));
    await runReleaseTest(testId);
    expect((await testRow()).error).toBe(COLLAUDO_MESSAGES.noModel);
    expect(fake.requests).toHaveLength(0);
  });
});
