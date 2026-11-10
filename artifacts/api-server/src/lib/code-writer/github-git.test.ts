import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { loadGithubConfig, type GithubConfig } from "../github/config";
import {
  commitFiles,
  createDraftPull,
  failedJobLogTail,
  findOpenPull,
  getBranchHead,
  getCommitTree,
  getDefaultBranch,
  getIssue,
  getPull,
  readCi,
  setLogHostsForTests,
  type RepoRef,
} from "./github-git";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "./messages";

const REPO = "ivan/mister";
const INST = 7;
const ALL = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" };

let gh: FakeGithub;
let cfg: GithubConfig;
let r: RepoRef;
let base: string;

async function rejects(p: Promise<unknown>): Promise<CodeWriteError> {
  const err = await p.then(
    () => {
      throw new Error("doveva fallire");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CodeWriteError);
  return err as CodeWriteError;
}

beforeAll(async () => {
  gh = await startFakeGithub();
  cfg = loadGithubConfig({
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  })!;
  r = { cfg, installationId: INST, repo: REPO };
});

afterAll(async () => {
  setLogHostsForTests(null);
  await gh.close();
});

beforeEach(() => {
  clearInstallationTokenCache();
  gh.requests.length = 0;
  gh.installations.clear();
  gh.repos.clear();
  gh.git.clear();
  gh.pulls.clear();
  gh.checkRuns.clear();
  gh.statuses.clear();
  gh.jobLogs.clear();
  gh.issues.clear();
  gh.installationPermissions.clear();
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, ALL);
  base = gh.seedRepo(REPO, "main", { "a.txt": "uno", "src/b.txt": "due", "c.txt": "tre" });
});

