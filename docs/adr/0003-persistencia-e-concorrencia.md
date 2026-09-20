# ADR-0003 — Persistência versionada e concorrência otimista

- Status: Aceita
- Data: 2026-09-20
- Decisor(es): proprietário do projeto

## Contexto
Partidas precisam ser recuperáveis, versionadas e reproduzíveis. Atualizações concorrentes não podem sobrescrever silenciosamente uma versão anterior.

## Decisão
O estado corrente é armazenado com `current_version`. Eventos e salvamentos usam a chave única `(game_id, version)`. Atualizações devem declarar a versão esperada e falhar em caso de conflito. A camada de domínio permanece independente do PostgreSQL por meio de portas de persistência.
