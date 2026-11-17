Atue como designer de produto e engenheiro frontend especializado em ERP. Analise as 20 capturas anexadas, encontre as telas correspondentes no repositório do **ERP Ávila Ops** e implemente as melhorias descritas abaixo.

Use o **TOTVS Protheus como referência de eficiência operacional**: alta densidade de informação legível, filtros rápidos, ações previsíveis, navegação por teclado e poucos passos para consultar ou editar um registro. Mantenha a identidade visual da Ávila Ops e os componentes do projeto sempre que atenderem a esses objetivos.

## Escopo

As capturas representam **20 das 63 telas**. Refatore as 20 identificadas abaixo e crie padrões reutilizáveis para as demais. Se alterar um componente compartilhado, verifique os outros consumidores para evitar regressões. Preserve rotas, permissões, isolamento por empresa, dados importados e regras de negócio. Para funcionalidades indisponíveis, melhore a comunicação do estado e registre as dependências identificadas no código.

## Padrão de interface

- **Área de trabalho.** Alinhe o conteúdo das rotinas à esquerda com margens consistentes. Use a maior parte da largura disponível em tabelas e painéis. Reserve as larguras mais estreitas para formulários curtos e mensagens que se beneficiam disso.
- **Cabeçalho e ações.** Coloque título, contexto e ação principal em uma faixa compacta. Use uma segunda linha para busca e filtros quando necessário. Padronize os rótulos de criação pelo objeto, como **Novo produto**, **Nova pessoa** e **Nova conta financeira**.
- **Listagens.** Use uma base comum para cabeçalho de colunas, contagem, estados e paginação. Como ponto de partida, experimente linhas de 32–36 px no desktop e texto de 13–14 px. Ajuste conforme o conteúdo e amplie os alvos de toque em telas menores. Alinhe valores monetários à direita, priorize identificadores e status e mantenha cabeçalhos visíveis em listagens longas quando isso ajudar.
- **Busca e edição.** Permita buscar com `Enter`, mantenha o `Ctrl+K` existente e valide a ordem de foco. Ao voltar de um detalhe, restaure busca, filtros, ordenação, página e, quando viável, a posição da rolagem. Preserve links diretos para os registros. Use painel lateral para consultas rápidas somente quando couber no fluxo existente.
- **Contexto da empresa.** Mantenha a empresa ativa visível e identifique quando o usuário estiver em contexto administrativo. Na troca de empresa, recarregue os dados, redefina seleções e invalide estados de consulta vinculados à empresa anterior. Confira o comportamento com duas empresas e perfis de acesso diferentes.
- **Estados e indicadores.** Diferencie carregamento, erro, falta de permissão, recurso indisponível, cadastro vazio e busca sem resultados. Exiba zero apenas quando for o valor real. Mostre filtros de período somente onde eles afetam os dados e identifique quais indicadores são posições atuais.
- **Acessibilidade.** Preserve foco visível, contraste, rótulos acessíveis e leitura dos estados sem depender apenas de cor. Teste o tema escuro das capturas e o tema claro caso exista no projeto. Use dados fictícios ou anonimizados nas capturas de validação.

## Melhorias nas 20 telas

