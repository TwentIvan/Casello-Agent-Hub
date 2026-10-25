-- Migrazione di produzione: login con GitHub.
-- Utenti, identità collegate (Google, GitHub), installazioni dell'App GitHub di Casello e
-- l'installazione da cui un'app legge il codice (apps.source_installation_id).
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-github.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore). Idempotente: una seconda esecuzione non cambia nulla.

BEGIN;

-- Enum ------------------------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE "public"."identity_provider" AS ENUM('google', 'github'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- apps ------------------------------------------------------------------------------------------
-- Le app esistenti restano con source_installation_id null.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "source_installation_id" bigint;

-- Nuove tabelle ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"picture" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE IF NOT EXISTS "user_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"username" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_user_unique" UNIQUE("provider","provider_user_id"),
	CONSTRAINT "user_identities_user_provider_unique" UNIQUE("user_id","provider"),
	CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_user_installation_unique" UNIQUE("user_id","installation_id"),
	CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

COMMIT;
