import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const migration = (name: string) => read(`../../../docs/migrations/${name}.sql`);

describe("migrazione 2026-11-esecutore-nodo", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione prima dell'esecutore sul nodo, con un utente, un account AI e un nodo; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    for (const m of [
      "2026-11-nodo-locale",
      "2026-11-nodo-cartelle",
      "2026-11-connettore-oauth",
      "2026-11-alfred",
      "2026-11-lucius-squadra",
      "2026-11-personaggi",
      "2026-11-plugin-incorporabile",
      "2026-11-thu-5c-tappa1",
      "2026-11-inneschi",
      "2026-11-proposte-multiple",
    ]) {
      await db.exec(migration(m));
    }
    await db.exec(`
      INSERT INTO users (email) VALUES ('u@example.com');
      INSERT INTO nodes (user_id, name) SELECT id, 'mac' FROM users;
    `);
    await db.exec(migration("2026-11-esecutore-nodo"));
    await db.exec(migration("2026-11-esecutore-nodo"));
  });

  afterAll(async () => {
    await db.close();
  });

  const columns = async (table: string) =>
    (
      await db.query<any>(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
        [table],
      )
    ).rows.reduce((acc: Record<string, string>, r: any) => ({ ...acc, [r.column_name]: r.data_type }), {});

  it("aggiunge le colonne a ai_accounts e nodes", async () => {
    const acc = await columns("ai_accounts");
    expect(acc.node_id).toBe("integer");
    expect(acc.fallback_ai_model_id).toBe("integer");
    expect((await columns("nodes")).last_turn_poll_at).toBe("timestamp without time zone");
    const r = await db.query<any>("SELECT last_turn_poll_at FROM nodes");
    expect(r.rows).toEqual([{ last_turn_poll_at: null }]);
  });

  it("crea node_turns con le colonne della spec", async () => {
    const c = await columns("node_turns");
    expect(Object.keys(c).sort()).toEqual(
      [
        "id", "node_id", "user_id", "ai_model_id", "consumer", "ref_id", "message_id", "status", "package",
        "turn_token_hash", "lease_token", "lease_expires_at", "content", "error_code", "prompt_tokens",
        "completion_tokens", "cached_tokens", "cost_usd", "session_id", "created_at", "claimed_at", "finished_at",
      ].sort(),
    );
    expect(c.package).toBe("jsonb");
    expect(c.cost_usd).toBe("numeric");
  });

  it("indici: token del turno unico, un account per nodo", async () => {
    const r = await db.query<any>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('node_turns_token_hash_unique', 'ai_accounts_one_per_node', 'node_turns_node_status_idx')",
    );
    const defs = Object.fromEntries(r.rows.map((x: any) => [x.indexname, x.indexdef]));
    expect(defs.node_turns_token_hash_unique).toMatch(/UNIQUE.*turn_token_hash/);
    expect(defs.ai_accounts_one_per_node).toMatch(/UNIQUE.*node_id.*WHERE/);
    expect(defs.node_turns_node_status_idx).toMatch(/node_id, status, created_at/);
  });

  it("il valore claude_code_node esiste e l'enum di stato dei turni è completo", async () => {
    const p = await db.query<any>("SELECT unnest(enum_range(NULL::provider_protocol))::text AS v");
    expect(p.rows.map((x: any) => x.v)).toContain("claude_code_node");
    const s = await db.query<any>("SELECT unnest(enum_range(NULL::node_turn_status))::text AS v");
    expect(s.rows.map((x: any) => x.v)).toEqual(["queued", "running", "done", "failed", "cancelled", "expired"]);
    const c = await db.query<any>("SELECT unnest(enum_range(NULL::node_turn_consumer))::text AS v");
    expect(c.rows.map((x: any) => x.v)).toEqual(["character", "plan_chat", "team_chat", "run"]);
  });

  it("schema-casello.sql ha le stesse definizioni", async () => {
    const schema = read("../../../docs/schema-casello.sql");
    expect(schema).toContain("'claude_code_node'");
    expect(schema).toContain('"last_turn_poll_at"');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "node_turns"');
    expect(schema).toContain('"ai_accounts_one_per_node"');
    // lo schema di test si carica da solo e permette di inserire un turno
    const t = new PGlite();
    await t.exec(schema);
    await t.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO node_turns (user_id, consumer, ref_id, status, turn_token_hash)
        SELECT id, 'character', 1, 'queued', 'h' FROM users;
    `);
    await t.close();
  });
});