| Nº | Tela | O que mudar |
|---|---|---|
| 01 | **Visão geral** | Hoje há três atalhos isolados em uma área quase vazia. Organize **Novo pedido**, **Consultar estoque** e **Documentos fiscais** em uma barra de operações com acesso por teclado. Abaixo dela, traga pendências ou registros recentes caso já exista uma fonte autorizada. |
| 02 | **Histórico importado** | Substitua a sequência de cartões expansíveis por uma grade paginada com filtro de tipo, busca e contagem. Mostre tipo, identificação e origem quando disponíveis. Abra o conteúdo original sob demanda em um detalhe de consulta. Preserve o acesso ao cadastro atual e verifique a apresentação de rótulos técnicos como `Empresa - true`. |
| 03 | **Notificações** | A rota abre uma página genérica com oito links. Mostre um estado compacto com o título **Notificações**, o motivo real da indisponibilidade quando conhecido e uma saída contextual. Alinhe o comportamento do sino global ao estado da rota. |
| 04 | **Empresas** | Troque os blocos centralizados por uma lista compacta com nome, razão social, indicação de empresa ativa e ação de acesso. Mantenha **Cadastrar empresa** no cabeçalho para quem tem permissão. Preserve o registro de acesso no contexto administrativo. |
| 05 | **Dashboard geral** | Reúna período, atualização e impressão/PDF na mesma barra. Mostre indicadores em uma faixa compacta e associe cada ligação aos registros de origem correspondentes. Diferencie pedidos do período, saldos atuais e contagem atual de produtos. |
| 06 | **Dashboard de vendas** | Preserve a definição de **valor em pedidos** e o tratamento dos cancelamentos. Dê acesso aos pedidos de um mês a partir da tabela, levando o recorte aplicado quando a rota aceitar esses filtros. Deixe a definição do ticket médio e dos cancelados disponível junto aos indicadores. |
| 07 | **Margem por pedido** | Reduza o painel de indisponibilidade a um estado contextual. Informe a dependência de custos e condições comerciais preservados por pedido e mantenha o acesso aos pedidos. Só exiba margem quando houver cobertura dos dados e regra de cálculo confirmada. |
| 08 | **Dashboard de produtos** | A tela exibe apenas **Produtos ativos**, que é uma posição atual. Retire dessa visão os controles e textos de período que não influenciam a contagem. Posicione **Consultar produtos ativos** ao lado do indicador e aplique o filtro na origem quando suportado. |
| 09 | **Dashboard de clientes** | Aplique o mesmo padrão de posição atual e elimine a referência ao período de pedidos quando ela não se aplicar. Leve o usuário à listagem com o recorte usado para contar clientes ativos. Confira como a regra existente trata quem é cliente e fornecedor. |
| 10 | **Curva ABC** | Identifique que a análise depende da base de faturamento por produto e mantenha o estado indisponível enquanto faltar essa base. Com fonte e critérios confirmados, a visão deve priorizar a grade com SKU, produto, valor, participação, participação acumulada e classe. |
| 11 | **Metas** | Confirme no código se falta o cadastro de metas ou se a empresa simplesmente não tem metas cadastradas. Mostre **Nova meta** apenas se houver fluxo funcional e permissão. Quando houver base e regra definidas, exiba período, meta, realizado e percentual juntos. |
| 12 | **Eventos** | Use o estado reutilizável de indisponibilidade com título e saída próprios de Eventos. Retire a grade de atalhos genéricos da área principal. Mostre agenda ou histórico somente se houver integração disponível. |
| 13 | **Assistente do ERP** | Dê mais largura ao chat para acomodar respostas tabulares. Mantenha o campo de mensagem acessível durante a rolagem e a empresa ativa visível. Inclua atalhos de consulta para produto, estoque e pedidos conforme as capacidades existentes. Retorne links para registros autorizados e preserve o acesso somente para consulta. |
| 14 | **Plano e limites** | Corrija o cabeçalho **Alterar dados da empresa** para refletir a seção de plano. Troque os seis cartões por uma tabela comparativa de preço, armazenamento, usuários e franquias. Destaque o plano atual quando identificado e explique junto às ações quando a contratação estiver indisponível por falta de integração. |
| 15 | **Cadastros** | Transforme os cartões altos e repetitivos em um índice compacto, agrupando **Produtos**, **Pessoas e equipe** e **Financeiro**. Use o nome da rotina como entrada principal e mostre ações de criação somente quando autorizadas. |
| 16 | **Produtos** | Dê mais espaço para nome e SKU. Mantenha unidade, preço-base e situação alinhados e reduza a altura causada pelas miniaturas. Agrupe busca, categoria e situação em uma barra. Preserve a edição pelo registro e o filtro ao retornar à lista. |
| 17 | **Clientes e fornecedores** | Aceite busca por nome ou CPF/CNPJ digitado com ou sem pontuação, respeitando a normalização do projeto. Mantenha **Cliente**, **Fornecedor** e **Cliente e fornecedor** distinguíveis. Apresente um contato principal na grade e deixe os demais no detalhe, conforme as permissões. |
| 18 | **Funcionários** | Priorize código ou matrícula existente, nome, cargo e situação. Use contato como informação secundária e padronize **Novo funcionário**. Preserve os identificadores legados e o acesso aos dados da equipe por perfil. |
| 19 | **Contas financeiras** | Use a mesma estrutura das demais listagens. Quando a empresa não tiver contas, mostre **Nova conta financeira** para o perfil autorizado. Quando a busca estiver vazia por causa dos filtros, ofereça **Limpar filtros**. Remova os controles de paginação inativos quando houver apenas uma página. |
| 20 | **Categorias financeiras** | Aplique o mesmo padrão de largura, busca e estados. Mostre nome, código, situação e tipo **Receita/Despesa** se esse campo existir. Exiba hierarquia apenas se o cadastro já suportar categorias pai e filhas. |

