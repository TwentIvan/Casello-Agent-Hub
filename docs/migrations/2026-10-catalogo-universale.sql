-- Migrazione di produzione: catalogo universale dei modelli (spec 2026-10-26-casello-catalogo-universale-design.md §10).
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-catalogo-universale.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Organizzata in sezioni: ognuna è indipendente dalle successive.

BEGIN;

-- =================================================================================================
-- Sezione 1: registro dei provider
-- I provider diventano dati (tabella providers) invece dell'enum ai_provider. Qui solo i provider di oggi,
-- necessari alla FK; all'avvio Casello aggiunge gli altri dal registro nel codice (ensureProviderRegistry).
-- L'enum ai_provider resta nel DB senza colonne che lo usano: si elimina in un passo successivo.
-- =================================================================================================

DO $$ BEGIN CREATE TYPE "public"."provider_protocol" AS ENUM('openai_compatible', 'anthropic', 'bedrock', 'vertex', 'azure', 'unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."provider_status" AS ENUM('managed', 'coming', 'unmanaged'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."provider_origin" AS ENUM('registry', 'discovered'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "providers" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" "provider_protocol" NOT NULL,
	"default_base_url" text,
	"source_keys" jsonb NOT NULL,
	"status" "provider_status" NOT NULL,
	"origin" "provider_origin" NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Gli stessi valori del registro (lib/catalog/provider-registry-data.ts); una riga già presente non si tocca
INSERT INTO "providers" ("slug", "name", "protocol", "default_base_url", "source_keys", "status", "origin") VALUES
	('deepseek', 'DeepSeek', 'openai_compatible', 'https://api.deepseek.com/v1', '{"litellm": ["deepseek"], "openrouterAuthor": "deepseek"}', 'managed', 'registry'),
	('openrouter', 'OpenRouter', 'openai_compatible', 'https://openrouter.ai/api/v1', '{"litellm": ["openrouter"], "openrouterAuthor": null}', 'managed', 'registry'),
	('huggingface', 'Hugging Face', 'openai_compatible', 'https://router.huggingface.co/v1', '{"litellm": ["huggingface"], "openrouterAuthor": null}', 'managed', 'registry'),
	('mistral', 'Mistral', 'openai_compatible', 'https://api.mistral.ai/v1', '{"litellm": ["mistral", "codestral", "text-completion-codestral"], "openrouterAuthor": "mistralai"}', 'managed', 'registry'),
	('groq', 'Groq', 'openai_compatible', 'https://api.groq.com/openai/v1', '{"litellm": ["groq"], "openrouterAuthor": null}', 'managed', 'registry'),
	('together', 'Together AI', 'openai_compatible', 'https://api.together.xyz/v1', '{"litellm": ["together_ai"], "openrouterAuthor": null}', 'managed', 'registry'),
	('gemini', 'Google Gemini', 'openai_compatible', 'https://generativelanguage.googleapis.com/v1beta/openai', '{"litellm": ["gemini"], "openrouterAuthor": "google"}', 'managed', 'registry'),
	('custom', 'Personalizzato (compatibile OpenAI)', 'openai_compatible', NULL, '{"litellm": [], "openrouterAuthor": null}', 'managed', 'registry'),
	('system_gateway', 'Gateway di Casello', 'openai_compatible', NULL, '{"litellm": [], "openrouterAuthor": null}', 'managed', 'registry')
ON CONFLICT ("slug") DO NOTHING;

-- provider da enum a testo, solo se la colonna è ancora dell'enum ai_provider (i valori restano gli stessi)
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_accounts' AND column_name = 'provider' AND udt_name = 'ai_provider') THEN
		ALTER TABLE "ai_accounts" ALTER COLUMN "provider" TYPE text USING "provider"::text;
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'model_catalog' AND column_name = 'provider' AND udt_name = 'ai_provider') THEN
		ALTER TABLE "model_catalog" ALTER COLUMN "provider" TYPE text USING "provider"::text;
	END IF;
END $$;

DO $$ BEGIN ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_provider_providers_slug_fk" FOREIGN KEY ("provider") REFERENCES "public"."providers"("slug") ON DELETE no action ON UPDATE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_provider_providers_slug_fk" FOREIGN KEY ("provider") REFERENCES "public"."providers"("slug") ON DELETE no action ON UPDATE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
