# Rebuplica 27 — PRD / Estado do Projeto

**Stack (preservada do projeto original, NÃO trocar):** Node.js + TypeScript (motor de simulação determinístico, event sourcing) · PostgreSQL 15 local · proxy FastAPI apenas para o ingress · React (CRA) + Tailwind no frontend.

## Problema original
Finalizar um projeto existente de simulação política do Brasil contemporâneo:
1. **Fase 1 — Backend:** investigar/corrigir os 4 testes do audit (golden-master, contract, end-to-end, server) e garantir E2E em Postgres real.
2. **Fase 2 — Contratos de API:** completar endpoints necessários ao frontend.
3. **Fase 3 — Frontend:** interface jogável consumindo a API real.
4. **Fases 4/5:** testes E2E do loop completo e preparação de deploy.

Restrições do usuário: não recriar o projeto do zero, preservar arquitetura/regras/determinismo, idioma da interface em **português (BR)**, autenticação por **e-mail e senha** com sessão em cookie HttpOnly (Google/Emergent removidos em 09/10/2026), visual sóbrio e funcional primeiro.

## Arquitetura em execução
| Componente | Onde | Porta |
| --- | --- | --- |
| Motor + API (TypeScript) | `/app/src` (`supervisor: node-backend`) | 127.0.0.1:8002 |
| Proxy FastAPI (só repassa `/api/*`) | `/app/backend/server.py` | 0.0.0.0:8001 |
| PostgreSQL 15 | `supervisor: postgres` | 5432 |
| Frontend React (CRA) | `/app/frontend` | 3000 |

- Prefixo `/api` é removido em `src/api/server.ts` antes do roteamento interno.
- O proxy remove o header `Origin` antes de encaminhar (a decisão de CORS é do edge; o cookie de sessão é `SameSite=Lax`).
- Migrações: `db/migrations/0001..0004`, aplicadas via `npm run migrate`.

## Implementado (09/06/2026 — sessão atual)
### Fase 1 — Backend (concluída)
- **Achado:** 3 dos 4 arquivos do audit não existiam no repositório; só `tests/api/server.test.ts` existia. Também não havia script `test:all`.
- Criado `tests/domain/golden-master.test.ts`: roteiro fixo (seed 2027) com estado, stream de eventos, fingerprint SHA-256 e sequência do RNG congelados; replay consistente; restauração auditável.
- Criado `tests/api/contract.test.ts`: todas as rotas do `docs/07-API.md`, nos prefixos `/` e `/api`, envelopes, paginação e erros 400/401/404/405/409/415.
- Criado `tests/api/end-to-end.test.ts`: loop completo em **Postgres real**, reinício a frio e isolamento entre jogadores.
- Criado `tests/api/oauth.test.ts`: fluxo de login social com fetcher injetado.
- Adicionado script `npm run test:all`. **Resultado reportado na fase Emergent: 273 testes, 0 falhas; a execução atual do CI registrou 274 testes passando.**
- Corrigido o supervisor do Postgres (havia instância duplicada iniciada fora do supervisor).

### Fase 2 — Autenticação social (concluída)
- Migração `0004_oauth_sessions.sql`: `users.display_name`, `users.picture_url` e tabela `user_sessions` (token guardado só como sha256, expiry de 7 dias, revogação).
- `src/api/oauth.ts`: troca do `session_id` no serviço Emergent (injetável em teste).
- `AuthService.exchangeOAuthSession` / `authenticateSession` / `revokeSession`.
- Rotas `POST /api/auth/session` e `POST /api/auth/logout`; cookie `session_token` HttpOnly + Secure + SameSite=Lax.
- Autenticação aceita cookie **ou** Bearer (JWT próprio ou token de sessão).
- `GET /auth/me` passou para o escopo de rate limit `read` (300/min).

### Fase 3 — Frontend jogável (concluída)
- Tema escuro institucional (Bitter + IBM Plex), grão, animações de entrada, layout assimétrico.
- `Login`: Google (Emergent) + e-mail/senha com mensagens em português.
- `AuthCallback` detectando `session_id` pelo `useLocation().hash`.
- `Dashboard`: criar partida (semente manual ou sorteada) e histórico de partidas.
- `Match`: painel do mundo (econômicos/sociais/institucionais/flags), despacho de decisões, avanço de turno (30/90/365 dias), saves com gravar/restaurar e Diário oficial (timeline de eventos) + selo de integridade do replay.

### Fase 4 — Testes E2E (concluída)
- `testing_agent` iteração 1: **backend 15/15 e frontend 16/16, zero bugs** (`/app/test_reports/iteration_1.json`).
- Suíte de regressão criada pelo agente de testes: `/app/backend/tests/test_backend_e2e.py`.

## Backlog priorizado
### P0 — Domínio político (não existe no backend hoje)
O motor só conhece `SET_ECONOMIC_INDICATOR` e `SET_FLAG`. Para as 22 telas do enunciado é preciso criar, dentro de `src/domain/core` e respeitando o determinismo:
1. Partidos e candidatos (ideologia, capital político, financiamento).
2. Eleições (presidencial + estaduais, apuração determinística por seed).
3. Congresso (composição, coalizões, votação de projetos).
4. Estados/mapa (27 unidades, indicadores regionais).
5. Crises e eventos aleatórios seedados.
6. Campanha (comícios, mídia, tempo de TV).

### P1
- Telas do frontend para cada bloco do P0.
- Gráficos de série histórica dos indicadores (recharts já instalado) a partir do stream de eventos.
- Paginação/carregar mais no Diário oficial.

### P2 — Deploy (Fase 5)
- Validar `npm run build` + `src/main.ts` em modo produção dentro do pipeline de deploy.
- Documentar variáveis de ambiente necessárias e o papel do proxy FastAPI.

## Notas operacionais
- `npm run test:all` precisa de `TEST_DATABASE_URL` (ou `DATABASE_URL`) no `.env` para os testes de integração.
- O golden master congela o comportamento do domínio: qualquer mudança de regra exige atualizar `tests/domain/golden-master.test.ts` de forma consciente.
- Contas de teste E2E devem ser temporárias e geradas por execução. Não armazenar senhas, tokens de sessão ou URLs de banco com credenciais em arquivos versionados.
