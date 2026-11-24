-- Rate limit persistente e per utente (issue #98): contatori a finestra fissa in Postgres per l'avvio di run e
-- analisi, così il limite non si azzera a ogni deploy e distingue gli utenti. Additiva e idempotente.
CREATE TABLE IF NOT EXISTS "rate_limit_counters" (
	"user_id" integer NOT NULL,
	"bucket" varchar(100) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_user_id_bucket_window_start_pk" PRIMARY KEY ("user_id", "bucket", "window_start"),
	CONSTRAINT "rate_limit_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "rate_limit_counters_window_start_idx" ON "rate_limit_counters" USING btree ("window_start");
