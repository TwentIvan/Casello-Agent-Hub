import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-run-programmate.sql";

describe("migrazione 2026-11-24-run-programmate", () => {
  let db: PGlite;
  let agentId: number;

  beforeAll(async () => {
    // Schema attuale senza la colonna e il vincolo nuovi: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_schedule_check; ALTER TABLE agent_triggers DROP COLUMN cron;`);
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
    await db.exec("INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com')");
    const r = await db.query<{ id: number }>(
      "INSERT INTO agents (app_id, name, system_prompt) SELECT id, 'Agente', 'p' FROM apps LIMIT 1 RETURNING id",
    );
    agentId = r.rows[0]!.id;
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge schedule a trigger_kind", async () => {
    const r = await db.query<any>(
      "SELECT 1 AS ok FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'trigger_kind' AND e.enumlabel = 'schedule'",
    );
    expect(r.rows).toHaveLength(1);
  });

  it("un innesco schedule vuole cron e prossima run", async () => {
    await expect(
      db.exec(`INSERT INTO agent_triggers (agent_id, kind, name, next_poll_at) VALUES (${agentId}, 'schedule', 'senza cron', now())`),
    ).rejects.toThrow(/agent_triggers_schedule_check/);
    await db.exec(
      `INSERT INTO agent_triggers (agent_id, kind, name, cron, next_poll_at, interval_seconds) VALUES (${agentId}, 'schedule', 'ogni mattina', '0 8 * * *', now(), null)`,
    );
    const r = await db.query<any>("SELECT cron FROM agent_triggers WHERE name = 'ogni mattina'");
    expect(r.rows).toEqual([{ cron: "0 8 * * *" }]);
  });
});