## Ordem de implementação

1. **Verifique as rotas e os componentes.** Para cada captura, identifique rota real, fonte de dados, permissões e ações existentes. Use as capturas como evidência visual e o código como fonte para confirmar o comportamento.
2. **Valide o padrão em três telas.** Comece por **Produtos**, **Histórico importado** e **Dashboard geral**. Elas cobrem a listagem de cadastro, a consulta de alto volume com detalhe e a análise com indicadores.
3. **Aplique o padrão às demais telas do lote.** Reaproveite barras de ações, filtros, tabelas e estados. Inclua no relatório final o que depende de fonte de dados ou regra de negócio.
4. **Compare antes e depois.** Em **1366 × 768** e **1920 × 1080**, meça quantas linhas aparecem na primeira dobra em Produtos e Histórico. Compare os passos para buscar, abrir um registro e voltar à lista. Verifique também teclado, zoom, telas estreitas, troca de empresa, estados vazios e impressão/PDF onde disponível.

## Entrega

Entregue as alterações no repositório e um resumo por tela com **rota, problema observado, melhoria entregue e validação executada**. Inclua evidências de antes e depois nas três telas piloto, resultados das verificações do projeto e os padrões que podem ser reaplicados nas outras 43 telas. Identifique cada dependência que impediu uma funcionalidade de ficar operacional.

Atue como designer de produto e engenheiro frontend especializado em ERP. Localize no repositório do **ERP Ávila Ops** as rotas correspondentes às 20 capturas deste lote, numeradas de **21 a 40 de um total de 62**, e implemente as melhorias abaixo.

Use o **TOTVS Protheus como referência de eficiência operacional**. Busque consultas rápidas, listagens densas e legíveis, navegação por teclado e ações previsíveis. Preserve a identidade visual da Ávila Ops. Reaproveite os padrões do primeiro lote para cabeçalhos, barras de filtros, tabelas e estados, conforme estiverem disponíveis no repositório.

Mantenha rotas, permissões, isolamento por empresa, regras comerciais e registros legados. Identifique no código os dados e as ações disponíveis antes de desenhar novos controles. Nas capturas, trate **“Erro interno”** como falha a investigar e **“Funcionalidade indisponível”** como estado a confirmar.

### Padrão de interface para este lote

- Alinhe as rotinas à mesma margem da área de trabalho. Use a largura disponível nas grades de vendas e estoque e concentre título, ação principal e filtros no topo. Reduza painéis centralizados, rodapés vazios e espaços entre controles.
- Nas listagens, use como ponto de partida linhas de **32–36 px** e texto de **13–14 px** no desktop. Valide legibilidade, foco e zoom. Dê colunas próprias para identificadores, valores e status quando houver espaço. Alinhe quantidades e valores à direita.
- Padronize **Buscar**, **Limpar filtros** e as ações de criação. Permita disparar a busca com `Enter`, mantenha o `Ctrl+K` e preserve filtros, página e ordenação ao retornar de um detalhe. Oculte a paginação quando houver apenas uma página.
- Diferencie empresa sem registros, filtros sem resultados, falha de consulta, falta de acesso e recurso indisponível. Exiba a ação correspondente a cada estado. Em falhas recuperáveis, preserve os filtros e ofereça nova tentativa.
- Mantenha a empresa ativa visível. Ao trocar de empresa, limpe seleções e invalide dados e filtros vinculados à anterior. Garanta que links para detalhes abram somente registros autorizados.

### Melhorias por tela

