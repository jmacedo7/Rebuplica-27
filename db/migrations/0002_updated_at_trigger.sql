CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now();RETURN NEW;END; $$;
DROP TRIGGER IF EXISTS games_set_updated_at ON games;CREATE TRIGGER games_set_updated_at BEFORE UPDATE ON games FOR EACH ROW EXECUTE FUNCTION set_updated_at();
