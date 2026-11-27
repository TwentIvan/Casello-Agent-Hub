import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_OUTPUT, runShell, stopBackground } from "./shell";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "collaudo-shell-"));
  await mkdir(path.join(root, "sub"));
});
afterEach(() => stopBackground());
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runShell", () => {
  it("riuscito: uscita del comando", async () => {
    const r = await runShell({ command: "echo ciao" }, root);
    expect(r).toEqual({ ok: true, output: "ciao\n" });
  });

  it("codice di uscita 1 → ok false", async () => {
    const r = await runShell({ command: "echo no >&2; exit 1" }, root);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no");
    expect(r.output).toContain("codice 1");
  });

  it("timeout di 1 s su sleep 5 → tempo scaduto", async () => {
    const start = Date.now();
    const r = await runShell({ command: "sleep 5", timeoutSec: 1 }, root);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("tempo scaduto");
    expect(Date.now() - start).toBeLessThan(4_000);
  });

  it("processo setsid che tiene la pipe aperta: risolve appena esce il comando", async () => {
    const start = Date.now();
    const r = await runShell({ command: "perl -e 'use POSIX; setsid(); sleep 8' & echo fatto" }, root);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("fatto");
    expect(Date.now() - start).toBeLessThan(4_000);
  });

  it("processo setsid con la pipe aperta e timeout: risolve entro timeout + grazia", async () => {
    const start = Date.now();
    const r = await runShell({ command: "perl -e 'use POSIX; setsid(); sleep 15' & sleep 10", timeoutSec: 1 }, root);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("tempo scaduto");
    expect(Date.now() - start).toBeLessThan(1_000 + 5_000 + 1_000 + 1_000);
  }, 15_000);

  it("cwd fuori dal repository → rifiutato", async () => {
    const r = await runShell({ command: "pwd", cwd: "../" }, root);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("cartella non valida");
  });

  it("cwd dentro il repository", async () => {
    const r = await runShell({ command: "pwd", cwd: "sub" }, root);
    expect(r.ok).toBe(true);
    expect(r.output.trim().endsWith(`${path.sep}sub`)).toBe(true);
  });

  it("uscita di 20 000 caratteri → 8 000", async () => {
    const r = await runShell({ command: "head -c 20000 /dev/zero | tr '\\0' 'a'" }, root);
    expect(r.ok).toBe(true);
    expect(r.output.length).toBe(MAX_OUTPUT);
  });

  it("l'ambiente non porta il codice né i token", async () => {
    process.env.COLLAUDO_CODICE = "segreto";
    process.env.ACTIONS_RUNTIME_TOKEN = "segreto";
    try {
      const r = await runShell({ command: "env" }, root);
      expect(r.output).not.toContain("segreto");
    } finally {
      delete process.env.COLLAUDO_CODICE;
      delete process.env.ACTIONS_RUNTIME_TOKEN;
    }
  });

  it("background: risponde con id e prime righe e il processo resta acceso", async () => {
    const r = await runShell({ command: "echo pronto; sleep 30", background: true }, root, { backgroundWaitMs: 300 });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^id: bg-\d+/);
    expect(r.output).toContain("pronto");
  });

  it("background che esce subito con errore → ok false", async () => {
    const r = await runShell({ command: "echo rotto; exit 3", background: true }, root, { backgroundWaitMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("rotto");
  });
});
