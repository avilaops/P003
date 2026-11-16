# Migração da API para TypeScript • evidências e pendências

Atualizado em 16/11/2026 na branch `feat/api-typescript-migration`.

O objetivo continua sendo migrar Preferências, Cadastros, Vendas e Relatórios para `apps/api-ts`, com contratos HTTP compatíveis e roteamento gradual no BFF. A implementação ainda não está pronta para ativação em produção.

O inventário de métodos, rotas, chamadas do frontend e dependências mantidas na Rust está em [Cobertura da migração](typescript-api-route-coverage.md). A revisão independente concluiu a análise do escopo e confirmou o fechamento do achado de revogação no commit `ac5cf072`; a preparação de código pode seguir para os gates de liberação.

## Estado verificado

| Área | Implementação atual | Verificação disponível | Trabalho restante |
| --- | --- | --- | --- |
| Fundação | Auth, empresa, permissões e transação com contexto RLS; escritas bloqueiam empresa antes de carregar permissões; administrador explícito por auth_subject | Testes de plataforma; role real sem bypass de RLS; revogação de permissão durante espera; administrador sem vínculo e revogação da concessão | Revisão final com os demais contratos |
| Preferências | GET e PUT com revisão i64 exata e verificação de titular antes da revisão | Testes HTTP e PostgreSQL: gravações sucessivas/concorrentes, owner key, auditoria, isolamento e limites i64 | Revisão final dos demais erros HTTP e dados persistidos |
| Cadastros | Listas, detalhes e comandos de parties, products e referências; configurações cadastrais; schemas e regras de clientes/produtos portados; envelopes/eventos/vínculos dos catálogos alinhados | Testes HTTP; escritas reais e concorrência; clientes com complementos/documento vinculado; produtos com foto, opcionais, legado, configurações e estoque; hierarquia dos catálogos | Revisão final dos contratos e integração geral de Cadastros |
| Vendas | Pedidos/propostas; aprovações; tabelas; simulação/conversão simples/mista; checkout; funil e métricas comerciais | Mesma matriz HTTP executada em Rust e TypeScript com migrations/RLS, concorrência, snapshots/permissões e rollback | Conferir rotas legadas usadas pelas telas e revisão final |
| Relatórios | Painel operacional e lista/criação/alteração de definições de relatórios personalizados | PostgreSQL/RLS com períodos, indicadores financeiros, permissões, visibilidade, fontes/colunas/filtros, revisões concorrentes e rollback | Revisão final de contratos e integração BFF/runtime |
| BFF e runtime | Seleção por módulo e método/recurso; pacote de produção; processo privado opcional, Compose e saúde das duas APIs | 178 testes de modelo web, 98 testes de edge/runtime, tipos web/API, pacote isolado, build web, dois projetos Playwright com Next real e parser Compose | CI Linux, implantação, ativação e retorno em ambiente real |

Os registros anteriores que chamaram Cadastros de concluído se basearam em testes limitados e não provam paridade completa. Esta matriz substitui essa classificação. As rotas elegíveis estão configuráveis no BFF; a ativação de produção permanece desabilitada.

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

A integração verifica criação, detalhe, listagem, alteração e replay para os quatro catálogos, incluindo compatibilidade do formato persistido do comando. Também verifica ciclos de categorias, bloqueio de arquivamento com filhos ativos, grupos de etiquetas ativos/arquivados e vínculos de outra empresa. Os contratos de clientes e produtos também estão descritos nas próximas seções.

## Clientes e fornecedores

O schema de `parties` preserva a distinção entre omissão e limpeza explícita de dados fiscais, endereços e contatos. Textos opcionais vazios normalizam para `null`; endereço e contato admitem no máximo dez registros e apenas um principal. CEP, UF, código IBGE, CPF/CNPJ e inscrição estadual seguem as validações da implementação Rust, inclusive a diferença entre validação de e-mail principal e de contato.

