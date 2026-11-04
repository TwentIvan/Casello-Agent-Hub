import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInside, resolveWorkspace, WorkspaceError } from "./workspace";
import { tempDir } from "./test/helpers";

let base: string;
let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: base, cleanup } = await tempDir());
  root = path.join(base, "root");
  await mkdir(path.join(root, "progetto", "sotto"), { recursive: true });
  await mkdir(path.join(base, "root-evil"), { recursive: true });
});
afterEach(async () => cleanup());

const invalid = new WorkspaceError();

describe("resolveWorkspace", () => {
  it("risolve una cartella dentro la radice", async () => {
    const ws = await resolveWorkspace(root, "progetto/sotto");
    expect(ws.endsWith(path.join("root", "progetto", "sotto"))).toBe(true);
  });

  it("normalizza barre e punti", async () => {
    const ws = await resolveWorkspace(root, "progetto//./sotto/");
    expect(ws.endsWith(path.join("root", "progetto", "sotto"))).toBe(true);
  });

  it.each([null, "", "   ", "/etc", "../root-evil", "progetto/../../root-evil"])("rifiuta %j", async (rel) => {
    await expect(resolveWorkspace(root, rel)).rejects.toThrow(invalid);
  });

  it("rifiuta una cartella inesistente", async () => {
    await expect(resolveWorkspace(root, "manca")).rejects.toThrow("spazio di lavoro non valido");
  });

  it("rifiuta una radice inesistente", async () => {
    await expect(resolveWorkspace(path.join(base, "nessuna"), "progetto")).rejects.toThrow(WorkspaceError);
  });

  it("rifiuta un link simbolico che esce dalla radice verso una cartella col prefisso della radice", async () => {
    await symlink(path.join(base, "root-evil"), path.join(root, "link"));
    await expect(resolveWorkspace(root, "link")).rejects.toThrow(invalid);
  });

  it("rifiuta un link simbolico intermedio che esce dalla radice", async () => {
    await mkdir(path.join(base, "fuori", "dentro"), { recursive: true });
    await symlink(path.join(base, "fuori"), path.join(root, "ponte"));
    await expect(resolveWorkspace(root, "ponte/dentro")).rejects.toThrow(invalid);
  });

  it("accetta un link simbolico che resta dentro la radice", async () => {
    await symlink(path.join(root, "progetto"), path.join(root, "alias"));
    const ws = await resolveWorkspace(root, "alias");
    expect(ws.endsWith(path.join("root", "progetto"))).toBe(true);
  });

  it("accetta una radice che è essa stessa un link simbolico", async () => {
    await symlink(root, path.join(base, "radice-link"));
    const ws = await resolveWorkspace(path.join(base, "radice-link"), "progetto");
    expect(ws.endsWith(path.join("root", "progetto"))).toBe(true);
  });
});

describe("isInside", () => {
  it("confronta con il separatore di percorso", () => {
    expect(isInside("/root", "/root")).toBe(true);
    expect(isInside("/root", "/root/a")).toBe(true);
    expect(isInside("/root", "/root-evil")).toBe(false);
    expect(isInside("/root", "/root-evil/a")).toBe(false);
    expect(isInside("/root", "/")).toBe(false);
  });
});
