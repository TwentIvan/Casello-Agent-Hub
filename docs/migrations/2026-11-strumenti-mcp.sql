-- Strumenti MCP, livelli d'azione L0-L3 e coda delle azioni da confermare (additiva, idempotente).
-- Da applicare in produzione PRIMA del merge. Le colonne `requires_confirmation` e `read_only` restano
-- (le toglierà una migrazione successiva, dopo il deploy).
-- `ALTER TYPE ... ADD VALUE` non si usa nella stessa transazione: lo script non usa `mcp` dopo averlo aggiunto.

ALTER TYPE "public"."tool_kind" ADD VALUE IF NOT EXISTS 'mcp';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_level') THEN
    CREATE TYPE "public"."tool_level" AS ENUM('L0', 'L1', 'L2', 'L3');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pending_action_status') THEN
    CREATE TYPE "public"."pending_action_status" AS ENUM('pending', 'executing', 'done', 'failed', 'rejected');
  END IF;
END $$;

-- Livello dei tool: travaso dai due flag solo se la colonna viene creata ora
-- (sola lettura -> L0, richiede conferma -> L2, altrimenti L1; sola lettura + conferma -> L2)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_tools' AND column_name = 'level'
  ) THEN
    ALTER TABLE "app_tools" ADD COLUMN "level" "tool_level";
    UPDATE "app_tools" SET "level" = CASE
      WHEN "requires_confirmation" THEN 'L2'::"tool_level"
      WHEN "read_only" THEN 'L0'::"tool_level"
      ELSE 'L1'::"tool_level"
    END;
    ALTER TABLE "app_tools" ALTER COLUMN "level" SET DEFAULT 'L2';
    ALTER TABLE "app_tools" ALTER COLUMN "level" SET NOT NULL;
  END IF;
END $$;
ALTER TABLE "app_tools" ADD COLUMN IF NOT EXISTS "level_override" "tool_level";

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "mcp_url" text;

CREATE TABLE IF NOT EXISTS "pending_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"number" integer NOT NULL,
	"app_id" integer NOT NULL,
	"tool_id" integer NOT NULL,
	"run_id" integer,
	"agent_id" integer,
	"args_enc" text NOT NULL,
	"args_public" jsonb NOT NULL,
	"recipient" text NOT NULL,
	"summary" text NOT NULL,
	"status" "pending_action_status" DEFAULT 'pending' NOT NULL,
	"result" text,
	"error_message" text,
	"decided_by" integer,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "pending_actions_user_number_unique" UNIQUE("user_id","number"),
	CONSTRAINT "pending_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pending_actions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pending_actions_tool_id_app_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."app_tools"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "pending_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "pending_actions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "pending_actions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "pending_actions_user_status_idx" ON "pending_actions" USING btree ("user_id", "status");
