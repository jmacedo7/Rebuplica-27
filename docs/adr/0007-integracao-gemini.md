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

## Adendo (09/10/2026): duas opções de chave
- **Chave do projeto** (`GEMINI_API_KEY`): gratuita para o jogador, limitada por
  `GEMINI_DAILY_LIMIT` consultas por jogador por dia UTC (tabela `ai_usage`, contagem
  atômica no PostgreSQL). Falhas do provedor devolvem a cota.
- **Chave pessoal**: cadastrada pelo jogador, criptografada com AES-256-GCM
  (`src/security/secret-box.ts`, segredo mestre `AI_KEY_ENCRYPTION_SECRET`) em
  `user_ai_keys`; sem o limite do projeto, o jogador arca com o próprio custo.
- Quando o projeto passar a cobrar (após o período gratuito), o ponto de extensão é
  `AiService.generate` em `src/api/ai-service.ts`, que já separa a origem da chave
  (`source`) e a cota. O modelo de cobrança ainda será definido.
- Rotação do `AI_KEY_ENCRYPTION_SECRET` invalida as chaves salvas: os jogadores
  precisam cadastrá-las de novo (decifrar com outro segredo falha de forma segura).
