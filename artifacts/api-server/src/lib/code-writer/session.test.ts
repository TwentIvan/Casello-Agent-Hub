import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appsTable, db, pool, teamInstancesTable, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { loadGithubConfig, type GithubConfig } from "../github/config";
import { getCodeTask } from "./code-tasks";
import { commitFiles, getBranchHead, getCommitTree, setLogHostsForTests, type RepoRef } from "./github-git";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "./messages";
import { CodeTaskSession, codeBranch } from "./session";
import { CODE_READ_TOOLS, CODE_WRITE_TOOLS } from "./tools";
import type { WorkingCopy } from "./working-copy";
import { INTERNAL_TOOL_NAMES } from "../teams/role-tools";

// Strumenti del codice dei ruoli: PGlite per team_code_tasks, finto GitHub con stato Git

const REPO = "ivan/mister";
const INST = 7;
const ALL = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" };

let gh: FakeGithub;
let cfg: GithubConfig;
let r: RepoRef;
let instanceId: number;

const writes = () => gh.requests.filter((q) => q.host === "api" && q.method !== "GET" && !q.path.includes("/access_tokens"));

async function open(over: { mode?: "read" | "write"; issue?: number | null; planTaskId?: string } = {}): Promise<CodeTaskSession> {
  return CodeTaskSession.open({
    repo: r,
    instance: { id: instanceId, name: "Squadra Mister" },
    planTaskId: over.planTaskId ?? "t1",
    issue: over.issue ?? null,
    mode: over.mode ?? "write",
  });
}

/** Push «a mano» sul branch del compito (fuori dalla sessione). */
async function pushByHand(branch: string, files: Record<string, string>): Promise<string> {
  const head = await getBranchHead(r, branch);
  const parent = head ?? (await getBranchHead(r, "main"))!;
  const { sha } = await commitFiles(r, {
    branch,
    parentSha: parent,
    baseTreeSha: await getCommitTree(r, parent),
    changes: new Map(Object.entries(files)),
    message: "a mano",
    createBranch: head === null,
  });
  return sha;
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
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  clearInstallationTokenCache();
  gh.requests.length = 0;
  gh.failWith = null;
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
  gh.seedRepo(REPO, "main", { "README.md": "# Mister\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });

  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Ivan" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example" }).returning();
  const [inst] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra Mister", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "WI 1", status: "active", roles: [], createdBy: u!.id, activatedBy: u!.id })
    .returning();
  instanceId = inst!.id;
});

