# Rebuplica 27 — Fundação do backend

Estado real do backend nesta etapa. Tudo aqui foi executado (`npm run typecheck`, `npm test`, `npm run build`) contra PostgreSQL 18 real; nada é aspiracional.

## Camadas

```
src/
  config/       validação de ambiente (falha cedo, segredos mascarados)
  domain/core/  núcleo determinístico: estado, decisões, turnos, eventos, snapshots, replay, schema
  domain/shared/utilitários puros (Result, JSON canônico, fingerprint)
  persistence/  portas + adapters (PostgreSQL e memória para testes) + runner de migrations
  security/     scrypt, JWT HS256
  api/          HTTP, roteamento, validação, serviços de aplicação, logging, rate limit, erros
  main.ts       wiring do processo (config → PostgreSQL → HTTP → shutdown)
```

O domínio não conhece HTTP nem SQL. A API não monta SQL: fala com as portas de persistência. O runtime **sempre** usa PostgreSQL: `src/main.ts` constrói `createPostgresPersistence`; não existe flag de ambiente que troque para memória.

## Persistência PostgreSQL

- Driver `pg` com pool (máx. 10 conexões, timeout de conexão 5s, idle 30s, `statement_timeout` 10s, `application_name=rebuplica-27`).
- Todas as queries são parametrizadas; identificadores são validados como UUID antes de chegar ao SQL.
- Escrita sempre dentro de `persistence.transaction(...)`: `BEGIN` → operação → `COMMIT`, com `ROLLBACK` em qualquer falha e liberação do cliente em `finally`.
- Erros do driver são traduzidos para erros tipados (`OptimisticConflictError`, `EmailConflictError`, `SaveVersionConflictError`, `DuplicateEventError`, `InvalidIdentifierError`, `InvalidStoredDataError`, `DatabaseUnavailableError`). A aplicação nunca compara strings de erro do PostgreSQL.
- JSONB lido do banco passa por validação estrutural (`parseGameState`, `parseSnapshot`, `parseDomainEvent`): dado corrompido vira `INVALID_STORED_DATA`/`CORRUPT_STATE` em vez de contaminar a simulação.
- `close()` encerra o pool no shutdown.

### Concorrência otimista

```sql
UPDATE games
   SET state = $1::jsonb, current_version = current_version + 1, updated_at = now()
 WHERE id = $2 AND current_version = $3
RETURNING …
```

Zero linhas ⇒ `OPTIMISTIC_CONFLICT` ⇒ HTTP 409. Nenhuma escrita sobrescreve silenciosamente a versão de outro escritor; o teste de concorrência demonstra dois escritores sobrepostos, com o segundo casando 0 linhas.

### Eventos

`game_events(game_id, version)` é `UNIQUE`: duplicação acidental falha no banco. Estado e evento são gravados na mesma transação — se um falhar, o outro volta atrás (testado).

### Migrations

`npm run migrate` lê `db/migrations/*.sql` em ordem, aplica cada arquivo em sua própria transação, registra `schema_migrations(version, name, checksum, applied_at)` e valida o checksum SHA-256 do que já foi aplicado (editar migration aplicada é erro). Um advisory lock impede dois runners simultâneos. `npm run migrate:status` apenas relata.

## Modelo de jogo e versionamento

- `games` guarda o estado materializado (`state jsonb`) e `current_version`.
- Cada transição válida (decisão, turno, restore) incrementa a versão e grava um evento com o estado resultante.
- `game_saves` guarda snapshots por `(game_id, version)`.
- Restaurar um save **não** apaga histórico: grava `SaveRestored` em `version + 1` apontando `saveId` e `restoredFromVersion`. O replay trata esse evento como checkpoint, portanto o fluxo permanece reconstruível.

## Determinismo e replay

- RNG determinístico por seed (`seed ^ version`), sem `Math.random()` no domínio.
- Datas avançam por aritmética sobre `state.world.date`; o relógio do sistema não entra no domínio.
- `replayEvents` reconstrói o estado apenas a partir do fluxo de eventos e compara cada estado derivado com o estado gravado no evento, devolvendo `consistent`, `firstMismatchVersion` e um fingerprint SHA-256 do JSON canônico.
- `GET /games/:id/replay` expõe essa verificação; `replay()` também calcula `deterministic` executando a lista de comandos duas vezes em vez de assumir.
- Testes cobrem: reconstrução, detecção de estado adulterado, lacuna de versão, checkpoint de restore e um handler que consome o RNG.

