# Rebuplica 27 — API

Contrato HTTP consumido pelo frontend. Base local: `http://127.0.0.1:3000`. Todas as respostas são JSON UTF-8.

## Autenticação

`POST /auth/login` devolve um access token JWT (HS256, `iss`, `aud`, `exp`, `jti`) que deve ser enviado em todas as rotas privadas:

```
Authorization: Bearer <accessToken>
```

- Validade padrão: `ACCESS_TOKEN_TTL_SECONDS` (900s). Não há refresh token nesta versão (ver ADR-0004).
- Requisições sem token, com token adulterado, expirado, de outro emissor/audiência ou de usuário inexistente respondem `401 UNAUTHORIZED`.
- O token não carrega papéis: a autorização é por proprietário do recurso.

## Formato de erro

```json
{
  "error": { "code": "CONFLICT", "message": "The game changed while this request was being processed; reload and try again" },
  "requestId": "1f2c…"
}
```

| Status | Quando |
| --- | --- |
| 400 | validação de entrada (`VALIDATION_ERROR`, `INVALID_EMAIL`, `INVALID_DECISION`, `WEAK_PASSWORD`), UUID inválido |
| 401 | não autenticado / credenciais inválidas (`UNAUTHORIZED`) |
| 403 | origem de navegador não permitida (`FORBIDDEN`) |
| 404 | rota ou recurso inexistente, inclusive recurso de outro usuário (`NOT_FOUND`) |
| 405 | método errado para uma rota existente (`METHOD_NOT_ALLOWED`, com header `Allow`) |
| 409 | conflito de versão, e-mail duplicado, save duplicado (`CONFLICT`, `EMAIL_ALREADY_EXISTS`, `SAVE_CONFLICT`) |
| 413 | corpo acima do limite (`PAYLOAD_TOO_LARGE`, 64 KiB por padrão) |
| 415 | corpo que não é JSON (`UNSUPPORTED_MEDIA_TYPE`) |
| 429 | rate limit (`RATE_LIMITED`, com `Retry-After` e `X-RateLimit-Remaining`) |
| 500 | falha interna (`INTERNAL_ERROR`, `CORRUPT_STATE`) — nunca com detalhes internos |
| 503 | banco indisponível (`SERVICE_UNAVAILABLE`) |

Nunca use o `message` como chave de lógica: use `error.code`.

## Paginação

Rotas de listagem aceitam `?limit=` e `?offset=` (default `limit=20`, máximo `100`; eventos usam `limit=50`, máximo `200`). A resposta traz:

```json
{ "games": [ … ], "page": { "limit": 20, "offset": 0, "total": 42 } }
```

`total` sempre reflete o conjunto filtrado (ex.: apenas as partidas do usuário autenticado).

## Monitoramento

### `GET /health`
Liveness. Não consulta o banco. `200 {"status":"ok","service":"rebuplica-27","uptimeSeconds":12}`

### `GET /ready`
Readiness. Executa `SELECT 1`: `200 {"status":"ready","checks":{"database":"ok"}}` ou `503 {"status":"not-ready","checks":{"database":"unavailable"}}`.

Nenhuma das duas rotas é limitada por rate limit nem exige autenticação.

## Autenticação

### `POST /auth/register`
```json
{ "email": "player@example.com", "password": "a-very-strong-password" }
```
Senha: no mínimo 12 e no máximo 200 caracteres (scrypt, N=32768, r=8, p=1, salt aleatório por senha). E-mail é normalizado para minúsculas.

`201 {"user":{"id":"uuid","email":"player@example.com","createdAt":"2026-…Z"}}` · `409 EMAIL_ALREADY_EXISTS` · `400 WEAK_PASSWORD` · `400 INVALID_EMAIL`

### `POST /auth/login`
```json
{ "email": "player@example.com", "password": "a-very-strong-password" }
```
`200 {"accessToken":"…","tokenType":"Bearer","expiresIn":900,"user":{"id":"…","email":"…","createdAt":"…"}}` · `401 UNAUTHORIZED` (mesma resposta para senha errada e usuário inexistente).

### `GET /auth/me`
`200 {"user":{…}}`

## Partidas

### `POST /games`
Corpo opcional `{"seed": 1234}` (inteiro 0–4294967295; omitido ⇒ seed aleatória). O seed define o RNG determinístico da partida.

`201 {"game": { … }}` — representação de jogo:

```json
{
  "id": "uuid",
  "seed": 1234,
  "turn": 0,
  "currentVersion": 1,
  "worldDate": "2027-01-01T00:00:00.000Z",
  "createdAt": "2026-…Z",
  "updatedAt": "2026-…Z",
  "state": {
    "gameId": "uuid",
    "ownerId": "uuid",
    "seed": 1234,
    "turn": 0,
    "world": { "date": "…", "economy": {}, "society": {}, "institutions": {}, "flags": {} }
  }
}
```

