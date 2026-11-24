-- Origine esplicita dei messaggi dell'utente nei turni (decisione A, opzione 1): l'evento `risposta_capo` ricorda il
-- turno del capo che lo ha prodotto. L'origine dei motivi `request` (`source`) sta nel jsonb `team_turns.reasons` e non
-- vuole SQL. Additiva e idempotente, la applica il deploy.
ALTER TABLE "team_events" ADD COLUMN IF NOT EXISTS "turn_id" integer;

DO $$ BEGIN
  ALTER TABLE "team_events" ADD CONSTRAINT "team_events_turn_id_team_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."team_turns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
