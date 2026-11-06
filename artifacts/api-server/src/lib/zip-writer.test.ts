import { describe, expect, it } from "vitest";
import { extractEntry, readZipEntries } from "./architect/zip-reader";
import { buildZip } from "./zip-writer";

describe("buildZip", () => {
  it("scrive uno zip che il lettore dell'architetto rilegge con gli stessi nomi e contenuti", () => {
    const files = [
      { name: "dev.md", content: Buffer.from("---\nname: dev\n---\n# Dev àèì\n", "utf8") },
      { name: "tester.md", content: Buffer.from("contenuto del tester", "utf8") },
      { name: "vuoto.md", content: Buffer.alloc(0) },
    ];
    const zip = buildZip(files);
    const entries = readZipEntries(new Uint8Array(zip), 10);
    expect(entries.map((e) => e.name)).toEqual(["dev.md", "tester.md", "vuoto.md"]);
    for (const [i, e] of entries.entries()) {
      expect(e.method).toBe(0);
      expect(Buffer.from(extractEntry(new Uint8Array(zip), e)).equals(files[i]!.content)).toBe(true);
    }
  });

  it("zip vuoto valido e nomi non ASCII rifiutati", () => {
    expect(readZipEntries(new Uint8Array(buildZip([])), 10)).toEqual([]);
    expect(() => buildZip([{ name: "città.md", content: Buffer.from("x") }])).toThrow();
  });
});