### `GET /games`
Lista apenas as partidas do usuário autenticado: `200 {"games":[…],"page":{…}}`

### `GET /games/:gameId`
`200 {"game":{…}}` (com `state`) · `400` se o id não for UUID · `404` se não existir **ou** for de outro usuário.

## Gameplay

### `POST /games/:gameId/decisions`
```json
{ "type": "SET_ECONOMIC_INDICATOR", "payload": { "key": "inflation", "value": 4.2 } }
```
Tipos disponíveis hoje (o servidor devolve a lista válida ao reportar erro):

| Tipo | Payload |
| --- | --- |
| `SET_ECONOMIC_INDICATOR` | `{ "key": string, "value": number }` |
| `SET_FLAG` | `{ "key": string, "value": boolean }` |

Regras do payload: objeto plano, no máximo 16 chaves, chaves no formato `[A-Za-z][A-Za-z0-9_]*`, valores string/número/booleano, no máximo 4096 bytes. Chaves como `__proto__`, `constructor` e `prototype` são rejeitadas.

Efeito: valida → aplica no domínio → grava novo estado (`currentVersion + 1`) → registra evento `DecisionApplied` → auditoria, tudo em uma transação.

`200 {"game":{…}}` · `400 VALIDATION_ERROR` / `INVALID_DECISION` · `409 CONFLICT` se outra requisição venceu a corrida.

### `POST /games/:gameId/turn`
Corpo opcional `{"days": 30}` (1–3650; default 30). Avança `turn`, soma `days` dias a `world.date` e registra `TurnAdvanced`.

`200 {"game":{…}}` · `400` payload inválido · `409 CONFLICT`.

## Histórico

### `GET /games/:gameId/events?limit=&offset=&afterVersion=`
`200 {"events":[{"version":2,"type":"DecisionApplied","eventId":"…","recordedAt":"…","event":{…}}],"page":{…}}` — ordenado por versão crescente.

Tipos: `GameCreated`, `DecisionApplied`, `TurnAdvanced`, `SaveRestored`. Cada evento carrega o estado resultante, o que permite reconstruir a linha do tempo sem outra chamada.

### `GET /games/:gameId/replay`
Reconstrói o estado a partir do fluxo de eventos e compara com os estados gravados:

```json
{ "replay": { "consistent": true, "version": 5, "turn": 2, "events": 5,
              "checkpoints": 0, "firstMismatchVersion": null, "fingerprint": "sha256…" } }
```

`consistent: false` indica divergência entre o estado persistido e o reconstruído (corrupção ou bug de determinismo) e é um sinal de alarme. Limite: 5000 eventos (`400 REPLAY_TOO_LARGE`).

## Saves e restauração

### `POST /games/:gameId/saves`
Sem corpo. Cria um snapshot da versão atual (`201 {"save":{"id":"uuid","version":3,"schemaVersion":1,"turn":1,"worldDate":"…","createdAt":"…"}}`). Um save por versão de jogo: repetir sem avançar responde `409 SAVE_CONFLICT`.

### `GET /games/:gameId/saves`
`200 {"saves":[…],"page":{…}}` — mais recentes primeiro.

### `POST /games/:gameId/saves/:saveId/restore`
Restaura o snapshot de forma transacional. Semântica explícita:

- o estado volta a ser o do save;
- `currentVersion` **não** volta no tempo: é gravado `version + 1` com um evento `SaveRestored` que aponta `saveId` e `restoredFromVersion`;
- o histórico anterior é preservado (nada é apagado);
- o replay continua consistente, tratando `SaveRestored` como checkpoint.

`200 {"game":{…},"save":{"id":"uuid","version":3}}` · `404` para save inexistente, de outra partida ou de outro usuário · `409 CONFLICT` em corrida.

### CORS

Rotas de escrita a partir de um navegador exigem origem listada em `CORS_ALLOWED_ORIGINS`; origens não listadas recebem `403`. O preflight `OPTIONS` responde `204` com `Access-Control-Allow-Origin` apenas para origens configuradas (`Vary: Origin`). Requisições sem header `Origin` (CLI, servidor-a-servidor, testes) seguem as regras normais de token.

### Headers de resposta

`X-Request-Id` (eco de um valor seguro do cliente ou gerado), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`, `Cache-Control: no-store`, `X-RateLimit-Limit`/`X-RateLimit-Remaining` nas rotas limitadas.

## Limites de rate limit

Por IP (ou pela cadeia confiável de proxy) e por escopo: `auth` 10/min, `write` 60/min, `read` 300/min. Em memória, por instância — ver limitações em `docs/05-BACKEND.md`.
