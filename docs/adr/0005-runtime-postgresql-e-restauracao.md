# ADR-0005 — PostgreSQL como persistência real do runtime e semântica de restauração

- Status: Aceita
- Data: 2026-09-21
- Decisor(es): proprietário do projeto

## Contexto

A fundação entregue anteriormente validava `DATABASE_URL` e possuía migrations, mas o
runtime (`createApiServer`) instanciava `InMemoryRepositories`. Não existia adaptador
`pg`, o pacote não estava instalado e a persistência era, na prática, memória: qualquer
reinício apagava usuários, partidas, eventos e saves. Também não havia semântica definida
para restaurar um save sem corromper o fluxo de eventos.

## Decisão

1. **O runtime usa PostgreSQL, sempre.** `src/main.ts` constrói
   `createPostgresPersistence` (driver `pg`, pool, `statement_timeout`) a partir de
   `DATABASE_URL`. A persistência em memória permanece apenas como adapter de teste e é
   injetada explicitamente pelos testes; não há flag de ambiente que a ative em produção.
2. **Escritas transacionais com versionamento otimista.** Toda mutação roda dentro de
   `persistence.transaction` e grava estado + evento + auditoria na mesma transação.
   `UPDATE games SET state = $1, current_version = current_version + 1 WHERE id = $2 AND
   current_version = $3` é a única forma de avançar o estado; zero linhas ⇒
   `OptimisticConflictError` ⇒ HTTP 409. `UNIQUE(game_id, version)` em `game_events` e
   `game_saves` impede duplicação acidental.
3. **Migrations com checksum.** `npm run migrate` aplica arquivos em ordem, cada um em sua
   própria transação, registrando `schema_migrations(version, checksum, applied_at)` sob
   advisory lock. Migration aplicada não pode ser editada: crie uma nova. `0003` é
   puramente aditiva (`NOT VALID` para CHECKs novos, índices, comentários, índice único
   `lower(email)`).
4. **Restauração preserva o histórico.** Restaurar grava um evento `SaveRestored` em
   `current_version + 1` referenciando `saveId` e `restoredFromVersion`, em vez de apagar
   eventos ou voltar a versão. O replay trata `SaveRestored` como checkpoint, então o
   estado continua sendo função do fluxo de eventos.
5. **Erros de driver são traduzidos** para erros tipados de persistência; nenhuma camada
   acima compara `error.message`.

## Consequências

- Reiniciar o processo não perde dados (coberto por teste que sobe `src/main.ts` duas
  vezes e confere usuário, partida, eventos e saves).
- O versionamento monotônico após restore mantém o optimistic locking utilizável.
- Instalações existentes precisam rodar `npm run migrate` antes de subir a nova versão e
  ter o Node 22.18+ com TypeScript nativo disponível para o comando de migration.
- Migrations são irreversíveis (não há `down`): mudanças destrutivas exigem migration
  aditiva + migração de dados planejada.
