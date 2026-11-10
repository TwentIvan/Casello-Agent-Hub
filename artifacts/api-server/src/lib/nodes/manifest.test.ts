import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, isBelowMinVersion, loadNodeManifest, resetNodeManifestCache, updateFor, type NodeManifest } from "./manifest";

const dir = mkdtempSync(join(tmpdir(), "manifest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetNodeManifestCache());

const manifest: NodeManifest = {
  version: "0.3.0",
  minVersion: "0.2.0",
  binary: { file: "casello-nodo-0.3.0", sha256: "b".repeat(64), size: 1234 },
  app: { file: "Botcave-Nodo-0.3.0.zip", sha256: "a".repeat(64), size: 99 },
};

describe("loadNodeManifest", () => {
  it("legge un file valido e lo tiene in memoria", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(manifest));
    expect(loadNodeManifest(path)).toEqual(manifest);
    writeFileSync(path, "{}");
    expect(loadNodeManifest(path)).toEqual(manifest);
  });

  it("file assente o non valido → null", () => {
    expect(loadNodeManifest(join(dir, "manca.json"))).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: "1.0.0" }));
    expect(loadNodeManifest(bad)).toBeNull();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "non json");
    expect(loadNodeManifest(broken)).toBeNull();
  });
});

describe("versioni", () => {
  it("confronta x.y.z numericamente", () => {
    expect(compareVersions("0.2.5", "0.3.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("boh", "1.0.0")).toBeNull();
  });

  it("isBelowMinVersion vale per ogni kind, non senza manifest o versione", () => {
    expect(isBelowMinVersion("0.1.9", manifest)).toBe(true);
    expect(isBelowMinVersion("0.2.0", manifest)).toBe(false);
    expect(isBelowMinVersion("0.1.0", null)).toBe(false);
    expect(isBelowMinVersion(null, manifest)).toBe(false);
    expect(isBelowMinVersion("strana", manifest)).toBe(false);
  });

  it("updateFor: solo kind app, solo versioni più vecchie, required sotto la minima, non la versione fallita", () => {
    expect(updateFor("0.2.5", "app", manifest)).toEqual({ version: "0.3.0", sha256: "b".repeat(64), size: 1234, required: false });
    expect(updateFor("0.1.9", "app", manifest)).toMatchObject({ required: true });
    expect(updateFor("0.3.0", "app", manifest)).toBeNull();
    expect(updateFor("0.2.5", "cli", manifest)).toBeNull();
    expect(updateFor("0.2.5", null, manifest)).toBeNull();
    expect(updateFor("0.2.5", "app", null)).toBeNull();
    expect(updateFor("0.2.5", "app", manifest, "0.3.0")).toBeNull();
    expect(updateFor("0.2.5", "app", manifest, "0.2.9")).not.toBeNull();
  });
});