Criação e alteração consultam `registration_settings` para aplicar as exigências de e-mail e telefone. O replay de uma criação idempotente conserva o resultado original antes de aplicar configurações posteriores. Alterações de documento ou tipo de pessoa são bloqueadas com 409 quando o cadastro já está vinculado a pedido de venda ou compra. Auditoria e outbox incluem revisão e papéis de cliente/fornecedor, sem dados pessoais nos detalhes.

Os testes de schema e PostgreSQL verificam normalização, preservação/limpeza de complementos, exigências de contato, documento vinculado, conflito de revisão, idempotência e metadados do outbox. Isso não declara concluída a revisão integral das rotas de Cadastros.

## Produtos

O schema de produtos normaliza aliases antes da gravação e do replay, conforme o Rust: `armColors` representa cores dos anilheiros, e `plateHolderType` alimenta `plateHolderTypes`. Campos antigos e novos podem coexistir quando concordam. O preço exige exatamente duas casas decimais, sem arredondamento ou zeros extras à esquerda.

Campos opcionais nulos ou omitidos preservam o valor na edição. Categoria e foto são removidas por string vazia; arrays vazios removem opções. A resposta omite opcionais ausentes e conserva o fallback de anilheiros legados. Categoria previamente vinculada e posteriormente arquivada pode ser mantida na edição; a troca de categoria exige uma categoria ativa da mesma empresa.

Fotos usam o mesmo limite de 256 KiB, prefixo JPEG e base64 estrito da validação Rust. As rotas de criação/alteração aceitam corpo de até 2 MiB, permitindo a foto válida além do limite padrão anterior de 64 KiB. O contrato valida marcadores JPEG; não adiciona uma exigência de decodificação de pixels que o Rust não fazia.

A integração PostgreSQL verifica foto de 70.000 bytes, omissão/null versus limpeza explícita, normalização do comando persistido, leitura legada, configuração de NCM/CEST/estofado, preservação de categoria arquivada e conflitos ao trocar unidade com movimentação ou arquivar com saldo. A revisão final de status, limites e precondições continua necessária antes de liberar o BFF.

## Critério de liberação

A autenticação das rotas registradas `/api/v1/` ocorre antes do parser do corpo e a identidade é reutilizada no handler, sem segunda consulta ao userinfo. Falhas de parsing JSON, tipo de conteúdo e limite de corpo retornam problema 422; falha de autenticação continua precedendo esses erros. `/health/live` permanece público.

A revisão final ainda precisa cobrir fronteiras dos demais cabeçalhos e respostas de erro em todos os módulos. O tratamento i64 descrito abaixo já possui testes específicos e integrados.

Antes de adicionar uma rota ao BFF, comparar entrada, saída, status, precondições, permissões, auditoria, outbox e regras de negócio com a implementação Rust. Escritas precisam provar concorrência, idempotência e rollback em PostgreSQL real. Testes com banco simulado ajudam a verificar o HTTP, mas não substituem essa prova.

## Revisões de 64 bits

`platform/revision.ts` centraliza leitura, `If-Match` e incremento de revisões positivas até `9223372036854775807`. Valores seguros usam `number`; valores maiores usam `bigint` internamente. A resposta conserva tokens numéricos JSON, sem converter revisões em strings. Headers com zeros iniciais são normalizados; zero, negativos e valores acima do máximo retornam 400, e o incremento além do máximo retorna 500 como o Rust, sem persistência parcial.

O adaptador PostgreSQL serializa objetos com inteiros exatos e lê JSON/JSONB com preservação dos tokens numéricos. Isso permite replay e metadados de auditoria com revisões grandes. Os testes integrados usam o mesmo `PgClientAdapter` da aplicação e verificam bytes do JSON, ETag, JSONB persistido, replay e rollback no limite máximo. A API requer Node.js 22 ou superior para `JSON.rawJSON` e a origem do token no reviver; o runtime web atual usa Node.js 24.

## Comandos de pedidos

