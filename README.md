# Rebuplica 27

**Rebuplica 27** é um jogo de simulação política e governamental ambientado no Brasil contemporâneo.

O jogador começa como candidato à Presidência da República, desenvolve sua campanha e propostas e pode ser eleito ou não. Caso eleito, passa a governar o Brasil, tomando decisões que afetam política, economia, sociedade, instituições, estados e relações internacionais.

> **O poder está nas suas mãos.**

## Status
🚧 **Em desenvolvimento — fase de fundação do projeto.**

O foco atual é construir uma base sólida: arquitetura, banco de dados, autenticação, partidas, estado do mundo, salvamentos, histórico de decisões, APIs, testes e segurança. A simulação avançada e a integração com modelos de IA serão desenvolvidas posteriormente.

## Desenvolvimento
Requisitos: Node.js 22.18 ou superior e npm. O PostgreSQL é necessário para a persistência de produção; a fundação também possui repositórios em memória para testes.

```bash
npm install
cp .env.example .env
npm run verify
npm run config:check
npm run dev
```

Veja `docs/03-ROADMAP.md` para o estado das fases e `docs/05-BACKEND.md` para a fundação técnica.

## Licença
Este projeto é **proprietário**. Consulte `LICENSE` para os termos de uso.
