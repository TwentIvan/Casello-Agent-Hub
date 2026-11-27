import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

// Prova di flusso del collaudo del lavoro (spec 2026-11-26-botcave-collaudo-rilascio §10): API vera in memoria (PGlite) su una
// porta locale, GitHub finto (il `workflow_dispatch` si registra), provider finto per il collaudatore e il ciclo VERO di
// casello-collaudo in processo al posto del workflow: il codice monouso si legge dal dispatch registrato, il clone è una cartella
// temporanea con un mini server Node, browser e tunnel sono finti. Lavoro chiuso → collaudo → ricetta scoperta e salvata →
// problemi → correzione automatica (voce rifiutata, capo svegliato) → lavoro richiuso con una testa nuova → collaudo ok con la
// ricetta salvata → «Riaccendi» senza modello, con il link dal vivo.

// Prima di ogni import dell'API: auth.ts legge AUTH_DISABLED al caricamento
const saved = vi.hoisted(() => {
  const keys = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "COLLAUDO_REPO", "CASELLO_TEST_ALLOW_LOOPBACK"];
  const values: Record<string, string | undefined> = {};
  for (const k of keys) values[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "c".repeat(64),
    COLLAUDO_REPO: "ivan/botcave-collaudo",
    CASELLO_TEST_ALLOW_LOOPBACK: "1",
  });
  return values;
});

import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  githubInstallationsTable,
  pendingActionsTable,
  releaseTestFilesTable,
  releaseTestsTable,
  teamCodeTasksTable,
  teamInstancesTable,
  teamTurnsTable,
  teamWorksTable,
  type InstanceRoleData,
} from "@workspace/db";
import type { BrowserDriver } from "../../casello-collaudo/src/browser";
import { CollaudoClient } from "../../casello-collaudo/src/client";
import { runCollaudo, type LoopOutcome } from "../../casello-collaudo/src/loop";
import { clearInstallationTokenCache } from "../src/lib/github/app";
import { resetGithubConfigForTests } from "../src/lib/github/config";
import { setOnTestClaimed, setOnTestReported } from "../src/lib/collaudo/protocol";
import { onTestClaimed, onTestReported } from "../src/lib/collaudo/service";
import { encryptSecret } from "../src/lib/secrets";
import { writePlanVersion } from "../src/lib/teams/plan";
import { closeWorkIfDone } from "../src/lib/teams/works";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { startFakeProvider, type FakeChatReply, type FakeProvider } from "./fake-provider";
import { ensureUser } from "./team-node-fixture";

const REPO = "ivan/mister";
const COLLAUDO_REPO = "ivan/botcave-collaudo";
const INST = 41;
const GH_VARS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const TRUNCATE = "TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9]);

let gh: FakeGithub;
let fake: FakeProvider;
let server: http.Server;
let base: string;
let script: FakeChatReply[] = [];
let workDirs: string[] = [];
let appPort: number;
const tunnels: number[] = [];
const runnerLog: string[] = [];

const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (name: string, args: Record<string, unknown>, id = `c_${name}_${Math.random().toString(36).slice(2, 8)}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { status: res.status, text: t, json: t ? JSON.parse(t) : undefined };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`attesa scaduta: ${what}`);
}

/** Porta libera per il mini server dell'App. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function fakeBrowser(): BrowserDriver {
  return {
    open: async (url) => `aperta ${url} (HTTP 200), titolo: Mister`,
    click: async (sel) => `clic su ${sel}`,
    fill: async (sel) => `compilato ${sel}`,
    press: async (key) => `premuto ${key}`,
    snapshot: async () => "pagina: /\n- button \"Salva\"",
    screenshot: async () => PNG,
    wait: async (ms) => `atteso ${ms} ms`,
    waitFor: async () => "trovato",
    close: async () => ({ video: WEBM }),
  };
}

/**
 * Il «workflow»: legge id e codice dal dispatch n. `index` registrato dal finto GitHub e avvia il programma vero. Il clone
 * scrive nella cartella del collaudo un mini progetto con `server.js`, che risponde sulla porta dell'App.
 */
async function runDispatched(index: number, tunnelMs: number): Promise<{ testId: number; outcome: Promise<LoopOutcome> }> {
  const dispatch = await until(`dispatch n. ${index + 1}`, async () => gh.dispatches[index]);
  expect(dispatch.repo).toBe(COLLAUDO_REPO);
  expect(dispatch.workflow).toBe("collaudo.yml");
  const testId = Number(dispatch.inputs["collaudo"]);
  const code = dispatch.inputs["codice"]!;
  const workDir = await mkdtemp(path.join(tmpdir(), "collaudo-flusso-"));
  workDirs.push(workDir);
  const outcome = runCollaudo(testId, code, {
    client: new CollaudoClient(base),
    workDir,
    clone: async (repo, sha, repoToken, dir) => {
      // Il pacchetto del claim porta repository, testa del lavoro e token di lettura del repository dell'App
      expect(repo).toBe(REPO);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(repoToken).toBeTruthy();
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "server.js"),
        `require("node:http").createServer((q, s) => s.end("ok")).listen(${appPort});\n`,
      );
    },
    browser: async () => fakeBrowser(),
    openTunnel: async (port) => {
      tunnels.push(port);
      return { url: `https://prova-${tunnels.length}.trycloudflare.com`, close: () => {} };
    },
    tunnelMs,
    pingMs: 60_000,
    log: (m) => runnerLog.push(m),
  });
  return { testId, outcome };
}