`POST /api/v1/orders` e `PUT /api/v1/orders/{id}` implementam o fluxo direto de catálogo. Criação e edição usam `Idempotency-Key`; a edição exige `If-Match`, apenas aceita rascunho e conserva preços, nomes e dados do cliente já acordados. Preparação valida cliente/produtos ativos, data, quantidade com seis casas, duplicação de produtos, acabamentos e total positivo. Valores são calculados com inteiros e o mesmo arredondamento do Rust.

Um item novo com tabela publicada exige o fluxo de simulação comercial. Pedidos com cotação/simulação ou checkout salvo não podem ter seu acordo alterado pelo endpoint de edição simples. O bloqueio de cotação é verificado antes do replay, como no Rust. Audit/outbox, linhas, cabeçalho e comando são gravados na mesma transação da empresa.

A integração verifica criação concorrente idempotente, edição e replay sem duplicação de auditoria, preço/nome/cliente históricos, revisão desatualizada, unidade alterada, estado não editável, checkout e tabela publicada. Os demais fluxos comerciais estão descritos abaixo; a seleção é configurável no BFF e permanece desabilitada em produção.

## Transições dos pedidos

`POST /api/v1/orders/{id}/accept`, `confirm`, `cancel` e `complete` usam chave idempotente, revisão e permissões de leitura/gestão. Aceite comercial exige checkout completo, aplica aprovações/configuração e cria os títulos das parcelas sem reservar estoque. Confirmação verifica saldo disponível e reserva o pedido; quando já aceito, preserva o acordo e verifica os títulos existentes. Conclusão exige conciliação fiscal de produção, baixa o estoque reservado e origina o recebível direto ou verifica as parcelas já originadas.

Cancelamento antes da expedição exige estorno explícito dos recebimentos, cancela títulos não pagos, verifica emissão fiscal em andamento e comissões, estorna consumos da produção e registra a conciliação e a retirada de contratos pendentes. Permissões adicionais de produção/estoque são verificadas antes do replay; retirar essas permissões impede repetir o comando antigo. Lançamentos originais são preservados.

Os cenários PostgreSQL verificam concorrência e replay, reserva concorrente sem saldo livre, baixa única, aceite sem estoque, parcelas/entrada com data de Brasília, preservação do acordo aceito após mudança de política, recebimento com estorno explícito, aprovações pendentes, cliente/produto inativo, unidade alterada, mínimo/prazo/contato, NF-e de produção e estorno único de componentes. Uma falha financeira induzida após a saída desfaz saldo, movimentação, recebível, revisão e comando. Isso comprova os efeitos dessas transições, sem declarar migrados os módulos completos de Financeiro, Estoque, Produção, Fiscal ou Contratos.

## Propostas comerciais

`POST`/`PUT /api/v1/proposals`, ações `send`/`accept`/`reject`/`cancel`, `revise`, `convert` e `approve-order` portados. A edição preserva preços e identificação já acordados; mudar preço exige `sales.proposals.negotiate`. Aceitar/rejeitar exige `sales.proposals.decide`, sem conceder implicitamente edição. Conversão exige também leitura/gestão de pedidos; aprovação e criação conjunta exige decisão. A ação `send` atualiza o estado comercial e não envia e-mail: os endpoints de e-mail continuam no Rust.

Revisão cria versão nova e conserva linhas antigas; validade usa a data de Brasília. A conversão copia os snapshots aceitos para um pedido em rascunho, verificando cliente/produtos ativos e unidade atual. O replay usa os mesmos escopos e objetos do Rust, incluindo os campos nulos de entrada e normalização do alias `armColor` antes de persistir o comando. Acabamentos são compartilhados com a preparação de pedidos, conservando regras de escolhas atuais e históricas.

Testes PostgreSQL cobrem criação e conversão concorrentes idempotentes, edição/versões históricas, condições expiradas, bloqueio de edição após envio, motivo obrigatório, aceite por usuário sem gestão, negociação sem permissão, alteração de unidade antes da conversão, aliases, revisão maior que 2^53 e rollback integral de pedido/linhas/vínculo/comando na falha de outbox. A matriz geral ainda exige revisão final de erros/precondições antes de ativar o BFF.

