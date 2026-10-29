import { afterAll, describe, expect, it } from "vitest";
import { analysesTable, analysisItemsTable, appsTable, db, pool } from "@workspace/db";
import { chatPlannedItems } from "./planned";

afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

async function newApp(slug: string) {
  const [app] = await db.insert(appsTable).values({ name: slug, slug, baseUrl: "https://x.example" }).returning();
  return app!;
}
async function newAnalysis(appId: number) {
  const [a] = await db.insert(analysesTable).values({ appId, model: "openrouter/auto", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
    .returning();
  return a!;
}
let seq = 0;
async function addItem(
  analysisId: number,
  chapter: "endpoint" | "completion" | "evolution" | "tool",
  payload: unknown,
  over: { origin?: "architect" | "chat"; status?: "pending" | "approved" } = {},
) {
  seq += 1;
  await db.insert(analysisItemsTable).values({
    analysisId,
    chapter,
    ref: `${chapter}:${seq}`,
    position: seq,
    payload,
    diff: "new",
    origin: over.origin ?? "chat",
    status: over.status ?? "approved",
  });
}

describe("chatPlannedItems", () => {
  it("prende solo le voci chat approvate delle analisi precedenti della stessa app", async () => {
    const app = await newApp("planned-a");
    const other = await newApp("planned-b");
    const prev = await newAnalysis(app.id);
    const otherPrev = await newAnalysis(other.id);
    const current = await newAnalysis(app.id);

    await addItem(prev.id, "completion", { title: "Esporta CSV" });
    await addItem(prev.id, "endpoint", { method: "post", path: "/orders" });
    await addItem(prev.id, "evolution", { title: "Notifiche" }, { status: "pending" });
    await addItem(prev.id, "completion", { title: "Dell'architetto" }, { origin: "architect" });
    await addItem(prev.id, "tool", { name: "t" });
    await addItem(otherPrev.id, "completion", { title: "Altra app" });
    await addItem(current.id, "completion", { title: "Nella stessa analisi" });

    const items = await chatPlannedItems(app.id, current.id);
    expect(items).toEqual(
      expect.arrayContaining([
        { chapter: "completion", title: "Esporta CSV" },
        { chapter: "endpoint", title: "POST /orders" },
      ]),
    );
    expect(items).toHaveLength(2);
  });
});