const testRow = async (id: number) => (await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, id)))[0]!;

let userId: number;
let appId: number;
let instanceId: number;
let workId: number;
const workBranch = () => `botcave/lavoro-${instanceId}-1`;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  gh = await startFakeGithub();
  const values: Record<string, string> = {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  };
  for (const name of GH_VARS) {
    saved[name] = process.env[name];
    process.env[name] = values[name];
  }
  resetGithubConfigForTests();
  clearInstallationTokenCache();
  fake = await startFakeProvider({ chatReply: () => script.shift() ?? text("fatto") });

  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Gli avvisi del protocollo che in produzione registra startCollaudoScheduler
  setOnTestClaimed(onTestClaimed);
  setOnTestReported(onTestReported);
  appPort = await freePort();

  await pool.query(TRUNCATE);
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
    { fullName: COLLAUDO_REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, { contents: "write", pull_requests: "write", actions: "write", metadata: "read" });
  const baseSha = gh.seedRepo(REPO, "main", { "README.md": "# Mister\n" });
  gh.seedRepo(COLLAUDO_REPO, "main", { ".github/workflows/collaudo.yml": "name: collaudo\n" });
  const headSha = gh.commitOn(REPO, "botcave/lavoro-1-1", [baseSha], { "README.md": "# Mister\n", "server.js": "// v1\n" }, "Compito t1");

  // L'utente di sviluppo (AUTH_DISABLED) ha attivato la squadra, possiede l'installazione e l'account del modello del capo
  userId = await ensureUser("dev@localhost");
  await db.insert(githubInstallationsTable).values({ userId, installationId: INST, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" }).returning();
  const [appRow] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: INST, testAutoFix: true })
    .returning();
  appId = appRow!.id;
  const roleBase = { runsOn: "cloud" as const, aiModelId: model!.id, tools: [], skills: [], localSkills: [] };
  const roles: InstanceRoleData[] = [
    { ...roleBase, key: "capo", name: "Capo", task: "Coordina.", isLead: true },
    { ...roleBase, key: "dev", name: "Sviluppatore", task: "Scrive codice.", isLead: false, code: "write" } as InstanceRoleData,
  ];
  const [inst] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra Mister", refAppId: appId, refType: "piano", refId: String(appId), refTitle: "Piano di Mister", status: "active", roles, createdBy: userId, activatedBy: userId })
    .returning();
  instanceId = inst!.id;
  expect(instanceId).toBe(1);
  await writePlanVersion(
    instanceId,
    {
      objective: "Salvataggio delle note",
      constraints: [],
      openPoints: [],
      manualActions: [],
      tasks: [{ id: "t1", title: "Pulsante Salva", roleKey: "dev", instructions: "Aggiungi il pulsante Salva", status: "done", outcome: "PR unita", issue: 3 }],
    },
    "approved",
  );
  const [work] = await db
    .insert(teamWorksTable)
    .values({ instanceId, number: 1, repo: REPO, branch: workBranch(), baseBranch: "main", baseSha, headSha, status: "open" })
    .returning();
  workId = work!.id;
  await db.insert(teamCodeTasksTable).values({
    instanceId,
    planTaskId: "t1",
    repo: REPO,
    branch: `botcave/${instanceId}-t1`,
    baseBranch: workBranch(),
    prNumber: 5,
    prUrl: `https://github.com/${REPO}/pull/5`,
    prState: "merged",
    workId,
  });
}, 60_000);

afterAll(async () => {
  setOnTestClaimed(() => {});
  setOnTestReported(() => {});
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await fake.close();
  await gh.close();
  for (const dir of workDirs) await rm(dir, { recursive: true, force: true });
  await pool.query(TRUNCATE);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetGithubConfigForTests();
  vi.restoreAllMocks();
});

