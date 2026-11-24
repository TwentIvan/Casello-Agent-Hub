import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  bugReportsTable,
  githubInstallationsTable,
  pendingActionsTable,
  runsTable,
  teamInstancesTable,
  teamTurnsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../src/lib/secrets";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "./fake-provider";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { clearInstallationTokenCache } from "../src/lib/github/app";
import { resetGithubConfigForTests } from "../src/lib/github/config";
import { generateIdentitySecret } from "../src/lib/bugs/identity";
import { BUG_MESSAGES } from "../src/lib/bugs/messages";
import { finalizeTriage } from "../src/lib/bugs/triage";
import { ESITO_VAGLIO } from "../src/lib/bugs/triage-tools";
import { scheduleRuns, setOnRunSettled, startRunQueue } from "../src/lib/run-queue";
import { approveAction } from "../src/lib/actions/decide";
import { upsertCodeTask } from "../src/lib/code-writer/code-tasks";
import { watchCodeTasksOnce } from "../src/lib/code-writer/watcher";
import { writePlanVersion } from "../src/lib/teams/plan";
import { resetBugLimits } from "../src/middlewares/rate-limit";

// Prova di flusso della segnalazione dei bug: app HTTP vera, coda delle run vera, finto provider (vaglio del Responsabile),
// finto GitHub (issue e PR), PGlite. Il capo si guida a mano: legge il turno `request` e scrive il compito con la issue.

const ORIGIN = "https://hub.example.com";
const SLUG = "hub-up";
const REPO = "ivan/hub-up";
const INST = 41;
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "EMBED_ALLOWED_ORIGINS", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(43);
const TRUNCATE = "TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE";

let gh: FakeGithub;
let fake: FakeProvider;
let script: FakeChatReply[];
let restoreLoopback: () => void;
let stopQueue: () => void;
let server: http.Server;
let base: string;
let secret: string;

const call = (name: string, args: Record<string, unknown>, id = `c_${name}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

function jwt(sub: string, now = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: SLUG, aud: "botcave", sub, name: "Ana", iat: now, exp: now + 300 });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, o: { key?: string; identity?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const q = new URLSearchParams({ app: SLUG, origin: ORIGIN });
  const headers: Record<string, string> = { "content-type": "application/json", "x-botcave-browser-key": o.key ?? KEY_A };
  if (o.identity) headers["x-botcave-identity"] = o.identity;
  const res = await fetch(`${base}/api${path}?${q}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : undefined };
}

async function waitFor(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout nell'attesa");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function drain(): Promise<void> {
  await waitFor(async () => {
    await scheduleRuns();
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(runsTable).where(inArray(runsTable.status, ["pending", "running"]));
    return Number(row?.n ?? 0) === 0;
  });
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  restoreLoopback = allowTestLoopback();
  gh = await startFakeGithub();
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    EMBED_ALLOWED_ORIGINS: ORIGIN,
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  resetGithubConfigForTests();
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setOnRunSettled(finalizeTriage);
  stopQueue = startRunQueue();
});

afterAll(async () => {
  stopQueue();
  restoreLoopback();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  await pool.query(TRUNCATE);
});

