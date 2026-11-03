import { afterEach, describe, expect, it } from "vitest";
import { startFakeMcp, type FakeMcp } from "../../../test/fake-mcp";
import type { McpToolInfo } from "../tools/mcp-client";
import type { AppConnection } from "../tools/types";
import { describeMcpTool, listMcpToolsPage, loadMcpSource } from "./mcp-source";
import { FULL_READ_LIMITS } from "./phase-loop";

const conn = (mcpUrl: string | null): AppConnection => ({
  baseUrl: "http://app.test",
  internalBaseUrl: null,
  userAuth: null,
  serviceAuth: null,
  serviceSecretEnc: null,
  mcpUrl,
});

const info = (name: string, over: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name,
  description: `Descrizione di ${name}`,
  inputSchema: { type: "object", properties: {} },
  level: "L0",
  levelDeclared: true,
  ...over,
});

let fake: FakeMcp | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("loadMcpSource", () => {
  it("app senza mcpUrl: null, nessuna riga di log", async () => {
    const log: string[] = [];
    expect(await loadMcpSource(conn(null), (m) => log.push(m))).toBeNull();
    expect(log).toEqual([]);
  });

  it("server raggiungibile: elenco con i livelli e riga di log con il conteggio", async () => {
    fake = await startFakeMcp({
      tools: [
        { name: "leggi", annotations: { readOnlyHint: true } },
        { name: "manda_mail", _meta: { "casello/level": "L2" } },
      ],
    });
    const log: string[] = [];
    const tools = await loadMcpSource(conn(fake.url), (m) => log.push(m));
    expect(tools?.map((t) => [t.name, t.level, t.levelDeclared])).toEqual([
      ["leggi", "L0", false],
      ["manda_mail", "L2", true],
    ]);
    expect(log).toEqual(["MCP: 2 strumenti"]);
  });

  it("server spento: null e «MCP: non raggiungibile»", async () => {
    fake = await startFakeMcp({ tools: [] });
    const url = fake.url;
    await fake.close();
    fake = null;
    const log: string[] = [];
    expect(await loadMcpSource(conn(url), (m) => log.push(m))).toBeNull();
    expect(log).toEqual(["MCP: non raggiungibile"]);
  });
});

describe("listMcpToolsPage", () => {
  const tools = [info("zeta", { level: "L2", levelDeclared: false }), info("alfa"), info("beta_due", { description: null })];

  it("ordinati per nome, con livello (o ripiego) e descrizione", () => {
    const out = listMcpToolsPage(tools, {}, FULL_READ_LIMITS);
    expect(out.content.split("\n")).toEqual([
      "alfa — livello L0 — Descrizione di alfa",
      "beta_due — livello L0",
      "zeta — livello L2 (non dichiarato: ripiego) — Descrizione di zeta",
    ]);
    expect(out.log).toBe("list_mcp_tools (3 strumenti)");
  });

  it("prefisso e offset come list_operations", () => {
    expect(listMcpToolsPage(tools, { prefix: "be" }, FULL_READ_LIMITS).content).toBe("beta_due — livello L0");
    const page = listMcpToolsPage(tools, { offset: 1 }, FULL_READ_LIMITS);
    expect(page.content.split("\n")[0]).toBe("Strumenti 2-3 di 3:");
    expect(listMcpToolsPage(tools, { prefix: "x" }, FULL_READ_LIMITS).content).toBe("Nessuno strumento con prefisso x sul server MCP.");
    expect(listMcpToolsPage(tools, { offset: 9 }, FULL_READ_LIMITS).content).toBe("Nessuno strumento oltre offset=9 (sono 3).");
  });

  it("oltre il tetto dell'output: pagina e indicazione dell'offset", () => {
    const many = Array.from({ length: 50 }, (_, i) => info(`t${String(i).padStart(2, "0")}`, { description: "d".repeat(100) }));
    const limits = { ...FULL_READ_LIMITS, maxToolOutputChars: 1_500 };
    const out = listMcpToolsPage(many, {}, limits);
    const lines = out.content.split("\n");
    expect(lines[0]).toMatch(/^Strumenti 1-\d+ di 50:$/);
    expect(lines.at(-1)).toMatch(/^\[altri \d+ strumenti: usa offset=\d+ o un prefix\]$/);
    expect(out.content.length).toBeLessThanOrEqual(1_500);
  });
});

describe("describeMcpTool", () => {
  it("nome, livello, descrizione e schema; nome sconosciuto: messaggio", () => {
    const text = describeMcpTool([info("alfa", { level: "L1", inputSchema: { type: "object", required: ["x"] } })], "alfa");
    expect(text).toBe(
      'alfa\nlivello L1\ndescrizione: Descrizione di alfa\nschema dei parametri: {"type":"object","required":["x"]}',
    );
    expect(describeMcpTool([], "nulla")).toBe('strumento "nulla" non trovato sul server MCP');
  });
});