| Nº | Tela | O que implementar |
|---|---|---|
| 21 | **Categorias de produtos** | Use a grade comum com código, nome e situação. Troque **Novo cadastro** por **Nova categoria**. Confira o destino do nome clicável e do link **Editar**. Se ambos abrirem o mesmo fluxo, mantenha uma entrada para evitar dois alvos para a mesma ação. |
| 22 | **Listas de preços** | Dê à rota o título **Listas de preços** e posicione **Nova lista de preços** no cabeçalho. Preserve código, nome, vigência, situação e quantidade de produtos quando disponível. Diferencie falta de listas de uma busca sem resultados. Explique a relação com a tabela publicada apenas se o vínculo existir no sistema. |
| 23 | **Formas de pagamento** | Compacte a grade de 12 registros da captura e use **Nova forma de pagamento**. Preserve a busca pelos códigos `LEGACY-*` e a distinção entre ativo e arquivado. Verifique que uma forma arquivada continua consultável nos registros históricos conforme as regras atuais. |
| 24 | **Grupos de produtos** | Use o padrão de busca por nome ou código e situação, com **Novo grupo de produtos**. Mostre **Limpar filtros** ou a ação de criação conforme o motivo da lista vazia. Se os vínculos já existirem, disponibilize a consulta dos produtos do grupo no detalhe. |
| 25 | **Grupos de tags** | Padronize o cabeçalho com **Novo grupo de tags** e use a grade comum. Se houver vínculo implementado, permita abrir as tags daquele grupo com o filtro já aplicado. |
| 26 | **Tags** | Use **Nova tag** como ação principal. Exiba código, nome e situação. Mostre grupo e permita filtrá-lo quando o vínculo estiver disponível no cadastro. Preserve os vínculos já usados por outros registros. |
| 27 | **Vendas · Visão geral** | Transforme os cartões de rascunhos em uma faixa compacta com acesso às listas filtradas de pedidos e propostas, se as rotas aceitarem o recorte. Preserve **Novo pedido**, **Novo orçamento** e **Tabela de preços** no topo. Mantenha **Continuar** nos rascunhos editáveis e **Abrir** nos registros de consulta, conforme as regras atuais. |
| 28 | **Funil comercial** | Reúna busca, filtro de etapa e **Nova oportunidade** no topo. Identifique se o **Resumo da empresa** representa todo o funil ou o recorte atual. Quando houver registros, priorize oportunidade, empresa ou contato, etapa e valor. Se já existirem, exiba responsável e próxima ação conforme a largura disponível. |
| 29 | **Tabela de preços publicada** | Reúna linha comercial, UF, condição de IE e busca em uma barra. Mantenha versão, publicação e alçada visíveis e indique a abrangência de cada uma. Consolide o aviso sobre produtos ou custos alterados em um resumo e numa indicação por item afetado, preservando o motivo no detalhe. Alinhe valores, explique as bases de preço e mantenha **Adicionar ao pedido** e **Simular** disponíveis nas condições autorizadas. |
| 30 | **Simulador comercial** | Coloque busca e inclusão de equipamentos no mesmo fluxo e dê prioridade à grade de itens e ao resumo do cálculo. Mantenha condições comerciais agrupadas e indique quando uma alteração exige recalcular. Deixe visíveis a versão da tabela, o caráter temporário da simulação e a exigência de aprovação. Preserve as regras de desconto, entrada, frete, tributação e criação do pedido. |
| 31 | **Propostas** | Separe número, cliente, versão, situação, validade e valor na grade. Retire CPF/CNPJ da primeira leitura quando puder ser consultado no detalhe autorizado. Alinhe valor e ação por linha. Preserve a entrada **Novo orçamento** e confirme no código se “orçamento” e “proposta” identificam etapas distintas do mesmo fluxo. |
| 32 | **Pedidos de venda** | Dê colunas próprias para número, cliente, situação, vencimento e valor. Mantenha **Novo pedido** como ação principal e preserve busca por número ou cliente. Garanta que pedidos cancelados e demais registros apareçam com as ações permitidas para seu estado. Teste o retorno à mesma consulta após abrir um pedido. |
| 33 | **PDV · Frente de caixa** | Reproduza o **Erro interno** ao consultar o caixa e investigue a causa com logs, chamada ao serviço e contexto de empresa e operador. Depois da correção, apresente o estado real do caixa em uma faixa compacta e organize a inclusão de itens e os recebimentos conforme o fluxo existente. Se a consulta falhar, preserve o caixa selecionado e mostre uma nova tentativa. |
| 34 | **Fechamento do PDV** | Investigue se a falha compartilha a causa da frente de caixa. Com o fluxo disponível, mostre recebimentos, valores contados e divergências no mesmo bloco de conferência. Mantenha a confirmação explícita e valide as proteções contra fechamento duplicado em clique repetido ou nova tentativa. |
| 35 | **Histórico do PDV** | Investigue o erro da consulta e mantenha caixa, situação e datas de abertura na mesma barra. Valide o intervalo de datas. Preserve os filtros na nova tentativa. Quando a consulta funcionar, use uma grade para os caixas e links autorizados para fechamentos e comprovantes já existentes. |
| 36 | **Garantias e assistência técnica** | Mantenha **Nova garantia** no cabeçalho e apresente um estado inicial curto. Quando houver solicitações, priorize protocolo, cliente, produto e situação. Inclua filtros de andamento quando suportados e use os estágios já registrados no fluxo de triagem, reparo, aprovação e encerramento. |
| 37 | **Loja virtual** | Substitua a grade genérica de oito links por uma mensagem curta com o título **Loja virtual** e uma saída contextual, como **Voltar a Vendas**. Se houver informação verificada sobre configuração ou disponibilidade para a empresa, apresente-a junto ao estado. |
| 38 | **Anúncios** | Reaproveite o mesmo componente com o título **Anúncios**. Mostre o motivo da indisponibilidade quando confirmado. Ofereça acesso a Produtos ou ao canal correspondente somente se o destino ajudar o operador a continuar a tarefa. |
| 39 | **Importar pedidos** | Reduza a mensagem de indisponibilidade e mantenha **Consultar pedidos** visível. Investigue se há processamento conectado à rota. Se já existir, valide prévia, erros por linha, identificação de duplicidades, confirmação e resultado. Se estiver ausente, registre a dependência e mantenha a interface coerente com o estado real. |
| 40 | **Estoque · Saldos por produto** | Reúna busca por nome ou SKU e acesso ao catálogo na barra superior. Dê espaço próprio a produto e SKU e mantenha **Saldo**, **Reservado** e **Disponível** comparáveis na mesma linha, com unidade clara. Coloque **Ver movimentos** como ação da linha, preservando o produto selecionado. Valide que saldo zero aparece como zero e falhas de consulta aparecem como erro. |

