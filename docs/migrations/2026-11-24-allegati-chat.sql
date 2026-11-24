-- Allegati nelle chat (issue #120): immagini e PDF nelle conversazioni dei personaggi, del piano e di squadra, e
-- capacità per offerta del catalogo (immagini e PDF in ingresso). Additiva e idempotente, la applica il deploy.
ALTER TABLE "model_offers" ADD COLUMN IF NOT EXISTS "supports_vision" boolean;
ALTER TABLE "model_offers" ADD COLUMN IF NOT EXISTS "supports_pdf" boolean;

CREATE TABLE IF NOT EXISTS "chat_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"conversation_kind" "instruction_conversation_kind" NOT NULL,
	"character_conversation_id" integer,
	"plan_conversation_id" integer,
	"team_chat_conversation_id" integer,
	"message_id" integer,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "chat_attachments_character_conversation_id_character_conversations_id_fk" FOREIGN KEY ("character_conversation_id") REFERENCES "public"."character_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "chat_attachments_plan_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("plan_conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "chat_attachments_team_chat_conversation_id_team_chat_conversations_id_fk" FOREIGN KEY ("team_chat_conversation_id") REFERENCES "public"."team_chat_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "chat_attachments_conversation_check" CHECK (
		("conversation_kind" = 'character' and "character_conversation_id" is not null and "plan_conversation_id" is null and "team_chat_conversation_id" is null)
		or ("conversation_kind" = 'plan_chat' and "plan_conversation_id" is not null and "character_conversation_id" is null and "team_chat_conversation_id" is null)
		or ("conversation_kind" = 'team_chat' and "team_chat_conversation_id" is not null and "character_conversation_id" is null and "plan_conversation_id" is null)
	)
);

CREATE INDEX IF NOT EXISTS "chat_attachments_character_idx" ON "chat_attachments" USING btree ("character_conversation_id");
CREATE INDEX IF NOT EXISTS "chat_attachments_plan_idx" ON "chat_attachments" USING btree ("plan_conversation_id");
CREATE INDEX IF NOT EXISTS "chat_attachments_team_chat_idx" ON "chat_attachments" USING btree ("team_chat_conversation_id");
