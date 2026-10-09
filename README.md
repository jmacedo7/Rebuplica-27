# República 27

**República 27** é um jogo de simulação política e governamental ambientado no Brasil contemporâneo.

O jogador começa como candidato à Presidência da República, desenvolve sua campanha e propostas e pode ser eleito ou não. Caso eleito, passa a governar o Brasil, tomando decisões que afetam política, economia, sociedade, instituições, estados e relações internacionais.

> **O poder está nas suas mãos.**

## Status

🚧 **Em desenvolvimento — protótipo jogável conectado ao backend; simulação política completa ainda pendente.**

O repositório já contém um frontend React em português com cadastro/login por e-mail e senha, dashboard de partidas, console de partida, decisões genéricas, avanço de turno, saves, histórico de eventos e verificação de replay. Isso é uma fundação funcional, não o jogo político completo.

| Área | Estado |
| --- | --- |
| Domínio determinístico (RNG por seed, decisões, turnos, snapshots, replay) | ✅ fundação |
| Persistência PostgreSQL real, transações e concorrência otimista | ✅ |
| API HTTP para auth, partidas, decisões genéricas, turnos, eventos e saves | ✅ |
| Autenticação por e-mail/senha com sessão em cookie HttpOnly | ✅ implementadas no código e nos testes |
| Integração com o Gemini (geração narrativa) | ✅ camada implementada; requer `GEMINI_API_KEY` para validação real |
| Frontend React em português (login, dashboard, partida, saves, timeline) | ✅ protótipo inicial |
| CI backend (TypeScript, testes, build e smoke test com PostgreSQL) | ✅ 274 testes passaram no CI em 09/10/2026 |
| Build/testes automatizados do frontend no CI | ⛔ pendente |
| Campanha, seleção/criação de candidatos e partidos, eleições e apuração | ⛔ não implementados |
| Governo, Congresso, votação de projetos, 27 UFs, crises e relações internacionais | ⛔ não implementados |
| Gráficos de indicadores históricos a partir dos eventos | ⛔ pendente |
| Integração com Gemini/Outros provedores de IA e gerenciamento seguro de chaves | ⛔ não implementada |

## Requisitos

- Node.js **22.18+** (o projeto usa TypeScript nativo do Node, sem etapa de transpilação em desenvolvimento).
- npm 10+.
- PostgreSQL 16+ (testado em 18).

## Instalação

```bash
npm install
cp .env.example .env      # ajuste DATABASE_URL e JWT_SECRET
npm run config:check      # falha rápido se algo obrigatório estiver ausente
npm run migrate           # aplica as migrations pendentes
npm run dev               # servidor em http://127.0.0.1:3000
```

Para gerar um `JWT_SECRET` adequado:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## Variáveis de ambiente

Todas as variáveis são validadas na inicialização (`src/config/env.ts`) e estão documentadas em `.env.example`.

| Variável | Obrigatória | Default | Descrição |
| --- | --- | --- | --- |
| `DATABASE_URL` | sim | — | `postgres://usuário:senha@host:porta/banco`. Não existe fallback em memória. |
| `DATABASE_SSL` | não | `disable` | `disable`, `require` ou `no-verify` (provedores gerenciados normalmente exigem TLS). |
| `JWT_SECRET` | em produção | aleatório em dev/test | Mínimo de 32 caracteres; placeholders e valores de baixa entropia são rejeitados em produção. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | não | `republica-27` / `rebuplica-api` | Claims verificadas em todo token. |
| `ACCESS_TOKEN_TTL_SECONDS` | não | `900` | Validade do access token (60–86400). |
| `CORS_ALLOWED_ORIGINS` | não | vazio (somente mesma origem) | Origens exatas separadas por vírgula para frontend/API em origens diferentes. Curingas são rejeitados. |
| `NODE_ENV` | não | `development` | `development`, `test` ou `production`. |
| `HOST` / `PORT` | não | `127.0.0.1` / `3000` | Endereço de escuta. Em containers use `0.0.0.0`. |
| `LOG_LEVEL` | não | `info` | `debug`, `info`, `warn`, `error` ou `silent`. |
| `GEMINI_API_KEY` | não | — | Chave **do projeto** (padrão, com limite diário por jogador). Ausente = só chaves pessoais. Nunca no frontend, nunca no repositório. |
| `GEMINI_DAILY_LIMIT` | não | `20` | Consultas por jogador por dia (UTC) atendidas com a chave do projeto (1–10000). Quem usa chave própria não é limitado. |
| `AI_KEY_ENCRYPTION_SECRET` | não | — | Segredo mestre (mín. 32 caracteres) que criptografa as chaves pessoais no banco (AES-256-GCM). Ausente = chaves pessoais desativadas. |
| `GEMINI_MODEL` | não | `gemini-2.5-flash` | Identificador do modelo usado nas chamadas `generateContent`. |
| `GEMINI_TIMEOUT_MS` | não | `20000` | Tempo limite por chamada ao provedor (1000–60000 ms). |

