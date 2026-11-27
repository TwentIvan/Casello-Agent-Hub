import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RUNNER_DATABASE_URL, recipeEnv, runRecipe, type TestRecipe } from "./recipe-run";
import { stopBackground } from "./shell";

let root: string;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function recipe(over: Partial<TestRecipe>): TestRecipe {
  return { install: [], build: [], services: [], postgres: false, schema: [], env: {}, startUrl: "/", login: null, ...over };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "collaudo-recipe-"));
});
afterEach(() => stopBackground());
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runRecipe", () => {
  it("servizio node -e che risponde su readyPath → ok con la porta", async () => {
    const port = await freePort();
    const server = `node -e "require('http').createServer((q,s)=>{s.statusCode=q.url==='/pronto'?200:404;s.end('ok')}).listen(${port})"`;
    const r = await runRecipe(
      recipe({ install: ["echo installa"], env: { SALUTO: "ciao" }, build: ["test \"$SALUTO\" = ciao"], services: [{ name: "web", command: server, port, readyPath: "/pronto" }] }),
      root,
      { readyTimeoutMs: 15_000, backgroundWaitMs: 200 },
    );
    expect(r.ok).toBe(true);
    expect(r.port).toBe(port);
    expect(r.output).toContain("web");
  });

  it("passo fallito → ok false e servizi non avviati", async () => {
    const r = await runRecipe(recipe({ install: ["exit 2"], services: [{ name: "web", command: "sleep 30", port: 1, readyPath: "/" }] }), root);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("exit 2");
  });

  it("servizio che non risponde entro l'attesa → ok false", async () => {
    const port = await freePort();
    const r = await runRecipe(recipe({ services: [{ name: "muto", command: "sleep 30", port, readyPath: "/" }] }), root, {
      readyTimeoutMs: 1_500,
      backgroundWaitMs: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("muto");
  });
});

describe("recipeEnv", () => {
  const base: TestRecipe = { install: [], build: [], services: [], postgres: false, schema: [], env: { A: "1" }, startUrl: "/", login: null };
  it("RUNNER_DATABASE_URL sempre; DATABASE_URL solo con postgres e se la ricetta non la dà", () => {
    expect(recipeEnv(base)).toEqual({ RUNNER_DATABASE_URL, A: "1" });
    expect(recipeEnv({ ...base, postgres: true })).toEqual({ RUNNER_DATABASE_URL, A: "1", DATABASE_URL: RUNNER_DATABASE_URL });
    expect(recipeEnv({ ...base, postgres: true, env: { DATABASE_URL: "postgres://altro" } }).DATABASE_URL).toBe("postgres://altro");
  });
});