## Painel e relatórios personalizados

`GET /api/v1/dashboard` preserva períodos 7D/30D/3M/6M/12M e recorte pela data de Brasília. Vendas exclui cancelados dos valores, conserva sua contagem separada e apresenta série mensal. Recebíveis e pagamentos a fornecedores mostram saldo atual com baixas parciais/estornos, independentemente do período de vendas. Indicadores sem permissão retornam `null`, sem simular saldo ou contagem zero.

`GET`/`POST /api/v1/system/custom-reports` e `PUT /api/v1/system/custom-reports/{id}` preservam as definições declarativas e a lista permitida de fontes, colunas e filtros. Não foi criado endpoint de exclusão ou execução de SQL, pois não existem nesse contrato Rust. A alteração exige revisão; as escritas registram auditoria/outbox. Não se acrescentou requisito de idempotência ausente no contrato original.

A leitura continua protegida pelas políticas restritivas existentes de `system_config.report_definitions`: permissão da fonte e visibilidade privada/da empresa. A criação exige vínculo ativo do titular com a empresa, inclusive para administrador da plataforma, conforme o INSERT original. A role da API precisa de USAGE no schema, EXECUTE em `system_config.has_permission(text)` e SELECT/INSERT/UPDATE na tabela.

Os testes usam uma empresa com valores conhecidos: duas vendas de R$ 100,00 e R$ 200,00 no período, um cancelamento e uma venda antiga excluída. Conferem médias, séries, recebimento parcial/estorno, ausência de permissão, períodos, visibilidade/RLS, fonte não autorizada, campos proibidos, concorrência 200/412 e rollback após falha de outbox. A validação conserva limites em bytes do Rust para nomes/filtros.

O parser HTTP agora conserva inteiros JSON i64/u64 antes da validação, usando a proteção de sintaxe/protótipos do Fastify. Isso corrige filtros numéricos como `9007199254740993`, que antes arredondavam já na entrada. PostgreSQL e resposta mantêm o token exato; números fora do intervalo finito são rejeitados. A suíte de fronteiras verifica autenticação antes do parser e rejeição de entradas inválidas.

## Aprovações comerciais

`GET`/`PUT /api/v1/commercial/approval-settings`, `GET /api/v1/commercial/orders/{id}` e `POST /api/v1/commercial/orders/{id}/decision` implementados. A configuração exige gestão da empresa. A consulta apresenta o snapshot público e conserva a margem privada apenas quando o usuário possui gestão da empresa e alçada de diretor. Gerente aprova somente negociações que não exigem diretor; a decisão exige leitura do pedido e a alçada, sem conceder edição geral do pedido.

As alçadas são verificadas sobre a negociação atual antes de devolver o replay. Decisão, revisão do pedido, histórico, auditoria/outbox e comando são atômicos. Os testes verificam regra ausente, configurações concorrentes 200/412, margem oculta, gerente sem permissão geral de edição, decisão concorrente idempotente, revogação antes do replay, exigência de diretor e rollback quando falha a gravação do histórico. A simulação de uma linha, as tabelas e o fluxo misto estão descritos abaixo.

## Fronteiras das consultas

Buscas de pedidos extraem somente número inteiro positivo até o máximo i64. Expressões como `1e30`, `1.0` e inteiros acima do limite continuam como busca textual, sem enviar decimal ou overflow ao PostgreSQL. Paginação e versão exigem sintaxe inteira e rejeitam coerções de JavaScript, valores vazios e parâmetros repetidos. Os limites de busca contam caracteres Unicode após remover espaços externos; pedidos rejeitam caracteres de controle, enquanto propostas preservam a regra original de rejeitar NUL no texto.

Testes unitários e PostgreSQL cobrem essas fronteiras. A revisão geral de precedência de erros e precondições continua pendente.

## Simulação comercial

