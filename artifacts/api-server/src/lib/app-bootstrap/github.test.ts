import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { resetGithubConfigForTests } from "../github/config";
import { commitFiles } from "../code-writer/github-git";
import { loadGithubConfig } from "../github/config";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";
import { INIT_LIMITS, checkInitChanges, inspectRepo, initializeRepo } from "./github";
import { MAX_FILES, personalizeFiles } from "./personalize";

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
    const res = await initializeRepo({ repo: REPO, installationId: INST, parentSha: head, baseTreeSha: treeSha, changes: new Map([["config.txt", "k=ghp_" + "a".repeat(30)]]), message: "m" });
    expect(res).toHaveProperty("error");
  });
});

describe("inspectRepo + personalizeFiles + initializeRepo: voci non di testo e modi", () => {
  const vars = { slug: "portfolio", name: "Portfolio", domain: "portfolio.example.com", brief: "Il brief" };

  it("binario sotto __SLUG__ spostato col suo blob, script 100755 rinominato resta eseguibile, cartella vecchia sparita", async () => {
    gh.seedRepo(REPO, "main", {
      ".botcave/modello.json": MARKER,
      "artifacts/__SLUG__-web/index.html": "<title>__APP_NAME__</title>",
      "artifacts/__SLUG__-web/public/favicon.png": "\u0089PNG-finto",
      "artifacts/__SLUG__-web/dist/bundle.js": "ignorato dallo zipball",
      "scripts/__SLUG__-start.sh": { content: "#!/bin/sh\necho __SLUG__\n", mode: "100755" },
      "public/logo.png": "fuori dai segnaposto",
    });
    const r = await inspectRepo(input);
    if (r.kind !== "fresh") throw new Error(JSON.stringify(r));
    expect(r.files.has("artifacts/__SLUG__-web/public/favicon.png")).toBe(false);
    expect(r.entries.get("scripts/__SLUG__-start.sh")?.mode).toBe("100755");
    const p = personalizeFiles(r.files, vars, r.entries);
    if ("error" in p) throw new Error(p.error);
    const res = await initializeRepo({ repo: REPO, installationId: INST, parentSha: r.headSha, baseTreeSha: r.treeSha, changes: p.changes, modes: p.modes, reuse: p.reuse, message: "m" });
    if (!("sha" in res)) throw new Error(res.error);
    const repo = gh.git.get(REPO)!;
    const tree = repo.trees.get(repo.commits.get(res.sha)!.tree)!;
    const byPath = new Map(tree.map((e) => [e.path, e]));
    const oldFavicon = r.entries.get("artifacts/__SLUG__-web/public/favicon.png")!;
    expect(byPath.get("artifacts/portfolio-web/public/favicon.png")?.sha).toBe(oldFavicon.sha);
    expect(byPath.get("artifacts/portfolio-web/dist/bundle.js")?.sha).toBe(r.entries.get("artifacts/__SLUG__-web/dist/bundle.js")!.sha);
    expect(byPath.get("scripts/portfolio-start.sh")?.mode).toBe("100755");
    expect(gh.filesAt(REPO, "main")["scripts/portfolio-start.sh"]).toBe("#!/bin/sh\necho portfolio\n");
    expect([...byPath.keys()].some((k) => k.includes("__SLUG__"))).toBe(false);
    expect(byPath.get("public/logo.png")?.sha).toBe(r.entries.get("public/logo.png")!.sha);
  });

  it("collegamento simbolico sotto un segnaposto: pathRefused", () => {
    const entries = new Map([["artifacts/__SLUG__-web/link", { mode: "120000", sha: "a".repeat(40) }]]);
    expect(personalizeFiles(new Map(), vars, entries)).toEqual({ error: M.pathRefused });
  });

  it("albero troncato da GitHub: treeTruncated", async () => {
    gh.seedRepo(REPO, "main", { ".botcave/modello.json": MARKER });
    gh.truncatedTrees.add(REPO);
    try {
      expect(await inspectRepo(input)).toEqual({ kind: "error", message: M.treeTruncated });
    } finally {
      gh.truncatedTrees.delete(REPO);
    }
  });
});

describe("checkInitChanges", () => {
  it("limite allineato alla personalizzazione: 200 file rinominati più brief e marcatore passano, una voce in più no", () => {
    expect(INIT_LIMITS.maxEntries).toBe(2 * MAX_FILES + 2);
    const ok = new Map<string, string | null>();
    for (let i = 0; i < MAX_FILES; i++) {
      ok.set(`artifacts/portfolio-web/f${i}.ts`, "x");
      ok.set(`artifacts/__SLUG__-web/f${i}.ts`, null);
    }
    ok.set("AGENT_BRIEF.md", "brief");
    ok.set(".botcave/modello.json", "{}");
    expect(checkInitChanges(ok)).toBeNull();
    ok.set("extra.txt", "x");
    expect(checkInitChanges(ok)).toBe(M.tooManyFiles);
    // Le voci riusate contano nel limite e passano dalla guardia dei percorsi
    expect(checkInitChanges(new Map([["a", "x"]]), [{ path: ".github/x.png", mode: "100644", sha: "a".repeat(40) }])).toBe(M.pathRefused);
  });

  it("file oltre 1 MiB, totale oltre 5 MiB o con NUL: tooManyFiles", () => {
    expect(checkInitChanges(new Map([["a", "x".repeat(1_048_577)]]))).toBe(M.tooManyFiles);
    const big = new Map<string, string | null>();
    for (let i = 0; i < 6; i++) big.set(`f${i}`, "x".repeat(1_000_000));
    expect(checkInitChanges(big)).toBe(M.tooManyFiles);
    expect(checkInitChanges(new Map([["a", "x\0y"]]))).toBe(M.tooManyFiles);
  });

  it("percorsi .git/, .github/, .env e .env.*: pathRefused, anche per le eliminazioni", () => {
    for (const p of [".git/config", ".github/workflows/x.yml", ".env", "app/.env", ".env.local", "a/.env.production"]) {
      expect(checkInitChanges(new Map([[p, "x"]]))).toBe(M.pathRefused);
    }
    expect(checkInitChanges(new Map([[".github/x", null]]))).toBe(M.pathRefused);
    expect(checkInitChanges(new Map([[".environment.md", "x"], ["docs/env.md", "x"]]))).toBeNull();
  });

  it("credenziale in un file: rifiutata", () => {
    expect(checkInitChanges(new Map([["a.txt", "sk-" + "a".repeat(20)]]))).not.toBeNull();
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
