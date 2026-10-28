import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoMap, REPO_MAP_MAX_CHARS } from "./repo-map";
import { SourceTree } from "./source-tree";
import type { OpenApiDoc } from "./sources";

const trees: SourceTree[] = [];
function makeTree(files: Record<string, string>): SourceTree {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  const tree = SourceTree.fromZip(zipSync(entries));
  trees.push(tree);
  return tree;
}
afterEach(async () => {
  await Promise.all(trees.splice(0).map((t) => t.dispose()));
});

function doc(operations: OpenApiDoc["operations"]): OpenApiDoc {
  return { source: "https://app.example/openapi.json", operations, raw: {} };
}

describe("buildRepoMap", () => {
  it("senza sorgenti", () => {
    expect(buildRepoMap(null, null)).toBe("");
  });

  it("stesso tree, stesso testo", () => {
    const tree = makeTree({ "src/a.ts": "a\nb\n", "src/b.py": "x\n", "README.md": "# Ciao\n" });
    const d = doc([{ method: "GET", path: "/api/x", operationId: "x", summary: "Ics" }]);
    expect(buildRepoMap(tree, d)).toBe(buildRepoMap(tree, d));
  });

  it("albero: righe e linguaggio per file", () => {
    const map = buildRepoMap(makeTree({ "src/a.ts": "a\nb\nc\n", "src/b.py": "x\n" }), null);
    expect(map).toContain("src/");
    expect(map).toContain("a.ts (3 righe, TypeScript)");
    expect(map).toContain("b.py (1 righe, Python)");
  });

  it("cartella con molti file compressa, i 5 più grandi visibili", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 40; i++) files[`src/c/big-${String(i).padStart(2, "0")}.tsx`] = "riga\n".repeat(i);
    const map = buildRepoMap(makeTree(files), null);
    expect(map).toContain("src/c/ (40 file .tsx,");
    for (const n of [40, 39, 38, 37, 36]) expect(map).toContain(`big-${n}.tsx`);
    expect(map).not.toContain("big-01.tsx");
    // 820 righe in totale, con separatore delle migliaia
    expect(map).toContain("820 righe)");
  });

  it("riepilogo con estensioni miste", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`d/f${i}.${i < 20 ? "tsx" : "ts"}`] = "x\n";
    expect(buildRepoMap(makeTree(files), null)).toContain("d/ (30 file: 20 .tsx, 10 .ts, 30 righe)");
  });

  it("sotto il tetto anche con migliaia di file", () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 300; d++) for (let f = 0; f < 10; f++) files[`modulo-${d}/sotto/file-numero-${f}.ts`] = "x\n".repeat(f + 1);
    const map = buildRepoMap(makeTree(files), null);
    expect(map.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS);
  });

  it("tronca per righe intere con il rinvio a list_dir", () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 1500; d++) files[`cartella-molto-lunga-numero-${d}/file.ts`] = "x\n";
    const map = buildRepoMap(makeTree(files), null);
    expect(map.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS);
    expect(map).toContain("[...mappa troncata: usa list_dir]");
  });

  it("esclude lockfile, generati e test", () => {
    const map = buildRepoMap(
      makeTree({ "pnpm-lock.yaml": "lock\n", "src/a.test.ts": "t\n", "src/a.ts": "a\n", "src/g.ts": "// @generated\nx\n" }),
      null,
    );
    expect(map).not.toContain("pnpm-lock.yaml");
    expect(map).not.toContain("a.test.ts");
    expect(map).not.toContain("g.ts");
    expect(map).toContain("a.ts");
  });

  describe("punti d'ingresso", () => {
    it("package.json, variabili d'ambiente e README", () => {
      const map = buildRepoMap(
        makeTree({
          "package.json": JSON.stringify({ name: "mia-app", scripts: { dev: "vite" }, dependencies: { express: "^5.0.0" } }),
          ".env.example": "SECRET=abc\n# commento\nPORT=3000\n",
          "pnpm-workspace.yaml": "packages:\n  - artifacts/*\n  - lib/*\n",
          "Dockerfile": "FROM node\n",
          "docker/web.Dockerfile": "FROM nginx\n",
          "README.md": "# Titolo\nDescrizione\n",
        }),
        null,
      );
      expect(map).toContain("mia-app");
      expect(map).toContain("dev: vite");
      expect(map).toContain("express");
      expect(map).toContain("SECRET");
      expect(map).toContain("PORT");
      expect(map).not.toContain("abc");
      expect(map).toContain("artifacts/*");
      expect(map).toContain("docker/web.Dockerfile");
      expect(map).toContain("Descrizione");
    });

    it("package.json non valido: riga dedicata, nessuna eccezione", () => {
      const map = buildRepoMap(makeTree({ "package.json": "{ non json" }), null);
      expect(map).toContain("package.json non leggibile");
    });

    it("openapi.yaml nel codice senza documento: conteggio per risorsa", () => {
      const yaml = "openapi: 3.0.0\npaths:\n  /api/squadre:\n    get: {}\n    post: {}\n  /api/squadre/{id}:\n    get: {}\n";
      const map = buildRepoMap(makeTree({ "openapi.yaml": yaml }), null);
      expect(map).toContain("squadre: 3 operazioni");
    });

    it("openapi.yaml nel codice con documento: sezione omessa", () => {
      const yaml = "openapi: 3.0.0\npaths:\n  /api/squadre:\n    get: {}\n";
      const map = buildRepoMap(makeTree({ "openapi.yaml": yaml }), doc([]));
      expect(map).not.toContain("squadre: 1 operazioni");
    });
  });

  describe("operazioni OpenAPI", () => {
    it("una riga per operazione, summary accorciato", () => {
      const map = buildRepoMap(
        null,
        doc([
          { method: "GET", path: "/api/squadre", operationId: "a", summary: "Elenco" },
          { method: "POST", path: "/api/squadre", operationId: "b", summary: "x".repeat(300) },
          { method: "DELETE", path: "/api/squadre/{id}", operationId: "c", summary: null },
        ]),
      );
      expect(map).toContain("GET /api/squadre — Elenco");
      expect(map).toContain(`POST /api/squadre — ${"x".repeat(150)}\n`);
      expect(map).toMatch(/DELETE \/api\/squadre\/\{id\}$/);
    });

    it("oltre il tetto: riepilogo per risorsa", () => {
      const ops: OpenApiDoc["operations"] = Array.from({ length: 2000 }, (_, i) => ({
        method: "GET",
        path: `/api/squadre/${i}/dettaglio-molto-lungo`,
        operationId: `op${i}`,
        summary: "Riassunto abbastanza lungo dell'operazione",
      }));
      ops.push({ method: "GET", path: "/api/giocatori", operationId: "g", summary: null });
      const map = buildRepoMap(null, doc(ops));
      expect(map).toContain("squadre: 2000 operazioni");
      expect(map).toContain("giocatori: 1 operazioni");
      expect(map).toContain("usa list_operations");
      expect(map.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS);
    });
  });
});