describe("client GitHub dei compiti", () => {
  it("commitFiles crea il branch e scrive file nuovi, modificati ed eliminati", async () => {
    expect(await getDefaultBranch(r)).toBe("main");
    expect(await getBranchHead(r, "main")).toBe(base);
    expect(await getBranchHead(r, "botcave/1-t1")).toBeNull();
    const tree = await getCommitTree(r, base);
    const { sha } = await commitFiles(r, {
      branch: "botcave/1-t1",
      parentSha: base,
      baseTreeSha: tree,
      changes: new Map<string, string | null>([["a.txt", "UNO"], ["nuovo/d.txt", "quattro"], ["c.txt", null]]),
      message: "prova",
      createBranch: true,
    });
    expect(await getBranchHead(r, "botcave/1-t1")).toBe(sha);
    expect(gh.filesAt(REPO, "botcave/1-t1")).toEqual({ "a.txt": "UNO", "src/b.txt": "due", "nuovo/d.txt": "quattro" });
    // secondo commit sul branch esistente
    const second = await commitFiles(r, {
      branch: "botcave/1-t1",
      parentSha: sha,
      baseTreeSha: await getCommitTree(r, sha),
      changes: new Map([["a.txt", "due"]]),
      message: "bis",
      createBranch: false,
    });
    expect(gh.filesAt(REPO, second.sha)["a.txt"]).toBe("due");
  });

  it("blob UTF-8 non ASCII", async () => {
    await commitFiles(r, {
      branch: "botcave/1-t2",
      parentSha: base,
      baseTreeSha: await getCommitTree(r, base),
      changes: new Map([["u.txt", "è ✓ 🚀"]]),
      message: "m",
      createBranch: true,
    });
    expect(gh.filesAt(REPO, "botcave/1-t2")["u.txt"]).toBe("è ✓ 🚀");
  });

  it("branch avanzato → branchMoved", async () => {
    const tree = await getCommitTree(r, base);
    const first = await commitFiles(r, { branch: "botcave/1-t3", parentSha: base, baseTreeSha: tree, changes: new Map([["x", "1"]]), message: "m", createBranch: true });
    // il branch esiste già: createBranch → 422
    expect((await rejects(commitFiles(r, { branch: "botcave/1-t3", parentSha: base, baseTreeSha: tree, changes: new Map([["y", "1"]]), message: "m", createBranch: true }))).message).toBe(
      CODE_WRITE_MESSAGES.branchMoved,
    );
    // un push a mano porta il branch avanti; un commit da un padre vecchio non è un fast-forward
    const hand = gh.git.get(REPO)!;
    expect(hand.refs.get("heads/botcave/1-t3")).toBe(first.sha);
    await commitFiles(r, { branch: "botcave/1-t3", parentSha: first.sha, baseTreeSha: await getCommitTree(r, first.sha), changes: new Map([["z", "1"]]), message: "m", createBranch: false });
    const err = await rejects(commitFiles(r, { branch: "botcave/1-t3", parentSha: base, baseTreeSha: tree, changes: new Map([["w", "1"]]), message: "m", createBranch: false }));
    expect(err.message).toBe(CODE_WRITE_MESSAGES.branchMoved);
  });

  it("rifiuta un branch fuori da botcave/ senza chiamare GitHub", async () => {
    gh.requests.length = 0;
    await expect(
      commitFiles(r, { branch: "main", parentSha: base, baseTreeSha: "x", changes: new Map([["a", "b"]]), message: "m", createBranch: false }),
    ).rejects.toThrow(/botcave\//);
    await expect(createDraftPull(r, { head: "main", base: "main", title: "t", body: "" })).rejects.toThrow(/botcave\//);
    expect(gh.requests).toHaveLength(0);
  });

  it("permesso mancante → permission('contents: write')", async () => {
    gh.installationPermissions.set(INST, { contents: "read", metadata: "read" });
    const err = await rejects(
      commitFiles(r, { branch: "botcave/1-t4", parentSha: base, baseTreeSha: await getCommitTree(r, base), changes: new Map([["a", "b"]]), message: "m", createBranch: true }),
    );
    expect(err.message).toBe(CODE_WRITE_MESSAGES.permission("contents: write"));
  });

  it("findOpenPull per head, createDraftPull e getPull", async () => {
    await commitFiles(r, { branch: "botcave/1-t5", parentSha: base, baseTreeSha: await getCommitTree(r, base), changes: new Map([["a", "b"]]), message: "m", createBranch: true });
    expect(await findOpenPull(r, "botcave/1-t5")).toBeNull();
    const pr = await createDraftPull(r, { head: "botcave/1-t5", base: "main", title: "Titolo", body: "Corpo" });
    expect(pr.url).toBe(`https://github.com/${REPO}/pull/${pr.number}`);
    expect(gh.pulls.get(REPO)![0]).toMatchObject({ draft: true, head: "botcave/1-t5", base: "main" });
    expect(await findOpenPull(r, "botcave/1-t5")).toEqual(pr);
    expect(await findOpenPull(r, "botcave/altro")).toBeNull();
    expect(await getPull(r, pr.number)).toEqual({ state: "open", headSha: pr.headSha, url: pr.url });
    gh.pulls.get(REPO)![0]!.state = "closed";
    gh.pulls.get(REPO)![0]!.merged = true;
    expect((await getPull(r, pr.number)).state).toBe("merged");
  });

  it("getIssue legge titolo, etichette e corpo", async () => {
    gh.issues.set(REPO, [{ number: 9, title: "T", body: "B", labels: ["casello"], state: "open", stateReason: null, updatedAt: "2026-11-01T00:00:00Z" }]);
    expect(await getIssue(r, 9)).toEqual({ title: "T", state: "open", labels: ["casello"], body: "B" });
  });

  it("readCi riporta check e stati", async () => {
    gh.checkRuns.set(base, [
      { id: 1, name: "build", status: "completed", conclusion: "failure", annotations: [], jobId: 55 },
      { id: 2, name: "lint", status: "in_progress", conclusion: null, annotations: [] },
    ]);
    gh.statuses.set(base, [{ context: "ci/x", state: "success" }]);
    const ci = await readCi(r, base);
    expect(ci.checks).toEqual([
      { id: 1, name: "build", status: "completed", conclusion: "failure", jobId: 55 },
      { id: 2, name: "lint", status: "in_progress", conclusion: null, jobId: null },
    ]);
    expect(ci.statuses).toEqual([{ context: "ci/x", state: "success" }]);
  });

  it("log: segue un redirect verso host ammesso, rifiuta gli altri, taglia a 150 righe", async () => {
    gh.jobLogs.set(55, Array.from({ length: 300 }, (_, i) => `riga ${i + 1}`).join("\n") + "\n");
    // host del finto non ammesso di default (http, 127.0.0.1)
    setLogHostsForTests(null);
    expect((await rejects(failedJobLogTail(r, 55))).message).toBe(CODE_WRITE_MESSAGES.unavailable);
    setLogHostsForTests([new URL(gh.apiBase).host]);
    gh.requests.length = 0;
    const tail = await failedJobLogTail(r, 55);
    const lines = tail.split("\n");
    expect(lines).toHaveLength(150);
    expect(lines[0]).toBe("riga 151");
    expect(lines[149]).toBe("riga 300");
    const logReq = gh.requests.find((q) => q.path.startsWith("/_logs/"))!;
    expect(logReq.auth).toBeUndefined();
    setLogHostsForTests(null);
  });
});
