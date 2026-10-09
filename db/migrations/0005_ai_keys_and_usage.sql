-- Gemini keys per player (encrypted at rest) and per-day usage of the project key.
-- The player's key is encrypted by the application (AES-256-GCM, master secret in the
-- backend environment) so a leaked database dump alone never reveals a usable key.
CREATE TABLE IF NOT EXISTS user_ai_keys (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'gemini',
  encrypted_key text NOT NULL,
  key_hint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per user per UTC day: counts requests served with the shared project key.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, usage_date)
);
