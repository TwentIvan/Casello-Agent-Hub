import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Registro delle migrazioni applicate dall'esecutore all'avvio dell'API (vedi lib/migrations/runner.ts).
// La crea l'esecutore stesso; qui serve perché `drizzle-kit push` non la proponga da cancellare.
export const schemaMigrationsTable = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  sha256: text("sha256").notNull(),
  baseline: boolean("baseline").notNull().default(false),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});