`POST /api/v1/commercial/simulate` usa a versão ativa publicada, os snapshots de política/custos/produtos e a revisão das regras de aprovação. Consulta preço/custo somente quando a identidade, unidade, estado ativo e revisões continuam compatíveis. Política alterada exige nova publicação; versão divergente retorna 412 e custo/produto desatualizado retorna 409. A consulta adquire bloqueio compartilhado da empresa; não é tratada como comando que altera dados. Margens continuam restritas à combinação de gestão da empresa com alçada de diretor.

`parameters.ts` e `negotiation-model.ts` portam as regras gerenciais e o cálculo de centavos com bigint: arredondamento por unidade, teto do IPI, descontos percentual/valor/total, busca do maior total que respeita o valor solicitado, entrada e comissão, frete, custos, impostos, margem e alçadas. Os parâmetros gerenciais que já eram f64 no Rust continuam com `number`; valores monetários e limites racionais usam inteiros.

Os testes reproduzem os valores dos cenários Rust, incluindo R$ 12.563,23 líquidos, R$ 1.633,22 de IPI e R$ 14.196,45 totais; preço com múltiplos produtos/quantidades, limite de total que não pode ser ultrapassado, prejuízo, entrada explícita zero e configurações inviáveis. PostgreSQL verifica a versão publicada, fontes válidas, margem oculta, estabilidade do digest, alteração da revisão de aprovação e fontes desatualizadas. O digest usa SHA-256 de JSON com chaves ordenadas, preservando a representação de inteiros e a estrutura usada por `serde_json::Value`.

O endpoint de simulação não cria pedidos. A conversão e a tabela comercial de consulta estão descritas nas próximas seções.

## Conversão da simulação e condições negociadas

`POST /api/v1/commercial/orders` revalida a simulação/digest e cria o rascunho, itens, snapshots público/privado e condições comerciais na mesma transação. Preserva `negotiation.convert` e seu objeto de replay, incluindo oportunidade/revisão e checkout quando informado. Vínculo com oportunidade verifica cliente, revisão e ausência de pedido anterior. Autoaprovação usa a política salva e a alçada de diretor.

`orders/checkout-save.ts` grava o cliente e as formas de pagamento como snapshots, entrada, parcelas, fabricação e observações. Forma de pagamento precisa estar ativa na mesma empresa; entrada e parcelas devem somar o total exato. As condições salvas são imutáveis e não representam recebimento ou criação de títulos. O aceite/confirmacão origina os títulos nos momentos já descritos nas transições.

A integração verifica digest desatualizado, oportunidade incompleta/stale, entrada sem forma de pagamento, soma incorreta, criação concorrente idempotente e replay do resultado original após aceite. Uma falha de INSERT no checkout desfaz pedido, itens, cotação, vínculo, auditoria e comando. O fluxo completo de entrada explícita zero permanece pendente de aprovação; após decisão autorizada, o aceite origina somente o título do saldo.

## Simulação e conversão de tabelas mistas

`POST /api/v1/commercial/mixed/simulate` e `POST /api/v1/commercial/mixed/orders` portados. Cada item conserva linha comercial e versão de origem, permitindo misturar importados e nacionais. O desconto usa uma razão comum; frete e taxa fixa são rateados com restos distribuídos de forma determinística, conservando todos os centavos. Cada grupo usa sua política de IPI e entrada. Taxas fixas incompatíveis retornam conflito; prejuízo em um grupo exige diretor mesmo com lucro agregado positivo.

A conversão compartilha o fluxo de cliente, acabamentos, oportunidade, checkout e auditoria com a conversão simples. Registra `mixed_negotiation.convert`, snapshot público com `kind: mixed`, políticas privadas e vínculos em `commercial_order_quote_versions`; não força uma única versão no cabeçalho. Margem privada continua protegida.

Os testes reproduzem o cenário Rust de total 152.715 centavos com IPI/entrada diferentes, frete 103 e taxa fixa 101 distribuídos sem duplicação. Conferem modos de desconto, limite de total, conservação dos itens e prejuízo por grupo. PostgreSQL verifica simulação/privacidade, entrada 86.497 e saldo 66.218, duas origens vinculadas, conversão concorrente idempotente, replay após custo alterado e rollback se a gravação das versões falhar.

