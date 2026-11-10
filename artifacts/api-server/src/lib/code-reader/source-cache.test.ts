import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, githubInstallationsTable, usersTable, type App } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import type { GithubConfig } from "../github/config";
import { buildZip } from "../zip-writer";
import { CODE_MESSAGES } from "./messages";
import {
  CodeReaderError,
  clearCodeCache,
  codeAvailability,
  getAppSource,
  setCodeCacheOptionsForTests,
  sweepCodeCache,
} from "./source-cache";

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

const zipWith = (name: string, text: string) => buildZip([{ name: `proj/${name}`, content: Buffer.from(text) }]);

let gh: FakeGithub;
let cfg: GithubConfig;
let userId: number;
let otherUserId: number;
let clock = 1_000_000;

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
  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  const [o] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  userId = u!.id;
  otherUserId = o!.id;
  await db.insert(githubInstallationsTable).values({
    userId,
    installationId: 11,
    accountLogin: "ivan",
    accountType: "User",
    repositorySelection: "all",
  });
});

afterAll(async () => {
  await gh.close();
  await pool.query("TRUNCATE apps, github_installations, users RESTART IDENTITY CASCADE");
  await pool.end();
});

beforeEach(() => {
  clock = 1_000_000;
  setCodeCacheOptionsForTests({ githubConfig: cfg, now: () => clock });
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.revoked.clear();
  gh.issuedTokens.clear();
  gh.zipballs.clear();
  gh.commits.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.addInstallation(
    { id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" },
    ["fanta", "r2", "r3", "r4"].map((n) => ({ fullName: `ivan/${n}`, defaultBranch: "main", private: true })),
  );
  for (const n of ["fanta", "r2", "r3", "r4"]) {
    gh.zipballs.set(`ivan/${n}`, zipWith("a.ts", `export const v = 1; // ${n}\n`));
    gh.commits.set(`ivan/${n}`, SHA1);
  }
});

afterEach(async () => {
  await clearCodeCache();
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

async function mkApp(repo = "ivan/fanta", over: Partial<typeof appsTable.$inferInsert> = {}): Promise<App> {
  const [row] = await db
    .insert(appsTable)
    .values({
      name: "Fanta",
      slug: `app-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "http://localhost:1",
      sourceType: "github",
      sourceRepo: repo,
      sourceBranch: "main",
      sourceInstallationId: 11,
      ...over,
    })
    .returning();
  return row!;
}

const zipballs = () => gh.requests.filter((r) => /^\/repos\/[^/]+\/[^/]+\/zipball/.test(r.path));
const commitReqs = () => gh.requests.filter((r) => /^\/repos\/[^/]+\/[^/]+\/commits\//.test(r.path));

describe("cache delle sorgenti", () => {
  it("stesso sha: un solo download, due letture dello sha", async () => {
    const app = await mkApp();
    const a = await getAppSource(userId, app);
    const b = await getAppSource(userId, app);
    expect(a.sha).toBe(SHA1);
    expect(b.tree).toBe(a.tree);
    expect(zipballs()).toHaveLength(1);
    expect(commitReqs()).toHaveLength(2);
  });

  it("sha cambiato: nuovo download e file nuovo visibile", async () => {
    const app = await mkApp();
    await getAppSource(userId, app);
    gh.commits.set("ivan/fanta", SHA2);
    gh.zipballs.set("ivan/fanta", zipWith("nuovo.ts", "export const n = 2;\n"));
    const b = await getAppSource(userId, app);
    expect(b.sha).toBe(SHA2);
    expect(zipballs()).toHaveLength(2);
    expect(b.tree.has("nuovo.ts")).toBe(true);
  });

  it("due richieste concorrenti: un solo download", async () => {
    const app = await mkApp();
    const [a, b] = await Promise.all([getAppSource(userId, app), getAppSource(userId, app)]);
    expect(a.tree).toBe(b.tree);
    expect(zipballs()).toHaveLength(1);
  });

  it("dopo 15 minuti di inattività la voce si toglie", async () => {
    const app = await mkApp();
    await getAppSource(userId, app);
    clock += 14 * 60_000;
    await sweepCodeCache(clock);
    await getAppSource(userId, app);
    expect(zipballs()).toHaveLength(1);
    clock += 15 * 60_000;
    await sweepCodeCache(clock);
    await getAppSource(userId, app);
    expect(zipballs()).toHaveLength(2);
  });

  it("al più 3 repository: si toglie il meno usato", async () => {
    const apps = [await mkApp("ivan/fanta"), await mkApp("ivan/r2"), await mkApp("ivan/r3"), await mkApp("ivan/r4")];
    for (const a of apps) {
      clock += 1000;
      await getAppSource(userId, a);
    }
    expect(zipballs()).toHaveLength(4);
    // le ultime tre sono ancora in cache, la prima è stata tolta
    for (const a of apps.slice(1)) await getAppSource(userId, a);
    expect(zipballs()).toHaveLength(4);
    await getAppSource(userId, apps[0]!);
    expect(zipballs()).toHaveLength(5);
  });

  it("utente senza installazione rifiutato anche con il repository in memoria", async () => {
    const app = await mkApp();
    await getAppSource(userId, app);
    await expect(getAppSource(otherUserId, app)).rejects.toThrow(CodeReaderError);
    await expect(getAppSource(otherUserId, app)).rejects.toThrow(CODE_MESSAGES.noAccess("Fanta"));
  });

  it("sha non leggibile con il repository in memoria: riuso con sha null", async () => {
    const app = await mkApp();
    const first = await getAppSource(userId, app);
    gh.commits.delete("ivan/fanta");
    const b = await getAppSource(userId, app);
    expect(b.sha).toBeNull();
    expect(b.tree).toBe(first.tree);
    expect(zipballs()).toHaveLength(1);
  });

  it("token revocato (401): accesso revocato", async () => {
    const app = await mkApp();
    await getAppSource(userId, app);
    gh.revoked.add(11);
    await expect(getAppSource(userId, app)).rejects.toThrow(CODE_MESSAGES.revoked);
  });

  it("403 sullo sha: accesso revocato, token scartati e cache non riusata", async () => {
    const app = await mkApp();
    await getAppSource(userId, app);
    const tokens = () => gh.requests.filter((r) => r.path === "/app/installations/11/access_tokens").length;
    expect(tokens()).toBe(1);
    gh.failWith = (r) => (r.path.includes("/commits/") ? 403 : null);
    await expect(getAppSource(userId, app)).rejects.toThrow(CODE_MESSAGES.revoked);
    gh.failWith = null;
    await getAppSource(userId, app);
    expect(tokens()).toBe(2);
  });

  it("lo sfratto fa dispose dell'albero", async () => {
    const apps = [await mkApp("ivan/fanta"), await mkApp("ivan/r2"), await mkApp("ivan/r3"), await mkApp("ivan/r4")];
    const first = await getAppSource(userId, apps[0]!);
    await first.tree.search("export", { regex: true });
    for (const a of apps.slice(1)) {
      clock += 1000;
      await getAppSource(userId, a);
    }
    await expect(first.tree.search("export", { regex: true })).rejects.toThrow("ricerca regex non disponibile: riprova");
  });

  it("5xx sullo zipball: GitHub non raggiungibile", async () => {
    const app = await mkApp();
    gh.failWith = (r) => (r.path.includes("/zipball") ? 502 : null);
    await expect(getAppSource(userId, app)).rejects.toThrow(CODE_MESSAGES.unreachable);
  });

  it("app zip: codice non disponibile", async () => {
    const app = await mkApp("ivan/fanta", { sourceType: "zip", sourceInstallationId: null });
    expect(await codeAvailability(userId, app)).toEqual({ ok: false, reason: CODE_MESSAGES.unavailable("Fanta") });
    await expect(getAppSource(userId, app)).rejects.toThrow(CODE_MESSAGES.unavailable("Fanta"));
  });

  it("archivio non leggibile: errore fisso e nessuna voce in cache", async () => {
    const app = await mkApp();
    gh.zipballs.set("ivan/fanta", new Uint8Array([1, 2, 3, 4]));
    await expect(getAppSource(userId, app)).rejects.toBeInstanceOf(CodeReaderError);
    gh.zipballs.set("ivan/fanta", zipWith("a.ts", "x\n"));
    const ok = await getAppSource(userId, app);
    expect(ok.sha).toBe(SHA1);
    expect(zipballs()).toHaveLength(2);
  });
});
