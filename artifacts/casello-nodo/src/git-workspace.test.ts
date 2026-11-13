import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyGitError,
  finishTaskRepo,
  gitEnv,
  GIT_MESSAGES,
  GitWorkspaceError,
  prepareTaskRepo,
} from "./git-workspace";
import { WorkspaceQueue } from "./runner";
import { tempDir } from "./test/helpers";

const TOKEN = "tok-segreto-git-0123456789";
const GIT = { repo: "o/r", baseBranch: "main", branch: "botcave/12-t1", issue: null };

// Isolamento dalla configurazione git dell'utente e identità dei commit dei test
const TEST_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(TEST_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Call {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

let base: string;
let root: string;
let remote: string;
let seed: string;
let calls: Call[];
let tokenCalls: number;
let cleanup: () => Promise<void>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...TEST_ENV }, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/** Comando git da far fallire (per provare la pulizia dopo il push). */
let failCommand: string | null = null;
function spySpawn(command: string, args: readonly string[], options: SpawnOptions) {
  calls.push({ args, env: options.env ?? {} });
  if (failCommand && args.includes(failCommand)) return spawn("false", [], options);
  return spawn(command, args, options);
}

const opts = <T extends object = object>(over: T = {} as T) => ({
  root,
  git: GIT,
  getToken: async () => {
    tokenCalls++;
    return TOKEN;
  },
  queue: new WorkspaceQueue(),
  signal: new AbortController().signal,
  remoteUrl: remote,
  spawn: spySpawn,
  ...over,
});

/** Commit nella copia di seme e push sul remoto. */
function seedCommit(branch: string, file: string, from = "main") {
  git(seed, "checkout", "-q", "-B", branch, `origin/${from}`);
  git(seed, "fetch", "-q", "origin");
  try {
    git(seed, "reset", "-q", "--hard", `origin/${branch}`);
  } catch {
    // branch nuovo sul remoto
  }
  execFileSync("sh", ["-c", `echo ${file} > ${file}`], { cwd: seed });
  git(seed, "add", file);
  git(seed, "commit", "-q", "-m", file);
  git(seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  return git(seed, "rev-parse", "HEAD");
}

function localCommit(dir: string, file: string) {
  execFileSync("sh", ["-c", `echo ${file} > ${file}`], { cwd: dir });
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", file);
  return git(dir, "rev-parse", "HEAD");
}

beforeEach(async () => {
  ({ dir: base, cleanup } = await tempDir("casello-git-"));
  base = await realpath(base);
  root = path.join(base, "radice");
  await mkdir(root);
  remote = path.join(base, "remoto.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  seed = path.join(base, "seme");
  git(base, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-b", "main");
  execFileSync("sh", ["-c", "echo ciao > README.md"], { cwd: seed });
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "primo");
  git(seed, "push", "-q", "origin", "main");
  calls = [];
  tokenCalls = 0;
  failCommand = null;
});
afterEach(async () => cleanup());

const cloneDir = () => path.join(root, ".botcave", "repos", "o", "r.git");
const taskDir = () => path.join(root, ".botcave", "compiti", "12-t1");

describe("prepareTaskRepo", () => {
  it("primo compito: clone nudo, copia sul branch del compito da origin/main, file di servizio in info/exclude", async () => {
    const r = await prepareTaskRepo(opts());
    expect(r).toEqual({ dir: taskDir(), resumed: false, note: null });
    expect(git(cloneDir(), "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(r.dir, "symbolic-ref", "--short", "HEAD")).toBe("botcave/12-t1");
    expect(git(r.dir, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
    const exclude = execFileSync("cat", [path.join(cloneDir(), "info", "exclude")]).toString();
    expect(exclude).toContain("casello-compito.md");
    expect(exclude).toContain("casello-esito.json");
    expect(exclude).toContain("casello-allegati/");
    expect(tokenCalls).toBe(1);
  });

  it("branch già sul remoto: la copia parte da origin/botcave/12-t1", async () => {
    const sha = seedCommit("botcave/12-t1", "lavoro.txt");
    const r = await prepareTaskRepo(opts());
    expect(git(r.dir, "rev-parse", "HEAD")).toBe(sha);
  });

  it("copia esistente valida: ripresa senza perdere un commit locale", async () => {
    const first = await prepareTaskRepo(opts());
    const sha = localCommit(first.dir, "locale.txt");
    const r = await prepareTaskRepo(opts());
    expect(r).toEqual({ dir: taskDir(), resumed: true, note: null });
    expect(git(r.dir, "rev-parse", "HEAD")).toBe(sha);
  });

  it("copia divergente da origin (branch riscritto sul remoto): ricreata con la nota", async () => {
    const first = await prepareTaskRepo(opts());
    localCommit(first.dir, "locale.txt");
    const remoteSha = seedCommit("botcave/12-t1", "altro.txt");
    const r = await prepareTaskRepo(opts());
    expect(r.resumed).toBe(false);
    expect(r.note).toBe("commit locali non pubblicati scartati: il branch era cambiato su GitHub");
    expect(git(r.dir, "rev-parse", "HEAD")).toBe(remoteSha);
  });

  it("cartella della copia cancellata a mano: ricreata senza errori", async () => {
    const first = await prepareTaskRepo(opts());
    await rm(first.dir, { recursive: true, force: true });
    const r = await prepareTaskRepo(opts());
    expect(r.resumed).toBe(false);
    expect(git(r.dir, "symbolic-ref", "--short", "HEAD")).toBe("botcave/12-t1");
  });

  it("copia su un altro branch con commit non pubblicati: ricreata con la nota", async () => {
    const first = await prepareTaskRepo(opts());
    git(first.dir, "checkout", "-q", "--detach");
    localCommit(first.dir, "staccato.txt");
    const r = await prepareTaskRepo(opts());
    expect(r.resumed).toBe(false);
    expect(r.note).toBe("commit locali non pubblicati scartati: la copia non era sul branch del compito");
    expect(git(r.dir, "symbolic-ref", "--short", "HEAD")).toBe("botcave/12-t1");
  });

  it("clone incompleto (cartella senza HEAD): riclonato", async () => {
    await mkdir(cloneDir(), { recursive: true });
    await writeFile(path.join(cloneDir(), "rimasuglio"), "x");
    const r = await prepareTaskRepo(opts());
    expect(git(r.dir, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
    expect(existsSync(path.join(cloneDir(), "rimasuglio"))).toBe(false);
  });

  it("due prepareTaskRepo in parallelo sullo stesso repo: entrambi riusciti, un solo clone", async () => {
    const queue = new WorkspaceQueue();
    const [a, b] = await Promise.all([
      prepareTaskRepo(opts({ queue })),
      prepareTaskRepo(opts({ queue, git: { ...GIT, branch: "botcave/12-t2" } })),
    ]);
    expect(a.dir).toBe(taskDir());
    expect(b.dir).toBe(path.join(root, ".botcave", "compiti", "12-t2"));
    expect(calls.filter((c) => c.args.includes("init")).length).toBe(1);
  });

  it("base assente sul remoto → failed «branch base non trovato»", async () => {
    const err = await prepareTaskRepo(opts({ git: { ...GIT, baseBranch: "sviluppo" } })).catch((e) => e);
    expect(err).toBeInstanceOf(GitWorkspaceError);
    expect(err.status).toBe("failed");
    expect(err.message).toBe("branch base non trovato: controlla il branch dell'App in Botcave");
  });

  it("Git non installato → blocked", async () => {
    const err = await prepareTaskRepo(opts({ gitBin: path.join(base, "git-inesistente") })).catch((e) => e);
    expect(err).toBeInstanceOf(GitWorkspaceError);
    expect(err.status).toBe("blocked");
    expect(err.message).toBe(GIT_MESSAGES.notInstalled);
    expect(tokenCalls).toBe(0);
  });

  it("repository o branch con nomi non validi → rifiutati", async () => {
    for (const g of [
      { ...GIT, repo: "../r" },
      { ...GIT, repo: "o/.." },
      { ...GIT, branch: "feature/x" },
      { ...GIT, branch: "botcave/../x" },
    ]) {
      const err = await prepareTaskRepo(opts({ git: g })).catch((e) => e);
      expect(err).toBeInstanceOf(GitWorkspaceError);
    }
    expect(tokenCalls).toBe(0);
  });
});

describe("finishTaskRepo", () => {
  it("2 commit: push riuscito, headSha del remoto, copia e branch locale tolti", async () => {
    const p = await prepareTaskRepo(opts());
    localCommit(p.dir, "a.txt");
    const sha = localCommit(p.dir, "b.txt");
    const r = await finishTaskRepo(opts({ dir: p.dir }));
    expect(r).toEqual({ pushed: true, headSha: sha, commits: 2, note: null });
    expect(git(remote, "rev-parse", "refs/heads/botcave/12-t1")).toBe(sha);
    expect(existsSync(p.dir)).toBe(false);
    expect(() => git(cloneDir(), "rev-parse", "--verify", "-q", "refs/heads/botcave/12-t1")).toThrow();
    expect(tokenCalls).toBe(2);
  });

  it("senza commit e con un file modificato: nessun push, nota delle modifiche scartate", async () => {
    const p = await prepareTaskRepo(opts());
    await writeFile(path.join(p.dir, "README.md"), "cambiato\n");
    await writeFile(path.join(p.dir, "casello-compito.md"), "istruzioni\n");
    await mkdir(path.join(p.dir, "casello-allegati"));
    await writeFile(path.join(p.dir, "casello-allegati", "x.txt"), "x");
    const r = await finishTaskRepo(opts({ dir: p.dir }));
    expect(r).toEqual({ pushed: false, headSha: null, commits: 0, note: "modifiche non committate scartate: 1 file" });
    expect(tokenCalls).toBe(1);
    expect(existsSync(p.dir)).toBe(false);
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("push rifiutato (il remoto è avanzato): failed «il branch è cambiato», copia rimasta", async () => {
    const p = await prepareTaskRepo(opts());
    localCommit(p.dir, "locale.txt");
    seedCommit("botcave/12-t1", "altro.txt");
    const err = await finishTaskRepo(opts({ dir: p.dir })).catch((e) => e);
    expect(err).toBeInstanceOf(GitWorkspaceError);
    expect(err.status).toBe("failed");
    expect(err.message).toBe("push non riuscito: il branch è cambiato su GitHub");
    expect(existsSync(p.dir)).toBe(true);
  });

  it("branch senza prefisso botcave/ o uguale al base: nessun push, errore", async () => {
    const p = await prepareTaskRepo(opts());
    localCommit(p.dir, "a.txt");
    calls = [];
    for (const g of [
      { ...GIT, branch: "feature/x" },
      { ...GIT, branch: "main" },
      { ...GIT, branch: "botcave/x", baseBranch: "botcave/x" },
    ]) {
      const err = await finishTaskRepo(opts({ dir: p.dir, git: g })).catch((e) => e);
      expect(err).toBeInstanceOf(GitWorkspaceError);
    }
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
    expect(git(remote, "branch", "--list")).not.toContain("botcave");
  });

  it("clone manomesso e config globale ostile: fetch e push vanno al remoto giusto, niente tag né comandi di Claude", async () => {
    const p = await prepareTaskRepo(opts());
    const evil = path.join(base, "evil.git");
    git(base, "init", "-q", "--bare", evil);
    const marker = path.join(base, "eseguito");
    // Manomissioni che Claude potrebbe fare dalla copia di lavoro
    git(cloneDir(), "config", `url.${evil}.insteadOf`, remote);
    git(cloneDir(), "config", "core.alternateRefsCommand", `touch ${marker}`);
    git(cloneDir(), "config", "push.followTags", "true");
    await writeFile(path.join(cloneDir(), "objects", "info", "alternates"), path.join(evil, "objects") + "\n");
    const sha = localCommit(p.dir, "a.txt");
    git(p.dir, "tag", "-a", "v-claude", "-m", "tag");
    // Configurazione globale ostile in una HOME temporanea, senza l'isolamento dei test
    const home = path.join(base, "home");
    await mkdir(home);
    await writeFile(path.join(home, ".gitconfig"), `[url "${evil}"]\n\tinsteadOf = ${remote}\n[http]\n\tproxy = http://127.0.0.1:9\n`);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    delete process.env.GIT_CONFIG_GLOBAL;
    try {
      const again = await prepareTaskRepo(opts());
      expect(again.resumed).toBe(true);
      const r = await finishTaskRepo(opts({ dir: p.dir }));
      expect(r).toMatchObject({ pushed: true, headSha: sha, commits: 1 });
    } finally {
      process.env.HOME = prevHome;
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    }
    expect(git(remote, "rev-parse", "refs/heads/botcave/12-t1")).toBe(sha);
    expect(git(evil, "for-each-ref")).toBe("");
    expect(git(remote, "tag", "--list")).toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(cloneDir(), "objects", "info", "alternates"))).toBe(false);
    expect(() => git(cloneDir(), "config", "--get", "push.followTags")).toThrow();
  });

  it("copia su un altro branch o con HEAD staccato: i commit si pubblicano sul branch del compito", async () => {
    for (const mode of ["branch", "detach"]) {
      const p = await prepareTaskRepo(opts());
      if (mode === "branch") git(p.dir, "checkout", "-q", "-b", "altro");
      else git(p.dir, "checkout", "-q", "--detach");
      const sha = localCommit(p.dir, `${mode}.txt`);
      const r = await finishTaskRepo(opts({ dir: p.dir }));
      expect(r).toMatchObject({ pushed: true, headSha: sha, commits: 1 });
      expect(git(remote, "rev-parse", "refs/heads/botcave/12-t1")).toBe(sha);
      expect(existsSync(p.dir)).toBe(false);
    }
  });

  it("pulizia dopo un push riuscito che fallisce: il push si riferisce comunque", async () => {
    const p = await prepareTaskRepo(opts());
    const sha = localCommit(p.dir, "a.txt");
    failCommand = "status";
    const r = await finishTaskRepo(opts({ dir: p.dir }));
    expect(r).toEqual({ pushed: true, headSha: sha, commits: 1, note: null });
    expect(git(remote, "rev-parse", "refs/heads/botcave/12-t1")).toBe(sha);
  });

  it("il token non compare negli argomenti, solo nell'ambiente dei comandi di rete", async () => {
    const p = await prepareTaskRepo(opts());
    localCommit(p.dir, "a.txt");
    await finishTaskRepo(opts({ dir: p.dir }));
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain(TOKEN);
      const network = c.args.includes("fetch") || c.args.includes("push");
      expect(c.env.BOTCAVE_GIT_TOKEN).toBe(network ? TOKEN : undefined);
    }
    const pushes = calls.filter((c) => c.args.includes("push"));
    expect(pushes).toHaveLength(1);
    const head = git(remote, "rev-parse", "refs/heads/botcave/12-t1");
    expect(pushes[0].args.slice(-2)).toEqual([remote, `${head}:refs/heads/botcave/12-t1`]);
    expect(pushes[0].args).toContain("--no-follow-tags");
    expect(pushes[0].args).toContain("--no-recurse-submodules");
    expect(pushes[0].args.some((a) => a.startsWith("--force") || a.startsWith("+"))).toBe(false);
  });
});

describe("gitEnv", () => {
  it("con il token: prompt spento, helper azzerati poi helper che legge la variabile", () => {
    const env = gitEnv("x");
    expect(env.BOTCAVE_GIT_TOKEN).toBe("x");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe(
      '!f() { echo username=x-access-token; echo "password=$BOTCAVE_GIT_TOKEN"; }; f',
    );
  });

  it("senza token: niente variabile né helper", () => {
    process.env.BOTCAVE_GIT_TOKEN = "ereditato";
    try {
      const env = gitEnv(null);
      expect("BOTCAVE_GIT_TOKEN" in env).toBe(false);
      expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      delete process.env.BOTCAVE_GIT_TOKEN;
    }
  });
});

describe("classifyGitError", () => {
  it("frasi di git → messaggi fissi", () => {
    expect(classifyGitError(" ! [rejected] HEAD -> botcave/1-t1 (non-fast-forward)", "push")).toBe(
      GIT_MESSAGES.pushChanged,
    );
    expect(classifyGitError(" ! [rejected] HEAD -> botcave/1-t1 (fetch first)", "push")).toBe(GIT_MESSAGES.pushChanged);
    expect(classifyGitError("fatal: unable to access: Could not resolve host: github.com", "fetch")).toBe(
      "repository non raggiungibile: riprova più tardi",
    );
    expect(classifyGitError(" ! [remote rejected] HEAD -> botcave/1-t1 (refusing to allow a GitHub App)", "push")).toBe(
      "push non riuscito: GitHub ha rifiutato le modifiche",
    );
    expect(classifyGitError("fatal: Could not resolve host: github.com", "push")).toBe(
      "push non riuscito: riprova più tardi",
    );
    expect(classifyGitError("qualcosa di strano", "fetch")).toBe(GIT_MESSAGES.unreachable);
  });
});
