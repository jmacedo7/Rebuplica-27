-- 0003: integrity hardening and indexes required by the runtime persistence layer.
--
-- Additive only: no column, constraint or index from 0001/0002 is dropped or rewritten.
-- New CHECK constraints are added as NOT VALID so an existing deployment never fails a
-- migration because of a pre-existing row; PostgreSQL still enforces them for every new
-- write, and VALIDATE CONSTRAINT can be run later during a maintenance window.

-- Listing games per owner is the hot read path of the game API.
CREATE INDEX IF NOT EXISTS idx_games_owner_created ON games(owner_id, created_at DESC, id DESC);

-- JSONB shape guards: the runtime only ever stores objects here.
ALTER TABLE games ADD CONSTRAINT games_state_is_object CHECK (jsonb_typeof(state) = 'object') NOT VALID;
ALTER TABLE game_saves ADD CONSTRAINT game_saves_snapshot_is_object CHECK (jsonb_typeof(snapshot) = 'object') NOT VALID;
ALTER TABLE game_events ADD CONSTRAINT game_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object') NOT VALID;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object') NOT VALID;

-- The seed is a 32 bit unsigned integer in the deterministic RNG.
ALTER TABLE games ADD CONSTRAINT games_seed_is_uint32 CHECK (seed >= 0 AND seed <= 4294967295) NOT VALID;

-- Emails are normalised to lower case by the auth service; the index makes the
-- uniqueness guarantee hold even if a future writer forgets to normalise.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users(lower(email));

-- Reserved for the refresh token flow documented in ADR-0004. The table exists so the
-- schema does not need a destructive change when rotation is implemented; the API
-- currently issues short lived access tokens only.
COMMENT ON TABLE refresh_tokens IS 'Reserved: refresh token rotation (hashed tokens only) is not implemented yet.';
COMMENT ON TABLE audit_log IS 'Append only audit trail for sensitive operations (auth, game creation, saves, restore).';
COMMENT ON TABLE game_events IS 'Ordered domain event stream; UNIQUE(game_id, version) is the replay/locking anchor.';
