import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-piano-issue.sql";

describe("migrazione 2026-10-piano-issue", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con una voce del piano già presente
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-piano-issue.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');
      INSERT INTO analyses (app_id, model, sources, max_tokens) SELECT id, 'm', '[]', 1000 FROM apps;
      INSERT INTO analysis_items (analysis_id, chapter, ref, position, payload, diff)
        SELECT id, 'completion', 'completion:1', 0, '{}', 'new' FROM analyses;
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("le voci esistenti non hanno issue", async () => {
    expect(
      (
        await db.query<any>(
          "SELECT issue_repo, issue_number, issue_url, issue_state, issue_state_reason, issue_created_at, issue_checked_at FROM analysis_items",
        )
      ).rows,
    ).toEqual([
      {
        issue_repo: null,
        issue_number: null,
        issue_url: null,
        issue_state: null,
        issue_state_reason: null,
        issue_created_at: null,
        issue_checked_at: null,
      },
    ]);
  });

  it("accetta un collegamento e lo indicizza", async () => {
    await db.exec(
      `UPDATE analysis_items SET issue_repo = 'o/r', issue_number = 7, issue_url = 'https://github.com/o/r/issues/7', issue_state = 'open'`,
    );
    expect((await db.query<any>("SELECT issue_number FROM analysis_items")).rows).toEqual([{ issue_number: 7 }]);
    expect(
      (await db.query<any>("SELECT indexname FROM pg_indexes WHERE indexname = 'analysis_items_issue_idx'")).rows,
    ).toHaveLength(1);
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect(
      (await db.query<any>("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'analysis_items_issue_idx'")).rows[0].n,
    ).toBe(1);
  });
});
