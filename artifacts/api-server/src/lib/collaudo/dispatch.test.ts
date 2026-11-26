import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { resetGithubConfigForTests } from "../github/config";
import { collaudoRepo, COLLAUDO_WORKFLOW } from "./config";
import { dispatchTest } from "./dispatch";
import { COLLAUDO_MESSAGES } from "./messages";
import { collaudoSetup } from "./setup";

const REPO = "ivan/collaudo";
const INST = 9;
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE", "COLLAUDO_REPO"];
const saved: Record<string, string | undefined> = {};
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

function install(withWorkflow: boolean, permissions: Record<string, string>): void {
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, permissions);
  gh.seedRepo(REPO, "main", withWorkflow ? { [`.github/workflows/${COLLAUDO_WORKFLOW}`]: "name: collaudo" } : { "README.md": "x" });
}

beforeEach(() => {
  clearInstallationTokenCache();
  gh.dispatches.length = 0;
  gh.installations.clear();
  gh.repos.clear();
  gh.git.clear();
  gh.installationPermissions.clear();
  process.env["COLLAUDO_REPO"] = REPO;
});

describe("collaudoRepo", () => {
  it("legge la variabile a ogni chiamata, null se manca o non è valida", () => {
    expect(collaudoRepo()).toBe(REPO);
    delete process.env["COLLAUDO_REPO"];
    expect(collaudoRepo()).toBeNull();
    process.env["COLLAUDO_REPO"] = "non valido";
    expect(collaudoRepo()).toBeNull();
  });
});

describe("dispatchTest", () => {
  it("registra il lancio con gli input attesi", async () => {
    install(true, { contents: "read", metadata: "read", actions: "write" });
    expect(await dispatchTest(42, "ABC123")).toEqual({ ok: true });
    expect(gh.dispatches).toEqual([{ repo: REPO, workflow: "collaudo.yml", ref: "main", inputs: { collaudo: "42", codice: "ABC123" } }]);
  });

  it("installazione assente: errore fisso", async () => {
    expect(await dispatchTest(1, "x")).toEqual({ ok: false, error: COLLAUDO_MESSAGES.dispatchFailed });
    expect(gh.dispatches).toHaveLength(0);
  });

  it("senza il permesso actions: errore fisso", async () => {
    install(true, { contents: "read", metadata: "read" });
    expect(await dispatchTest(1, "x")).toEqual({ ok: false, error: COLLAUDO_MESSAGES.dispatchFailed });
  });

  it("senza COLLAUDO_REPO: errore fisso", async () => {
    delete process.env["COLLAUDO_REPO"];
    expect(await dispatchTest(1, "x")).toEqual({ ok: false, error: COLLAUDO_MESSAGES.dispatchFailed });
  });
});

describe("collaudoSetup", () => {
  it("tutto pronto", async () => {
    install(true, { contents: "read", metadata: "read", actions: "write" });
    expect(await collaudoSetup()).toEqual({ repo: REPO, installed: true, workflow: true, actionsWrite: true });
  });

  it("workflow assente", async () => {
    install(false, { contents: "read", metadata: "read", actions: "write" });
    expect(await collaudoSetup()).toMatchObject({ installed: true, workflow: false, actionsWrite: true });
  });

  it("permesso actions non concesso", async () => {
    install(true, { contents: "read", metadata: "read" });
    expect(await collaudoSetup()).toMatchObject({ installed: true, workflow: true, actionsWrite: false });
  });

  it("repository non installato o variabile mancante", async () => {
    expect(await collaudoSetup()).toEqual({ repo: REPO, installed: false, workflow: false, actionsWrite: false });
    delete process.env["COLLAUDO_REPO"];
    expect(await collaudoSetup()).toEqual({ repo: null, installed: false, workflow: false, actionsWrite: false });
  });
});
