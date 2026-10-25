import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// Avvia un Postgres in memoria (PGlite) esposto su socket, con lo schema di produzione,
// e imposta DATABASE_URL prima che i worker importino @workspace/db.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export default async function setup() {
  const db = await PGlite.create();
  const schemaPath = fileURLToPath(new URL("../../../docs/schema-casello.sql", import.meta.url));
  await db.exec(readFileSync(schemaPath, "utf8"));

  const port = await freePort();
  // maxConnections > 1: il Pool dell'API esegue query concorrenti
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });
  await server.start();

  process.env["DATABASE_URL"] = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

  return async () => {
    await server.stop();
    await db.close();
  };
}
