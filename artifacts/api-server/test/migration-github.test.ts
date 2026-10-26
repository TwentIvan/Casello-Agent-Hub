import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-github.sql";

describe("migrazione 2026-10-github", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente al login con GitHub, con un'app già presente
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-github.sql"));
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');`);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  // Le sequenze non tornano indietro dopo un insert rifiutato: gli id si cercano per email
  const userId = async (email: string) =>
    (await db.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email])).rows[0]!.id;

  it("crea le tabelle users, user_identities e github_installations", async () => {
    for (const t of ["users", "user_identities", "github_installations"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
      expect(rows[0]).toEqual({ t });
    }
  });

  it("aggiunge apps.source_installation_id, null per le app esistenti", async () => {
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM apps");
    expect(rows).toHaveLength(1);
    expect("source_installation_id" in rows[0]!).toBe(true);
    expect(rows[0]!.source_installation_id).toBeNull();
  });

  it("users: email unica", async () => {
    const ins = () => db.query(`INSERT INTO users (email, name) VALUES ('ivan@example.com', 'Ivan')`);
    await ins();
    await expect(ins()).rejects.toThrow(/users_email_unique/);
    const u = (await db.query<any>("SELECT * FROM users")).rows[0];
    expect(u.created_at).toBeTruthy();
    expect(u.last_login_at).toBeNull();
  });

  it("user_identities: i vincoli unici rifiutano identità duplicate", async () => {
    await db.exec(`INSERT INTO users (email) VALUES ('altro@example.com')`);
    const id2 = await userId("altro@example.com");
    const ins = (userId: number, provider: string, pid: string) =>
      db.query(`INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES ($1, $2, $3)`, [userId, provider, pid]);
    const id1 = await userId("ivan@example.com");
    await ins(id1, "github", "100");
    // stessa identità del provider su un altro utente
    await expect(ins(id2, "github", "100")).rejects.toThrow(/user_identities_provider_user_unique/);
    // stesso utente, stesso provider, altro account
    await expect(ins(id1, "github", "101")).rejects.toThrow(/user_identities_user_provider_unique/);
    await ins(id1, "google", "100"); // altro provider: ammessa
    // provider non previsto dall'enum
    await expect(ins(id1, "gitlab", "100")).rejects.toThrow(/identity_provider/);
  });

  it("user_identities: eliminando l'utente si eliminano le sue identità (cascade)", async () => {
    await db.exec(`INSERT INTO users (email) VALUES ('cascata@example.com')`);
    const id = await userId("cascata@example.com");
    await db.query(`INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES ($1, 'github', '555')`, [id]);
    await db.query("DELETE FROM users WHERE id = $1", [id]);
    expect((await db.query("SELECT 1 FROM user_identities WHERE provider_user_id = '555'")).rows).toHaveLength(0);
  });

  it("github_installations: unica (user_id, installation_id) e cascade sull'utente", async () => {
    const ins = (userId: number) =>
      db.query(
        `INSERT INTO github_installations (user_id, installation_id, account_login, account_type, repository_selection) VALUES ($1, 9000000001, 'ivan', 'User', 'all')`,
        [userId],
      );
    const id1 = await userId("ivan@example.com");
    const id2 = await userId("altro@example.com");
    await ins(id1);
    await expect(ins(id1)).rejects.toThrow(/github_installations_user_installation_unique/);
    await ins(id2); // altro utente: ammessa
    await db.exec(`DELETE FROM users WHERE id = ${id2}`);
    expect((await db.query("SELECT 1 FROM github_installations")).rows).toHaveLength(1);
  });

  it("è idempotente: una seconda esecuzione non cambia nulla", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM users")).rows[0];
    await db.exec(read(SQL));
    expect((await db.query("SELECT count(*)::int AS n FROM users")).rows[0]).toEqual(before);
  });
});
