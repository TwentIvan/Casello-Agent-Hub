import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

// Regressione dell'ambiente di test (pglite-protocol.ts). Le query restano in coda finché
// un'altra connessione tiene aperta una transazione; al commit ripartono tutte insieme e, senza
// la correzione, i loro messaggi Parse/Bind/Execute si alternano sull'unica sessione PGlite.
describe("PGlite condiviso dai test", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("query concorrenti in coda dietro una transazione ricevono i propri risultati", async () => {
    const holder = await pool.connect();
    try {
      for (let round = 0; round < 5; round++) {
        await holder.query("begin");
        const pending = Array.from({ length: 6 }, (_, i) =>
          pool.query<{ v: string }>(`select $1::text || '-${i}' as v`, [`r${round}`]).then(
            (r) => r.rows[0]?.v,
            (err: Error) => err.message,
          ),
        );
        // Lascia arrivare in coda i messaggi delle altre connessioni
        await new Promise((resolve) => setTimeout(resolve, 50));
        await holder.query("commit");
        expect(await Promise.all(pending)).toEqual(Array.from({ length: 6 }, (_, i) => `r${round}-${i}`));
      }
    } finally {
      holder.release();
    }
  });
});
