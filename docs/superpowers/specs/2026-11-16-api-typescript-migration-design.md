# P003 • migração gradual da API para TypeScript

## Intenção

Reduzir custo de desenvolvimento e publicação substituindo gradualmente a API Rust por uma API TypeScript separada, sem reescrita total e sem alterar os contratos usados pelo ERP.

## Escopo aprovado

• Preferências

• Cadastros • clientes, fornecedores, produtos e dados de referência usados por essas telas

• Vendas • pedidos, propostas e consultas comerciais diretamente usadas pelas telas migradas

• Relatórios • painel e relatórios personalizados

## Abordagem escolhida

Uma API modular em `apps/api-ts` usa Node.js, TypeScript, Fastify, PostgreSQL e Zod. O BFF existente continua sendo a entrada do navegador e escolhe o backend por uma lista explícita de rotas. O Rust permanece disponível somente para rotas ainda não migradas.

Alternativas rejeitadas:

• Colocar regras de negócio nos Route Handlers do Next.js • mistura frontend, sessão, persistência e jobs no mesmo processo.

• Reescrever todos os módulos de uma vez • amplia o risco e impede comparação gradual.

## Compatibilidade obrigatória

• Mesmos métodos, caminhos, códigos HTTP, JSON, `ETag`, `If-Match` e `Idempotency-Key`.

• Mesmos cabeçalhos `Authorization` e `X-Tenant-Id`.

• Mesmos limites de paginação, filtros e mensagens funcionais já contratadas.

• O BFF nunca tenta outro backend depois de enviar um comando.

• Uma rota é transferida somente quando testes de contrato executam a mesma matriz contra Rust e TypeScript.

## Segurança

• O token continua validado no `userinfo` do Auth com timeouts e falha fechada.

• Toda operação abre uma transação, define `app.tenant_id` e, quando aplicável, `app.auth_subject` via `set_config(..., true)`.

• Permissões são carregadas do PostgreSQL dentro da mesma transação.

• A conta do runtime continua restrita e sujeita a RLS.

• Erros de banco não revelam SQL, valores ou credenciais.

• Comandos usam transação, revisão otimista, auditoria e idempotência existentes.

## Estrutura

`apps/api-ts/src/platform` contém configuração, autenticação, acesso, transações, erros e resposta HTTP.

`apps/api-ts/src/modules` contém um diretório por módulo e não importa código do Next.js.

`apps/api-ts/src/app.ts` registra rotas sem iniciar a rede; `server.ts` é o único ponto que escuta uma porta.

`apps/web/src/server/bff/erp-backend.ts` mantém a lista explícita de recursos migrados e escolhe `ERP_TYPESCRIPT_API_URL` ou a origem Rust.

## Ondas

1. Fundação TypeScript e Preferências.

2. Cadastros.

3. Vendas.

4. Relatórios.

5. Remoção das rotas Rust equivalentes após evidência de produção e rollback validado.

## Não objetivos

• Migrar Fiscal, certificados A1, assinatura, Financeiro, Estoque ou Compras nesta iniciativa.

• Trocar PostgreSQL, migrations SQL, RLS ou Auth.

• Usar Supabase ou acesso direto do navegador ao banco.

• Remover rotas Rust antes da validação equivalente.

## Resultado esperado

Preferências, Cadastros, Vendas e Relatórios passam a ser atendidos pela API TypeScript sem mudança perceptível no frontend. O custo de compilação Rust deixa de afetar a evolução desses módulos, enquanto o fallback operacional permanece explícito durante a transição.
