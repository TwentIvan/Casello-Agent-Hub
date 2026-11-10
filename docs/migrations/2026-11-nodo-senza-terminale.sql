-- Botcave Nodo senza terminale: abbinamento dal browser, diagnosi e stato dei nodi (additiva, idempotente).
-- Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  CREATE TYPE "public"."node_pairing_status" AS ENUM('pending', 'approved', 'denied', 'consumed', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "node_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code_hash" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"version" text NOT NULL,
	"status" "node_pairing_status" DEFAULT 'pending' NOT NULL,
	"user_id" integer,
	"node_id" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"request_ip" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	CONSTRAINT "node_pairings_user_code_hash_unique" UNIQUE("user_code_hash"),
	CONSTRAINT "node_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "node_pairings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "node_pairings_expires_idx" ON "node_pairings" USING btree ("expires_at");

CREATE TABLE IF NOT EXISTS "node_diagnostics" (
	"node_id" integer PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "node_diagnostics_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action
);

ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "paired_at" timestamp;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "paired_ip" text;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "claude_status" jsonb;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "claude_checked_at" timestamp;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "settings" jsonb;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "diagnostics_requested_at" timestamp;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "uninstall_requested_at" timestamp;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "update_failed_version" text;
