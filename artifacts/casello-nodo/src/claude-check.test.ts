import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkClaude,
  CLAUDE_INSTALL_URL,
  createCachedClaudeStatus,
  installClaude,
  locateClaude,
  loginClaude,
  type ClaudeDeps,
  type RunFn,
} from "./claude-check";
import { tempDir } from "./test/helpers";

const AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  loginExpiresAt: "2026-11-20T15:13:29.801Z",
  email: "ivan@example.com",
  orgId: "org-secret",
  orgName: "Derga Dev",
  subscriptionType: "team",
});

function fakeRun(opts: { auth?: string | null; version?: string | null } = {}): RunFn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === "--version") return opts.version === undefined ? "2.1.321 (Claude Code)\n" : opts.version;
    if (args[0] === "auth") return opts.auth === undefined ? AUTH : opts.auth;
    return null;
  }) as unknown as RunFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
}
const deps = (run: RunFn, which: ClaudeDeps["which"] = async () => "/h/.local/bin/claude"): ClaudeDeps => ({
  which,
  run,
  home: "/h",
});

describe("checkClaude", () => {
  it("installato e con login: solo i campi ammessi", async () => {
    const st = await checkClaude(deps(fakeRun()));
    expect(st).toEqual({
      found: true,
      version: "2.1.321",
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "team",
      loginExpiresAt: "2026-11-20T15:13:29.801Z",
    });
    expect(JSON.stringify(st)).not.toMatch(/ivan|org-secret|Derga/);
  });
  it("senza login", async () => {
    const st = await checkClaude(deps(fakeRun({ auth: '{"loggedIn":false}' })));
    expect(st).toEqual({ found: true, version: "2.1.321", loggedIn: false });
  });
  it("assente", async () => {
    expect(await checkClaude(deps(fakeRun(), async () => null))).toEqual({ found: false });
  });
  it("auth status senza risposta o JSON non valido: loggedIn assente", async () => {
    expect(await checkClaude(deps(fakeRun({ auth: null })))).toEqual({ found: true, version: "2.1.321" });
    expect(await checkClaude(deps(fakeRun({ auth: "non json" })))).toEqual({ found: true, version: "2.1.321" });
  });
  it("usa il percorso trovato e un timeout di 10 s", async () => {
    const run = vi.fn(async () => null);
    await checkClaude(deps(run as unknown as RunFn));
    expect(run).toHaveBeenCalledWith("/h/.local/bin/claude", ["--version"], 10_000);
    expect(run).toHaveBeenCalledWith("/h/.local/bin/claude", ["auth", "status", "--json"], 10_000);
  });
});

describe("locateClaude", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir("claude-loc-"));
  });
  afterEach(async () => cleanup());
  async function exe(p: string, mode = 0o755) {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, "#!/bin/sh\n");
    await chmod(p, mode);
  }
  it("PATH prima, poi le cartelle consuete; solo file eseguibili", async () => {
    await exe(path.join(dir, "a", "claude"), 0o644);
    await exe(path.join(dir, "b", "claude"));
    await exe(path.join(dir, ".local/bin/claude"));
    expect(await locateClaude({ pathEnv: `${dir}/a:${dir}/b`, home: dir })).toBe(path.join(dir, "b", "claude"));
    expect(await locateClaude({ pathEnv: `${dir}/a`, home: dir })).toBe(path.join(dir, ".local/bin/claude"));
    expect(await locateClaude({ pathEnv: undefined, home: path.join(dir, "vuota"), extraDirs: [] })).toBeNull();
  });
});

describe("installClaude", () => {
  it("esegue la riga con l'URL costante, poi verifica", async () => {
    const run = fakeRun();
    const exec = vi.fn(async () => {});
    const st = await installClaude({ ...deps(run), exec });
    expect(CLAUDE_INSTALL_URL).toBe("https://claude.ai/install.sh");
    expect(exec).toHaveBeenCalledWith("/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], 600_000);
    expect(st.found).toBe(true);
  });
});

describe("loginClaude", () => {
  it("termina quando il finto passa a loggedIn true", async () => {
    let n = 0;
    const run = (async (_f: string, args: string[]) => {
      if (args[0] === "--version") return "2.1.321 (Claude Code)";
      n++;
      return JSON.stringify({ loggedIn: n >= 3 });
    }) as RunFn;
    const spawnLogin = vi.fn();
    const sleeps: number[] = [];
    const ok = await loginClaude({
      ...deps(run),
      spawnLogin,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(ok).toBe(true);
    expect(spawnLogin).toHaveBeenCalledWith("/h/.local/bin/claude");
    expect(sleeps).toEqual([5_000, 5_000]);
  });
  it("dopo 10 minuti smette", async () => {
    const run = fakeRun({ auth: '{"loggedIn":false}' });
    let t = 0;
    const ok = await loginClaude({
      ...deps(run),
      spawnLogin: vi.fn(),
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    expect(ok).toBe(false);
    expect(t).toBe(600_000);
  });
});

describe("createCachedClaudeStatus", () => {
  it("riusa l'ultimo risultato per 10 minuti", async () => {
    let t = 0;
    const check = vi.fn(async () => ({ found: true }));
    const get = createCachedClaudeStatus(check, () => t);
    await get();
    t = 599_000;
    await get();
    expect(check).toHaveBeenCalledTimes(1);
    t = 600_000;
    await get();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
