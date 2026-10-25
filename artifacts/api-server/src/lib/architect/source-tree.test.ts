import { deflateSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SOURCE_LIMITS, SourceTree, SourceTreeError } from "./source-tree";

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries);
}

describe("SourceTree", () => {
  it("legge e lista", () => {
    const tree = SourceTree.fromZip(
      zip({ "src/a.ts": "const a = 1;\n", "src/b/c.ts": "export {};\n" }),
    );
    expect(tree.list("src")).toEqual(["src/a.ts", "src/b/"]);
    expect(tree.list("")).toEqual(["src/"]);
    expect(tree.list("/")).toEqual(["src/"]);
    expect(tree.list("src", 2)).toEqual(["src/a.ts", "src/b/", "src/b/c.ts"]);
    expect(tree.read("src/a.ts").content).toBe("const a = 1;");
    expect(tree.read("./src/a.ts").totalLines).toBe(1);
    expect(tree.has("src/b/c.ts")).toBe(true);
    expect(tree.fileCount).toBe(2);
    expect(() => tree.list("nope")).toThrow(SourceTreeError);
    expect(() => tree.read("nope.ts")).toThrow(SourceTreeError);
  });

  it("toglie la cartella radice", () => {
    const bytes = zip({
      "repo-abc123/src/a.ts": "x",
      "repo-abc123/README.md": "y",
    });
    const tree = SourceTree.fromZip(bytes, { stripTopFolder: true });
    expect(tree.has("src/a.ts")).toBe(true);
    expect(tree.has("README.md")).toBe(true);
    const kept = SourceTree.fromZip(bytes);
    expect(kept.has("repo-abc123/src/a.ts")).toBe(true);
  });

  it("scarta percorsi pericolosi", () => {
    const tree = SourceTree.fromZip(
      zip({
        "../evil.ts": "x",
        "/etc/passwd": "x",
        "a/../../x.ts": "x",
        "C:/win.ts": "x",
        "ok.ts": "x",
      }),
    );
    expect(tree.has("evil.ts")).toBe(false);
    expect(tree.has("../evil.ts")).toBe(false);
    expect(tree.has("etc/passwd")).toBe(false);
    expect(tree.has("/etc/passwd")).toBe(false);
    expect(tree.has("x.ts")).toBe(false);
    expect(tree.has("win.ts")).toBe(false);
    expect(tree.fileCount).toBe(1);
    expect(() => tree.read("../evil.ts")).toThrow(SourceTreeError);
  });

  it("esclude binari, cartelle ignorate e file grandi", () => {
    const tree = SourceTree.fromZip(
      zip({
        "src/ok.ts": "ok",
        "logo.png": "not really a png",
        "data.bin": new Uint8Array([1, 2, 0, 3]),
        "node_modules/x/index.js": "x",
        ".git/config": "x",
        "dist/out.js": "x",
        "big.ts": "a".repeat(SOURCE_LIMITS.maxFileBytes + 1),
      }),
    );
    expect(tree.fileCount).toBe(1);
    expect(tree.skipped).toEqual({ binary: 2, tooLarge: 1, ignored: 3 });
  });

  it("zip bomb: file troppo grande escluso in base alla dimensione dichiarata", () => {
    const bomb = new Uint8Array(300 * 1024).fill(0x61);
    const tree = SourceTree.fromZip(zip({ "bomb.txt": bomb, "a.ts": "x" }));
    expect(tree.has("bomb.txt")).toBe(false);
    expect(tree.skipped.tooLarge).toBe(1);
    expect(tree.has("a.ts")).toBe(true);
  });

  it("zip bomb: totale oltre il limite", () => {
    const chunk = "a".repeat(SOURCE_LIMITS.maxFileBytes);
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) files[`f${i}.txt`] = chunk;
    expect(() => SourceTree.fromZip(zip(files))).toThrow(/limite/);
    expect(() => SourceTree.fromZip(zip(files))).toThrow(SourceTreeError);
  });

  it("zip oltre maxZipBytes", () => {
    const big = new Uint8Array(SOURCE_LIMITS.maxZipBytes + 1);
    expect(() => SourceTree.fromZip(big)).toThrow(/limite/);
  });

  it("troppi file", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= SOURCE_LIMITS.maxFiles; i++) files[`d/f${i}.txt`] = "x";
    expect(() => SourceTree.fromZip(zip(files))).toThrow(/limite/);
  });

  it("zip non valido", () => {
    expect(() => SourceTree.fromZip(new Uint8Array([1, 2, 3]))).toThrow(
      SourceTreeError,
    );
  });

  it("read paginato", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `riga ${i + 1}`);
    const tree = SourceTree.fromZip(zip({ "big.txt": lines.join("\n") + "\n" }));
    const first = tree.read("big.txt");
    expect(first.totalLines).toBe(1000);
    expect(first.truncated).toBe(true);
    expect(first.content.split("\n")).toHaveLength(400);
    expect(first.content.startsWith("riga 1\n")).toBe(true);
    const part = tree.read("big.txt", 10, 12);
    expect(part.content).toBe("riga 10\nriga 11\nriga 12");
    const rest = tree.read("big.txt", 990);
    expect(rest.truncated).toBe(false);
    expect(rest.content.endsWith("riga 1000")).toBe(true);
    const wide = tree.read("big.txt", 1, 1000);
    expect(wide.content.split("\n")).toHaveLength(400);
  });

  it("read limita i caratteri", () => {
    const tree = SourceTree.fromZip(
      zip({ "w.txt": Array(300).fill("x".repeat(200)).join("\n") }),
    );
    const r = tree.read("w.txt");
    expect(r.content.length).toBeLessThanOrEqual(SOURCE_LIMITS.maxReadChars);
    expect(r.truncated).toBe(true);
  });

  it("search", async () => {
    const tree = SourceTree.fromZip(
      zip({
        "src/a.ts": "const Foo = 1;\nconst bar = 2;\n  foo again\n",
        "src/b.js": "foo in js\n",
        "docs/x.md": "foo doc\n",
      }),
    );
    const sub = await tree.search("FOO");
    expect(sub.map((r) => `${r.path}:${r.line}`)).toEqual([
      "docs/x.md:1",
      "src/a.ts:1",
      "src/a.ts:3",
      "src/b.js:1",
    ]);
    expect(sub[2]!.text).toBe("foo again");
    expect(await tree.search("^const \\w+ = \\d", { regex: true })).toHaveLength(2);
    expect(
      (await tree.search("foo", { glob: "**/*.ts" })).map((r) => r.path),
    ).toEqual(["src/a.ts", "src/a.ts"]);
    expect(
      (await tree.search("foo", { glob: "**/*.ts", regex: true })).map((r) => r.path),
    ).toEqual(["src/a.ts"]);
    expect(await tree.search("foo", { glob: "src/*.js" })).toHaveLength(1);
    expect(await tree.search("foo", { glob: "src/?.js" })).toHaveLength(1);
    expect(await tree.search("foo", { glob: "*.ts" })).toHaveLength(0);
    await expect(tree.search("(", { regex: true })).rejects.toThrow(SourceTreeError);
    await tree.dispose();
  });

  it("search limita i risultati e il testo", async () => {
    const tree = SourceTree.fromZip(
      zip({ "m.txt": Array(250).fill("match " + "z".repeat(500)).join("\n") }),
    );
    const res = await tree.search("match");
    expect(res).toHaveLength(SOURCE_LIMITS.maxSearchResults);
    expect(res[0]!.text.length).toBe(200);
  });

  it("percorso __proto__ e duplicati: vale la prima voce", () => {
    const tree = SourceTree.fromZip(
      rawZip([
        { name: "__proto__", data: strToU8("p") },
        { name: "a.ts", data: strToU8("primo") },
        { name: "a.ts", data: strToU8("secondo") },
      ]),
    );
    expect(tree.read("__proto__").content).toBe("p");
    expect(tree.read("a.ts").content).toBe("primo");
    expect(tree.fileCount).toBe(2);
  });

  it("ReDoS: la ricerca regex è interrotta e poi disabilitata", async () => {
    const tree = SourceTree.fromZip(zip({ "a.txt": "a".repeat(40) + "!\nciao\n" }));
    try {
      expect(await tree.search("ciao", { regex: true })).toHaveLength(1);
      const t0 = Date.now();
      await expect(tree.search("^(a+)+$", { regex: true })).rejects.toThrow(
        /ricerca regex troppo lenta/,
      );
      expect(Date.now() - t0).toBeLessThan(3500);
      await expect(tree.search("ciao", { regex: true })).rejects.toThrow(SourceTreeError);
      expect(await tree.search("ciao")).toHaveLength(1);
    } finally {
      await tree.dispose();
    }
  }, 20_000);

  it("regex: pattern troppo lungo, righe lunghe saltate, dispose", async () => {
    const tree = SourceTree.fromZip(
      zip({ "a.txt": "x".repeat(10_001) + "\nx\n" }),
    );
    await expect(
      tree.search("a".repeat(201), { regex: true }),
    ).rejects.toThrow(SourceTreeError);
    const res = await tree.search("x", { regex: true });
    expect(res).toEqual([{ path: "a.txt", line: 2, text: "x" }]);
    await tree.dispose();
    await expect(tree.search("x", { regex: true })).resolves.toHaveLength(1);
    await tree.dispose();
  }, 20_000);
});

