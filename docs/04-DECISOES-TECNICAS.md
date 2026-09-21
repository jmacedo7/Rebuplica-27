# Rebuplica 27 — Decisões Técnicas

## Regra de decisão

Decisões pequenas, locais e reversíveis podem ser tomadas durante a implementação. Mudanças importantes devem ser analisadas antes de serem aplicadas, especialmente arquitetura, stack, banco de dados, autenticação, contratos de API, infraestrutura e modelo de dados.

## Critérios

As decisões devem considerar segurança, manutenção, simplicidade, desempenho, escalabilidade, custo, testabilidade e compatibilidade com os requisitos do jogo.

## Governança técnica

O proprietário do projeto é o responsável pela decisão final. A gestão do projeto é compartilhada entre o proprietário e os responsáveis pela coordenação técnica.

Implementadores devem explicar problema, impacto, solução proposta, riscos e testes antes de mudanças estruturais relevantes.

## Registro

Decisões arquiteturais relevantes devem ser registradas aqui ou em ADRs dedicadas.

ADRs existentes:

- `adr/0003-persistencia-e-concorrencia.md` — estado versionado e concorrência otimista.
- `adr/0004-seguranca-autenticacao.md` — autenticação, hashing e tokens.
- `adr/0005-runtime-postgresql-e-restauracao.md` — PostgreSQL como persistência real do runtime, migrations com checksum e semântica de restauração.
- `adr/0006-rate-limit-e-determinismo.md` — rate limit em memória e determinismo verificável.