## Tabelas comerciais por alçada

`GET /api/v1/commercial/tables/{line}` implementado para imported/national, com destino/condição tributária, forma de pagamento ativa e limite aplicável ao usuário. O limite usa a mesma cotação por centavo e busca binária da implementação Rust. Vendedor, gerente e diretor recebem limites diferentes conforme as regras; custos e margens não saem nessa consulta, inclusive para o diretor.

Versão ausente retorna `data: null`. Configuração desatualizada, regras ausentes e itens desatualizados preservam seus estados e mensagens de disponibilidade. São retornados os 54 cenários de UF/condição, com limite nulo quando não há item elegível. Após aguardar o bloqueio compartilhado da empresa, a rota recarrega as permissões antes de calcular alçadas.

Os cenários PostgreSQL verificam vendedor com 20%, gerente sem permissão geral de edição, diretor, campos privados ausentes, contexto/filtros, pagamento com apenas campos de exibição, estados de indisponibilidade e revogação de leitura durante espera real pelo bloqueio. A consulta retorna 403 após a revogação.

## Funil e métricas comerciais

Lista, detalhe, criação e alteração de `/api/v1/opportunities` portados. Totais por etapa abrangem a empresa inteira, enquanto busca/etapa/paginação filtram a lista. A escrita conserva os textos e o formato original do comando, valida CNPJ/contato, exige cliente ativo quando informado e preserva o cliente após vínculo com pedido. Revisão, replay, auditoria/outbox e rollback usam a transação comum.

`GET /api/v1/commercial/metrics/orders` e `commissions` preservam as consultas Rust. Conclusões são contadas pelos eventos `order.completed` dentro da competência em Brasília, independentemente da criação do pedido. A leitura de comissões exige sua permissão própria; competência e valores atuais pendentes/futuros conservam os critérios originais. Essas consultas não migram os comandos do módulo Financeiro.

Os testes PostgreSQL verificam criação idempotente, edição concorrente 200/412, filtros/totais globais, vínculo de cliente, entradas inválidas e rollback no funil. As métricas usam valores conhecidos e eventos na fronteira UTC do mês para demonstrar o recorte de Brasília; recebimento parcial e estorno mudam a previsão de comissão de 664 para 885 centavos.

## Matriz HTTP executada nas duas APIs

`pnpm --filter api-ts test:contracts` executa os mesmos cenários de integração contra Fastify e contra o servidor Rust real compilado do checkout. Cada execução cria seu próprio banco, aplica todas as migrações e usa a mesma role restrita sujeita a RLS. O servidor Rust recebe autenticação local controlada, limite de conexões e workers desabilitados; nenhuma credencial externa é necessária. O comando exige a URL administrativa de testes e falha se não puder executar a comparação.

A matriz passou nas duas implementações em 16/11/2026. A comparação identificou fixtures de pagamento incompletas, corrigidas para refletir os snapshots realmente salvos. Cenários adicionais demonstraram uma diferença real na leitura TypeScript: snapshots incompletos eram retornados sem validação. O leitor agora conserva o erro 500 do contrato Rust para dados salvos inválidos e omite campos extras ao decodificar a forma de pagamento.

Esse resultado verifica os cenários existentes, sem substituir a revisão final de cobertura, o teste do BFF ou a validação de implantação/retorno por módulo. As rotas equivalentes Rust continuam presentes para retorno controlado.

## Seleção de backend no BFF

O proxy do navegador seleciona o backend antes do envio, usando uma lista explícita de métodos e recursos já implementados. `ERP_TYPESCRIPT_MODULES` aceita `preferences,registrations,sales,reports`; vazio conserva todas as rotas Rust. Um módulo habilitado exige `ERP_TYPESCRIPT_API_URL` como origem HTTPS ou HTTP em loopback. Recursos fora da lista continuam na Rust, inclusive Fiscal, Financeiro, documentos e e-mail.

