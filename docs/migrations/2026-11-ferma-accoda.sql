-- Ferma, Invia subito, Accoda: messaggio in coda per conversazione (additiva e idempotente, niente -post)
ALTER TABLE "character_messages" ADD COLUMN IF NOT EXISTS "queued_at" timestamp;
ALTER TABLE "plan_messages" ADD COLUMN IF NOT EXISTS "queued_at" timestamp;
ALTER TABLE "team_chat_messages" ADD COLUMN IF NOT EXISTS "queued_at" timestamp;
CREATE UNIQUE INDEX IF NOT EXISTS "character_messages_queued_uidx" ON "character_messages" USING btree ("conversation_id") WHERE "queued_at" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "plan_messages_queued_uidx" ON "plan_messages" USING btree ("conversation_id") WHERE "queued_at" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "team_chat_messages_queued_uidx" ON "team_chat_messages" USING btree ("conversation_id") WHERE "queued_at" IS NOT NULL;
