import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./log";
import { tempDir } from "./test/helpers";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => cleanup());

describe("createLogger", () => {
  it("scrive su file con livello e data", async () => {
    const log = createLogger({ dir, stdout: false });
    log.info("nodo avviato");
    log.error("qualcosa è andato storto");
    const text = await readFile(path.join(dir, "casello-nodo.log"), "utf8");
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT.* INFO nodo avviato\n.* ERROR qualcosa è andato storto\n$/);
  });

  it("oscura i token e i segreti dichiarati", async () => {
    const log = createLogger({ dir, stdout: false, secrets: ["lease-super-segreta"] });
    log.warn("token cas_abcDEF123_xyz e lease lease-super-segreta");
    const text = await readFile(path.join(dir, "casello-nodo.log"), "utf8");
    expect(text).not.toContain("cas_abcDEF123_xyz");
    expect(text).not.toContain("lease-super-segreta");
    expect(text).toContain("***");
  });

  it("ruota a dimensione massima tenendo al più 5 file", async () => {
    const log = createLogger({ dir, stdout: false, maxBytes: 200, maxFiles: 5 });
    for (let i = 0; i < 100; i++) log.info(`riga numero ${i} `.padEnd(60, "x"));
    const files = (await readdir(dir)).sort();
    expect(files).toEqual([
      "casello-nodo.log",
      "casello-nodo.log.1",
      "casello-nodo.log.2",
      "casello-nodo.log.3",
      "casello-nodo.log.4",
    ]);
    const current = await readFile(path.join(dir, "casello-nodo.log"), "utf8");
    expect(current).toContain("riga numero 99");
  });
});
