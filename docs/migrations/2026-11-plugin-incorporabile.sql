-- Plugin incorporabile di Botcave: valore `embed` per i client OAuth delle app ospiti (additiva e idempotente).
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Da applicare su Neon PRIMA del merge. Nessun `-post`.

ALTER TYPE "public"."oauth_client_kind" ADD VALUE IF NOT EXISTS 'embed';