describe("flusso: segnalazione di un bug dal plugin", () => {
  let ownerId: number;
  let appId: number;
  let teamId: number;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    script = [];
    fake = await startFakeProvider({ chatReply: () => script.shift() ?? { content: "Fatto.", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
    clearInstallationTokenCache();
    gh.requests.length = 0;
    gh.failWith = null;
    gh.installations.clear();
    gh.repos.clear();
    gh.git.clear();
    gh.pulls.clear();
    gh.checkRuns.clear();
    gh.statuses.clear();
    gh.issues.clear();
    gh.labels.clear();
    gh.installationPermissions.clear();
    gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
      { fullName: REPO, defaultBranch: "main", private: true },
    ]);
    gh.installationPermissions.set(INST, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" });
    gh.seedRepo(REPO, "main", { "README.md": "# Hub\n" });
    resetBugLimits();

    await pool.query(TRUNCATE);
    const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
    ownerId = u!.id;
    await db.insert(githubInstallationsTable).values({ userId: ownerId, installationId: INST, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" });
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId: ownerId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
      .returning();
    const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" }).returning();
    secret = generateIdentitySecret();
    const [app] = await db
      .insert(appsTable)
      .values({
        name: "The Hub Up",
        slug: SLUG,
        baseUrl: ORIGIN,
        sourceType: "github",
        sourceRepo: REPO,
        sourceInstallationId: INST,
        bugReportsEnabled: true,
        identitySecretEnc: encryptSecret(secret),
      })
      .returning();
    appId = app!.id;
    await db.insert(agentsTable).values({ appId, name: "Responsabile", role: "general", status: "active", aiModelId: model!.id });
    const [team] = await db
      .insert(teamInstancesTable)
      .values({
        name: "Squadra bug",
        refAppId: appId,
        refType: "bug",
        refId: SLUG,
        refTitle: "Bug di The Hub Up",
        status: "active",
        roles: [],
        createdBy: ownerId,
        activatedBy: ownerId,
        bugTeam: true,
      })
      .returning();
    teamId = team!.id;
  });

  afterEach(async () => {
    await drain();
    vi.restoreAllMocks();
    await fake.close();
  });

  const reload = async (id: number) => (await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, id)))[0]!;
  const settled = async (id: number, status: string) => {
    await waitFor(async () => (await reload(id)).status === status);
    await drain();
    return reload(id);
  };

  it("segnalazione con identità → domanda → risposta → bug → approvazione → issue e turno del capo → PR unita → corretta", async () => {
    const identity = jwt("utente-77");

    // 1. Segnalazione con identità; il vaglio chiede un dettaglio
    script = [call(ESITO_VAGLIO, { esito: "dettagli", sintesi: "Mancano i passi", domanda: "Quale intervallo di date usi?", messaggio_utente: "Ci serve un dettaglio" })];
    const created = await api("POST", "/embed/bugs", { identity, body: { title: "Il filtro per data non funziona", description: "Filtro per data senza risultati" } });
    expect(created.status).toBe(201);
    const id: number = created.json.id;
    const waiting = await settled(id, "needs_info");
    expect(waiting.reporterKind).toBe("identity");

    // 2. La domanda è visibile da un'altra chiave del browser con lo stesso sub; chi non ha l'identità non la vede
    const other = await api("GET", `/embed/bugs/${id}`, { key: KEY_B, identity });
    expect(other.status).toBe(200);
    expect(other.json.messages.map((m: { author: string; content: string }) => [m.author, m.content])).toEqual([["lead", "Quale intervallo di date usi?"]]);
    expect((await api("GET", `/embed/bugs/${id}`, { key: KEY_B })).status).toBe(404);

    // 3. Risposta dell'utente: nuovo vaglio con esito bug → pending_approval e voce «Bug»
    script = [call(ESITO_VAGLIO, { esito: "bug", sintesi: "Il filtro ignora l'intervallo", messaggio_utente: "Grazie, lo correggiamo" })];
    const answered = await api("POST", `/embed/bugs/${id}/messages`, { key: KEY_B, identity, body: { content: "Dal 1 al 15 novembre" } });
    expect(answered.status).toBe(200);
    await settled(id, "pending_approval");
    // La voce si crea subito dopo il cambio di stato (due passi): si aspetta il collegamento
    await waitFor(async () => (await reload(id)).pendingActionId !== null);
    const pending = await reload(id);
    expect(pending.triage).toMatchObject({ verdict: "bug", summary: "Il filtro ignora l'intervallo" });
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, pending.pendingActionId!));
    expect(item).toMatchObject({ kind: "bug", userId: ownerId, status: "pending", appId });

    // 4. L'amministratore approva: issue su GitHub e turno `request` del capo con il numero
    const approved = await approveAction(ownerId, item!.number);
    expect(approved.ok).toBe(true);
    const inProgress = await reload(id);
    expect(inProgress).toMatchObject({ status: "in_progress", teamInstanceId: teamId });
    expect(inProgress.issueNumber).toBeTruthy();
    const issue = gh.issues.get(REPO)!.find((i) => i.number === inProgress.issueNumber)!;
    expect(issue.labels).toEqual(expect.arrayContaining(["bug", "botcave"]));
    expect(issue.body).not.toContain("utente-77");
    const turnReasons = (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, teamId))).flatMap((t) => t.reasons);
    expect(turnReasons).toHaveLength(1);
    expect(turnReasons[0]).toMatchObject({ type: "request", source: "system" });
    expect((turnReasons[0] as { text: string }).text).toContain(`#${inProgress.issueNumber}`);

    // 5. Il capo crea il compito con la issue; la squadra apre una PR (riga di sorveglianza)
    await writePlanVersion(
      teamId,
      {
        objective: "Correggere il filtro",
        constraints: [],
        openPoints: [],
        manualActions: [],
        tasks: [{ id: "t1", title: "Filtro per data", roleKey: "dev", instructions: "Correggi il filtro", status: "done", outcome: "PR aperta", issue: inProgress.issueNumber! }],
      },
      "approved",
    );
    const head = gh.seedRepo(REPO, `botcave/${teamId}-t1`, { "README.md": "# Hub\n", "fix.txt": "ok" });
    gh.pulls.set(REPO, [{ number: 5, head: `botcave/${teamId}-t1`, base: "main", title: "Filtro", body: `Closes #${inProgress.issueNumber}`, draft: false, state: "open", merged: false, headSha: head }]);
    await upsertCodeTask({
      instanceId: teamId,
      planTaskId: "t1",
      repo: REPO,
      branch: `botcave/${teamId}-t1`,
      baseBranch: "main",
      headSha: head,
      pr: { number: 5, url: `https://github.com/${REPO}/pull/5` },
    } as Parameters<typeof upsertCodeTask>[0]);

    // PR ancora aperta: nessuna chiusura
    gh.checkRuns.set(head, [{ id: 1, name: "test", status: "completed", conclusion: "success", annotations: [] }]);
    const t0 = Date.now();
    await watchCodeTasksOnce(new Date(t0 + 60_000));
    expect((await reload(id)).status).toBe("in_progress");

    // 6. PR unita: la segnalazione diventa corretta, con la frase fissa e il link alla PR
    gh.pulls.get(REPO)![0]!.state = "closed";
    gh.pulls.get(REPO)![0]!.merged = true;
    await watchCodeTasksOnce(new Date(t0 + 120_000));
    const fixed = await reload(id);
    expect(fixed).toMatchObject({ status: "fixed", publicMessage: BUG_MESSAGES.fixedMessage, prUrl: `https://github.com/${REPO}/pull/5` });

    // 7. Contatore del visitatore: da un altro dispositivo, non visto → visto
    const list = await api("GET", "/embed/bugs", { key: KEY_B, identity });
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id, status: "fixed", unseen: true });
    expect((await api("POST", "/embed/bugs/seen", { key: KEY_B, identity, body: { ids: [id] } })).json).toEqual({ updated: 1 });
    expect((await api("GET", "/embed/bugs", { key: KEY_B, identity })).json[0].unseen).toBe(false);
  });
});
