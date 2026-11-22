import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, appBootstrapsTable, usersTable } from "@workspace/db";
import { buildChecklist } from "./checklist";
import { checkHealth } from "./health";
import { bootstrapNames } from "./naming";

let id: number;

beforeEach(async () => {
  await pool.query("TRUNCATE users, app_bootstraps RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  const [r] = await db
    .insert(appBootstrapsTable)
    .values({ userId: u!.id, slug: "portfolio", name: "Portfolio", domain: "portfolio.fantamister.cloud", repo: "ivan/portfolio", installationId: 1, brief: "b", status: "done" })
    .returning();
  id = r!.id;
});

afterAll(async () => {
  delete process.env["EMBED_ALLOWED_ORIGINS"];
  await pool.query("TRUNCATE users, app_bootstraps RESTART IDENTITY CASCADE");
});

describe("lista guidata", () => {
  it("ha_sette_voci_e_embed_origin_e_automatica", async () => {
    process.env["EMBED_ALLOWED_ORIGINS"] = "https://portfolio.fantamister.cloud";
    const [row] = await db.select().from(appBootstrapsTable).where(eq(appBootstrapsTable.id, id));
    const list = buildChecklist(row!, bootstrapNames("portfolio", "ivan"));
    expect(list.map((i) => i.key)).toEqual(["dns", "neon", "coolify_api", "coolify_web", "secrets", "embed_origin", "health"]);
    const origin = list.find((i) => i.key === "embed_origin")!;
    expect(origin.done).toBe(true);
    expect(origin.auto).toBe(true);
    expect(list.find((i) => i.key === "health")!.done).toBe(false);
    expect(list.find((i) => i.key === "dns")!.auto).toBe(false);
  });
});

describe("checkHealth", () => {
  it("risposta_ok_valorizza_healthOkAt", async () => {
    let asked = "";
    const ok = await checkHealth(id, async (u) => {
      asked = u;
      return { ok: true, finalUrl: u, kind: "json", charset: null, body: Buffer.from("{}"), truncated: false, redirects: 0 };
    });
    expect(ok).toBe(true);
    expect(asked).toBe("https://portfolio.fantamister.cloud/api/healthz");
    const [row] = await db.select().from(appBootstrapsTable).where(eq(appBootstrapsTable.id, id));
    expect(row!.healthOkAt).not.toBeNull();
    expect(row!.healthCheckedAt).not.toBeNull();
  });

  it("risposta_negativa_lascia_healthOkAt_nullo", async () => {
    const ok = await checkHealth(id, async () => ({ ok: false, code: "http_status" }));
    expect(ok).toBe(false);
    const [row] = await db.select().from(appBootstrapsTable).where(eq(appBootstrapsTable.id, id));
    expect(row!.healthOkAt).toBeNull();
    expect(row!.healthCheckedAt).not.toBeNull();
  });
});
