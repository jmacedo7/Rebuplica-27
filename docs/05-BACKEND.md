# Rebuplica 27 — Fundação do backend

## Entregue nesta etapa
- Núcleo de domínio determinístico com estado do mundo, decisões, eventos, turnos, snapshots e replay.
- RNG determinístico por seed.
- Portas de persistência e repositórios em memória para testes.
- Migrações PostgreSQL com constraints de integridade, versionamento e auditoria.
- Autenticação inicial com scrypt e JWT assinado, incluindo issuer/audience/expiração.
- API HTTP nativa do Node para health, registro, login e sessão autenticada.
- Rate limiting básico e cabeçalhos de segurança.

## Fora do escopo
Motor completo de simulação, IA, frontend e integração de produção com provedor externo de PostgreSQL. O adaptador PostgreSQL concreto depende do driver `pg`; a instalação do pacote foi bloqueada neste ambiente por indisponibilidade de DNS para o npm registry.

## Garantias
Nenhum teste é considerado verde sem execução real. A suíte deve ser executada com `npm test`; o build com `npm run build`.
