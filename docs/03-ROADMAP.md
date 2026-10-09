# Rebuplica 27 — Roadmap

## Fase 0 — Fundação do repositório
- [x] Licença proprietária
- [ ] Confirmar visibilidade segura do repositório; atualmente o GitHub indica que está público
- [x] README inicial
- [x] .gitignore
- [x] Documentação inicial

## Fase 1 — Fundação técnica
- [x] Stack definitiva (Node 22 + TypeScript nativo + PostgreSQL)
- [x] Estrutura de diretórios
- [x] Tipagem estrita (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [x] Testes backend (274 passaram no CI com PostgreSQL em 09/10/2026)
- [x] CI com serviço PostgreSQL, migrations e smoke test do build
- [x] Validação de ambiente (`npm run config:check`, falha rápida)
- [x] Lockfile (`package-lock.json`) e `npm ci`
- [ ] Lint e formatação (ESLint/Prettier) — ainda pendente

## Fase 2 — Backend base
- [x] Modelo PostgreSQL com constraints de integridade
- [x] Migrations versionadas com checksum e advisory lock
- [x] Adaptador PostgreSQL real (pool, transações, optimistic locking)
- [x] Autenticação (scrypt assíncrono + JWT HS256 com iss/aud/exp/jti)
- [x] Autorização por proprietário (partidas, eventos, saves, restore) e testes de IDOR
- [x] Usuários e sessão (`/auth/register`, `/auth/login`, `/auth/me`)
- [x] Núcleo de partidas e estado do mundo determinístico
- [x] Salvar/restaurar snapshots versionados (semântica de checkpoint via `SaveRestored`)
- [x] Histórico de eventos e trilha de auditoria (`audit_log`)
- [x] Persistência comprovada após reinício do processo

## Fase 3 — API e segurança
- [x] Contratos de API de partidas, decisões, turnos, eventos, saves e restore
- [x] Validação de entrada (corpos, UUIDs, paginação, payload de decisão, propriedades desconhecidas)
- [x] Rate limiting em memória por IP/escopo, com expiração e teto de chaves
- [x] Tratamento padronizado de erros (400/401/403/404/405/409/413/415/429/500/503)
- [x] Logs estruturados com request id e mascaramento de segredos
- [x] `/health` e `/ready`, CORS por ambiente, headers de segurança
- [x] Testes de integração com PostgreSQL, concorrência e reinício
- [ ] Observabilidade/telemetria completa (métricas, tracing) — pendente
- [ ] Refresh token com rotação (tabela reservada, ver ADR-0004)

## Fase 4 — Sistemas do jogo
- [ ] Campanha
- [ ] Eleições
- [ ] Governo
- [ ] Congresso
- [ ] Economia
- [ ] Sociedade
- [ ] Estados
- [ ] Instituições
- [ ] Relações internacionais
- [ ] Crises e eventos

Hoje existem dois tipos de decisão (`SET_ECONOMIC_INDICATOR`, `SET_FLAG`) apenas para provar o caminho completo: validar → aplicar → versionar → registrar evento → replay.

## Fase 5 — Simulation Engine
- [ ] Contrato do motor
- [ ] Motor determinístico inicial (sobre o RNG por seed já existente)
- [ ] Sistema de eventos e consequências
- [ ] Evolução do estado do mundo por turno

## Fase 6 — IA
- [ ] Abstração de provedores
- [ ] Provedores
- [ ] Configuração de modelo
- [ ] Controle de custos e limites
- [ ] Segurança de chaves

## Fase 7 — Frontend (protótipo inicial implementado)
- [x] Interface base em português, tema escuro, componentes e animações
- [x] Login/cadastro por e-mail com sessão em cookie HttpOnly (Google/Emergent removidos)
- [x] Camada de integração com o Gemini (endpoint autenticado `/ai/ping`; requer `GEMINI_API_KEY`)
- [x] Dashboard para criar partidas por semente e consultar histórico
- [x] Console de partida com indicadores genéricos, decisões de teste, avanço de turno, saves, timeline e selo de replay
- [ ] Fluxo de campanha completo
- [ ] Selecionar candidato/partido existente ou criar candidato/partido novo
- [ ] Telas de governo, Congresso, votações e mapa dos 27 estados
- [ ] Gráficos históricos ligados a indicadores/eventos (a dependência Recharts existe, mas os gráficos ainda não)
- [ ] Testes reproduzíveis do frontend e build frontend incluídos no CI
- [ ] Validar responsividade/acessibilidade de todas as telas, não só do protótipo
