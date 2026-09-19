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

## Camadas previstas

### Interface
Responsável pela experiência do jogador.

### API
Responsável por autenticação, validação, autorização e comunicação com os sistemas do jogo.

### Domínio
Contém as regras centrais do jogo e deve evitar dependência direta de infraestrutura.

### Persistência
Responsável por banco de dados, migrações e acesso aos dados.

### Infraestrutura
Responsável por serviços externos, filas, armazenamento, observabilidade e integrações.

## Futuro: Simulation Engine

O motor deverá ser modular e consumir/produzir estado do mundo por meio de contratos definidos. A implementação concreta será decidida quando os requisitos da simulação estiverem definidos.

## Futuro: IA

A IA será uma camada de integração, não a fonte única da verdade do estado do jogo. O estado persistido e as regras determinísticas do domínio devem continuar sob controle do sistema.