### Ordem de execução e critérios de aceite

1. **Reproduza primeiro as falhas das telas 33–35.** Confira se há uma causa comum entre as três rotas. Teste caixa aberto, fechado, inexistente e falha de consulta. Use um ambiente de teste para abertura, recebimento e fechamento. Registre a causa confirmada e o resultado de cada fluxo.
2. **Use Pedidos de venda, Formas de pagamento e Saldos por produto como pilotos de compactação.** Compare quantas linhas ficam visíveis sem rolar em **1366 × 768** e **1920 × 1080**. Meça também os passos para buscar um registro, abri-lo e voltar à mesma consulta.
3. **Valide a negociação comercial de ponta a ponta.** Abra um item da tabela publicada no simulador, altere UF, IE e desconto e confira a atualização do resultado e a regra de aprovação. Verifique que a proposta ou o pedido recebe os valores e o contexto comercial do fluxo existente.
4. **Aplique o padrão às 20 telas e faça a revisão final.** Teste teclado, foco, zoom, telas estreitas, troca de empresa, perfis de acesso e estados de vazio e erro. Use registros de teste ou anonimizados nas evidências.

### Entrega esperada

Entregue a implementação no repositório e um resumo com **tela, rota, alteração, validação executada e pendência**, se houver. Inclua antes e depois das três listagens piloto, o diagnóstico e o resultado das três rotas de PDV e os componentes que poderão ser reaproveitados nas **22 telas restantes**.

Atue como designer de produto e engenheiro frontend especializado em ERP. Localize no repositório do **ERP Ávila Ops** as rotinas das 20 capturas numeradas de **41 a 60**. Implemente as melhorias abaixo em **Estoque, Compras e Financeiro**.

Use o **TOTVS Protheus como referência de eficiência operacional**. Priorize grades densas e legíveis, filtros rápidos, navegação por teclado, ações previsíveis e acesso direto aos documentos de origem. Preserve a identidade visual da Ávila Ops e reaproveite os padrões dos lotes anteriores.

### Padrão para as 20 telas

- Use uma margem comum na área de trabalho e aproveite a largura disponível. Coloque título, contexto e ação principal no cabeçalho. Reúna busca e filtros em uma linha onde couber. Em desktop, use linhas de **32–36 px** como ponto de partida, com ajuste para legibilidade, zoom e foco.
- Dê colunas próprias a identificadores, datas, situação e valores. Alinhe valores monetários e quantidades à direita. Mantenha cabeçalho fixo onde a rolagem prejudicar a comparação. Elimine paginação inativa e mensagens repetidas.
- Permita enviar a busca com `Enter`, preserve o `Ctrl+K` e restaure filtros, ordenação e página ao voltar de um detalhe. Ao trocar de empresa, descarte dados e seleções do contexto anterior.
- Diferencie **sem registros**, **sem resultados para os filtros**, **falta de configuração**, **falta de permissão**, **falha de consulta** e **recurso indisponível**. Em caso de erro recuperável, mantenha os filtros e ofereça nova tentativa. Exiba zero somente quando confirmado pela fonte.
- Preserve URLs, permissões, isolamento por empresa, registros legados e regras de estoque, compras, fiscal e financeiro. Confirme as operações disponíveis no código antes de acrescentar controles. Nas páginas indisponíveis, use o título da rotina, um motivo quando confirmado e uma saída que ajude a continuar o trabalho.

