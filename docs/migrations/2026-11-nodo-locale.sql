-- Nodo locale: nodi registrati (esecutori esterni dei compiti delle squadre), allegati delle squadre e colonne nuove su
-- token, istanze e compiti (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'node_status') THEN
    CREATE TYPE "public"."node_status" AS ENUM('active', 'disabled');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" "node_status" DEFAULT 'active' NOT NULL,
	"executor" text,
	"version" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_root" text,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_user_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "team_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" bytea NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "team_attachments_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_attachments_instance_idx" ON "team_attachments" USING btree ("instance_id");

-- Colonne nuove su tabelle esistenti
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "node_id" integer;
ALTER TABLE "team_instances" ADD COLUMN IF NOT EXISTS "node_workspace" text;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "node_id" integer;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "lease_token" text;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "session_id" text;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "waiting_since" timestamp;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "no_node_notified" boolean DEFAULT false NOT NULL;
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
CREATE INDEX IF NOT EXISTS "team_tasks_node_status_idx" ON "team_tasks" USING btree ("node_id", "status");

-- Chiavi esterne sulle tabelle esistenti (aggiunte solo se mancano)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_tokens_node_id_nodes_id_fk') THEN
    ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_tasks_node_id_nodes_id_fk') THEN
    ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