O proxy conserva sessão, empresa, corpo sem reserializar números, `If-Match`, `Idempotency-Key`, ETag e identificação da resposta. Cada operação faz uma única chamada. Perda de resposta ou erro do backend não provoca nova tentativa em Rust. Para retornar um módulo, remova seu nome da configuração e reinicie/reimplante o BFF. As duas implementações compartilham PostgreSQL, revisões e comandos salvos.

Testes de seleção e do proxy real verificam as quatro famílias, rollback de Vendas, cabeçalhos/JSON, conflito, falha após envio, configuração ausente e permanência de rotas não migradas em Rust. A regressão dos proxies existentes também passou. O processo TypeScript foi preparado no runtime conforme descrito a seguir; a ativação de produção continua pendente.

## Runtime privado e empacotamento

O build de produção compila somente o código da API para `dist/server.js` e produz um pacote com dependências de execução, incluído na imagem web existente da mesma release. Não acrescenta um novo registro de imagem ao manifesto. Um teste inicia o pacote isolado, sem `tsx`, com configuração sintética e banco indisponível; a API responde liveness 200 e readiness 503.

O runtime Cloudflare inicia TypeScript em loopback8081 somente quando houver módulos habilitados. Passa somente banco/Auth; mantém segredos de sessão, SMTP e Fiscal fora desse processo. O supervisor aguarda readiness real de Rust e TypeScript antes de iniciar a interface e encerra os demais processos quando um falha. A saúde pública exige todas as APIs habilitadas. As configurações do inventário continuam desativadas por padrão.

O produtor web empacota o artefato validado e o produtor API executa a matriz compartilhada durante a validação completa. Testes locais verificaram isolamento das variáveis, espera por prontidão, falha/encerramento dos processos e saúde pública. A integração no deploy Compose existente e a validação por navegador estão descritas abaixo; a ativação real continua pendente.

O build web passou após gerar o OpenAPI do checkout e os tipos de rotas Next. Na primeira execução, após compilação/tipos/prerenderização, o Next interrompeu o comando com um alerta de segurança da versão instalada. A repetição concluiu com código zero. Nenhuma atualização de dependência foi realizada nesta etapa; a recomendação de atualização de segurança precisa continuar registrada separadamente.

O alerta reapareceu na verificação posterior. A auditoria e o [aviso oficial GHSA-mfr8-8qww-v76h](https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h) confirmaram a correção em 16.4.5. Next, `@next/mdx` e `eslint-config-next` foram atualizados juntos de 16.4.3 para 16.4.5, com lockfile regenerado. A nova auditoria não aponta esse aviso em Next; o build e os 179 testes de modelo passaram. O lint terminou sem erros, com oito avisos existentes. Isso não representa resolução dos demais avisos de dependências do monorepo.

## Navegador e BFF Next real

`playwright.api-migration.config.ts` inicia dois servidores Next do build de produção: um com os quatro módulos habilitados e outro com retorno explícito a Rust. Ambos usam cookies de sessão cifrados e backends HTTP locais controlados, sem interceptar as chamadas do navegador ao BFF. A matriz PostgreSQL real permanece a verificação separada das regras de negócio.

Os dois projetos passaram. Conferem a tela de Vendas com o backend esperado, consultas das quatro famílias, POST com sessão/empresa/revisão/chave de comando, corpo numérico sem arredondamento e cabeçalhos da resposta. Troca de empresa e sessão ausente são barradas antes do upstream. Perda da resposta produz uma única chamada, sem repetir em outro backend; Financeiro permanece na Rust. O teste integra a primeira partição de navegador da validação completa.

## Integração com Compose

