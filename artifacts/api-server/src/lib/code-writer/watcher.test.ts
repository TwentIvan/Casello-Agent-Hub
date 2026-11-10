import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, pool, teamCodeTasksTable, teamEventsTable, teamInstancesTable, teamTurnsTable, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { resetGithubConfigForTests } from "../github/config";
import { getPlan, writePlanVersion } from "../teams/plan";
import { watchCodeTasksOnce } from "./watcher";

// Sorveglianza della CI: PGlite + finto GitHub, configurazione GitHub dall'ambiente

const REPO = "ivan/mister";
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
const T0 = new Date("2026-11-10T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

let gh: FakeGithub;
let instanceId: number;
let codeId: number;

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
  resetGithubConfigForTests();
});

afterAll(async () => {
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  clearInstallationTokenCache();
  gh.pulls.clear();
  gh.checkRuns.clear();
  gh.statuses.clear();
  gh.installations.clear();
  gh.repos.clear();
  gh.installationPermissions.clear();
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(7, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" });
  gh.pulls.set(REPO, [{ number: 5, head: "botcave/1-t1", base: "main", title: "t", body: "", draft: true, state: "open", merged: false, headSha: SHA1 }]);

  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Ivan" }).returning();
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7 })
    .returning();
  const [inst] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "WI 1", status: "active", roles: [], createdBy: u!.id, activatedBy: u!.id })
    .returning();
  instanceId = inst!.id;
  await writePlanVersion(
    instanceId,
    { objective: "o", constraints: [], openPoints: [], manualActions: [], tasks: [{ id: "t1", title: "T", roleKey: "dev", instructions: "", status: "done", outcome: "ok" }] },
    "approved",
  );
  const [code] = await db
    .insert(teamCodeTasksTable)
    .values({ instanceId, planTaskId: "t1", repo: REPO, branch: "botcave/1-t1", baseBranch: "main", headSha: SHA1, prNumber: 5, prUrl: "u", prState: "open", ciState: "pending", lastCommitAt: T0 })
    .returning();
  codeId = code!.id;
});

const run = (name: string, status = "completed", conclusion: string | null = "success", sha = SHA1) => {
  const list = gh.checkRuns.get(sha) ?? [];
  list.push({ id: list.length + 1, name, status, conclusion, annotations: [] });
  gh.checkRuns.set(sha, list);
};
const events = async () => (await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId))).sort((a, b) => a.id - b.id);
const reasons = async () => (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId))).flatMap((t) => t.reasons);
const row = async () => (await db.select().from(teamCodeTasksTable).where(eq(teamCodeTasksTable.id, codeId)))[0]!;

describe("sorveglianza della CI", () => {
  it("CI rossa: compito blocked nel PLAN, evento e turno ci_finished una volta sola", async () => {
    run("build");
    run("test", "completed", "failure");
    await watchCodeTasksOnce(at(60_000));
    await watchCodeTasksOnce(at(120_000));
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "bloccato", bulletin: "Compito t1: CI non superata sulla PR #5", detail: "CI non superata: test" });
    expect(await reasons()).toEqual([{ type: "ci_finished", taskCodeId: codeId, outcome: "failure" }]);
    const plan = await getPlan(instanceId);
    expect(plan.tasks[0]).toMatchObject({ status: "blocked", outcome: "CI non superata: test" });
    expect(await row()).toMatchObject({ ciState: "failure", ciSummary: "CI non superata: test", ciNotifiedSha: SHA1 });
  });

  it("CI verde", async () => {
    run("build");
    await watchCodeTasksOnce(at(60_000));
    await watchCodeTasksOnce(at(120_000));
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "compito_finito", bulletin: "Compito t1: CI verde, PR #5 pronta per la revisione" });
    expect(await reasons()).toEqual([{ type: "ci_finished", taskCodeId: codeId, outcome: "success" }]);
    expect(await row()).toMatchObject({ ciState: "success", ciSummary: "CI verde" });
  });

  it("nessuna CI", async () => {
    await watchCodeTasksOnce(at(5 * 60_000));
    expect(await events()).toHaveLength(0);
    await watchCodeTasksOnce(at(11 * 60_000));
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "compito_finito", bulletin: "Compito t1: nessuna CI configurata, PR #5 pronta per la revisione" });
    expect(await reasons()).toEqual([{ type: "ci_finished", taskCodeId: codeId, outcome: "none" }]);
  });

  it("pending da 2 ore: evento una volta", async () => {
    run("build", "in_progress", null);
    await watchCodeTasksOnce(at(3_600_000));
    expect(await events()).toHaveLength(0);
    await watchCodeTasksOnce(at(2 * 3_600_000 + 1000));
    await watchCodeTasksOnce(at(3 * 3_600_000));
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "bloccato", bulletin: "CI della PR #5 non conclusa da 2 ore" });
    expect(await reasons()).toEqual([]);
  });

  it("PR unita: pr_closed merged e nessuna sorveglianza dopo", async () => {
    gh.pulls.get(REPO)![0]!.state = "closed";
    gh.pulls.get(REPO)![0]!.merged = true;
    await watchCodeTasksOnce(at(60_000));
    await watchCodeTasksOnce(at(120_000));
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "compito_finito", bulletin: "Compito t1: PR #5 unita" });
    expect(await reasons()).toEqual([{ type: "pr_closed", taskCodeId: codeId, merged: true }]);
    expect((await row()).prState).toBe("merged");
  });

  it("PR chiusa senza merge", async () => {
    gh.pulls.get(REPO)![0]!.state = "closed";
    await watchCodeTasksOnce(at(60_000));
    expect((await events())[0]).toMatchObject({ type: "bloccato", bulletin: "Compito t1: PR #5 chiusa senza merge" });
    expect(await reasons()).toEqual([{ type: "pr_closed", taskCodeId: codeId, merged: false }]);
  });

  it("nuovo commit dopo la CI rossa riapre la notifica", async () => {
    run("test", "completed", "failure");
    await watchCodeTasksOnce(at(60_000));
    gh.pulls.get(REPO)![0]!.headSha = SHA2;
    run("test", "completed", "success", SHA2);
    await watchCodeTasksOnce(at(120_000));
    const ev = await events();
    expect(ev.map((e) => e.bulletin)).toEqual(["Compito t1: CI non superata sulla PR #5", "Compito t1: CI verde, PR #5 pronta per la revisione"]);
    const r = await row();
    expect(r).toMatchObject({ headSha: SHA2, ciNotifiedSha: SHA2, ciState: "success" });
    expect(r.lastCommitAt!.getTime()).toBe(at(120_000).getTime());
  });

  it("squadra chiusa: riga ignorata", async () => {
    await db.update(teamInstancesTable).set({ status: "closed" }).where(eq(teamInstancesTable.id, instanceId));
    run("build");
    await watchCodeTasksOnce(at(60_000));
    expect(await events()).toHaveLength(0);
    expect((await row()).ciCheckedAt).toBeNull();
  });
});
