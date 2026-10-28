import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db, pool, analysesTable, analysisItemsTable, appToolsTable, appsTable } from "@workspace/db";
import { recordPhaseResult } from "./phase-record";

const evidence = [{ source: "code", location: "src/a.ts:1" }];

const toolProposal = (over: Record<string, unknown> = {}) => ({
  name: "list_teams",
  description: "Elenco squadre",
  kind: "http",
  identity: "user",
  requiresConfirmation: false,
  readOnly: true,
  paramsSchema: { type: "object", properties: { q: { type: "string" } } },
  definition: { method: "GET", path: "/teams", paramLocations: { q: "query" } },
  area: "Squadre",
  evidence,
  needsVerification: false,
  ...over,
});

const catalogResult = (tool = toolProposal()) => ({
  tools: [tool],
  endpoints: [
    { title: "Classifica", area: "Squadre", method: "get", path: "/standings", motivation: "Manca", patch: "router.get('/standings')", evidence },
  ],
});

const completionResult = {
  items: [
    {
      key: "standings",
      phase: 1,
      area: "Squadre",
      title: "Classifica",
      missing: "Pagina senza backend",
      evidence,
      goal: "Classifica",
      dependsOn: [],
      files: ["src/a.ts"],
      effort: "M",
      doneWhen: "La pagina mostra la classifica",
      implementation: "Aggiungere la route",
    },
  ],
};

let appId: number;
let analysisId: number;

const loadItems = () =>
  db.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, analysisId)).orderBy(asc(analysisItemsTable.position));

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  const [app] = await db.insert(appsTable).values({ name: "Fanta", slug: "fanta-record", baseUrl: "http://127.0.0.1:1" }).returning();
  appId = app!.id;
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId, model: "openrouter/auto", sources: { code: "none", openapi: false, description: false }, maxTokens: 1000 })
    .returning();
  analysisId = analysis!.id;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

describe("recordPhaseResult", () => {
  it("la position prosegue tra fasi diverse della stessa analisi", async () => {
    const first = await recordPhaseResult({ analysisId, appId, phase: "catalog", result: catalogResult() });
    expect(first).toBe(2);
    const second = await recordPhaseResult({ analysisId, appId, phase: "completion", result: completionResult });
    expect(second).toBe(1);
    expect((await loadItems()).map((i) => i.position)).toEqual([1, 2, 3]);
  });

  it("una fase senza elementi non inserisce nulla", async () => {
    expect(await recordPhaseResult({ analysisId, appId, phase: "map", result: {} })).toBe(0);
    expect(await loadItems()).toHaveLength(0);
  });

  it("un tool del catalogo già esistente e diverso risulta changed, uno nuovo new", async () => {
    await db.insert(appToolsTable).values({
      appId,
      name: "list_teams",
      description: "Vecchia descrizione",
      kind: "http",
      identity: "user",
      requiresConfirmation: false,
      readOnly: true,
      paramsSchema: { type: "object", properties: { q: { type: "string" } } },
      definition: { method: "GET", path: "/teams", paramLocations: { q: "query" } },
      status: "active",
    });
    await recordPhaseResult({ analysisId, appId, phase: "catalog", result: catalogResult() });
    const items = await loadItems();
    expect(items.find((i) => i.ref === "tool:list_teams")!.diff).toBe("changed");
    expect(items.find((i) => i.chapter === "endpoint")!.diff).toBe("new");
    expect(items.find((i) => i.ref === "tool:list_teams")!.evidence).toEqual(evidence);
  });
});