describe("SourceTree: zip ostili", () => {
  it("voce stored che mente sulla dimensione", () => {
    const bytes = rawZip([{ name: "a.txt", data: new Uint8Array(1000).fill(97), usize: 10 }]);
    expect(() => SourceTree.fromZip(bytes)).toThrow(SourceTreeError);
  });

  it("due voci della central directory sullo stesso header locale", () => {
    const bytes = rawZip([
      { name: "a.txt", data: new Uint8Array(1000).fill(97) },
      { name: "b.txt", data: new Uint8Array(0), sameLocalAs: 0, csize: 1000, usize: 1000 },
    ]);
    expect(() => SourceTree.fromZip(bytes)).toThrow(/sovrapposte/);
  });

  it("deflate con output reale oltre il dichiarato: rifiutato in fretta", () => {
    const real = deflateSync(new Uint8Array(8 * 1024 * 1024).fill(97), { level: 9 });
    const bytes = rawZip([{ name: "a.txt", method: 8, data: real, usize: 100 }]);
    const t0 = Date.now();
    expect(() => SourceTree.fromZip(bytes)).toThrow(SourceTreeError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("deflate con output reale inferiore al dichiarato: rifiutato", () => {
    const real = deflateSync(strToU8("abc"));
    const bytes = rawZip([{ name: "a.txt", method: 8, data: real, usize: 100 }]);
    expect(() => SourceTree.fromZip(bytes)).toThrow(SourceTreeError);
  });

  it("deflate oltre maxFileBytes dichiarato: saltato senza decomprimere", () => {
    // dati compressi non validi: se venissero decompressi, l'archivio verrebbe rifiutato
    const bytes = rawZip([
      { name: "big.txt", method: 8, data: new Uint8Array([1, 2, 3]), usize: 5_000_000 },
      { name: "ok.txt", data: strToU8("ok") },
    ]);
    const tree = SourceTree.fromZip(bytes);
    expect(tree.skipped.tooLarge).toBe(1);
    expect(tree.has("ok.txt")).toBe(true);
  });

  it("voce cifrata o metodo non supportato", () => {
    expect(() =>
      SourceTree.fromZip(rawZip([{ name: "a.txt", data: strToU8("x"), flags: 1 }])),
    ).toThrow(/cifrate/);
    expect(() =>
      SourceTree.fromZip(rawZip([{ name: "a.txt", data: strToU8("x"), method: 12 }])),
    ).toThrow(/metodo/);
  });

  it("troppe voci grezze", () => {
    const bytes = zip({ "a.txt": "1", "b.txt": "2", "c.txt": "3" });
    expect(() => SourceTree.fromZip(bytes, { limits: { maxRawEntries: 2 } })).toThrow(
      /troppe voci/,
    );
    expect(SourceTree.fromZip(bytes, { limits: { maxRawEntries: 3 } }).fileCount).toBe(3);
  });

  it("zip64 rifiutato", () => {
    const bytes = rawZip([{ name: "a.txt", data: strToU8("x") }], { zip64: true });
    expect(() => SourceTree.fromZip(bytes)).toThrow(/zip64 non supportato/);
  });
});

interface RawEntry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  csize?: number;
  usize?: number;
  /** Indice di una voce precedente di cui riusare l'header locale. */
  sameLocalAs?: number;
}

/** Costruisce uno zip a mano, anche con intestazioni incoerenti. */
function rawZip(entries: RawEntry[], opts: { zip64?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (u: Uint8Array) => {
    parts.push(u);
    pos += u.length;
  };
  for (const e of entries) {
    if (e.sameLocalAs !== undefined) {
      offsets.push(offsets[e.sameLocalAs]!);
      continue;
    }
    offsets.push(pos);
    const name = strToU8(e.name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(6, e.flags ?? 0, true);
    h.setUint16(8, e.method ?? 0, true);
    h.setUint32(18, e.csize ?? e.data.length, true);
    h.setUint32(22, e.usize ?? e.data.length, true);
    h.setUint16(26, name.length, true);
    push(new Uint8Array(h.buffer));
    push(name);
    push(e.data);
  }
  const cdStart = pos;
  entries.forEach((e, i) => {
    const name = strToU8(e.name);
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(8, e.flags ?? 0, true);
    h.setUint16(10, e.method ?? 0, true);
    h.setUint32(20, e.csize ?? e.data.length, true);
    h.setUint32(24, e.usize ?? e.data.length, true);
    h.setUint16(28, name.length, true);
    h.setUint32(42, offsets[i]!, true);
    push(new Uint8Array(h.buffer));
    push(name);
  });
  const cdSize = pos - cdStart;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, opts.zip64 ? 0xffff : entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  push(new Uint8Array(eocd.buffer));
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("SourceTree: glob e EOCD", () => {
  it("glob patologico: nessun blocco (DP, non regex)", async () => {
    const tree = SourceTree.fromZip(zip({ [`src/${"a".repeat(50)}.ts`]: "x" }));
    for (const glob of ["src/*a*a*a*a*a*a*a*a*aZ", "**a**a**a**a**a**a**a**a**aZ"]) {
      const t0 = Date.now();
      expect(await tree.search("x", { glob })).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(50);
    }
    await expect(tree.search("x", { glob: "a".repeat(201) })).rejects.toThrow(SourceTreeError);
  });

  it("semantica del glob", async () => {
    const tree = SourceTree.fromZip(
      zip({ "a.ts": "x", "src/b.ts": "x", "src/d/c.ts": "x", "src/d/e/f.ts": "x", "q/x.ts": "x" }),
    );
    const g = async (glob: string) =>
      (await tree.search("x", { glob })).map((r) => r.path);
    expect(await g("**/*.ts")).toEqual(["a.ts", "q/x.ts", "src/b.ts", "src/d/c.ts", "src/d/e/f.ts"]);
    expect(await g("src/**/c.ts")).toEqual(["src/d/c.ts"]);
    expect(await g("src/**/b.ts")).toEqual(["src/b.ts"]); // zero cartelle
    expect(await g("src/***/b.ts")).toEqual(["src/b.ts"]);
    expect(await g("src/**")).toEqual(["src/b.ts", "src/d/c.ts", "src/d/e/f.ts"]);
    expect(await g("src/*")).toEqual(["src/b.ts"]);
    expect(await g("src?b.ts")).toEqual([]); // ? non vale "/"
    expect(await g("src/?.ts")).toEqual(["src/b.ts"]);
  });

  it("finto EOCD nel commento non vale", () => {
    const good = zip({ "a.ts": "x" });
    const fake = new Uint8Array(27); // EOCD finto + 5 byte di commento
    new DataView(fake.buffer).setUint32(0, 0x06054b50, true);
    // vero EOCD con commento = EOCD finto
    const out = new Uint8Array(good.length + fake.length);
    out.set(good);
    out.set(fake, good.length);
    new DataView(out.buffer).setUint16(good.length - 2, fake.length, true);
    const tree = SourceTree.fromZip(out);
    expect(tree.has("a.ts")).toBe(true);
    // EOCD finto in coda senza commento corrispondente: archivio non valido
    const bad = new Uint8Array(good.length + fake.length);
    bad.set(good);
    bad.set(fake, good.length);
    expect(() => SourceTree.fromZip(bad)).toThrow(SourceTreeError);
  });
});