### Melhorias por tela

| Nº | Tela | O que implementar |
|---|---|---|
| 41 | **Estoque · Saldos** | Reaproveite a grade de **Saldos por produto** da tela 40. Separe produto, SKU e unidade das colunas **Saldo**, **Reservado** e **Disponível**. Coloque **Ver movimentos** como ação de linha e leve o SKU selecionado. Mostre filtro por depósito se já houver saldo por depósito na fonte. |
| 42 | **Lançamentos de estoque** | A captura abre **Saldos por produto**. Confirme se a entrada é um atalho deliberado para escolher um SKU ou se aponta para a rotina errada. Se houver uma consulta de movimentos, dê acesso direto com filtros de produto, depósito, tipo e período conforme a fonte. Priorize data, movimento, quantidade e documento de origem. |
| 43 | **Conferência de estoque** | Troque a página genérica por um estado compacto com o título **Conferência de estoque** e acesso a **Saldos** ou **Lançamentos**. Registre o que falta para disponibilizar contagem, conferência de diferenças e ajustes, conforme as dependências encontradas. |
| 44 | **Ordens de produção** | Adicione cabeçalho claro e reúna **Enviar pedido à produção** e **Recarregar**. Priorize pedido de origem, produto, quantidade e etapa na listagem. Coloque **Configurar etapas** como ação secundária. Preserve a trilha dos componentes consumidos e as regras de conclusão, reabertura e cancelamento. |
| 45 | **Depósitos de estoque** | Use a grade comum com código, nome e situação. Substitua **Novo cadastro** por **Novo depósito**. Quando não houver depósitos, ofereça a criação ao perfil autorizado. Quando os filtros zerarem a lista, ofereça **Limpar filtros**. |
| 46 | **Compras · Visão geral** | Organize a entrada do módulo na ordem **Pedido de compra → Recebimento → Contas a pagar**, com **Notas fiscais de entrada** acessível no contexto. Troque os blocos de links por uma barra de operações ou lista compacta. Preserve a distinção entre entrada física, obrigação financeira e pagamento. |
| 47 | **Pedidos de compra** | Dê título à rotina e posição fixa a **Novo pedido de compra**. Com dados disponíveis, priorize número, fornecedor, situação, previsão e valor. Mantenha o **Histórico importado** acessível para consultar documentos antigos. Diferencie pedidos operacionais dos registros preservados para consulta. |
| 48 | **Notas fiscais de entrada · Monitor** | Comprima **Distribuição da SEFAZ**, **Importar XML** e **Notas armazenadas** sem esconder informações operacionais. Deixe visíveis ambiente, resultado da última consulta e NSU quando disponíveis. Esclareça a diferença entre **Atualizar distribuição** e **Consultar SEFAZ** conforme o código. Preserve a busca por fornecedor, CNPJ, nota ou chave e os filtros de emissão. Valide a separação entre produção e homologação, a importação de XML e a preservação do cursor em caso de falha. |
| 49 | **Sugestões de compra** | Use um estado próprio com acesso contextual a **Saldos** ou **Pedidos de compra**. Se o repositório já tiver regras de reposição e demanda, confirme a disponibilidade por empresa antes de exibir sugestões. Mostre a origem dos dados quando houver recomendação calculada. |
| 50 | **Check-in de recebimentos** | A captura repete **Pedidos de compra**. Confirme se a lista serve para selecionar um pedido ou se existe uma rota de recebimento própria. Se a seleção for a primeira etapa, deixe isso explícito e priorize pedidos elegíveis. Quando suportado, mostre quantidades pedida, recebida e pendente e abra a conferência pelo pedido selecionado. |
| 51 | **Financeiro · Visão geral** | Organize **Contas a receber**, **Contas a pagar** e **Comissões** como rotinas principais. Agrupe cadastros e recursos pendentes em seções mais compactas. Preserve a informação de que recebimentos e pagamentos declarados no ERP têm origem operacional e identifique saldos de contas somente quando houver dados confirmados. |
| 52 | **Contas a receber** | Mantenha **Consultar pedidos** como acesso à origem. Quando houver títulos, priorize cliente, documento ou parcela, vencimento, valor, saldo e situação. Use filtros por cliente, vencimento e situação conforme o suporte da consulta. Diferencie saldo em aberto de recebimento declarado. |
| 53 | **Contas a pagar** | Traga **Contas e pagamentos** e **Pagamentos de funcionários** para o cabeçalho da rotina, com indicação clara da seção ativa. Priorize origem, favorecido, vencimento, valor, saldo e situação. Preserve **Consultar compras** e as permissões específicas dos registros da equipe. |
| 54 | **Controle de caixa** | Mostre um estado próprio com o título **Controle de caixa**. Confirme sua relação com **Caixas e bancos** e com o caixa do **PDV** antes de oferecer atalhos. Mantenha claros os papéis de cada rotina e os requisitos para abertura, movimentação e fechamento. |
| 55 | **Caixas e bancos** | Substitua a mensagem isolada por um cabeçalho e um estado de configuração com acesso a **Contas financeiras**, quando autorizado. Diferencie falta de conta ativa, falta de movimentos e erro de consulta. Quando houver registros, identifique conta, saldo e movimentos conforme a fonte e a data de referência. |
| 56 | **Ficha financeira** | Use o título **Ficha financeira** e confirme no código a entidade que a ficha deve representar. Enquanto indisponível, ofereça uma saída para a consulta de origem compatível com o perfil. Preserve o acesso por empresa e autorização para dados de terceiros. |
| 57 | **Remessas e retornos** | Informe o estado da rotina pelo título e pelas dependências confirmadas, como banco, convênio ou processamento de arquivos. Quando houver fluxo conectado, exponha identificador do arquivo, data, status e resultado do processamento. Verifique o comportamento ao reenviar ou reprocessar o mesmo arquivo. |
| 58 | **Comissões** | Troque os cartões por uma grade por vendedor com **Em aberto**, **Pagamento declarado** e acesso ao detalhe. Coloque a competência no cabeçalho e indique se os totais cobrem toda a consulta ou apenas a página. Preserve regras de cálculo, competência, pagamentos e permissões. |
| 59 | **Tributos** | Confirme a rota e o nome no menu. A captura mostra a tela genérica e também exibe **Faturamento agrupado** na lateral. Se o destino corresponder a **Tributos**, use esse título e informe a dependência fiscal confirmada. Se a captura apontar para outra rotina, registre a divergência e aplique o estado contextual à rota identificada. |
| 60 | **Contador** | A captura apresenta a página genérica. Confirme a rota, o rótulo e o público autorizado antes de propor ações. Mostre um estado contextual para a rotina identificada. Exponha consultas ou exportações somente quando houver fluxo e autorização no projeto. |

