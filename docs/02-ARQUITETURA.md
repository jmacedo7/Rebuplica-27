# Rebuplica 27 — Arquitetura

## Princípios

1. Modularidade.
2. Separação clara de responsabilidades.
3. Segurança por padrão.
4. Configuração por ambiente.
5. Estado persistente e versionado.
6. APIs com contratos claros.
7. Testabilidade.
8. Observabilidade.
9. Escala sem complexidade prematura.

## Camadas implementadas

### Interface
Não iniciada (fase 7). O backend já expõe o contrato documentado em `docs/07-API.md`.

### API (`src/api`)
Roteamento HTTP, autenticação, validação, autorização por proprietário, rate limit, logging estruturado, tratamento de erros e serviços de aplicação (`AuthService`, `GameService`).

### Domínio (`src/domain`)
Regras centrais determinísticas: estado do mundo, decisões, turnos, eventos, snapshots, replay e validadores de schema. Não conhece HTTP, SQL nem o relógio do sistema.

### Persistência (`src/persistence`)
Portas (interfaces), adaptador PostgreSQL real, adaptador em memória apenas para testes e runner de migrations versionadas com checksum.

### Infraestrutura
Limitada ao que existe hoje: pool PostgreSQL, logs JSON, probes `/health` e `/ready`, shutdown gracioso. Sem filas, cache distribuído ou serviços externos — por decisão explícita (ADR-0005/0006).

## Futuro: Simulation Engine

O motor deverá ser modular e consumir/produzir estado do mundo por meio de contratos definidos. A implementação concreta será decidida quando os requisitos da simulação estiverem definidos.

## Futuro: IA

A IA será uma camada de integração, não a fonte única da verdade do estado do jogo. O estado persistido e as regras determinísticas do domínio devem continuar sob controle do sistema.
