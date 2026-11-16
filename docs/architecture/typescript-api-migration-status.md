# Migração da API para TypeScript • evidências e pendências

Atualizado em 16/11/2026 na branch `feat/api-typescript-migration`.

O objetivo continua sendo migrar Preferências, Cadastros, Vendas e Relatórios para `apps/api-ts`, com contratos HTTP compatíveis e roteamento gradual no BFF. A implementação ainda não está pronta para ativação em produção.

## Estado verificado

| Área | Implementação atual | Verificação disponível | Trabalho restante |
| --- | --- | --- | --- |
| Fundação | Auth, empresa, permissões e transação com contexto RLS | Testes de plataforma; role real sem bypass de RLS nas leituras de Vendas | Paridade de administrador da plataforma; serialização e rechecagem de permissões nas escritas |
| Preferências | GET e PUT com revisão | Testes com adaptador de banco simulado | Contrato integrado com PostgreSQL e revisão de paridade |
| Cadastros | Listas, detalhes e comandos de parties, products e referências | Testes HTTP com banco simulado | Concorrência, replay com JSONB, validação completa, envelopes das referências, configurações cadastrais e testes reais de escrita |
| Vendas | Listas e detalhes de pedidos e propostas; checkout e versões históricas | Testes HTTP e integração PostgreSQL com migrations completas e RLS | Comandos, transições e consultas comerciais |
| Relatórios | Pendente | Pendente | Painel e CRUD de relatórios personalizados |
| BFF e runtime | Pendente | Pendente | Seleção explícita por rota, ausência de retry de comandos, runtime e rollback |

Os registros anteriores que chamaram Cadastros de concluído se basearam em testes limitados e não provam paridade completa. Esta matriz substitui essa classificação. Nenhuma rota foi liberada no BFF.

## Teste integrado de Vendas

O arquivo `apps/api-ts/test/postgres-sales.test.ts` cria um banco descartável, aplica todos os arquivos SQL de `migrations` em ordem e consulta através de uma role `NOLOGIN NOSUPERUSER NOBYPASSRLS`. A conexão administrativa serve apenas à preparação e limpeza do teste. A API acessa os dados com a role restrita.

O teste verifica itens, checkout salvo, proposta por versão, listagem, permissões de consulta e isolamento entre empresas. Cada execução remove exclusivamente o banco e a role de nomes aleatórios que ela própria criou.

Execução em PowerShell com PostgreSQL local descartável:

```powershell
$env:API_TS_TEST_ADMIN_URL='postgresql://postgres@127.0.0.1:55432/postgres'
pnpm --filter api-ts test
pnpm --filter api-ts typecheck
```

Sem `API_TS_TEST_ADMIN_URL`, somente o teste integrado é ignorado. Um resultado com esse teste ignorado não comprova integração PostgreSQL.

## Critério de liberação

Antes de adicionar uma rota ao BFF, comparar entrada, saída, status, precondições, permissões, auditoria, outbox e regras de negócio com a implementação Rust. Escritas precisam provar concorrência, idempotência e rollback em PostgreSQL real. Testes com banco simulado ajudam a verificar o HTTP, mas não substituem essa prova.
