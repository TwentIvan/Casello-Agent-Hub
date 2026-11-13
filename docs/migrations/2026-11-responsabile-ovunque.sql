-- Responsabile di Botcave da ogni area: conversazioni dell'utente con il Responsabile di prodotto, fatte di run.
-- Additiva e idempotente, niente -post. Da applicare su Neon PRIMA del merge.

CREATE TABLE IF NOT EXISTS lead_conversations (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id integer NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  archived_at timestamp
);

CREATE INDEX IF NOT EXISTS lead_conversations_user_updated_idx ON lead_conversations (user_id, updated_at);

CREATE TABLE IF NOT EXISTS lead_messages (
  id serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES lead_conversations(id) ON DELETE CASCADE,
  content text NOT NULL,
  page_context jsonb,
  run_id integer REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_messages_conversation_idx ON lead_messages (conversation_id, id);
