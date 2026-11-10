import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { fetchBranchSha } from "../src/lib/github/commit";

const REPO = "acme/app";
let fake: FakeGithub;

function token(permissions: Record<string, string>): string {
  const t = `ghs_${Math.random().toString(16).slice(2)}`;
  fake.issuedTokens.set(t, { installationId: 1, repositories: null, permissions, expiresAt: Date.now() + 60_000 });
  return t;
}

async function call(method: string, path: string, tok: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${fake.apiBase}/repos/${REPO}${path}`, {
    method,
    redirect: "manual",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  fake = await startFakeGithub();
  fake.addInstallation({ id: 1, appId: Number(fake.appId), accountLogin: "acme", accountType: "Organization", repositorySelection: "all" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
});
afterAll(async () => {
  await fake.close();
});

describe("finto GitHub: Git Data API", () => {
  it("seed, ref, blob, tree, commit, PATCH ref, zipball e commit dallo stato git", async () => {
    const seed = fake.seedRepo(REPO, "main", { "a.txt": "uno", "b.txt": "due" });
    const rw = token({ contents: "write", metadata: "read" });

    const branch = await (await call("POST", "/git/refs", rw, { ref: "refs/heads/work", sha: seed })).json();
    expect(branch).toEqual({ ref: "refs/heads/work", object: { sha: seed, type: "commit" } });

    const blob = (await (await call("POST", "/git/blobs", rw, { content: Buffer.from("tre").toString("base64"), encoding: "base64" })).json()) as { sha: string };
    const base = (await (await call("GET", `/git/commits/${seed}`, rw)).json()) as { tree: { sha: string }; parents: unknown[] };
    const tree = (await (
      await call("POST", "/git/trees", rw, {
        base_tree: base.tree.sha,
        tree: [
          { path: "c.txt", mode: "100644", type: "blob", sha: blob.sha },
          { path: "b.txt", mode: "100644", type: "blob", sha: null },
        ],
      })
    ).json()) as { sha: string };
    const commit = (await (await call("POST", "/git/commits", rw, { message: "m", tree: tree.sha, parents: [seed] })).json()) as { sha: string };
    const patched = await call("PATCH", "/git/refs/heads/work", rw, { sha: commit.sha, force: false });
    expect(patched.status).toBe(200);

    expect(fake.filesAt(REPO, "work")).toEqual({ "a.txt": "uno", "c.txt": "tre" });
    expect(fake.filesAt(REPO, "main")).toEqual({ "a.txt": "uno", "b.txt": "due" });

    // non fast-forward: tornare indietro senza force
    expect((await call("PATCH", "/git/refs/heads/work", rw, { sha: seed, force: false })).status).toBe(422);
    expect((await call("PATCH", "/git/refs/heads/work", rw, { sha: seed, force: true })).status).toBe(200);
    await call("PATCH", "/git/refs/heads/work", rw, { sha: commit.sha, force: true });

    const zip = Buffer.from(await (await call("GET", "/zipball/work", rw)).arrayBuffer());
    expect(zip.includes(`acme-app-${commit.sha.slice(0, 7)}/c.txt`)).toBe(true);
    expect(zip.includes("b.txt")).toBe(false);
    const byBranchSha = await fetchBranchSha({ apiBase: fake.apiBase, repo: REPO, branch: "work", token: rw });
    expect(byBranchSha).toBe(commit.sha);
    expect((await call("GET", `/zipball/${seed}`, rw)).status).toBe(200);
    expect((await call("GET", "/zipball/nope", rw)).status).toBe(404);
  });

  it("senza contents: write le scritture danno 403", async () => {
    const ro = token({ contents: "read" });
    expect((await call("POST", "/git/blobs", ro, { content: "x", encoding: "utf-8" })).status).toBe(403);
    expect((await call("GET", "", ro)).status).toBe(200);
    const none = token({ metadata: "read" });
    expect((await call("GET", "/git/refs", none)).status).toBe(403);
  });

  it("pull request draft: creata e trovata per head", async () => {
    const rw = token({ contents: "write", pull_requests: "write" });
    expect((await call("POST", "/pulls", token({ pull_requests: "read" }), { title: "t", head: "work", base: "main" })).status).toBe(403);
    const created = (await (await call("POST", "/pulls", rw, { title: "Lavoro", head: "work", base: "main", draft: true })).json()) as { number: number; draft: boolean; html_url: string };
    expect(created.draft).toBe(true);
    const list = (await (await call("GET", "/pulls?head=acme:work&state=open", rw)).json()) as { number: number; head: { ref: string } }[];
    expect(list.map((p) => p.number)).toEqual([created.number]);
    expect((await call("GET", `/pulls/${created.number}`, rw)).status).toBe(200);
    expect(((await (await call("GET", "/pulls?head=acme:altro", rw)).json()) as unknown[]).length).toBe(0);
  });

  it("check run, annotazioni, stati, log dei job e issue", async () => {
    const tok = token({ checks: "read", statuses: "read", actions: "read", issues: "read" });
    fake.checkRuns.set("abc", [{ id: 7, name: "ci", status: "completed", conclusion: "failure", jobId: 9, annotations: [{ path: "a.ts", start_line: 3, message: "boom" }] }]);
    fake.statuses.set("abc", [{ context: "lint", state: "success" }]);
    fake.jobLogs.set(9, "riga di log");
    fake.issues.set(REPO, [{ number: 1, title: "T", body: "B", labels: [], state: "open", stateReason: null, updatedAt: new Date().toISOString() }]);

    const runs = (await (await call("GET", "/commits/abc/check-runs", tok)).json()) as { total_count: number; check_runs: { id: number; details_url: string }[] };
    expect(runs.total_count).toBe(1);
    expect(runs.check_runs[0]!.details_url).toContain("/job/9");
    expect(await (await call("GET", "/check-runs/7/annotations", tok)).json()).toEqual([{ path: "a.ts", start_line: 3, message: "boom" }]);
    expect(await (await call("GET", "/commits/abc/status", tok)).json()).toMatchObject({ state: "success", statuses: [{ context: "lint", state: "success" }] });
    const logs = await call("GET", "/actions/jobs/9/logs", tok);
    expect(logs.status).toBe(302);
    expect(await (await fetch(logs.headers.get("location")!)).text()).toBe("riga di log");
    expect(await (await call("GET", "/issues/1", tok)).json()).toMatchObject({ number: 1, title: "T", state: "open" });
    expect((await call("GET", "/commits/abc/check-runs", token({ contents: "read" }))).status).toBe(403);
  });
});
