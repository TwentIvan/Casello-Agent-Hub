-- Connettore OAuth per l'app Claude: client, collegamenti, codici d'autorizzazione e token (additiva, idempotente).
-- Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oauth_client_kind') THEN
    CREATE TYPE "public"."oauth_client_kind" AS ENUM('dcr', 'metadata');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oauth_token_kind') THEN
    CREATE TYPE "public"."oauth_token_kind" AS ENUM('access', 'refresh');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "oauth_clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"kind" "oauth_client_kind" NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata_fetched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);

CREATE TABLE IF NOT EXISTS "oauth_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_grants_active_unique" ON "oauth_grants" USING btree ("user_id","client_id") WHERE "oauth_grants"."revoked_at" IS NULL;

CREATE TABLE IF NOT EXISTS "oauth_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"grant_id" integer NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "oauth_codes_grant_idx" ON "oauth_codes" USING btree ("grant_id");

CREATE TABLE IF NOT EXISTS "oauth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"grant_id" integer NOT NULL,
	"kind" "oauth_token_kind" NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");
