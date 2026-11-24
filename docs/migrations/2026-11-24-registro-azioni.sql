-- Registro delle azioni (issue #115): eventi delle operazioni sensibili per utente (chi, cosa, quando, da dove),
-- senza segreti. Additiva e idempotente, la applica il deploy.
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"action" varchar(80) NOT NULL,
	"object_type" varchar(40),
	"object_id" varchar(100),
	"detail" jsonb,
	"via" varchar(20) NOT NULL,
	"token_id" integer,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "audit_events_user_created_idx" ON "audit_events" USING btree ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_events_created_idx" ON "audit_events" USING btree ("created_at");
