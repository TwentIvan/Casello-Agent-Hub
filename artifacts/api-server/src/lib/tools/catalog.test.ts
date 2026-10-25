import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, agentsTable, appToolsTable, agentToolsTable } from "@workspace/db";
import { loadAgentTools, loadAppConnection, maskSensitiveArgs, toFunctionTools } from "./catalog";
import type { CatalogTool } from "./types";

const HTTP_DEF = { method: "GET", path: "/items", paramLocations: {} };

async function seed() {
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      internalBaseUrl: "http://mister:3000/api",
      userAuth: { header: "authorization", scheme: "Bearer" },
    })
    .returning();
  const [general] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Generale", role: "general" })
    .returning();
  const [area] = await db.insert(agentsTable).values({ appId: app!.id, name: "Rose", role: "area" }).returning();
  const tools = await db
    .insert(appToolsTable)
    .values([
      { appId: app!.id, name: "list_a", kind: "http", status: "active", definition: HTTP_DEF },
      { appId: app!.id, name: "list_b", kind: "http", status: "active", definition: HTTP_DEF },
      { appId: app!.id, name: "draft_c", kind: "http", status: "draft", definition: HTTP_DEF },
      // Definizione non più valida: va saltata
      { appId: app!.id, name: "broken_d", kind: "http", status: "active", definition: { method: "GET" } },
      // Fase 1: nessun client esegue tool ui o composti, non vanno offerti al modello
      { appId: app!.id, name: "open_page", kind: "ui", status: "active", definition: { action: "navigate" } },
      {
        appId: app!.id,
        name: "combo",
        kind: "composite",
        status: "active",
        definition: { steps: [{ tool: "list_a", args: {} }], output: {} },
      },
    ])
    .returning();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await db.insert(agentToolsTable).values([
    { agentId: area!.id, toolId: byName["list_b"]!.id },
    { agentId: area!.id, toolId: byName["draft_c"]!.id },
    { agentId: area!.id, toolId: byName["open_page"]!.id },
    { agentId: area!.id, toolId: byName["combo"]!.id },
  ]);
  return { app: app!, general: general!, area: area! };
}

// Il DB di prova è condiviso tra i file: lo si lascia vuoto
afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

describe("catalogo dei tool", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  });

  it("l'agente general vede tutti i tool http active dell'app e non i draft né ui/composite", async () => {
    const { general } = await seed();
    const tools = await loadAgentTools(general.id);
    expect(tools.map((t) => t.name).sort()).toEqual(["list_a", "list_b"]);
    expect(tools[0]!.definition).toMatchObject({ method: "GET", path: "/items" });
  });

  it("l'agente area vede solo i tool http collegati e active", async () => {
    const { area } = await seed();
    const tools = await loadAgentTools(area.id);
    expect(tools.map((t) => t.name)).toEqual(["list_b"]);
  });

  it("loadAppConnection restituisce i campi di esecuzione dell'app", async () => {
    const { app } = await seed();
    const conn = await loadAppConnection(app.id);
    expect(conn).toEqual({
      baseUrl: "http://mister.example",
      internalBaseUrl: "http://mister:3000/api",
      userAuth: { header: "authorization", scheme: "Bearer" },
      serviceAuth: null,
      serviceSecretEnc: null,
    });
  });

  it("esegue query concorrenti sul pool condiviso (PGlite con più connessioni)", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => pool.query("select $1::int as n, pg_sleep(0.05)", [i])),
    );
    expect(results.map((r) => r.rows[0].n)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

function tool(paramsSchema: Record<string, unknown>): CatalogTool {
  return {
    id: 1,
    appId: 1,
    name: "login",
    description: "Accede",
    kind: "http",
    identity: "user",
    requiresConfirmation: false,
    readOnly: false,
    status: "active",
    paramsSchema,
    definition: { method: "POST", path: "/login", paramLocations: {} },
    evidence: null,
    needsVerification: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("maskSensitiveArgs", () => {
  const schema = {
    type: "object",
    properties: {
      user: { type: "string" },
      password: { type: "string", "x-sensitive": true },
    },
  };

  it("oscura le proprietà marcate x-sensitive", () => {
    expect(maskSensitiveArgs(tool(schema), { user: "ivan", password: "segreta" })).toEqual({
      user: "ivan",
      password: "***",
    });
  });

  it("non modifica gli argomenti ricevuti", () => {
    const args = { user: "ivan", password: "segreta" };
    maskSensitiveArgs(tool(schema), args);
    expect(args.password).toBe("segreta");
  });

  it("argomenti non oggetto con proprietà sensibili nello schema: oscurati per intero", () => {
    expect(maskSensitiveArgs(tool(schema), '{"password":"segr')).toBe("***");
  });
});

describe("toFunctionTools", () => {
  it("converte in function tool senza le estensioni x-*", () => {
    const t = tool({ type: "object", properties: { password: { type: "string", "x-sensitive": true } } });
    expect(toFunctionTools([t])).toEqual([
      {
        type: "function",
        function: {
          name: "login",
          description: "Accede",
          parameters: { type: "object", properties: { password: { type: "string" } } },
        },
      },
    ]);
  });

  it("non offre al modello i tool ui e composite", () => {
    const http = tool({ type: "object", properties: {} });
    const ui = { ...http, name: "apri", kind: "ui" as const, definition: { action: "navigate" } };
    const composite = { ...http, name: "combo", kind: "composite" as const, definition: { steps: [], output: {} } };
    expect(toFunctionTools([http, ui, composite]).map((t) => (t.type === "function" ? t.function.name : t.type))).toEqual(["login"]);
  });
});
