import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, pool } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { createNode } from "../nodes/nodes";
import { claimTask, heartbeat, reportTask } from "../nodes/protocol";
import { startTask } from "../teams/task-runner";
import { getCodeTask } from "./code-tasks";
import { nodeGitSection } from "./node-git";

// Compiti node con codice: sezione Git nel pacchetto e PR adottata al report `done` (PGlite + finto GitHub)

const REPO = "ivan/mister";
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
let gh: FakeGithub;
let userId: number;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
});

afterAll(async () => {
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  clearInstallationTokenCache();
  gh.pulls.clear();
  gh.installationPermissions.clear();
  gh.requests.length = 0;
  userId = await ensureUser("dev@localhost");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(7, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" });
  gh.seedRepo(REPO, "main", { "a.txt": "uno" });
});

async function setup(opts: { withRepo?: boolean; code?: "none" | "write"; sourceBranch?: string | null } = {}) {
  const role = nodeRole({ skills: [{ code: "sap-abap", version: 1 }], code: opts.code ?? "write" });
  const instanceId = await seedNodeTeam({ userId, roles: [role] });
  if (opts.withRepo !== false) {
    await db
      .update(appsTable)
      .set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7, sourceBranch: opts.sourceBranch ?? null })
      .where(eq(appsTable.slug, "hub-up"));
  }
  const started = await startTask(instanceId, "t1");
  const { node } = await createNode(userId, "Mac");
  await heartbeat(node.id, { version: "0.1.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1 });
  const pkg = (await claimTask(node.id))!;
  return { instanceId, nodeId: node.id, taskId: started.id, pkg };
}

describe("nodeGitSection", () => {
  it("repository, branch, issue e comando gh", () => {
    const s = nodeGitSection({ repo: REPO, baseBranch: "main", branch: "botcave/3-t1", issue: 12 });
    expect(s).toContain("Repository: ivan/mister");
    expect(s).toContain("Issue: #12");
    expect(s).toContain("gh pr create --draft --base main --head botcave/3-t1");
    expect(s).toContain("Non fare merge");
  });
  it("senza base: branch predefinito", () => {
    const s = nodeGitSection({ repo: REPO, baseBranch: null, branch: "botcave/3-t1", issue: null });
    expect(s).toContain("il branch predefinito");
    expect(s).not.toContain("Issue:");
  });
});

describe("pacchetto del claim", () => {
  it("ruolo code write: sezione Git con branch e gh pr create --draft", async () => {
    const { instanceId, pkg } = await setup();
    expect(pkg.task.instructions.startsWith("Istruzioni di t1")).toBe(true);
    expect(pkg.task.instructions).toContain(`botcave/${instanceId}-t1`);
    expect(pkg.task.instructions).toContain("gh pr create --draft --base main");
  });
  it("senza code write o senza repository: istruzioni invariate", async () => {
    expect((await setup({ code: "none" })).pkg.task.instructions).toBe("Istruzioni di t1");
    await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
    userId = await ensureUser("dev@localhost");
    expect((await setup({ withRepo: false })).pkg.task.instructions).toBe("Istruzioni di t1");
  });
});

describe("report done", () => {
  const report = (nodeId: number, taskId: number, pkg: { leaseToken: string }, status: "done" | "failed" = "done") =>
    reportTask(nodeId, taskId, { leaseToken: pkg.leaseToken, status, outcome: "fatto" });

  it("con una PR aperta sul branch crea la riga da sorvegliare", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const branch = `botcave/${instanceId}-t1`;
    const head = gh.seedRepo(REPO, branch, { "a.txt": "due" });
    gh.pulls.set(REPO, [{ number: 5, head: branch, base: "main", title: "t", body: "", draft: true, state: "open", merged: false, headSha: head }]);
    await report(nodeId, taskId, pkg);
    const row = await getCodeTask(instanceId, "t1");
    expect(row).toMatchObject({ prNumber: 5, prState: "open", ciState: "pending", branch, baseBranch: "main", headSha: head, repo: REPO });
    expect(row!.lastCommitAt).not.toBeNull();
  });

  it("senza PR nessuna riga; un report failed non cerca la PR", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup();
    await report(nodeId, taskId, pkg);
    expect(await getCodeTask(instanceId, "t1")).toBeNull();
  });

  it("errore di GitHub: il report riesce comunque", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup();
    gh.failWith = () => 500;
    await report(nodeId, taskId, pkg);
    expect(await getCodeTask(instanceId, "t1")).toBeNull();
    gh.failWith = null;
  });
});
