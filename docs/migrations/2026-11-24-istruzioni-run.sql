-- Istruire una run in corso (issue #119): messaggi dell'utente verso una run `running`, consegnati dal ciclo
-- dell'agente tra un passo e l'altro. Additiva e idempotente, la applica il deploy.
DO $$ BEGIN
	CREATE TYPE "public"."run_message_status" AS ENUM('pending', 'delivered', 'dropped');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "run_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"user_id" integer,
	"content" text NOT NULL,
	"status" "run_message_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "run_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "run_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "run_messages_run_id_status_idx" ON "run_messages" USING btree ("run_id","status");
