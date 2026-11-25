-- Capo delle squadre con un modello Claude Code (nodo): i turni del capo si delegano al nodo dell'account.
-- Additiva e idempotente, la applica il deploy. Niente BEGIN/COMMIT: ALTER TYPE … ADD VALUE non si esegue in una
-- transazione esplicita insieme all'uso del valore.
ALTER TYPE "node_turn_consumer" ADD VALUE IF NOT EXISTS 'team_turn';
ALTER TABLE "team_turn_steps" ADD COLUMN IF NOT EXISTS "note" text;
