import { beforeAll } from "vitest";
import { pool } from "@workspace/db";

// Il Postgres di prova è condiviso da tutti i file di test: i contatori persistenti del rate limit (per utente)
// si azzerano all'inizio di ogni file, come facevano da soli i vecchi contatori in memoria.
beforeAll(async () => {
  await pool.query("DELETE FROM rate_limit_counters");
});
