-- The Hub Up 5c tappa 1: coda e annidamento delle run (run madre, token utente, indici dello scheduler) e conferma delle
-- scritture per agente (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parent_run_id" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "has_user_token" boolean DEFAULT false NOT NULL;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "confirm_writes" boolean DEFAULT false NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_parent_run_id_runs_id_fk') THEN
    ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk"
      FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "runs_agent_status_idx" ON "runs" USING btree ("agent_id", "status");
CREATE INDEX IF NOT EXISTS "runs_parent_run_id_idx" ON "runs" USING btree ("parent_run_id");