## Banco de dados e migrations

```bash
npm run migrate          # aplica o que falta (idempotente, checa checksum, usa advisory lock)
npm run migrate:status   # apenas relata o estado, sem alterar nada
```

As migrations ficam em `db/migrations` e são aplicadas em ordem, cada uma em sua própria transação, registradas em `schema_migrations` com checksum SHA-256. Editar uma migration já aplicada é erro: crie uma nova.

Tabelas: `users`, `games`, `game_events`, `game_saves`, `audit_log`, `schema_migrations` e `refresh_tokens` (reservada, ver ADR-0004).

## Desenvolvimento

```bash
npm run dev            # servidor com TypeScript nativo do Node
npm test               # suíte completa (integração PostgreSQL roda quando TEST_DATABASE_URL/DATABASE_URL existe)
npm run typecheck      # tsc --noEmit
npm run build          # compila para dist/
npm start              # executa o build (dist/main.js)
npm run verify         # typecheck + testes + build
```

Sem `DATABASE_URL`/`TEST_DATABASE_URL` a suíte roda 218 testes e marca como *skipped* apenas os de integração PostgreSQL (mensagem explícita no relatório). Com banco, roda 249 testes, incluindo concorrência real e reinício de processo.

Testes de integração precisam de um usuário com permissão de `CREATEDB` (cada arquivo cria um banco temporário descartável). No CI o serviço `postgres` é superusuário.

## API

Documentação completa em [`docs/07-API.md`](docs/07-API.md). Resumo:

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| GET | `/health` | não | Liveness (sem banco). |
| GET | `/ready` | não | Readiness (verifica o banco). |
| POST | `/auth/register` | não | Cria usuário. |
| POST | `/auth/login` | não | Devolve access token. |
| GET | `/auth/me` | sim | Usuário autenticado. |
| POST | `/games` | sim | Cria partida. |
| GET | `/games` | sim | Lista partidas do usuário (paginado). |
| GET | `/games/:id` | sim | Estado da partida. |
| POST | `/games/:id/decisions` | sim | Aplica decisão (versiona + registra evento). |
| POST | `/games/:id/turn` | sim | Avança turno (versiona + registra evento). |
| GET | `/games/:id/events` | sim | Histórico de eventos (paginado, `afterVersion`). |
| GET | `/games/:id/replay` | sim | Reconstrói o estado pelos eventos e compara com o persistido. |
| POST | `/games/:id/saves` | sim | Cria snapshot da versão atual. |
| GET | `/games/:id/saves` | sim | Lista snapshots. |
| POST | `/games/:id/saves/:saveId/restore` | sim | Restaura um snapshot (transacional). |

Regras invariantes:

- todo recurso privado pertence a um usuário; partidas de terceiros respondem **404** (não 403), para não revelar existência;
- escritas são transacionais e usam optimistic locking por `current_version`: um conflito responde **409**;
- eventos são únicos por `(game_id, version)`; nada de estado sem evento correspondente;
- erros nunca expõem SQL, stack trace, caminho de arquivo ou segredo.

## Deploy

1. Configure `DATABASE_URL` (e `DATABASE_SSL=require` em provedores gerenciados) e um `JWT_SECRET` forte.
2. Rode as migrations antes de subir a nova versão: `npm run migrate` (release phase, job de deploy ou `npm run migrate && npm start`).
3. Suba o processo com `npm start` (usa `dist/`).
4. Aponte os probes para `/ready` (depende do banco) e/ou `/health` (apenas processo).
5. Defina `HOST=0.0.0.0`. Se frontend e API estiverem em origens diferentes, configure `CORS_ALLOWED_ORIGINS` com a origem exata do frontend (incluindo `https://`, sem barra final).
6. O processo trata `SIGTERM`/`SIGINT`: para de aceitar conexões, drena requisições (10s) e fecha o pool.

Limitação conhecida: o rate limiting é em memória, portanto por instância. Com mais de uma réplica, o limite efetivo é multiplicado pelo número de instâncias (ver `docs/05-BACKEND.md`).

## Documentação

- [`docs/01-PROJETO.md`](docs/01-PROJETO.md) — conceito e visão
- [`docs/02-ARQUITETURA.md`](docs/02-ARQUITETURA.md) — camadas
- [`docs/03-ROADMAP.md`](docs/03-ROADMAP.md) — fases
- [`docs/05-BACKEND.md`](docs/05-BACKEND.md) — fundação técnica, persistência, segurança e limitações
- [`docs/07-API.md`](docs/07-API.md) — contrato da API para o frontend
- [`docs/adr/`](docs/adr) — decisões arquiteturais

## Licença

Este projeto é **proprietário**. Consulte `LICENSE` para os termos de uso.
