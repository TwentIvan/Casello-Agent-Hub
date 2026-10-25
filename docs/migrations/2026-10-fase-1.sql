-- Migrazione di produzione: fase 1 (agenti operativi).
-- Catalogo dei tool per app, ruoli degli agenti, passi delle run; la vecchia tabella `tools` viene
-- convertita in `app_tools` + `agent_tools` e poi eliminata.
-- Eseguire una volta sul DB Neon (psql -f). Idempotente: una seconda esecuzione non cambia nulla.
-- I nuovi valori di `run_status` sono aggiunti qui ma non usati nella stessa transazione.

BEGIN;

-- Enum ------------------------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE "public"."tool_kind" AS ENUM('http', 'ui', 'composite'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."tool_identity" AS ENUM('user', 'service'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."tool_status" AS ENUM('draft', 'active', 'disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."agent_role" AS ENUM('general', 'area'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE "public"."run_status" ADD VALUE IF NOT EXISTS 'awaiting_client';
ALTER TYPE "public"."run_status" ADD VALUE IF NOT EXISTS 'cancelled';

-- apps ------------------------------------------------------------------------------------------
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "internal_base_url" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "user_auth" jsonb;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "service_auth" jsonb;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "service_secret_enc" text;

-- slug da name: minuscolo, non alfanumerici -> '-'; sui duplicati (dal secondo in poi) suffisso '-<id>'
WITH base AS (
  SELECT id,
         COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'app') AS s
  FROM "apps"
  WHERE "slug" IS NULL
), ranked AS (
  SELECT id, s, row_number() OVER (PARTITION BY s ORDER BY id) AS rn FROM base
)
UPDATE "apps" a
SET "slug" = CASE WHEN r.rn = 1 AND NOT EXISTS (SELECT 1 FROM "apps" o WHERE o.slug = r.s AND o.id <> a.id)
                  THEN r.s ELSE r.s || '-' || a.id END
FROM ranked r
WHERE a.id = r.id;

ALTER TABLE "apps" ALTER COLUMN "slug" SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE "apps" ADD CONSTRAINT "apps_slug_unique" UNIQUE ("slug");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- agents ----------------------------------------------------------------------------------------
-- Gli agenti esistenti diventano 'area' tramite il default.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "role" "agent_role" DEFAULT 'area' NOT NULL;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "area" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "default_identity" "tool_identity" DEFAULT 'user' NOT NULL;

-- runs ------------------------------------------------------------------------------------------
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pending_action" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "loop_state" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "paused_at" timestamp;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "prompt_tokens" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "completion_tokens" integer;

-- Nuove tabelle ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_tools" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "tool_kind" NOT NULL,
	"identity" "tool_identity" DEFAULT 'user' NOT NULL,
	"requires_confirmation" boolean DEFAULT false NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"status" "tool_status" DEFAULT 'draft' NOT NULL,
	"params_schema" jsonb DEFAULT '{"type":"object","properties":{}}'::jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"evidence" jsonb,
	"needs_verification" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_tools_app_id_name_unique" UNIQUE("app_id","name"),
	CONSTRAINT "app_tools_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "agent_tools" (
	"agent_id" integer NOT NULL,
	"tool_id" integer NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id"),
	CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_tools_tool_id_app_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."app_tools"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "run_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"tool_name" text,
	"args" jsonb,
	"ok" boolean,
	"http_status" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action
);

-- Conversione dei vecchi tool -------------------------------------------------------------------
-- Funzione di appoggio: restituisce lo schema solo se è JSON valido e di tipo oggetto
-- (un cast ::jsonb su testo non valido farebbe abortire la transazione).
CREATE OR REPLACE FUNCTION pg_temp.casello_safe_schema(t text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE j jsonb;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  j := t::jsonb;
  IF jsonb_typeof(j) <> 'object' THEN RETURN NULL; END IF;
  RETURN j;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

DO $mig$
BEGIN
  IF to_regclass('public.tools') IS NOT NULL THEN
    ALTER TABLE "app_tools" ADD COLUMN "legacy_tool_id" integer;

    -- Se due agenti della stessa app hanno un tool con lo stesso nome, dal secondo in poi si aggiunge '-<id>'.
    INSERT INTO "app_tools" ("app_id", "name", "description", "kind", "status", "params_schema", "definition", "legacy_tool_id")
    SELECT ag.app_id,
           CASE WHEN row_number() OVER (PARTITION BY ag.app_id, t.name ORDER BY t.id) = 1
                THEN t.name ELSE t.name || '-' || t.id END,
           t.description,
           'http',
           'draft',
           COALESCE(pg_temp.casello_safe_schema(t.parameters_schema), '{"type":"object","properties":{}}'::jsonb),
           jsonb_build_object('method', t.http_method::text, 'path', t.endpoint, 'paramLocations', '{}'::jsonb),
           t.id
    FROM "tools" t
    JOIN "agents" ag ON ag.id = t.agent_id
    ORDER BY t.id;

    INSERT INTO "agent_tools" ("agent_id", "tool_id")
    SELECT t.agent_id, at.id
    FROM "tools" t
    JOIN "app_tools" at ON at.legacy_tool_id = t.id;

    ALTER TABLE "app_tools" DROP COLUMN "legacy_tool_id";
    DROP TABLE "tools";
  END IF;
END
$mig$;

-- Un agente 'general' per ogni app che non lo ha ----------------------------------------------------
INSERT INTO "agents" ("app_id", "name", "status", "role")
SELECT a.id, a.name || ' – generale', 'draft', 'general'
FROM "apps" a
WHERE NOT EXISTS (SELECT 1 FROM "agents" g WHERE g.app_id = a.id AND g.role = 'general');

CREATE UNIQUE INDEX IF NOT EXISTS "agents_one_general_per_app" ON "agents" USING btree ("app_id") WHERE "role" = 'general';
CREATE INDEX IF NOT EXISTS "run_steps_run_id_position_idx" ON "run_steps" USING btree ("run_id", "position");

-- Il tipo http_method serviva solo alla vecchia tabella `tools`.
DROP TYPE IF EXISTS "public"."http_method";

COMMIT;
