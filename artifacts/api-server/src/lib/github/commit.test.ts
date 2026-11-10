import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { SourceError } from "../architect/sources";
import { clearInstallationTokenCache, installationToken } from "./app";
import type { GithubConfig } from "./config";
import { fetchBranchSha } from "./commit";

const SHA = "0123456789abcdef0123456789abcdef01234567";

let gh: FakeGithub;
let cfg: GithubConfig;

beforeAll(async () => {
  gh = await startFakeGithub();
  cfg = {
    appId: gh.appId,
    slug: gh.slug,
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    privateKey: gh.privateKeyPem,
    apiBase: gh.apiBase,
    webBase: gh.webBase,
  };
});

afterAll(async () => {
  await gh.close();
});

beforeEach(() => {
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.revoked.clear();
  gh.issuedTokens.clear();
  gh.commits.clear();
  gh.addInstallation({ id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: "ivan/fanta", defaultBranch: "main", private: true },
  ]);
});

const token = () => installationToken(cfg, 11, { repo: "ivan/fanta" });

describe("fetchBranchSha", () => {
  it("restituisce lo sha del branch in minuscolo", async () => {
    gh.commits.set("ivan/fanta", SHA.toUpperCase());
    expect(await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "main", token: await token() })).toBe(SHA);
  });

  it("senza branch usa HEAD", async () => {
    gh.commits.set("ivan/fanta", SHA);
    expect(await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "  ", token: await token() })).toBe(SHA);
    expect(gh.requests.some((r) => r.path === "/repos/ivan/fanta/commits/HEAD")).toBe(true);
  });

  it("repo o branch sconosciuto: SourceError 404", async () => {
    const err = await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "main", token: await token() }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.status).toBe(404);
  });

  it("token sconosciuto: SourceError 401", async () => {
    gh.commits.set("ivan/fanta", SHA);
    const err = await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "main", token: "ghs_sconosciuto" }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.status).toBe(401);
  });

  it("accetta il corpo JSON {sha}", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ sha: SHA }), { status: 200 })) as typeof fetch;
    expect(await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "main", token: "x", fetchImpl })).toBe(SHA);
  });

  it("risposta non valida o rete: SourceError senza stato", async () => {
    const bad = (async () => new Response("non uno sha", { status: 200 })) as typeof fetch;
    const e1 = await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "main", token: "x", fetchImpl: bad }).catch((e) => e);
    expect(e1).toBeInstanceOf(SourceError);
    expect(e1.status).toBeNull();
    const down = (async () => {
      throw new Error("rete");
    }) as typeof fetch;
    const e2 = await fetchBranchSha({ apiBase: cfg.apiBase, repo: "ivan/fanta", branch: "main", token: "x", fetchImpl: down }).catch((e) => e);
    expect(e2).toBeInstanceOf(SourceError);
    expect(e2.status).toBeNull();
  });
});
