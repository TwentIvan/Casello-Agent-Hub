-- Accesso dell'utente ai repository GitHub (issue #94): repo dell'installazione che l'utente vede davvero,
-- letti con il suo token alla callback di GitHub (additiva, idempotente). Da applicare in produzione PRIMA del merge.
-- Nessun `-post`. Le righe esistenti restano con user_repos null (non verificati): basta ricollegare GitHub da Account.

ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "user_repos" jsonb;
ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "user_repos_checked_at" timestamp;
