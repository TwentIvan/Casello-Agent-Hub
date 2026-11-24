-- Orchestrazione della flotta degli agenti (issue #117): politica centrale di coordinamento (pausa e limiti di
-- concorrenza delle run), una sola riga. Additiva e idempotente, la applica il deploy.
CREATE TABLE IF NOT EXISTS "fleet_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by" integer,
	"pause_reason" varchar(300),
	"max_running_runs" integer DEFAULT 6 NOT NULL,
	"max_running_per_agent" integer DEFAULT 2 NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_policy_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "fleet_policy_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "fleet_policy_singleton_check" CHECK ("id" = 1),
	CONSTRAINT "fleet_policy_limits_check" CHECK ("max_running_runs" between 1 and 20 and "max_running_per_agent" between 1 and 10)
);
