# Validação da fundação

Registro do que foi realmente executado nesta etapa (2026-09-21), no ambiente de desenvolvimento, e como reproduzir.

## Ambiente

- Node.js v22.22.3, npm 10.9.8.
- PostgreSQL 18.4 local (`127.0.0.1:5432`), banco `rebuplica` para desenvolvimento e `rebuplica_test` para provisionamento dos testes.
- Dependências instaladas pelo lockfile: `pg` 8.23.0, `@types/pg`, `typescript` 6.0.3, `@types/node` 22.

## Comandos executados e resultado

| Comando | Resultado |
| --- | --- |
| `npm run migrate` | aplicou `0001_init`, `0002_updated_at_trigger`, `0003_integrity_and_indexes`; segunda execução: `alreadyApplied` (idempotente) |
| `npm run migrate:status` | 3 migrations aplicadas, todos os checksums `ok` |
| `npm run typecheck` | sem erros (TS estrito) |
| `npm test` (com `TEST_DATABASE_URL`) | **249 testes, 40 suítes, 0 falhas** (15,6s) |
| `npm test` (sem banco) | **218 testes, 0 falhas**, integrações PostgreSQL explicitamente *skipped* |
| `npm run build` | `dist/` gerado |
| `node dist/main.js` | sobe, conecta no PostgreSQL, responde `/health`, `/ready` e `/auth/register`; `SIGTERM` encerra com código 0 e fecha o pool |

## Cobertura por área

- **Domínio**: decisões, validação por handler, turnos, ownership no domínio, snapshots, restore (jogos/proprietários diferentes, snapshot futuro), replay (reconstrução, detecção de estado adulterado, lacuna de versão, checkpoint `SaveRestored`, determinismo do RNG).
- **Segurança**: JWT (`alg: none`, algoritmo substituído, assinatura adulterada, expirado, `iss`/`aud` errados, claims com tipos errados, token gigante), scrypt (parâmetros, salt por senha, hashes legados, parâmetros hostis, versões sync/async), mascaramento de segredos nos logs, IDOR em partidas/eventos/saves/restore/decisões, validação de payload e prototype pollution, rate limit, CORS.
- **API**: fluxo completo de registro/login/sessão, criação e listagem paginada de partidas, decisões, turnos, eventos, saves, restore, replay, 404/405, headers de segurança, request id, corpo inválido/grande/demasiado grande, erros sem detalhes internos.
- **Integração PostgreSQL**: migrations (ordem, checksum, rollback por migration, detecção de arquivo alterado), repositórios, optimistic locking, `UNIQUE(game_id, version)` em eventos e saves, transações com rollback, leitura de dado corrompido, banco indisponível, dados preservados após reciclar o pool.
- **Concorrência**: 5 decisões simultâneas sem *lost update*, turnos concorrentes, saves concorrentes (1 aceito, 3 conflitos), registros simultâneos do mesmo e-mail, dois escritores sobrepostos no banco (segundo casa 0 linhas).
- **Persistência entre processos**: teste sobe `src/main.ts` de verdade, executa o fluxo, encerra com `SIGTERM` (exit 0), sobe outro processo e confirma usuário, partida, eventos, saves, replay consistente e isolamento entre usuários. Também verifica que o processo se recusa a iniciar com banco inalcançável.

## Testes que existiam antes desta etapa

A suíte anterior (83 testes) permaneceu verde; os dois arquivos que dependiam de detalhes internos foram atualizados para a nova API pública (`tests/api/rate-limit.test.ts` e `tests/security/password.test.ts`), não removidos.

## O que não foi possível validar aqui

- Execução do CI no GitHub Actions (o workflow foi escrito e roda em `ubuntu-latest` com serviço `postgres:18-alpine`; a validação local usou um PostgreSQL equivalente).
- Lint/formatador: não existe configuração no repositório (item aberto no roadmap).
- Deploy real em provedor externo: o processo foi validado localmente no formato de produção (`npm run migrate && npm start`, probes, shutdown), mas nenhum provedor específico foi configurado.

## Atualização de estado — 09/10/2026

O CI do commit `eeb5a34` passou com **274 testes, 0 falhas**, além de typecheck, build do backend e smoke test de `/health` e `/ready`.

