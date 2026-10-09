"""End-to-end backend tests for Rebuplica 27 via the public FastAPI proxy.

Covers: health, register/login, /auth/me, create match, decision, turn,
events, replay consistency, saves (incl. duplicate conflict), restore,
and user isolation (404 on another user's match).

OAuth session (Emergent Google) is tested by inserting a session row
directly in Postgres per /app/memory/test_credentials.md.
"""
import os
import hashlib
import secrets
import subprocess
import time
import uuid

import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"
PRIMARY_EMAIL = "qa.rebuplica@example.com"
PRIMARY_PASSWORD = "uma-senha-bem-longa-123"
SECOND_EMAIL = f"qa.rebuplica.second+{secrets.token_hex(3)}@example.com"
SECOND_PASSWORD = "uma-senha-bem-longa-456"


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- fixtures ---------------------------------------------------------
@pytest.fixture(scope="session")
def primary_token():
    # Ensure the primary account exists; register is idempotent-ish: 409 means exists.
    r = requests.post(f"{BASE}/auth/register", json={"email": PRIMARY_EMAIL, "password": PRIMARY_PASSWORD})
    assert r.status_code in (201, 409), f"register unexpected: {r.status_code} {r.text}"
    r = requests.post(f"{BASE}/auth/login", json={"email": PRIMARY_EMAIL, "password": PRIMARY_PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "accessToken" in data and data["user"]["email"] == PRIMARY_EMAIL
    return data["accessToken"]


@pytest.fixture(scope="session")
def second_token():
    r = requests.post(f"{BASE}/auth/register", json={"email": SECOND_EMAIL, "password": SECOND_PASSWORD})
    assert r.status_code in (201, 409), f"second register: {r.status_code} {r.text}"
    r = requests.post(f"{BASE}/auth/login", json={"email": SECOND_EMAIL, "password": SECOND_PASSWORD})
    assert r.status_code == 200
    return r.json()["accessToken"]


# ---------- health -----------------------------------------------------------
def test_health():
    r = requests.get(f"{BASE}/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"


# ---------- auth -------------------------------------------------------------
def test_login_wrong_password_401():
    r = requests.post(f"{BASE}/auth/login", json={"email": PRIMARY_EMAIL, "password": "wrong-password-very-long"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHORIZED"


def test_register_weak_password_400():
    r = requests.post(f"{BASE}/auth/register", json={"email": f"weak+{secrets.token_hex(3)}@example.com", "password": "short"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] in ("WEAK_PASSWORD", "VALIDATION_ERROR")


def test_auth_me(primary_token):
    r = requests.get(f"{BASE}/auth/me", headers=_bearer(primary_token))
    assert r.status_code == 200
    assert r.json()["user"]["email"] == PRIMARY_EMAIL


def test_auth_me_no_token_401():
    r = requests.get(f"{BASE}/auth/me")
    assert r.status_code == 401


# ---------- games ------------------------------------------------------------
@pytest.fixture(scope="session")
def primary_game(primary_token):
    r = requests.post(f"{BASE}/games", json={"seed": 42}, headers=_bearer(primary_token))
    assert r.status_code == 201, r.text
    g = r.json()["game"]
    assert g["seed"] == 42
    assert g["turn"] == 0
    assert g["currentVersion"] == 1
    assert g["worldDate"].startswith("2027-01-01")
    return g


def test_create_match_invalid_seed(primary_token):
    r = requests.post(f"{BASE}/games", json={"seed": 99999999999}, headers=_bearer(primary_token))
    assert r.status_code == 400


def test_list_games_owner_only(primary_token, second_token, primary_game):
    r = requests.get(f"{BASE}/games", headers=_bearer(primary_token))
    assert r.status_code == 200
    ids = [g["id"] for g in r.json()["games"]]
    assert primary_game["id"] in ids
    # Second user should not see it
    r2 = requests.get(f"{BASE}/games", headers=_bearer(second_token))
    assert r2.status_code == 200
    assert primary_game["id"] not in [g["id"] for g in r2.json()["games"]]


def test_match_isolation_404(second_token, primary_game):
    r = requests.get(f"{BASE}/games/{primary_game['id']}", headers=_bearer(second_token))
    assert r.status_code == 404


# ---------- gameplay --------------------------------------------------------
def test_decision_sets_indicator(primary_token, primary_game):
    gid = primary_game["id"]
    r = requests.post(
        f"{BASE}/games/{gid}/decisions",
        headers=_bearer(primary_token),
        json={"type": "SET_ECONOMIC_INDICATOR", "payload": {"key": "inflation", "value": 4.2}},
    )
    assert r.status_code == 200, r.text
    g = r.json()["game"]
    assert g["currentVersion"] >= 2
    assert g["state"]["world"]["economy"].get("inflation") == 4.2


def test_decision_invalid_key(primary_token, primary_game):
    gid = primary_game["id"]
    r = requests.post(
        f"{BASE}/games/{gid}/decisions",
        headers=_bearer(primary_token),
        json={"type": "SET_ECONOMIC_INDICATOR", "payload": {"key": "1abc", "value": 1}},
    )
    assert r.status_code == 400

    r2 = requests.post(
        f"{BASE}/games/{gid}/decisions",
        headers=_bearer(primary_token),
        json={"type": "SET_FLAG", "payload": {"key": "__proto__", "value": True}},
    )
    assert r2.status_code == 400


def test_set_flag(primary_token, primary_game):
    gid = primary_game["id"]
    r = requests.post(
        f"{BASE}/games/{gid}/decisions",
        headers=_bearer(primary_token),
        json={"type": "SET_FLAG", "payload": {"key": "emergency", "value": True}},
    )
    assert r.status_code == 200
    assert r.json()["game"]["state"]["world"]["flags"].get("emergency") is True


def test_advance_turn(primary_token, primary_game):
    gid = primary_game["id"]
    before = requests.get(f"{BASE}/games/{gid}", headers=_bearer(primary_token)).json()["game"]
    r = requests.post(f"{BASE}/games/{gid}/turn", headers=_bearer(primary_token), json={"days": 90})
    assert r.status_code == 200, r.text
    after = r.json()["game"]
    assert after["turn"] == before["turn"] + 1
    # Date advanced ~90 days
    from datetime import datetime
    d1 = datetime.fromisoformat(before["worldDate"].replace("Z", "+00:00"))
    d2 = datetime.fromisoformat(after["worldDate"].replace("Z", "+00:00"))
    assert (d2 - d1).days == 90


def test_events_and_replay(primary_token, primary_game):
    gid = primary_game["id"]
    r = requests.get(f"{BASE}/games/{gid}/events", headers=_bearer(primary_token))
    assert r.status_code == 200
    events = r.json()["events"]
    types = [e["type"] for e in events]
    assert "GameCreated" in types
    assert "DecisionApplied" in types
    assert "TurnAdvanced" in types

    rp = requests.get(f"{BASE}/games/{gid}/replay", headers=_bearer(primary_token))
    assert rp.status_code == 200
    assert rp.json()["replay"]["consistent"] is True


# ---------- saves -----------------------------------------------------------
def test_save_create_duplicate_and_restore(primary_token, primary_game):
    gid = primary_game["id"]
    r = requests.post(f"{BASE}/games/{gid}/saves", headers=_bearer(primary_token))
    assert r.status_code == 201, r.text
    save = r.json()["save"]

    # Duplicate without advancing -> 409 SAVE_CONFLICT
    r2 = requests.post(f"{BASE}/games/{gid}/saves", headers=_bearer(primary_token))
    assert r2.status_code == 409
    assert r2.json()["error"]["code"] in ("SAVE_CONFLICT", "CONFLICT")

    # Advance turn then restore
    requests.post(f"{BASE}/games/{gid}/turn", headers=_bearer(primary_token), json={"days": 30})
    rr = requests.post(f"{BASE}/games/{gid}/saves/{save['id']}/restore", headers=_bearer(primary_token))
    assert rr.status_code == 200, rr.text
    restored = rr.json()["game"]
    assert restored["turn"] == save["turn"]

    # Replay still consistent
    rp = requests.get(f"{BASE}/games/{gid}/replay", headers=_bearer(primary_token))
    assert rp.json()["replay"]["consistent"] is True


# ---------- OAuth session via DB --------------------------------------------
def _psql(sql):
    return subprocess.run(
        ["su", "postgres", "-c", f'psql -d rebuplica -tAc "{sql}"'],
        capture_output=True, text=True, timeout=10,
    )


def test_oauth_session_cookie_and_logout():
    token = f"test_session_{int(time.time())}_{secrets.token_hex(4)}"
    hsh = hashlib.sha256(token.encode()).hexdigest()
    email = f"oauth.qa+{secrets.token_hex(3)}@example.com"
    # Insert user + session
    sql = (
        f"INSERT INTO users (id,email,password_hash,display_name) "
        f"VALUES (gen_random_uuid(),'{email}','x-unusable','QA Google') "
        f"ON CONFLICT (email) DO NOTHING; "
        f"INSERT INTO user_sessions (id,user_id,token_hash,provider,expires_at) "
        f"SELECT gen_random_uuid(), id, '{hsh}', 'emergent-google', now() + interval '7 days' "
        f"FROM users WHERE email='{email}';"
    )
    res = _psql(sql)
    if res.returncode != 0:
        pytest.skip(f"Cannot access postgres directly: {res.stderr}")

    # Use the session via cookie
    r = requests.get(f"{BASE}/auth/me", cookies={"session_token": token})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == email

    # Also works via Bearer header
    r2 = requests.get(f"{BASE}/auth/me", headers=_bearer(token))
    assert r2.status_code == 200

    # Logout invalidates
    rl = requests.post(f"{BASE}/auth/logout", cookies={"session_token": token})
    assert rl.status_code in (200, 204)
    r3 = requests.get(f"{BASE}/auth/me", cookies={"session_token": token})
    assert r3.status_code == 401
