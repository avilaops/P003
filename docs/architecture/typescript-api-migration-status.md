# Migração da API para TypeScript • evidências e pendências

Atualizado em 16/11/2026 na branch `feat/api-typescript-migration`.

O objetivo continua sendo migrar Preferências, Cadastros, Vendas e Relatórios para `apps/api-ts`, com contratos HTTP compatíveis e roteamento gradual no BFF. A implementação ainda não está pronta para ativação em produção.

## Estado verificado

| Área | Implementação atual | Verificação disponível | Trabalho restante |
| --- | --- | --- | --- |
| Fundação | Auth, empresa, permissões e transação com contexto RLS; escritas bloqueiam empresa antes de carregar permissões; administrador explícito por auth_subject | Testes de plataforma; role real sem bypass de RLS; revogação de permissão durante espera; administrador sem vínculo e revogação da concessão | Revisão final com os demais contratos |
| Preferências | GET e PUT com revisão | Testes com adaptador de banco simulado | Contrato integrado com PostgreSQL e revisão de paridade |
| Cadastros | Listas, detalhes e comandos de parties, products e referências; replay por igualdade estrutural de JSON; configurações cadastrais; escritas exigem leitura e gestão | Testes HTTP; escritas reais de parties/products; configurações com concorrência, auditoria e isolamento; administrador e permissão de gestão sem leitura | Validação completa dos cadastros, aplicação de todas as configurações nos comandos, envelopes/regras das referências e integração dos catálogos auxiliares |
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

## Critério de liberação

Antes de adicionar uma rota ao BFF, comparar entrada, saída, status, precondições, permissões, auditoria, outbox e regras de negócio com a implementação Rust. Escritas precisam provar concorrência, idempotência e rollback em PostgreSQL real. Testes com banco simulado ajudam a verificar o HTTP, mas não substituem essa prova.
