# Migração da API para TypeScript • evidências e pendências

Atualizado em 16/11/2026 na branch `feat/api-typescript-migration`.

O objetivo continua sendo migrar Preferências, Cadastros, Vendas e Relatórios para `apps/api-ts`, com contratos HTTP compatíveis e roteamento gradual no BFF. A implementação ainda não está pronta para ativação em produção.

## Estado verificado

| Área | Implementação atual | Verificação disponível | Trabalho restante |
| --- | --- | --- | --- |
| Fundação | Auth, empresa, permissões e transação com contexto RLS; escritas bloqueiam empresa antes de carregar permissões; administrador explícito por auth_subject | Testes de plataforma; role real sem bypass de RLS; revogação de permissão durante espera; administrador sem vínculo e revogação da concessão | Revisão final com os demais contratos |
| Preferências | GET e PUT com revisão | Testes com adaptador de banco simulado | Contrato integrado com PostgreSQL e revisão de paridade |
| Cadastros | Listas, detalhes e comandos de parties, products e referências; replay por igualdade estrutural de JSON; configurações cadastrais; escritas exigem leitura e gestão; envelopes, eventos e vínculos dos catálogos auxiliares alinhados ao Rust | Testes HTTP; escritas reais de parties/products; configurações concorrentes; CRUD/replay/listas dos quatro catálogos e conflitos de hierarquia/grupos em PostgreSQL | Validação completa dos clientes/produtos, aplicação de todas as configurações nos comandos e revisão final de paridade |
| Vendas | Listas e detalhes de pedidos e propostas; checkout e versões históricas | Testes HTTP e integração PostgreSQL com migrations completas e RLS | Comandos, transições e consultas comerciais |
| Relatórios | Pendente | Pendente | Painel e CRUD de relatórios personalizados |
| BFF e runtime | Pendente | Pendente | Seleção explícita por rota, ausência de retry de comandos, runtime e rollback |

Os registros anteriores que chamaram Cadastros de concluído se basearam em testes limitados e não provam paridade completa. Esta matriz substitui essa classificação. Nenhuma rota foi liberada no BFF.

## Teste integrado de Vendas

O arquivo `apps/api-ts/test/postgres-sales.test.ts` cria um banco descartável, aplica todos os arquivos SQL de `migrations` em ordem e consulta através de uma role `NOLOGIN NOSUPERUSER NOBYPASSRLS`. A conexão administrativa serve apenas à preparação e limpeza do teste. A API acessa os dados com a role restrita.

O teste verifica itens, checkout salvo, proposta por versão, listagem, permissões de consulta e isolamento entre empresas. Também concede permissões específicas para testar escritas reais de parties/products: duas criações com a mesma chave retornam o mesmo snapshot, duas alterações da mesma revisão retornam 200 e 412, dados divergentes na chave retornam 409, e auditoria/outbox não se duplicam. Uma revogação de permissão enquanto o comando aguarda a empresa bloqueada resulta em 403. A falha induzida do outbox desfaz a criação e não registra o comando. Cada execução remove exclusivamente o banco e a role de nomes aleatórios que ela própria criou.

Execução em PowerShell com PostgreSQL local descartável:

```powershell
$env:API_TS_TEST_ADMIN_URL='postgresql://postgres@127.0.0.1:55432/postgres'
pnpm --filter api-ts test
pnpm --filter api-ts typecheck
```

Sem `API_TS_TEST_ADMIN_URL`, somente o teste integrado é ignorado. Um resultado com esse teste ignorado não comprova integração PostgreSQL.

## Configurações cadastrais

`GET` e `PUT /api/v1/registration-settings/{section}` implementados para `products`, `parties`, `contact-types` e `tax-profiles`. A leitura aceita gestão da empresa, leitura da empresa ou leitura do domínio correspondente. A escrita exige `platform.company.manage` e `If-Match`; grava a revisão seguinte e auditoria na mesma transação, sem adicionar outbox inexistente no contrato Rust.

Perfis tributários preservam códigos com zeros à esquerda, normalizam alíquotas para quatro casas e validam regras completas somente quando declaradas. O cadastro de perfis não transfere os processos de emissão fiscal para a API TypeScript.

## Catálogos auxiliares

Categorias de produtos, grupos de produtos, grupos de etiquetas e etiquetas usam o snapshot `{tenantId,canEdit,data}` no detalhe e nos comandos. `data` conserva os campos planos do registro. O replay de POST retorna 201 e o de PUT retorna 200, com `idempotency-replayed: true` somente na repetição.

Os escopos persistidos em `domain_commands` usam os nomes Rust (`product_category.created`, `product_group.created`, `tag_group.created`, `tag.created` e os equivalentes `.updated`). A requisição persistida usa `{id,revision,input}` e o resultado armazena o snapshot completo. Auditoria e outbox conservam o nome da tabela como tipo de entidade e apenas revisão, revisão anterior e status nos detalhes.

A integração verifica criação, detalhe, listagem, alteração e replay para os quatro catálogos, incluindo compatibilidade do formato persistido do comando. Também verifica ciclos de categorias, bloqueio de arquivamento com filhos ativos, grupos de etiquetas ativos/arquivados e vínculos de outra empresa. Esses testes não substituem a revisão ainda pendente dos comandos de clientes e produtos.

## Critério de liberação

Antes de adicionar uma rota ao BFF, comparar entrada, saída, status, precondições, permissões, auditoria, outbox e regras de negócio com a implementação Rust. Escritas precisam provar concorrência, idempotência e rollback em PostgreSQL real. Testes com banco simulado ajudam a verificar o HTTP, mas não substituem essa prova.
