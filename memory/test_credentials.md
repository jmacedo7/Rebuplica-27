# Credenciais de teste — Rebuplica 27

## Conta por e-mail/senha (JWT próprio do backend TS)
- E-mail: `qa.rebuplica@example.com`
- Senha: `uma-senha-bem-longa-123`
- Criada via `POST /api/auth/register`. Login em `POST /api/auth/login` devolve `accessToken` (Bearer, 1h).
- A senha precisa de no mínimo 12 caracteres (regra do domínio).

## Login social (Emergent-managed Google Auth)
- Não há senha gerenciada pelo app. O fluxo é:
  1. `GET https://auth.emergentagent.com/?redirect={origin}/dashboard`
  2. retorno em `#session_id=...`
  3. `POST /api/auth/session` com `{"session_id": "..."}` → cria/atualiza o usuário e devolve cookie `session_token` (HttpOnly, Secure, SameSite=Lax, 7 dias).
- Para testar sem passar pelo Google: criar a sessão direto no Postgres.

```bash
# token de sessão de teste (o banco guarda só o sha256)
TOKEN="test_session_$(date +%s)"
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)
su postgres -c "psql -d rebuplica -c \"
  INSERT INTO users (id,email,password_hash,display_name)
  VALUES (gen_random_uuid(),'oauth.qa@example.com','x-unusable','QA Google')
  ON CONFLICT (email) DO NOTHING;
  INSERT INTO user_sessions (id,user_id,token_hash,provider,expires_at)
  SELECT gen_random_uuid(), id, '$HASH', 'emergent-google', now() + interval '7 days'
  FROM users WHERE email='oauth.qa@example.com';\""
echo "cookie: session_token=$TOKEN"
```

O backend aceita o mesmo valor como `Authorization: Bearer <session_token>`.

## Banco
- Postgres local: `postgres://rebuplica:rebuplica@localhost:5432/rebuplica`
- Banco de testes: `rebuplica_test`