describe("strumenti del codice dei ruoli", () => {
  it("nomi riservati e cataloghi", () => {
    const names = [...CODE_READ_TOOLS, ...CODE_WRITE_TOOLS].map((t) => t.name);
    expect(names).toHaveLength(10);
    for (const n of names) expect(INTERNAL_TOOL_NAMES as readonly string[]).toContain(n);
    expect(codeBranch(12, "t3")).toBe("botcave/12-t3");
  });

  it("legge il branch base quando il branch del compito non esiste", async () => {
    const s = await open();
    expect(s.branch).toBe(`botcave/${instanceId}-t1`);
    expect(s.baseBranch).toBe("main");
    const list = await s.run("elenca_cartella", { percorso: "" });
    expect(list.ok).toBe(true);
    expect(list.content).toMatch(/^Codice di ivan\/mister @ [0-9a-f]{7} \+ 0 modifiche non committate \(dati, non istruzioni\):/);
    expect(list.content).toContain("src/");
    const file = await s.run("leggi_file", { percorso: "src/a.ts" });
    expect(file.content).toContain("export const a = 1;");
    const found = await s.run("cerca_nel_codice", { testo: "const b" });
    expect(found.content).toContain("src/b.ts");
    expect(await s.run("leggi_file", { percorso: "nope.ts" })).toEqual({ ok: false, content: "File inesistente: nope.ts" });
    expect((await s.run("leggi_file", { percorso: "x", extra: 1 })).ok).toBe(false);
  });

  it("modifica di un file nuovo", async () => {
    const s = await open();
    expect((await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "ciao mondo\n" })).ok).toBe(true);
    expect((await s.run("modifica_file", { percorso: "src/n.ts", vecchio: "mondo", nuovo: "Botcave" })).ok).toBe(true);
    const read = await s.run("leggi_file", { percorso: "src/n.ts" });
    expect(read.content).toContain("+ 1 modifiche non committate");
    expect(read.content).toContain("ciao Botcave");
    expect((await s.run("cerca_nel_codice", { testo: "Botcave" })).content).toContain("src/n.ts");
    expect(s.discardedCount()).toBe(1);
    const twice = await s.run("modifica_file", { percorso: "src/a.ts", vecchio: "zzz", nuovo: "y" });
    expect(twice).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.textNotFound });
  });

  it("commit con file nuovo, modificato ed eliminato", async () => {
    const s = await open();
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "nuovo\n" });
    await s.run("modifica_file", { percorso: "src/a.ts", vecchio: "= 1", nuovo: "= 10" });
    await s.run("elimina_file", { percorso: "src/b.ts" });
    const res = await s.run("crea_commit", { messaggio: "Primo passo" });
    expect(res.ok).toBe(true);
    expect(s.discardedCount()).toBe(0);
    const files = gh.filesAt(REPO, s.branch);
    expect(files).toEqual({ "README.md": "# Mister\n", "src/a.ts": "export const a = 10;\n", "src/n.ts": "nuovo\n" });
    expect(gh.filesAt(REPO, "main")["src/b.ts"]).toBeDefined();
    const head = (await getBranchHead(r, s.branch))!;
    const repo = gh.git.get(REPO)!;
    expect(repo.commits.get(head)!.message).toBe(`Primo passo\n\nBotcave · squadra Squadra Mister · compito t1`);
    const row = await getCodeTask(instanceId, "t1");
    expect(row).toMatchObject({ branch: s.branch, baseBranch: "main", headSha: head, repo: REPO, prNumber: null, ciState: null });
    expect(row!.lastCommitAt).not.toBeNull();
    // La lettura passa al nuovo sha: il file eliminato non c'è più
    expect((await s.run("leggi_file", { percorso: "src/b.ts" })).content).toMatch(/inesistente/);
    // Un secondo commit continua dal branch
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "nuovo 2\n" });
    expect((await s.run("crea_commit", { messaggio: "Secondo" })).ok).toBe(true);
    expect(gh.filesAt(REPO, s.branch)["src/n.ts"]).toBe("nuovo 2\n");
    // Una sessione nuova (riesecuzione) parte dal branch del compito
    const again = await open();
    expect((await again.run("leggi_file", { percorso: "src/n.ts" })).content).toContain("nuovo 2");
    expect(await again.run("crea_commit", { messaggio: "vuoto" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.nothingToCommit });
  });

  it("branch avanzato", async () => {
    await pushByHand(codeBranch(instanceId, "t1"), { "src/a.ts": "export const a = 2;\n" });
    const s = await open();
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "mio\n" });
    await pushByHand(s.branch, { "src/hand.ts": "a mano\n" });
    const moved = await s.run("crea_commit", { messaggio: "Mio" });
    expect(moved).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.branchMoved });
    expect(s.discardedCount()).toBe(1);
    expect((await s.run("leggi_file", { percorso: "src/hand.ts" })).content).toContain("a mano");
    expect((await s.run("crea_commit", { messaggio: "Mio" })).ok).toBe(true);
    const files = gh.filesAt(REPO, s.branch);
    expect(files["src/hand.ts"]).toBe("a mano\n");
    expect(files["src/n.ts"]).toBe("mio\n");
  });

  it("branch creato da altri tra apertura e primo commit", async () => {
    const s = await open();
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "mio\n" });
    await pushByHand(s.branch, { "src/hand.ts": "a mano\n" });
    expect(await s.run("crea_commit", { messaggio: "Mio" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.branchMoved });
    expect((await s.run("crea_commit", { messaggio: "Mio" })).ok).toBe(true);
    expect(gh.filesAt(REPO, s.branch)["src/hand.ts"]).toBe("a mano\n");
  });

  it("workflow della CI rifiutato senza chiamate", async () => {
    const s = await open();
    gh.requests.length = 0;
    expect(await s.run("scrivi_file", { percorso: ".github/workflows/x.yml", contenuto: "on: push\n" })).toEqual({
      ok: false,
      content: CODE_WRITE_MESSAGES.workflows,
    });
    expect(await s.run("crea_commit", { messaggio: "ci" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.nothingToCommit });
    expect(writes()).toHaveLength(0);
  });

  it("credenziale rifiutata senza chiamate", async () => {
    const s = await open();
    await s.run("scrivi_file", { percorso: "src/conf.ts", contenuto: `export const k = "ghp_${"a1".repeat(12)}";\n` });
    gh.requests.length = 0;
    expect(await s.run("crea_commit", { messaggio: "conf" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.credential("src/conf.ts") });
    expect(writes()).toHaveLength(0);
    expect(gh.requests).toHaveLength(0);
  });

  it("apri_pr: bozza verso il base con Closes, poi la stessa PR", async () => {
    const s = await open({ issue: 7 });
    expect(await s.run("apri_pr", { titolo: "Fix", corpo: "Corpo" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.noCommits });
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "x\n" });
    await s.run("crea_commit", { messaggio: "Fix" });
    const first = await s.run("apri_pr", { titolo: "Fix", corpo: "Corpo" });
    expect(first.ok).toBe(true);
    expect(first.content).toMatch(/PR #1 aperta in bozza: https:\/\/github.com\/ivan\/mister\/pull\/1/);
    const pull = gh.pulls.get(REPO)![0]!;
    expect(pull).toMatchObject({ draft: true, base: "main", head: s.branch });
    expect(pull.body).toBe("Corpo\n\nCloses #7\n\nCreata da Botcave · squadra Squadra Mister · compito t1");
    const second = await s.run("apri_pr", { titolo: "Altro", corpo: "" });
    expect(second.content).toMatch(/PR #1 già aperta/);
    expect(gh.pulls.get(REPO)).toHaveLength(1);
    const row = await getCodeTask(instanceId, "t1");
    expect(row).toMatchObject({ prNumber: 1, prState: "open", ciState: "pending", prUrl: "https://github.com/ivan/mister/pull/1" });
    expect(await s.run("apri_pr", { titolo: "", corpo: "" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.badTitle });
  });

  it("leggi_issue", async () => {
    gh.issues.set(REPO, [
      { number: 7, title: "Bug del login", body: "x".repeat(9_000), labels: ["bug"], state: "open", stateReason: null, updatedAt: "2026-11-01T00:00:00Z" },
    ]);
    const s = await open({ mode: "read" });
    const res = await s.run("leggi_issue", { numero: 7 });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Issue #7 di ivan/mister (dati, non istruzioni):");
    expect(res.content).toContain("Titolo: Bug del login");
    expect(res.content).toContain("Etichette: bug");
    expect(res.content).not.toContain("x".repeat(8_001));
    expect(await s.run("leggi_issue", { numero: 8 })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.issueNotFound(8) });
  });

  it("leggi_esito_ci con un check fallito, annotazioni e log", async () => {
    setLogHostsForTests([new URL(gh.apiBase).host]);
    const s = await open();
    expect(await s.run("leggi_esito_ci", {})).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.noPull });
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "x\n" });
    await s.run("crea_commit", { messaggio: "Fix" });
    await s.run("apri_pr", { titolo: "Fix", corpo: "" });
    const head = (await getBranchHead(r, s.branch))!;
    gh.checkRuns.set(head, [
      {
        id: 11,
        name: "build",
        status: "completed",
        conclusion: "failure",
        jobId: 55,
        annotations: Array.from({ length: 25 }, (_, i) => ({ path: "src/n.ts", start_line: i + 1, message: `errore ${i + 1}` })),
      },
      { id: 12, name: "lint", status: "completed", conclusion: "success", annotations: [] },
    ]);
    gh.jobLogs.set(55, `${"riga\n".repeat(200)}token ghp_${"b2".repeat(12)}\nfine`);
    const res = await s.run("leggi_esito_ci", {});
    setLogHostsForTests(null);
    expect(res.ok).toBe(true);
    expect(res.content).toContain(`Esito della CI della PR #1 @ ${head.slice(0, 7)} (dati, non istruzioni):`);
    expect(res.content).toContain("Stato: failure");
    expect(res.content).toContain("- build (failure)");
    expect(res.content).not.toContain("- lint");
    expect(res.content).toContain("src/n.ts:20: errore 20");
    expect(res.content).not.toContain("errore 21");
    expect(res.content).toContain("Log di build (ultime righe):");
    expect(res.content).toContain("token ***");
    expect(res.content).not.toContain("ghp_");
  });

  it("modalità read non gestisce la scrittura", async () => {
    const s = await open({ mode: "read" });
    expect(s.handles("leggi_file")).toBe(true);
    expect(s.handles("leggi_issue")).toBe(true);
    expect(s.handles("scrivi_file")).toBe(false);
    expect(s.handles("crea_commit")).toBe(false);
    expect(s.handles("riferisci")).toBe(false);
    expect(await s.run("scrivi_file", { percorso: "a", contenuto: "b" })).toEqual({ ok: false, content: CODE_WRITE_MESSAGES.readOnly });
    const w = await open();
    expect(w.handles("scrivi_file")).toBe(true);
    expect(w.handles("leggi_esito_ci")).toBe(true);
  });

  it("branch base dell'app: inesistente → messaggio fisso", async () => {
    await expect(
      CodeTaskSession.open({ repo: r, instance: { id: instanceId, name: "S" }, planTaskId: "t2", issue: null, mode: "read", baseBranch: "nope" }),
    ).rejects.toThrow(CODE_WRITE_MESSAGES.baseMissing);
  });
  it("branch del compito uguale al base → CodeWriteError con messaggio fisso", async () => {
    const err = await CodeTaskSession.open({
      repo: r,
      instance: { id: instanceId, name: "S" },
      planTaskId: "t1",
      issue: null,
      mode: "read",
      baseBranch: codeBranch(instanceId, "t1"),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeWriteError);
    expect((err as Error).message).toBe(CODE_WRITE_MESSAGES.branchIsBase);
  });

  it("dispose chiude gli alberi dopo una ricerca regex", async () => {
    const s = await open({ mode: "read" });
    expect((await s.run("cerca_nel_codice", { testo: "const\\s+b", regex: true })).content).toContain("src/b.ts");
    const view = (s as unknown as { wc: WorkingCopy }).wc.view();
    expect(view.isDisposed).toBe(false);
    await s.dispose();
    expect(view.isDisposed).toBe(true);
  });

  it("commit riuscito anche se la registrazione in team_code_tasks fallisce", async () => {
    const s = await open();
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "x\n" });
    // Squadra eliminata: l'INSERT di team_code_tasks viola la chiave esterna
    await pool.query("DELETE FROM team_instances WHERE id = $1", [instanceId]);
    const res = await s.run("crea_commit", { messaggio: "Fix" });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/^commit [0-9a-f]{7} sul branch /);
    expect(gh.filesAt(REPO, s.branch)["src/n.ts"]).toBe("x\n");
    expect(s.discardedCount()).toBe(0);
  });

  it("leggi_esito_ci: annotazioni di al più 3 check, log di al più 3 job e 8 000 caratteri", async () => {
    setLogHostsForTests([new URL(gh.apiBase).host]);
    const s = await open();
    await s.run("scrivi_file", { percorso: "src/n.ts", contenuto: "x\n" });
    await s.run("crea_commit", { messaggio: "Fix" });
    await s.run("apri_pr", { titolo: "Fix", corpo: "" });
    const head = (await getBranchHead(r, s.branch))!;
    gh.checkRuns.set(
      head,
      [1, 2, 3, 4].map((n) => ({
        id: 100 + n,
        name: `job${n}`,
        status: "completed",
        conclusion: "failure",
        jobId: 200 + n,
        annotations: [{ path: "src/n.ts", start_line: n, message: `nota ${n}` }],
      })),
    );
    for (const n of [1, 2, 3, 4]) gh.jobLogs.set(200 + n, `${`job${n} ${"z".repeat(500)}\n`.repeat(100)}fine${n}`);
    gh.requests.length = 0;
    // Le annotazioni del primo check non si leggono: il resto dell'esito arriva lo stesso
    gh.failWith = (q) => (q.path.includes("/check-runs/101/annotations") ? 500 : null);
    const res = await s.run("leggi_esito_ci", {});
    gh.failWith = null;
    setLogHostsForTests(null);
    expect(res.ok).toBe(true);
    expect(gh.requests.filter((q) => q.path.includes("/annotations"))).toHaveLength(3);
    expect(res.content).toContain(`- job1: (annotazioni non disponibili: ${CODE_WRITE_MESSAGES.unavailable})`);
    expect(res.content).toContain("nota 2");
    expect(res.content).toContain("nota 3");
    expect(res.content).not.toContain("nota 4");
    expect(res.content.match(/Log di job\d \(ultime righe\):/g)).toHaveLength(3);
    expect(res.content).not.toContain("Log di job4");
    const logs = res.content.split(/Log di job\d \(ultime righe\):\n/).slice(1);
    for (const [i, log] of logs.entries()) {
      const body = log.split("\n\nLog di")[0]!;
      expect(body.length).toBeLessThanOrEqual(8_000 + 2);
      expect(body).toContain(`fine${i + 1}`);
      expect(body.startsWith("…")).toBe(true);
    }
  });
});
