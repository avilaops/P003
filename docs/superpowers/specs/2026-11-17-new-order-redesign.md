# Novo Pedido • web e mobile

## Objetivo e limites

O vendedor deve montar pedidos de 1 a 40+ itens e acompanhar total, peso e pendências sem percorrer todo o formulário. Não mudar preço, desconto, alçada, IPI, entrada, persistência de pedido/cliente ou bibliotecas. API nova permitida somente para leitura em lote de acabamentos/pesos. PostgreSQL próprio; sem novas dependências. Nacional não possui cores. Não usar pedidos, emissões, pagamentos, assinaturas ou envios reais como testes. Textos novos usam •.

## Diagnóstico confirmado

GET do produto LD-A045, ID `23951779-d8c5-30df-2e2a-c909b08d7832`, retornou404 na produção. O produto existe ativo na empresa consultada. A validação Zod UUID RFC rejeitava a variante histórica antes do SELECT. Corrigir com GUID canônico de PostgreSQL sem relaxar chaves idempotentes. A regressão local demonstrou404 antes e200 depois, com RLS/contratos preservados.

SelectedProduct faz GET por item; OrderWeightSummary faz outro GET de catálogo por item. A lista gera uma segunda linha completa por acabamento, inclusive quando faltam dados, e o resumo ocupa uma linha da grade abaixo dos equipamentos. A simulação já possui debounce300ms e verificação de resposta por empresa/digest: preservar.

## Layout proposto

Desktop: coluna principal com busca, equipamentos compactos e formulários; coluna direita sticky desde a primeira linha, com totais, peso, pendências e salvar. Resumo limitado à altura disponível com rolagem interna se necessário. Equipamentos com nome/SKU, quantidade, valor e remoção; chips resumem acabamentos. Mostrar desconto e valor simulado somente com simulação válida; antes, preço/total de tabela claramente identificados.

Abaixo768px: itens em cartões de duas linhas; lista de14 itens acabados ocupa até quatro telas375×812. Barra inferior fixa com safe-area, total, pendências, salvar e acionador do resumo completo. Desktop1280×800: lista14 até duas telas. Barra de seis seções sticky com scroll-spy e contadores visíveis; móvel horizontal até48px. Manter formulário contínuo, sem wizard, pois estado e validação já são compartilhados e o vendedor precisa voltar entre seções.

Acabamentos: Sheet Base UI existente, drawer direito desktop e bottom sheet móvel abaixo768px, máximo90dvh, rolagem interna. Um item por vez, anterior/próximo, nomes textuais, foco preso, Esc e retorno ao acionador. Aplicar cores somente onde cada opção existe, reportar produtos/partes não compatíveis; não alterar o tipo de anilheiro em massa nem atribuir cores aos nacionais. Não tornar acabamento opcional em obrigatório. Erro é um estado compacto único sem seletores vazios; falhas múltiplas recebem aviso agregado e repetir todos.

Lista longa: a partir8 itens, cabeçalho sticky, filtro nos itens do pedido e recolhimento com contagem/peso/valor de tabela. Busca para adicionar permanece acima e Enter inclui primeiro resultado; repetição soma quantidade. Não virtualizar sem medição que justifique para50+ itens.

Pendências: cliente ainda não escolhido e formulário de cadastro fechado gera somente “Selecione ou cadastre o cliente”. Após selecionar ou iniciar cadastro, indicar campos efetivamente incompletos com mensagens curtas. Ordenar pelas seis seções, foco no campo correto e reabrir seção recolhida. Seções concluídas podem ser recolhidas manualmente preservando dados e resumo curto.

Formulários: busca de cliente principal, cadastro inline existente; reaproveitar CNPJ/CEP e máscaras atuais, sem substituir preenchimento manual. Ajuda visível curta e detalhes expansíveis. Motivo de indisponibilidade das ações de parcelas apresentado uma vez quando compartilhado. Labels preservados; inputMode adequado; alvos44px no móvel. Não alterar CNPJ alfanumérico aceito pelo projeto.

## Aceite e evidência

- 1,14 e40 itens em375×812 e1280×800, mais geometria768/1024/1440 sem overflow horizontal da página.
- Total e contagem de pendências visíveis em qualquer rolagem; “—” somente se desconhecido, com causa curta.
- Percorrer14 acabamentos sem fechar; compatibilidade em massa comprovada; nacional sem cores.
- Uma consulta em lote por conjunto faltante, sem GET individual para acabamentos/pesos do pedido; cache por empresa, cancelamento/identidade em troca de empresa; repetir falha sem perder edições.
- Drawer com Tab/Shift+Tab/Esc/restauração de foco; navegação e pendências apontam o campo; foco não encoberto por barras.
- Aria-live polite com atualização contida/debounced; contraste AA pelos tokens existentes e inspeção visual.
- Capturas antes/depois375 e1280; commercial-checkout-ui.spec atualizado sem quebrar cenário legado de simulador; typecheck/lint e testes relevantes passando.

## Entregas

Cinco PRs pequenos na ordem: (a) ID histórico e leitura em lote; (b) lista compacta e painel de acabamentos; (c) resumo sticky e barra móvel; (d) scroll-spy e pendências por causa; (e) texto/formulários e aceite final. A migração geral do ERP permanece pausada.
