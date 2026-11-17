import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-17-segnalazione-bug", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema precedente alla migrazione: si tolgono ciò che è già riportato in docs/schema-casello.sql e si ripristina con lo script, due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      DROP TABLE bug_report_messages;
      DROP TABLE bug_reports;
      DROP TYPE bug_report_status;
      DROP TYPE bug_reporter_kind;
      DROP TYPE bug_message_author;
      DROP INDEX team_instances_bug_team_uidx;
      ALTER TABLE team_instances DROP COLUMN bug_team;
      ALTER TABLE apps DROP CONSTRAINT apps_bug_reports_daily_limit_check;
      ALTER TABLE apps DROP COLUMN bug_reports_enabled, DROP COLUMN bug_reports_daily_limit,
        DROP COLUMN identity_secret_enc, DROP COLUMN identity_secret_set_at;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-17-segnalazione-bug.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-17-segnalazione-bug.sql"));
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('A', 'a', 'https://a.example')`);
  });

  afterAll(async () => {
    await db.close();
  });

  const enumValues = async (t: string) =>
    (
      await db.query<any>(
        "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder",
        [t],
      )
    ).rows.map((x) => x.enumlabel);

  it("gli enum hanno i valori attesi", async () => {
    expect(await enumValues("bug_report_status")).toEqual([
      "received", "triage", "needs_info", "pending_approval", "in_progress", "fixed", "not_a_bug", "duplicate", "rejected",
    ]);
    expect(await enumValues("bug_reporter_kind")).toEqual(["identity", "browser"]);
    expect(await enumValues("bug_message_author")).toEqual(["reporter", "lead", "owner"]);
    expect(await enumValues("pending_action_kind")).toContain("bug");
  });

  it("le colonne dell'App hanno i default e il limite giornaliero è vincolato a 1..500", async () => {
    const r = await db.query<any>("SELECT bug_reports_enabled, bug_reports_daily_limit, identity_secret_enc FROM apps");
    expect(r.rows).toEqual([{ bug_reports_enabled: false, bug_reports_daily_limit: 20, identity_secret_enc: null }]);
    await expect(db.exec("UPDATE apps SET bug_reports_daily_limit = 0")).rejects.toThrow(/check/i);
    await expect(db.exec("UPDATE apps SET bug_reports_daily_limit = 501")).rejects.toThrow(/check/i);
    await db.exec("UPDATE apps SET bug_reports_daily_limit = 500");
    await db.exec("UPDATE apps SET bug_reports_daily_limit = 1");
  });

  it("una sola squadra per i bug non chiusa per App", async () => {
    const ins = (status: string) =>
      db.exec(`INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title, status, bug_team)
        SELECT 'S', id, 'bug', 'x', 'T', '${status}', true FROM apps`);
    await ins("draft");
    await expect(ins("active")).rejects.toThrow(/unique|duplicate/i);
    await db.exec("UPDATE team_instances SET status = 'closed'");
    await ins("active");
  });

  it("UNIQUE(app_id, number) e cancellazione a cascata con l'App", async () => {
    const ins = (n: number) =>
      db.exec(`INSERT INTO bug_reports (app_id, number, reporter_kind, title, description) SELECT id, ${n}, 'browser', 't', 'd' FROM apps`);
    await ins(1);
    await expect(ins(1)).rejects.toThrow(/unique|duplicate/i);
    await ins(2);
    await db.exec(`INSERT INTO bug_report_messages (report_id, author, content) SELECT id, 'lead', 'ciao' FROM bug_reports LIMIT 1`);
    const d = await db.query<any>("SELECT status, public_message FROM bug_reports WHERE number = 1");
    expect(d.rows).toEqual([{ status: "received", public_message: null }]);
    await db.exec("UPDATE team_instances SET status = 'closed'");
    await db.exec("DELETE FROM team_instances");
    await db.exec("DELETE FROM apps");
    const c = await db.query<any>(
      "SELECT (SELECT count(*) FROM bug_reports)::int AS r, (SELECT count(*) FROM bug_report_messages)::int AS m",
    );
    expect(c.rows[0]).toEqual({ r: 0, m: 0 });
  });
});