### Ordem de execução e critérios de aceite

1. **Confirme as rotas 40–42, 47–50 e 59–60.** Registre quais entradas compartilham código e qual tarefa cada uma atende. Corrija destinos incorretos e preserve links existentes quando houver dependência.
2. **Use Saldos, Monitor de notas fiscais e Comissões como pilotos.** Compare antes e depois em **1366 × 768** e **1920 × 1080**. Meça quantas linhas ficam visíveis sem rolar e quantas ações são necessárias para consultar um registro e voltar ao mesmo recorte.
3. **Valide compra, recebimento e financeiro em ambiente de teste.** Use um pedido com recebimento parcial e outro concluído, se o fluxo suportar esses cenários. Verifique quantidades, movimentos e obrigações de acordo com o comportamento existente. Repita uma confirmação para verificar se o sistema mantém o estado consistente.
4. **Valide o monitor fiscal.** Teste consulta bem-sucedida, falha, XML inválido e XML repetido nos ambientes autorizados. Confira os efeitos na lista de notas e no cursor de distribuição. Use dados de teste ou anonimizados nas evidências.
5. **Revise saldos, comissões e acesso entre empresas.** Teste zero real, lista vazia, falha de consulta e falta de permissão. Confira se links de origem e filtros mantêm o recorte e se dados da empresa anterior deixam de aparecer após a troca.

### Entrega esperada

Entregue a implementação no repositório e um resumo por tela com **rota confirmada, problema observado, melhoria entregue, validação e dependência pendente**, quando houver. Inclua evidências das três telas piloto e documente a decisão sobre as rotinas que hoje exibem conteúdo igual. Mantenha as telas **61–62** fora deste lote até que suas capturas sejam identificadas.

