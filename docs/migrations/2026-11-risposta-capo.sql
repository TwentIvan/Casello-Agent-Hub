-- Risposta del capo nel bollettino: valore `risposta_capo` del tipo di evento delle squadre (additiva e idempotente).
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Da applicare su Neon PRIMA del merge. Nessun `-post`.

ALTER TYPE "public"."team_event_type" ADD VALUE IF NOT EXISTS 'risposta_capo';
