# ADR-0007 — Integração com o Gemini

- Status: Aceita
- Data: 2026-10-09
- Decisor(es): proprietário do projeto

## Decisão
A geração de conteúdo narrativo (discursos, debates, notícias, crises, diálogos)
usará a API oficial do Google Gemini, acessada exclusivamente pelo backend por
meio de uma camada isolada (`src/ai/gemini.ts`).

- A chave vive na variável de ambiente `GEMINI_API_KEY`, lida como `Secret` (nunca
  serializada em logs, erros ou saídas) e cadastre-se apenas no ambiente do backend.
- O modelo é configurável (`GEMINI_MODEL`, padrão `gemini-2.5-flash`) e o tempo
  limite por chamada é `GEMINI_TIMEOUT_MS` (padrão 20 s).
- Ausência de chave é um estado explícito: o endpoint autenticado `POST /ai/ping`
  responde `503 AI_NOT_CONFIGURED`; nunca há resposta simulada.
- Cada chamada é validada (3–1000 caracteres, propriedades desconhecidas
  rejeitadas), limitada por um escopo próprio de rate limit (`ai`, 10/min por IP) e
  mapeada para códigos de erro estáveis (`AI_AUTH_FAILED`, `AI_TIMEOUT`,
  `AI_PROVIDER_RATE_LIMITED`, `AI_PROVIDER_ERROR`, `AI_PROVIDER_UNAVAILABLE`).

## Consequências
A IA é uma camada de conteúdo, não uma fonte de verdade: o motor determinístico
continua responsável por regras, validações, alterações de estado e persistência.
A IA jamais escreve no banco nem aplica decisões políticas sem passar pelas
validações do domínio. A dependência do provedor fica confinada a `src/ai/gemini.ts`,
com o `fetcher` injetável para que os testes nunca realizem chamadas reais.