## Segurança

- Senhas: scrypt (N=32768, r=8, p=1, maxmem 64 MiB), salt de 16 bytes por senha, comparação em tempo constante, parâmetros embutidos no hash (hashes legados de 2 segmentos ainda validam) e `passwordNeedsRehash`. Versões assíncronas evitam bloquear o event loop.
- JWT: apenas HS256 (header é validado, então `alg: none` e substituição de algoritmo falham antes de qualquer criptografia), assinatura comparada com `timingSafeEqual`, `iss`, `aud`, `iat`, `exp`, `nbf` opcional e `jti` validados, tolerância de relógio de 30s, tamanho máximo de token.
- Autorização: toda rota privada resolve o dono do recurso; partida/save de outro usuário responde 404 (autorização + não vazamento de existência). Cobertura explícita de IDOR em partidas, eventos, saves, restore e decisões.
- Validação: corpos JSON com limite de tamanho, rejeição de propriedades desconhecidas em rotas de escrita, UUIDs validados, paginação limitada, payload de decisão validado (chaves, tipos, tamanho) e proteção contra chaves de prototype pollution.
- Erros: `ApiError`/`mapError` produzem status corretos (400/401/403/404/405/409/413/415/429/500/503) sem SQL, stack ou caminho de arquivo; falhas inesperadas são logadas internamente.
- Rate limiting: escopos `auth` (10/min), `write` (60/min) e `read` (300/min), com sweep de janelas expiradas e teto de chaves rastreadas (10.000). `/health` e `/ready` são isentos.
- CORS: apenas origens explícitas (`*` é rejeitado na configuração), `Vary: Origin`, escrita bloqueada para origem não listada.
- Headers de segurança em todas as respostas e `Cache-Control: no-store`.

## Observabilidade e ciclo de vida

- Log JSON por linha com `time`, `level`, `message`, `requestId`, rota, método, status, duração e `userId`; nomes de campo sensíveis (password, token, secret, hash, authorization…) são mascarados automaticamente.
- `X-Request-Id` validado (ou gerado) e devolvido na resposta.
- `GET /health` (processo) e `GET /ready` (banco, via `SELECT 1`).
- `main.ts` falha rápido: configuração inválida ⇒ exit 78; banco inalcançável ⇒ exit 69. `SIGTERM`/`SIGINT` param de aceitar conexões, drenam requisições por 10s, forçam o fechamento se necessário e fecham o pool.

## Limitações reais desta etapa

1. **Refresh token**: não implementado. A tabela `refresh_tokens` está reservada no schema (com `token_hash` único), mas a API usa apenas access tokens de 15 minutos. Ao implementar: armazenar somente hash, rotacionar e revogar (ADR-0004).
2. **Rate limit por instância**: em memória; com N réplicas o limite efetivo é N×. Substituir por armazenamento compartilhado só quando houver mais de uma instância.
3. **`X-Forwarded-For`**: só é respeitado com hops confiáveis configurados; hoje o servidor usa o socket. Atrás de um proxy, defina o número de hops no código de wiring (`trustedProxyHops`) para não limitar todos os clientes no mesmo bucket.
4. **Replay limitado a 5000 eventos** por chamada de `/replay` (proteção contra payload gigante); partidas muito longas precisarão de snapshots como base de replay.
5. **Sem papéis/administração**: todos os usuários são jogadores; não existe endpoint administrativo nem consulta de `audit_log` pela API.
6. **Motor de simulação**: existem dois tipos de decisão (`SET_ECONOMIC_INDICATOR`, `SET_FLAG`). O motor completo, eleições, IA e frontend são fases seguintes.

## Verificação

```bash
npm run typecheck
npm test                  # 249 testes com PostgreSQL; 218 sem banco (integração é skipped)
npm run build
```

Os testes de integração criam bancos temporários descartáveis via `TEST_DATABASE_URL`/`DATABASE_URL` (requer `CREATEDB`).
