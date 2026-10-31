import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache, installationToken } from "./app";
import { loadGithubConfig, type GithubConfig } from "./config";
import { createIssue, ensureLabels, ISSUE_MESSAGES, IssueError, issuesToken, listCaselloIssues } from "./issues";

const REPO = "ivan/mister";
const INST = 7;

let gh: FakeGithub;
let cfg: GithubConfig;

async function expectIssueError(p: Promise<unknown>, message: string, scope: "batch" | "item"): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("doveva fallire");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IssueError);
  expect((err as IssueError).message).toBe(message);
  expect((err as IssueError).scope).toBe(scope);
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
});

afterAll(async () => {
  await gh.close();
});

beforeEach(() => {
  clearInstallationTokenCache();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.failHeaders = {};
  gh.installations.clear();
  gh.repos.clear();
  gh.installationPermissions.clear();
  gh.issues.clear();
  gh.labels.clear();
  gh.issuesDisabled.clear();
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
});

describe("client delle issue", () => {
  it("crea un'issue con etichette e restituisce numero e url", async () => {
    const token = await issuesToken(cfg, INST, REPO);
    expect(gh.issuedTokens.get(token)).toMatchObject({ repositories: [REPO], permissions: { issues: "write" } });
    await ensureLabels(cfg, token, REPO, ["casello", "casello:endpoint"]);
    const created = await createIssue(cfg, token, REPO, { title: "Aggiungere /export", body: "Dettagli", labels: ["casello", "casello:endpoint"] });
    expect(created.number).toBe(1);
    expect(created.url).toBe(`https://github.com/${REPO}/issues/1`);
    const stored = gh.issues.get(REPO)!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title: "Aggiungere /export", body: "Dettagli", labels: ["casello", "casello:endpoint"], state: "open" });
    expect([...gh.labels.get(REPO)!]).toEqual(["casello", "casello:endpoint"]);
    const labelPosts = gh.requests.filter((r) => r.method === "POST" && r.path === `/repos/${REPO}/labels`);
    expect(labelPosts.map((r) => r.body)).toEqual([
      { name: "casello", color: "ededed" },
      { name: "casello:endpoint", color: "ededed" },
    ]);
  });

  it("etichetta già esistente non è un errore", async () => {
    gh.labels.set(REPO, new Set(["casello"]));
    const token = await issuesToken(cfg, INST, REPO);
    await expect(ensureLabels(cfg, token, REPO, ["casello"])).resolves.toBeUndefined();
    expect(gh.requests.some((r) => r.path === `/repos/${REPO}/labels`)).toBe(true);
  });

  it("token senza permesso issues → IssueError batch con il messaggio del permesso", async () => {
    gh.installationPermissions.set(INST, { contents: "read", metadata: "read" });
    await expectIssueError(issuesToken(cfg, INST, REPO), ISSUE_MESSAGES.permission, "batch");
  });

  it("issue disattivate → disabled batch", async () => {
    gh.issuesDisabled.add(REPO);
    const token = await issuesToken(cfg, INST, REPO);
    await expectIssueError(createIssue(cfg, token, REPO, { title: "t", body: "b", labels: [] }), ISSUE_MESSAGES.disabled, "batch");
    await expectIssueError(listCaselloIssues(cfg, token, REPO, null), ISSUE_MESSAGES.disabled, "batch");
  });

  it("rate limit (failWith 429) → rateLimited batch", async () => {
    const token = await issuesToken(cfg, INST, REPO);
    gh.failWith = () => 429;
    await expectIssueError(createIssue(cfg, token, REPO, { title: "t", body: "b", labels: [] }), ISSUE_MESSAGES.rateLimited, "batch");
    await expectIssueError(ensureLabels(cfg, token, REPO, ["casello"]), ISSUE_MESSAGES.rateLimited, "batch");
    gh.failWith = () => 403;
    gh.failHeaders = { "x-ratelimit-remaining": "0" };
    await expectIssueError(listCaselloIssues(cfg, token, REPO, null), ISSUE_MESSAGES.rateLimited, "batch");
    clearInstallationTokenCache();
    await expectIssueError(issuesToken(cfg, INST, REPO), ISSUE_MESSAGES.rateLimited, "batch");
  });

  it("500 su una creazione → unavailable item", async () => {
    const token = await issuesToken(cfg, INST, REPO);
    gh.failWith = () => 500;
    await expectIssueError(createIssue(cfg, token, REPO, { title: "t", body: "b", labels: [] }), ISSUE_MESSAGES.unavailable, "item");
    clearInstallationTokenCache();
    await expectIssueError(issuesToken(cfg, INST, REPO), ISSUE_MESSAGES.unavailable, "batch");
  });

  it("titolo rifiutato (422) → rejected item; repo fuori dal token → permission batch", async () => {
    const token = await issuesToken(cfg, INST, REPO);
    await expectIssueError(createIssue(cfg, token, REPO, { title: "", body: "b", labels: [] }), ISSUE_MESSAGES.rejected, "item");
    gh.repos.get(INST)!.push({ fullName: "ivan/altro", defaultBranch: "main", private: true });
    await expectIssueError(createIssue(cfg, token, "ivan/altro", { title: "t", body: "b", labels: [] }), ISSUE_MESSAGES.permission, "batch");
    await expectIssueError(createIssue(cfg, token, "ivan/sparito", { title: "t", body: "b", labels: [] }), ISSUE_MESSAGES.notFound, "batch");
  });

  it("lista: stato e state_reason, paginazione su 150 issue, since passato in query", async () => {
    const list = [];
    for (let n = 1; n <= 150; n++) {
      list.push({
        number: n,
        title: `issue ${n}`,
        body: "",
        labels: n === 150 ? ["altro"] : ["casello"],
        state: (n % 2 === 0 ? "closed" : "open") as "open" | "closed",
        stateReason: n % 2 === 0 ? (n === 4 ? "not_planned" : "completed") : null,
        updatedAt: n <= 10 ? "2026-10-01T00:00:00Z" : "2026-10-29T00:00:00Z",
      });
    }
    gh.issues.set(REPO, list);
    const token = await issuesToken(cfg, INST, REPO);

    const all = await listCaselloIssues(cfg, token, REPO, null);
    expect(all.size).toBe(149);
    expect(all.get(1)).toEqual({ state: "open", stateReason: null });
    expect(all.get(2)).toEqual({ state: "closed", stateReason: "completed" });
    expect(all.get(4)).toEqual({ state: "closed", stateReason: "not_planned" });
    expect(all.has(150)).toBe(false);
    const pages = gh.requests.filter((r) => r.method === "GET" && r.path.startsWith(`/repos/${REPO}/issues`));
    expect(pages.map((r) => r.path)).toEqual([
      `/repos/${REPO}/issues?state=all&labels=casello&per_page=100&page=1`,
      `/repos/${REPO}/issues?state=all&labels=casello&per_page=100&page=2`,
    ]);

    gh.requests.length = 0;
    const since = new Date("2026-10-15T00:00:00Z");
    const recent = await listCaselloIssues(cfg, token, REPO, since);
    expect(recent.size).toBe(139);
    expect(recent.has(10)).toBe(false);
    const sincePaths = gh.requests.filter((r) => r.method === "GET" && r.path.startsWith(`/repos/${REPO}/issues`)).map((r) => r.path);
    expect(sincePaths[0]).toBe(`/repos/${REPO}/issues?state=all&labels=casello&per_page=100&page=1&since=${encodeURIComponent(since.toISOString())}`);
  });

  it("il token di lettura resta contents: read", async () => {
    const t = await installationToken(cfg, INST, { repo: REPO });
    expect(gh.issuedTokens.get(t)!.permissions).toEqual({ contents: "read" });
    // Il token delle issue è distinto: chiave di cache diversa
    const w = await issuesToken(cfg, INST, REPO);
    expect(w).not.toBe(t);
    expect(gh.issuedTokens.get(w)!.permissions).toEqual({ issues: "write" });
  });
});
