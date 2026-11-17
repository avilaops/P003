# API TypeScript • cobertura da migração

Inventário integrado à `main`, conferido com as chamadas das telas e a lista explícita do BFF em 16/11/2026. Os quatro módulos foram ativados em produção na release `3c00410091fc30e6191f301f2b762740643a2772`. As evidências e os limites da verificação estão em [Estado da migração](typescript-api-migration-status.md#produção--ativação-e-retorno-verificados).

| Módulo | Métodos e recursos em `/api/v1` | Uso conferido no frontend |
| --- | --- | --- |
| `preferences` | GET/PUT `preferences` | Preferências pessoais e organização do painel em `features/dashboard/use-dashboard-preferences.ts` |
| `registrations` | GET/POST `parties`; GET/PUT `parties/{id}` | Clientes/fornecedores e seleção de cliente de pedidos/propostas |
| `registrations` | GET/POST `products`; GET/PUT `products/{id}` | Cadastro, busca e acabamentos dos equipamentos |
| `registrations` | GET/POST das coleções e GET/PUT do detalhe em `product-categories`, `product-groups`, `tag-groups`, `tags` | Categorias, grupos e etiquetas dos cadastros |
| `registrations` | GET/PUT `registration-settings/{section}` para `products`, `parties`, `contact-types`, `tax-profiles` | Regras cadastrais consumidas por clientes e produtos |
| `sales` | GET/POST `orders`; GET/PUT `orders/{id}` | Visão geral, listas, detalhe e edição de pedidos |
| `sales` | POST `orders/{id}/{action}` para `accept`, `confirm`, `cancel`, `complete` | Aceite, confirmação, cancelamento anterior à conclusão e conclusão |
| `sales` | GET `orders/{id}/pricing`; POST `orders/{id}/pricing/approve` | Consulta e aprovação do preço preservado de pedidos antigos em `order-detail-commercial.tsx` |
| `sales` | GET/POST `proposals`; GET/PUT `proposals/{id}` | Lista, detalhe/versão histórica e edição de propostas |
| `sales` | POST `proposals/{id}/{action}` para `send`, `accept`, `reject`, `cancel`, `revise`, `convert`, `approve-order` | Estado comercial, versões e conversão em pedido |
| `sales` | GET/PUT `commercial/approval-settings`; GET `commercial/orders/{id}`; POST `commercial/orders/{id}/decision` | Configuração de alçadas, consulta e decisão da negociação |
| `sales` | GET `commercial/tables/{line}` para `imported`, `national` | Tabela comercial e montagem de pedido com as duas origens |
| `sales` | POST `commercial/simulate`, `commercial/orders`, `commercial/mixed/simulate`, `commercial/mixed/orders` | Simulação, condições comerciais e conversão simples/mista |
| `sales` | GET/POST `opportunities`; GET/PUT `opportunities/{id}` | Funil comercial e vínculo da oportunidade com o pedido |
| `sales` | GET `commercial/metrics/orders`, `commercial/metrics/commissions` | Indicadores comerciais; leitura de comissão mantém sua permissão própria |
| `reports` | GET `dashboard` | Indicadores do painel com períodos e permissões |
| `reports` | GET/POST `system/custom-reports`; PUT `system/custom-reports/{id}` | Definições declarativas em `features/preferences/system/custom-reports.tsx` |

## Dependências que conservam o backend Rust

A seleção é feita por método e recurso, permitindo que uma tela consulte ambos os backends sobre o mesmo PostgreSQL. Não há transferência de dados entre bancos.

• `me`, `company`, empresas e administração de usuários/permissões continuam na API existente. Preferências nesta onda correspondem ao contrato pessoal `preferences`, conforme a tarefa 2 do plano.

• Fiscal, Financeiro, Estoque, Compras, Produção e Contratos conservam seus endpoints. As transições de pedidos preservam os efeitos transacionais nessas tabelas; isso não migra seus módulos completos.

• Documentos, anexos, e-mail, exportação/importação de produtos, catálogo técnico e imagens continuam nas rotas existentes. Não são redirecionados por uma regra genérica de prefixo.

• A administração e publicação de tabelas/custos (`price-tables`, `commercial-settings`, `product-costs`, `fixed-expenses`) e o simulador legado (`sales-simulator`) conservam sua API existente. `/vendas/simulador` usa o fluxo `commercial` migrado. A consulta de um pedido antigo usa agora `orders/{id}/pricing`, também migrada.

• Relatórios de Financeiro/Estoque que consultam `receivables`, `financial-payables` ou `stock` conservam essas fontes. A onda de Relatórios migra `dashboard` e as definições de relatórios personalizados, conforme a tarefa 5; não cria um mecanismo de execução arbitrária de SQL.

## Verificação e retorno

`apps/api-ts/test/postgres-sales.test.ts` aplica as migrações em bancos descartáveis, usa uma role sujeita a RLS e executa os mesmos cenários contra Fastify e o servidor Rust real. Os helpers incluem permissões, revogação, revisões, replay, concorrência, snapshots e rollback das escritas. O comando obrigatório é `pnpm --filter api-ts test:contracts`.

Os testes Node do BFF verificam a lista permitida, recursos mantidos em Rust, configuração inválida e ausência de nova tentativa após um comando. Dois projetos Playwright exercitam o Next real com flags antigas preenchidas e vazias; os quatro módulos usam TypeScript nos dois casos. A matriz PostgreSQL verifica TypeScript, Rust de referência explícita e o gateway Rust de produção, incluindo MCP nativo. Os upstreams do navegador são fixtures HTTP locais controladas.

Os 65 handlers dos 43 caminhos migrados e seus helpers exclusivos são compilados somente em testes ou com `--features migration-reference`. A compilação de produção mantém os nomes de transporte como aliases do gateway e deriva as operações não migradas normalmente. O fragmento OpenAPI versionado conserva as operações migradas e 85 schemas exportados, incluindo dois componentes que a referência registra sem referência transitiva. Os testes comparam esse fragmento à referência e os documentos completos das duas compilações.

O retorno operacional seleciona uma release anterior completa, com suas imagens e configuração, conforme [o procedimento atual](typescript-api-transition-finalization.md). `ERP_TYPESCRIPT_MODULES` foi aposentada e não restaura handlers ausentes da imagem. Falha ou perda de resposta nunca seleciona outro backend ou repete um comando.