O dispatcher do layout JSON prepara o serviço privado quando a configuração web já habilita módulos, sem alterar essa decisão do operador. Seleciona somente banco/Auth, força loopback e fixa a imagem no mesmo digest web. Módulos inválidos são recusados antes de regravar a configuração. O layout YAML oferece o perfil opcional `typescript` e um arquivo privado próprio, preservado nas releases seguintes. Os detalhes de ativação/retorno estão em `deploy/CI-CD.md`.

O transformador JSON passou nos testes de ativação, desativação e separação de segredos. O parser real do Compose validou o YAML com configuração sintética, sem iniciar containers. Sete simulações completas do dispatcher dependem de Linux e foram ignoradas no Windows; a tentativa de usar WSL encontrou o serviço de virtualização indisponível. Essas simulações continuam obrigatórias no CI Linux. Não houve alteração do dispatcher instalado ou da configuração de produção.

As nove verificações de `test_dispatcher.py`, incluindo as sete simulações de Linux, foram executadas em seguida em um diretório temporário isolado no servidor Applications e passaram. O pacote continha somente sete arquivos de código permitidos. Docker, imagens, releases e HTTP foram substituídos pelas fixtures do próprio teste; os serviços reais permaneceram intactos. O pacote e os arquivos temporários remotos foram removidos após a execução.

## Pedidos antigos • simulação preservada

A revisão das chamadas em `order-detail-commercial.tsx` identificou `GET /api/v1/orders/{id}/pricing` e `POST /api/v1/orders/{id}/pricing/approve`, usados pelos pedidos antigos. Ambos foram portados e adicionados à seleção de Vendas no BFF.

A consulta devolve o snapshot original sem recalcular a negociação. Margens privadas exigem simultaneamente gestão da empresa e alçada de diretor. Gestão da empresa permite aprovar uma exceção pendente sem conceder edição geral de pedidos; não concede, sozinha, acesso às margens. A aprovação conserva motivo normalizado, revisão, replay, auditoria/outbox e a transação original.

A mesma matriz passou em Rust e TypeScript para consulta pública/privada, snapshot ausente, pedido inexistente, permissões, motivo inválido, concorrência idempotente, revisão antiga, falta de pendência, revogação antes do replay e rollback quando falha o outbox.

## Fronteiras de autenticação

A matriz compartilhada passou também para perfis `userinfo` com nome nulo ou vazio, resposta 201, perfil inválido, recusa e formato Bearer. O leitor conserva o fallback do nome para e-mail e exige status 200 do Auth. O cabeçalho de empresa presente mas vazio retorna `invalid_tenant`, distinguindo a ausência do cabeçalho. Essas diferenças foram corrigidas na API TypeScript antes da liberação.

A API conserva `X-Request-Id` recebido ou gera um UUID antes de autenticar. A resposta, inclusive falhas de autenticação, devolve o mesmo identificador. Comandos que já usam esse campo na auditoria recebem o identificador da requisição original; o teste concorrente verifica essa correlação sem duplicar a auditoria no replay.

## Revisão de código • revogação durante simulação

A revisão independente identificou permissões antigas na projeção privada das duas rotas de simulação: a requisição podia aguardar `FOR SHARE` enquanto uma transação administrativa revogava a alçada. O contexto agora recarrega as permissões antes de incluir `director`, como os `allowed()` da implementação Rust. Quando somente gestão da empresa ou alçada de diretor é revogada, a resposta continua 200 com `director: null` e a mesma cotação pública.

Um teste PostgreSQL observa a espera real em `pg_stat_activity`, revoga cada uma das duas permissões separadamente e libera o bloqueio. Os quatro casos passaram nas duas APIs. O teste falhou antes da correção TypeScript, demonstrando a diferença real. A revisão não identificou outro achado Critical ou Important na cobertura examinada e confirmou o fechamento da correção.

## Revisão no GitHub

O [PR #229](https://github.com/avilaops/P003/pull/229) reúne a implementação em rascunho. A verificação TypeScript/PostgreSQL e a matriz Rust/TypeScript são obrigatórias também na validação de PR, sem depender de `inputs.full` e sem permitir omitir a URL de testes. A preparação do código e o PR não representam ativação em produção.