A Fase A acrescentou um protótipo de frontend React e o fluxo de sessão Google ao código do repositório. O relatório `test_reports/iteration_1.json` registra uma execução anterior com 15 testes de backend e 16 passos de UI aprovados, mas o teste Playwright de frontend não está versionado como suíte reproduzível nem é executado pelo CI atual. O pipeline também não executa `npm run build` dentro de `frontend/`.

A autenticação do preview precisa de uma validação manual após atualizar o deploy. Os testes do backend comprovam o contrato HTTP, mas não comprovam que o preview ativo está rodando o mesmo commit ou com as variáveis de ambiente corretas.

### Lacunas confirmadas

- O motor de domínio só implementa `SET_ECONOMIC_INDICATOR` e `SET_FLAG`; não há entidades/persistência para campanha, candidatos, partidos, eleição, Congresso, propostas, estados ou crises.
- Não há integração de IA/provedores (Gemini/OpenRouter/OpenAI/Grok) nem gerenciamento de chaves.
- A interface atual é o protótipo de login, dashboard e partida; não é a simulação política completa.
- A contagem antiga de 249 testes acima é o histórico da etapa de setembro. Para o estado atual, use o resultado de 274 testes do CI em 09/10/2026.

**Segurança:** o arquivo antigo `memory/test_credentials.md` e os ZIPs públicos gerados durante o desenvolvimento foram removidos do estado atual do repositório. A exclusão não apaga cópias em commits anteriores. Como o GitHub reporta o repositório como público, credenciais/sessões que tenham sido válidas devem ser revogadas e a visibilidade do repositório deve ser revista; não se deve considerar o histórico antigo sanitizado.


---

## Atualização de estado — 09/10/2026 (autenticação sem Emergent + Gemini)

Escopo executado nesta etapa (sem commits; alterações no diretório de trabalho):

1. **Remoção completa da Emergent:** `src/api/oauth.ts`, `tests/api/oauth.test.ts`,
   `POST /auth/session`, header `X-Session-ID`, `backend/` (proxy FastAPI da plataforma
   antiga), `.emergent/` e `.gitconfig` foram removidos. O login passou a ser apenas por
   e-mail e senha.
2. **Sessão por cookie:** `POST /auth/login` agora emite também uma sessão opaca no cookie
   `session_token` (`HttpOnly; Secure; SameSite=None`), usando a infraestrutura de sessões
   já existente (`user_sessions`, tokens guardados apenas como hash, `POST /auth/logout`
   revoga e limpa o cookie). O frontend não guarda mais token em `localStorage`.
3. **Cadastro com nome opcional:** `POST /auth/register` aceita `displayName` (1–80 caracteres).
4. **Camada Gemini:** `src/ai/gemini.ts` (serviço com timeout, validação de entrada e erros
   estáveis) e endpoint autenticado `POST /ai/ping` com escopo próprio de rate limit
   (`ai`, 10/min). Configuração por `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`
   (documentadas em `.env.example` e no README). A chave é lida como `Secret` e nunca
   aparece em respostas, logs ou erros.
5. **Frontend:** Google removido da tela de login; campo de mostrar/ocultar senha;
   cadastro com nome e confirmação de senha; painel `POST /ai/ping` em `/painel-ia`;
   tratamento de 401 global (limpa o usuário e as rotas protegidas redirecionam).

### Comandos executados e resultado (ambiente de auditoria, sem PostgreSQL)

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | sem erros (TS estrito) |
| `npm test` (sem `TEST_DATABASE_URL`) | **261 testes, 53 suítes, 0 falhas** — incluindo as novas suítes de sessão, registro com nome e integração Gemini (com `fetcher` injetado, sem chamadas reais ao provedor) |
| `npm run build` | `dist/` gerado |
| `npm run config:check` | ok; `GEMINI_API_KEY` impressa como `[REDACTED]` |
| `frontend`: `npm ci && CI=true npm run build` | `build/` gerado sem erros de compilação |

### O que permanece exigindo validação externa

- Os testes de integração PostgreSQL (não executados aqui por ausência de banco no
  ambiente de auditoria; no CI rodam com o serviço `postgres:18-alpine`).
- A chamada real ao Gemini: exige uma `GEMINI_API_KEY` válida cadastrada no ambiente do
  backend. Sem a chave, `/ai/ping` responde `503 AI_NOT_CONFIGURED` — comportamento
  coberto por teste, não é falha.
- Teste manual do fluxo completo de login por cookie com frontend e backend em origens
  diferentes (exige `CORS_ALLOWED_ORIGINS` configurado e HTTPS).
