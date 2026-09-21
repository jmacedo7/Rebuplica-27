# ADR-0006 — Rate limit em memória e determinismo auditável

- Status: Aceita
- Data: 2026-09-21
- Decisor(es): proprietário do projeto

## Contexto

Havia rate limiting em memória sem expiração de entradas (crescimento ilimitado do mapa) e
o replay se declarava determinístico sem verificar nada, apenas devolvendo `true`.

## Decisão

1. **Rate limit em memória, limitado e documentado.** Janela fixa por IP e escopo
   (`auth` 10/min, `write` 60/min, `read` 300/min), com varredura periódica de janelas
   expiradas e teto de chaves rastreadas. É suficiente enquanto o backend roda em uma única
   instância; a limitação (limite efetivo = N × limite com N réplicas) está registrada em
   `docs/05-BACKEND.md`. Redis não foi introduzido.
2. **Determinismo verificado, não presumido.** `replayEvents` reconstrói o estado a partir
   do fluxo de eventos e compara, evento a evento, com o estado persistido, expondo
   `consistent`, `firstMismatchVersion` e fingerprint SHA-256 do JSON canônico; `replay()`
   calcula `deterministic` executando duas vezes. O RNG continua derivado de
   `seed ^ version`, e o domínio não lê relógio do sistema.

## Consequências

- Divergência de replay passa a ser detectável (endpoint `/games/:id/replay`) em vez de
  silenciosa.
- Qualquer nova fonte de não determinismo no domínio (data/hora real, aleatoriedade do
  host) quebra os testes de replay, o que é intencional.
