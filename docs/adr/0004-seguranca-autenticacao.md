# ADR-0004 — Autenticação e segurança da API

- Status: Aceita
- Data: 2026-09-20
- Decisor(es): proprietário do projeto

## Decisão
Senhas são armazenadas somente como hashes scrypt. Access tokens são JWT HS256 de curta duração, com `iss`, `aud`, `exp` e `jti`. Segredos vêm do ambiente e nunca são incluídos em respostas ou logs. A API aplica limite básico por IP/rota e respostas de erro têm formato uniforme.

Refresh tokens, quando ativados, deverão ser armazenados somente por hash e rotacionados/revogados. Cookies de autenticação, se adotados, deverão ter `HttpOnly`, `Secure`, `SameSite` apropriado e proteção CSRF correspondente.
