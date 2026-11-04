-- Squadre di agenti: skill con codice e versioni, modelli di squadra con manifesti versionati, istanze legate a un
-- lavoro di riferimento (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessuna modifica a tabelle esistenti.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'skill_kind') THEN
    CREATE TYPE "public"."skill_kind" AS ENUM('casello', 'node');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_instance_status') THEN
    CREATE TYPE "public"."team_instance_status" AS ENUM('draft', 'active', 'closed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" "skill_kind" NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"deprecated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_code_unique" UNIQUE("code")
);
CREATE TABLE IF NOT EXISTS "skill_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"tool_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_version_unique" UNIQUE("skill_id","version"),
	CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action
);
CREATE TABLE IF NOT EXISTS "team_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_templates_name_active_unique" ON "team_templates" USING btree ("name") WHERE "team_templates"."archived" = false;
CREATE TABLE IF NOT EXISTS "team_template_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_template_versions_template_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "team_template_versions_template_id_team_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."team_templates"("id") ON DELETE cascade ON UPDATE no action
);
CREATE TABLE IF NOT EXISTS "team_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"template_id" integer,
	"template_version" integer,
	"ref_app_id" integer NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"ref_title" text NOT NULL,
	"status" "team_instance_status" DEFAULT 'draft' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	CONSTRAINT "team_instances_template_id_team_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."team_templates"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "team_instances_ref_app_id_apps_id_fk" FOREIGN KEY ("ref_app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "team_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_instances_ref_idx" ON "team_instances" USING btree ("ref_app_id", "ref_type", "ref_id");
CREATE TABLE IF NOT EXISTS "team_instance_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "skill_kind" NOT NULL,
	"content" text NOT NULL,
	"tool_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_instance_skills_instance_code_unique" UNIQUE("instance_id","code"),
	CONSTRAINT "team_instance_skills_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action
);
