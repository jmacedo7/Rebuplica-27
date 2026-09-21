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
