import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { resetGithubConfigForTests } from "../github/config";
import { commitFiles } from "../code-writer/github-git";
import { loadGithubConfig } from "../github/config";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";
import { inspectRepo, initializeRepo } from "./github";

const REPO = "ivan/portfolio";
const INST = 7;
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE", "APP_TEMPLATE_REPO"];
const saved: Record<string, string | undefined> = {};
const MARKER = JSON.stringify({ template: "botcave-modello-app", version: 1 });

let gh: FakeGithub;

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
    APP_TEMPLATE_REPO: "TwentIvan/botcave-modello-app",
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
});

beforeEach(() => {
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.templates.clear();
  gh.git.clear();
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, { contents: "write", metadata: "read" });
  gh.templates.set(REPO, "twentivan/Botcave-Modello-App");
});

const input = { repo: REPO, installationId: INST, slug: "portfolio" };

describe("inspectRepo", () => {
  it("repo fresco: fresh con testa, albero e file", async () => {
    const head = gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER, "README.md": "# __APP_NAME__" });
    const r = await inspectRepo(input);
    expect(r.kind).toBe("fresh");
    if (r.kind !== "fresh") return;
    expect(r.headSha).toBe(head);
    expect(r.treeSha).toBe(gh.git.get(REPO)!.commits.get(head)!.tree);
    expect(r.files.get("README.md")).toBe("# __APP_NAME__");
    expect(r.files.has(".botcave/modello.json")).toBe(true);
  });

  it("repo nato da un altro modello: notFromTemplate", async () => {
    gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER });
    gh.templates.set(REPO, "altro/modello");
    expect(await inspectRepo(input)).toEqual({ kind: "error", message: M.notFromTemplate });
  });

  it("senza marcatore o con marcatore sbagliato: notFromTemplate", async () => {
    gh.seedRepo(REPO, "main", { "README.md": "x" });
    expect(await inspectRepo(input)).toEqual({ kind: "error", message: M.notFromTemplate });
    gh.seedRepo(REPO, "main", { ".botcave/modello.json": JSON.stringify({ template: "altro" }) });
    expect(await inspectRepo(input)).toEqual({ kind: "error", message: M.notFromTemplate });
  });

  it("3 commit: notFresh", async () => {
    const head = gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER });
    const repo = gh.git.get(REPO)!;
    const c = repo.commits.get(head)!;
    const c2 = "b".repeat(40);
    const c3 = "c".repeat(40);
    repo.commits.set(c2, { tree: c.tree, parents: [head], message: "due" });
    repo.commits.set(c3, { tree: c.tree, parents: [c2], message: "tre" });
    repo.refs.set("heads/main", c3);
    expect(await inspectRepo(input)).toEqual({ kind: "error", message: M.notFresh });
  });

  it("2 commit e marcatore con lo slug: initialized; con un altro slug: notFresh", async () => {
    const head = gh.seedRepo(REPO, "main", { ".botcave/modello.json": JSON.stringify({ template: "botcave-modello-app", slug: "portfolio" }) });
    const repo = gh.git.get(REPO)!;
    const c2 = "b".repeat(40);
    repo.commits.set(c2, { tree: repo.commits.get(head)!.tree, parents: [head], message: "init" });
    repo.refs.set("heads/main", c2);
    expect(await inspectRepo(input)).toEqual({ kind: "initialized", headSha: c2 });
    expect(await inspectRepo({ ...input, slug: "altro" })).toEqual({ kind: "error", message: M.notFresh });
  });

  it("repo non visibile all'installazione: notVisible; GitHub in errore: githubUnavailable", async () => {
    expect(await inspectRepo({ ...input, repo: "ivan/altro" })).toEqual({ kind: "error", message: M.notVisible });
    gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER });
    gh.failWith = (req) => (req.path.startsWith(`/repos/${REPO}`) ? 500 : null);
    try {
      expect(await inspectRepo(input)).toEqual({ kind: "error", message: M.githubUnavailable });
    } finally {
      gh.failWith = null;
    }
  });
});

describe("initializeRepo", () => {
  it("commit su main con i cambi (anche eliminazioni)", async () => {
    const head = gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER, "__SLUG__.txt": "x" });
    const treeSha = gh.git.get(REPO)!.commits.get(head)!.tree;
    const res = await initializeRepo({
      repo: REPO,
      installationId: INST,
      parentSha: head,
      baseTreeSha: treeSha,
      changes: new Map<string, string | null>([["portfolio.txt", "x"], ["__SLUG__.txt", null]]),
      message: "Inizializza Portfolio\n\nBotcave · nuova app da zero · richiesta 1",
    });
    expect(res).toHaveProperty("sha");
    const files = gh.filesAt(REPO, "main");
    expect(files["portfolio.txt"]).toBe("x");
    expect(files["__SLUG__.txt"]).toBeUndefined();
  });

  it("main avanzato nel frattempo (422): notFresh e main invariato", async () => {
    const head = gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER });
    const repo = gh.git.get(REPO)!;
    const treeSha = repo.commits.get(head)!.tree;
    // un altro commit sposta main lontano dal parent usato
    const other = "d".repeat(40);
    repo.commits.set(other, { tree: treeSha, parents: [], message: "altro" });
    repo.refs.set("heads/main", other);
    const res = await initializeRepo({ repo: REPO, installationId: INST, parentSha: head, baseTreeSha: treeSha, changes: new Map([["a.txt", "a"]]), message: "m" });
    expect(res).toEqual({ error: M.notFresh });
    expect(repo.refs.get("heads/main")).toBe(other);
  });

  it("rifiuta credenziali nei file prima di scrivere", async () => {
    const head = gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER });
    const treeSha = gh.git.get(REPO)!.commits.get(head)!.tree;
    const res = await initializeRepo({ repo: REPO, installationId: INST, parentSha: head, baseTreeSha: treeSha, changes: new Map([[".env.txt", "k=ghp_" + "a".repeat(30)]]), message: "m" });
    expect(res).toHaveProperty("error");
  });
});

describe("commitFiles", () => {
  it("resta limitato ai branch botcave/…", async () => {
    const cfg = loadGithubConfig()!;
    await expect(
      commitFiles({ cfg, installationId: INST, repo: REPO }, { branch: "main", parentSha: "x", baseTreeSha: "x", changes: new Map(), message: "m", createBranch: false }),
    ).rejects.toThrow(/botcave\//);
  });
});
