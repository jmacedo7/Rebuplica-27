# Rebuplica 27 — Roadmap

## Fase 0 — Fundação do repositório
- [x] Licença proprietária
- [x] Repositório privado
- [x] README inicial
- [x] .gitignore
- [x] Documentação inicial

## Fase 1 — Fundação técnica
- [x] Stack definitiva
- [x] Estrutura de diretórios
- [x] Tipagem
- [ ] Lint e formatação
- [x] Testes
- [x] CI
- [x] Validação de ambiente
- [x] PostgreSQL e migrações versionadas

## Fase 2 — Backend base
- [x] Modelo PostgreSQL inicial e constraints
- [x] Migrações versionadas
- [x] Autenticação inicial (scrypt + JWT)
- [x] Autorização básica por proprietário no domínio
- [x] Usuários e perfis mínimos
- [x] Núcleo de partidas e estado do mundo
- [x] Snapshots/salvamentos versionados (portas + memória + SQL)
- [x] Histórico de eventos e estrutura de auditoria (SQL)

## Fase 3 — API e segurança
- [x] Contratos iniciais de API
- [x] Validação de entrada básica
- [x] Rate limiting em memória por IP/rota
- [x] Tratamento padronizado de erros
- [ ] Logs estruturados completos
- [ ] Observabilidade/telemetria completa
- [ ] Testes de integração com PostgreSQL

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

## Fase 5 — Simulation Engine
- [ ] Contrato do motor
- [ ] Motor determinístico inicial
- [ ] Sistema de eventos
- [ ] Consequências
- [ ] Evolução do estado do mundo

## Fase 6 — IA
- [ ] Abstração de provedores
- [ ] Provedores
- [ ] Configuração de modelo
- [ ] Controle de custos e limites
- [ ] Segurança de chaves

## Fase 7 — Frontend
- [ ] Interface base
- [ ] Dashboard
- [ ] Campanha
- [ ] Governo
- [ ] Estado do país
- [ ] Decisões
- [ ] Histórico
- [ ] Responsividade
