# Migração integral • fundação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remover a dependência do SQLx para migrações e registrar as lacunas reais de cobertura da API antes dos próximos domínios.

**Architecture:** Migrador Node independente mantém o ledger SQLx existente; inventário cruza as rotas Rust descobertas e as efetivamente registradas no Fastify, sem alegar equivalência funcional só por registro. A ativação em deploy ocorre depois da validação, em plano separado.

**Tech Stack:** Node 22+, TypeScript, pg, node:crypto, PostgreSQL.

**Spec:** docs/superpowers/specs/2026-11-17-typescript-complete-api.md

## Global Constraints

- PostgreSQL próprio permanece; não usar Supabase.
- Preservar contratos, autorização, isolamento, idempotência e histórico de migrações.
- Não modificar arquivos SQL já aplicados nem usar produção para testes de escrita.
- Não retirar a API nativa ou alterar seu deploy antes da equivalência necessária.
- Não ampliar automações de preparação contratual.

## Review Focus

- Uma migração aplicada ausente ou alterada deve bloquear qualquer pendente.
- Falha SQL deve reverter o arquivo e não deixar registro de sucesso.
- Duas execuções simultâneas devem compartilhar o bloqueio SQLx.
- Encerramento com erro não pode devolver conexão ainda bloqueada ao pool.
- Rotas parametrizadas registradas não provam comportamento nem permissão equivalentes.

## Task 1 • Migrador compatível

Arquivos: apps/api-ts/src/platform/migrations.ts, src/migrate.ts, test/migrations.test.ts, package.json.

- [ ] Ler implementação local sqlx-postgres-0.8.6/src/migrate.rs e sqlx-core/migrate para regras exatas de arquivos/checksum/lock; não adivinhar.
- [ ] Criar testes com PG descartável cobrindo ledger existente, checksum alterado, dirty, arquivo aplicado ausente, transação falha e concorrência/bloqueio compartilhado.
- [ ] Exportar runMigrations(pool: Pool, options: { directory: string }): Promise<{ applied: string[]; existing: number }> e CLI npm run migrate com DATABASE_URL e diretório explícito/raiz documentado. Não imprimir credenciais.
- [ ] Usar SHA384, ledger _sqlx_migrations e advisory lock SQLx (0x3d32ad9e multiplicado pelo CRC32 ISO HDLC do nome do banco); conexão dedicada e liberação segura.
- [ ] Reconhecer apenas formatos suportados pelo SQLx, rejeitar ambiguidades, manter reversíveis/down conforme a fonte e tratar no-transaction conscientemente. Não escrever SQL novo.
- [ ] Executar testes específicos e typecheck, registrar evidência. Root possui git/commits.

## Task 2 • Inventário verificável

Arquivos: verification/ts-migration-inventory.mjs e documentação gerada.

- [ ] Reutilizar discovery.mjs para rotas Rust de produção, cruzar com Fastify.hasRoute depois de ready sem acesso a dados reais.
- [ ] Emitir método/caminho/arquivo original e estado native_only ou registered_unverified; nenhuma rota deve ser marcada concluída por esta medição.
- [ ] Documentar contagens e próximos subprojetos, sem eliminar arquivos nativos ainda necessários.

## Task 3 • Revisão e integração

- [ ] Revisão independente, correções de achados reais e PR isolado.
- [ ] Ativar migrador somente em plano posterior com deploy e rollback próprios; esta entrega adiciona capacidade sem trocar a produção silenciosamente.