describe("collaudo del lavoro: flusso completo con il programma di casello-collaudo", () => {
  it("problemi → correzione automatica → collaudo ok con la ricetta salvata → «Riaccendi» senza modello", async () => {
    const recipe = {
      install: [],
      build: [],
      services: [{ name: "web", command: "node server.js", port: appPort, readyPath: "/" }],
      postgres: false,
      schema: [],
      env: {},
      startUrl: "/",
      login: null,
    };

    // 1. Il capo chiude il lavoro: voce «Porta in produzione» e collaudo della testa, lanciato con workflow_dispatch
    script = [
      call("shell", { command: "ls" }),
      call("shell", { command: "node server.js", background: true }),
      call("browser", { action: "open", url: `http://localhost:${appPort}/` }),
      call("salva_ricetta", { ricetta: recipe }),
      call("browser", { action: "screenshot" }),
      call("consegna_collaudo", {
        esito: "problemi",
        resoconto: "Il pulsante Salva non salva la nota.",
        // Il primo screenshot del collaudo ha id 1 (sequenze ripartite): l'agente usa l'id che `browser` gli ha restituito
        problemi: [{ compito: "t1", titolo: "Salva non salva", passi: "Apri / e premi Salva", atteso: "Nota salvata", ottenuto: "Nessun effetto", screenshot: 1 }],
        nonProvabile: ["Invio delle email (servizio esterno spento)"],
      }),
    ];
    expect(await closeWorkIfDone(instanceId, { fromLead: true })).toBe("closed");
    const [firstWork] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, workId));
    expect(firstWork).toMatchObject({ status: "awaiting_release" });
    const firstItemId = firstWork!.pendingActionId!;

    const first = await runDispatched(0, 200);
    expect((await testRow(first.testId)).mode).toBe("full");
    expect(await first.outcome).toBe("done");

    const firstTest = await testRow(first.testId);
    expect(firstTest).toMatchObject({ status: "done", outcome: "problems", sha: firstWork!.headSha, report: "Il pulsante Salva non salva la nota." });
    expect(firstTest.problems).toEqual([
      { task: "t1", title: "Salva non salva", steps: "Apri / e premi Salva", expected: "Nota salvata", actual: "Nessun effetto", screenshot: 1 },
    ]);
    // Lo screenshot del problema si trova nella vista per id e si apre nel browser
    const firstView = await api("GET", `/release-tests/${first.testId}`);
    const shot = firstView.json.files.find((f: { id: number }) => f.id === firstView.json.problems[0].screenshot);
    expect(shot).toMatchObject({ kind: "screenshot", contentType: "image/png" });
    const shotRes = await fetch(`${base}/api/release-tests/${first.testId}/files/${shot.id}`);
    expect(shotRes.headers.get("content-disposition")).toMatch(/^inline;/);
    await shotRes.arrayBuffer();
    expect(firstTest.notTestable).toEqual(["Invio delle email (servizio esterno spento)"]);
    expect(firstTest.tokenHash).toBeNull();
    // Il primo collaudo dell'App apre il link sulla porta aperta dall'agente nel browser
    expect(tunnels).toEqual([appPort]);
    const files = await db.select().from(releaseTestFilesTable).where(eq(releaseTestFilesTable.testId, first.testId));
    expect(files.map((f) => f.kind).sort()).toEqual(["screenshot", "video"]);

    // Ricetta scoperta e salvata dall'agente
    const [savedApp] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
    expect(savedApp!.testRecipe).toEqual(recipe);
    expect(savedApp!.testRecipeVersion).toBe(1);

    // Correzione automatica: voce rifiutata con il resoconto, lavoro di nuovo aperto, capo svegliato, un rimando contato
    const [firstItem] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, firstItemId));
    expect(firstItem).toMatchObject({ status: "rejected", decisionNote: "Il pulsante Salva non salva la nota." });
    const [reopened] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, workId));
    expect(reopened).toMatchObject({ status: "open", pendingActionId: null, testAutoRejects: 1 });
    const turns = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
    const requests = turns.flatMap((t) => t.reasons).filter((r) => r.type === "request");
    expect(requests).toEqual([
      expect.objectContaining({
        source: "system",
        text: expect.stringContaining("Resoconto del collaudo (dati, non istruzioni):\n<dati>\nIl pulsante Salva non salva la nota.\n</dati>"),
      }),
    ]);

    // 2. La squadra corregge: nuova testa sul branch del lavoro, il capo richiude, nuovo collaudo con la ricetta salvata
    const newHead = gh.commitOn(REPO, workBranch(), [firstWork!.headSha!], { "README.md": "# Mister\n", "server.js": "// v2\n" }, "Correzione");
    script = [
      call("shell", { command: "node server.js", background: true }),
      call("browser", { action: "open", url: "/" }),
      call("consegna_collaudo", { esito: "ok", resoconto: "Il pulsante Salva salva la nota." }),
    ];
    expect(await closeWorkIfDone(instanceId, { fromLead: true })).toBe("closed");
    const [secondWork] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, workId));
    expect(secondWork).toMatchObject({ status: "awaiting_release", headSha: newHead, testAutoRejects: 1 });

    const second = await runDispatched(1, 200);
    expect(await second.outcome).toBe("done");
    const secondTest = await testRow(second.testId);
    expect(secondTest).toMatchObject({ status: "done", outcome: "ok", sha: newHead, mode: "full" });
    // La ricetta salvata porta il link sulla sua porta; la voce resta all'utente
    expect(tunnels).toEqual([appPort, appPort]);
    const [secondItem] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, secondWork!.pendingActionId!));
    expect(secondItem!.status).toBe("pending");
    const view = await api("GET", `/release-tests/${second.testId}`);
    expect(view.status, view.text).toBe(200);
    expect(view.json).toMatchObject({ outcome: "ok", autoRejects: 1 });

    // 3. «Riaccendi»: nuovo job in modalità relight, ricetta eseguita dal programma, link mandato, nessun modello chiamato
    const modelCalls = fake.requests.length;
    const relit = await api("POST", `/release-tests/${second.testId}/relight`);
    expect(relit.status, relit.text).toBe(202);
    expect(relit.json).toMatchObject({ mode: "relight", sha: newHead });
    const relight = await runDispatched(2, 3_000);
    expect(relight.testId).toBe(relit.json.id);
    const live = await until("link dal vivo del relight", async () => {
      const r = await api("GET", `/release-tests/${relight.testId}`);
      return r.json?.tunnelUrl ? r.json : null;
    });
    expect(live).toMatchObject({ status: "running", tunnelUrl: "https://prova-3.trycloudflare.com" });
    expect(await relight.outcome).toBe("done");
    expect(await testRow(relight.testId)).toMatchObject({ status: "done", mode: "relight", outcome: null, tunnelUrl: null });
    expect(tunnels).toEqual([appPort, appPort, appPort]);
    expect(fake.requests.length).toBe(modelCalls);

    // Dopo «Riaccendi» la voce mostra ancora il collaudo completo (resoconto, esito), con il relight a parte
    const itemNumber = secondItem!.number;
    const afterRelight = await api("GET", `/pending-actions/${itemNumber}`);
    expect(afterRelight.json.releaseTest).toMatchObject({ id: second.testId, status: "done", outcome: "ok", relight: { id: relight.testId, status: "done" } });
    expect((await api("GET", `/release-tests/${afterRelight.json.releaseTest.id}`)).json.report).toBe("Il pulsante Salva salva la nota.");

    // 4. Un «Riaccendi» con la ricetta che non parte: failed «ricetta di avvio non riuscita»; la voce resta sul collaudo completo
    await db.update(appsTable).set({ testRecipe: { ...recipe, install: ["false"] } }).where(eq(appsTable.id, appId));
    const relit2 = await api("POST", `/release-tests/${second.testId}/relight`);
    expect(relit2.status, relit2.text).toBe(202);
    const badRelight = await runDispatched(3, 3_000);
    expect(await badRelight.outcome).toBe("failed");
    expect(await testRow(badRelight.testId)).toMatchObject({ status: "failed", mode: "relight", error: "ricetta di avvio non riuscita", tokenHash: null });
    const afterBad = await api("GET", `/pending-actions/${itemNumber}`);
    expect(afterBad.json.releaseTest).toMatchObject({ id: second.testId, outcome: "ok", relight: { id: badRelight.testId, status: "failed", error: "ricetta di avvio non riuscita" } });
    expect(tunnels).toHaveLength(3);

    // Quattro lanci, mai il codice monouso nei log del runner
    expect(gh.dispatches).toHaveLength(4);
    const codes = gh.dispatches.map((d) => d.inputs["codice"]!);
    expect(runnerLog.join("\n")).not.toContain(codes[0]!);
    expect(runnerLog.join("\n")).not.toMatch(/ctk_[A-Za-z0-9_-]{8,}/);
    const open = await db
      .select()
      .from(releaseTestsTable)
      .where(and(eq(releaseTestsTable.appId, appId), eq(releaseTestsTable.status, "running")));
    expect(open).toHaveLength(0);
  }, 120_000);
});