Atue como designer de produto e engenheiro frontend especializado em ERP. Localize no repositório do **ERP Ávila Ops** as rotas correspondentes às capturas **61 · Conta digital** e **62 · Fiscal — Visão geral**. Aplique os padrões dos lotes anteriores e use o **TOTVS Protheus como referência de eficiência operacional**, com navegação por teclado, títulos claros e acesso rápido às rotinas. Preserve a identidade visual da Ávila Ops.

### 61 · Financeiro · Conta digital

A captura mostra a página genérica **Funcionalidade indisponível**, com oito atalhos para outras rotinas do ERP. O operador precisa saber onde está e qual ação pode tomar.

- Confirme no código a rota, o rótulo no menu e a condição que leva à tela genérica. Use **Conta digital** como título se esse for o destino confirmado.
- Mostre um estado compacto com o motivo que o sistema puder confirmar. Diferencie integração indisponível, configuração pendente, falta de permissão e falha temporária quando esses estados puderem ser identificados.
- Substitua os oito atalhos por **Voltar ao Financeiro**. Inclua **Caixas e bancos** apenas se a consulta ajudar no contexto e o perfil tiver acesso.
- Exiba **Configurar integração** somente se existir um fluxo real e autorizado. Vincule saldos, movimentações e ações bancárias a fontes e capacidades confirmadas da empresa ativa.
- Valide a navegação pelo menu, pelo link direto e pelo retorno ao Financeiro.

### 62 · Fiscal · Visão geral

A captura usa oito cartões do mesmo tamanho para rotinas com objetivos diferentes. Transforme a página em um **índice compacto de operações fiscais**. Use linhas clicáveis com nome da rotina e uma descrição curta quando ela ajudar a escolher o destino.

| Grupo | Rotinas | O que a interface precisa esclarecer |
|---|---|---|
| **Documentos recebidos** | Monitor fiscal e importação de XML, CT-e recebidos e NFS-e recebidas | Qual opção consulta documentos e qual permite importar. Confira se o monitor leva à mesma rotina da tela 48, acessada por Compras. Se o destino for compartilhado, preserve os dois acessos com rótulos coerentes. |
| **Documentos de saída** | NF-e e NFC-e | Identifique as ações já disponíveis, como preparar documento ou consultar registros. Mostre transmissão somente quando a operação estiver habilitada para a empresa, o ambiente e o perfil. |
| **Documentos auxiliares** | DANFE de XML autorizado | Deixe explícito que o ponto de partida é um XML autorizado e que a ação gera ou baixa o DANFE a partir dele. |
| **Configuração e guias** | Configurações fiscais e Guias tributárias | Dê acesso à configuração conforme as permissões. Se Guias tributárias continuar indisponível, mostre o estado ao lado da rotina. |

- Coloque **Fiscal**, empresa ativa e **Configurações fiscais**, quando autorizada, no cabeçalho. Se o ambiente fiscal puder ser confirmado, exiba **Produção** ou **Homologação** no contexto correto.
- Troque o aviso longo do topo por mensagens curtas junto às operações afetadas. Quando faltar uma configuração, indique a dependência confirmada e ofereça o caminho de resolução ao perfil autorizado.
- Confira a correspondência entre menu lateral, títulos e destinos. Mantenha NF-e, NFC-e, notas recebidas, CT-e e NFS-e identificáveis pelo nome ao navegar pelo teclado.
- Limite a mudança aos pontos de entrada e à apresentação dos estados. Preserve rotas, permissões, isolamento por empresa e o comportamento existente de importação, emissão e transmissão.

### Validação e entrega

1. Compare antes e depois em **1366 × 768** e **1920 × 1080**. Verifique se, em desktop, todas as rotinas fiscais ficam visíveis sem rolagem em zoom de 100% e se continuam acessíveis com zoom ampliado.
2. Teste os destinos do Fiscal com dois perfis e, quando houver dados de teste, duas empresas. Verifique foco, navegação por teclado e configuração ausente. Valide ações fiscais em ambiente de teste ou homologação conforme o fluxo disponível.
3. Entregue um resumo das duas telas com **rota confirmada, mudança aplicada, evidência visual, validação executada e dependência pendente**, quando houver. Na revisão do conjunto de 62 telas, confira a consistência dos cabeçalhos, da empresa ativa e dos estados de indisponibilidade, especialmente entre Financeiro, Compras e Fiscal.