# Índice de melhorias por tela

[Todas as telas](../README.md) • [Padrão comum](PADRAO-MELHORIAS.md) • [Funcionalidades pendentes](pendencias/README.md)

Este índice trata da **interface das telas existentes**. Funcionalidades que ainda não existem, com a forma de desenvolvê-las no padrão Protheus, estão em [Funcionalidades pendentes](pendencias/README.md).

Prompts gerados a partir das capturas de 17/11/2026 (`erp-web.pdf`, `erp-mobile.pdf`, `reports/screens/mobile/`) e do documento `docs/strategy/analise-saas-comercial-padrao-totvs.pdf`. Cada prompt vale junto com o [padrão comum](PADRAO-MELHORIAS.md).

## Prioridade

- **P0 • defeito:** a tela mostra conteúdo errado, erro ou dado técnico que impede o uso.
- **P1 • fluxo comercial:** afeta vender, aprovar, receber (documento, seção 9.1).
- **P2 • clareza e padrão:** consistência, estados vazios, nomenclatura.
- **P3 • fora do menu:** funções indisponíveis que só precisam sair do menu e ganhar página específica.

## P0 • defeitos

| Tela | Problema principal | Prompt |
| --- | --- | --- |
| PDV (3 telas) | API `pos/sessions` responde 500 para a empresa de exemplo; tela mostra só "Erro interno" | [vendas/pdv](vendas/pdv/MELHORIAS.md) |
| Estoque: visão geral, Saldos, Lançamentos | Três rotas reexportam a mesma página | [estoque/saldos](estoque/saldos/MELHORIAS.md) • [estoque/lancamentos](estoque/lancamentos/MELHORIAS.md) |
| Recebimentos de compra | Idêntica a Pedidos de compra quando vazia, oferece "Novo pedido de compra" | [compras/recebimentos](compras/recebimentos/MELHORIAS.md) |
| Tabela publicada | Alçada e menor preço "Indisponível" em todas as linhas; aviso repetido por linha | [vendas/tabela-publicada](vendas/tabela-publicada/MELHORIAS.md) |
| CT-e recebidos | "Sem permissão" para perfil Diretoria; transbordo no celular | [fiscal/cte](fiscal/cte/MELHORIAS.md) |
| NF-e e NFC-e no celular | Página mais larga que a tela | [fiscal/nfe](fiscal/nfe/MELHORIAS.md) • [fiscal/nfce](fiscal/nfce/MELHORIAS.md) |
| Monitor fiscal | NSU zerado, "cursor preservado", "UTC"; mesma tela em dois módulos | [fiscal/monitor](fiscal/monitor/MELHORIAS.md) |
| Histórico importado | "Empresa - true"; 1.048 itens sem busca; select cortado | [inicio/historico](inicio/historico/MELHORIAS.md) |
| Plano e limites | Título "Alterar dados da empresa"; botões ativos com cobrança indisponível | [preferencias/empresa](preferencias/empresa/MELHORIAS.md) |

## P1 • fluxo comercial

| Tela | Prompt |
| --- | --- |
| Novo pedido | [prompt](../strategy/novo-pedido-ux-prompt.md) • [proposta de layout](../strategy/novo-pedido-layout-proposta.md) |
| Simulador (unificar com Novo pedido) | [vendas/simulador](vendas/simulador/MELHORIAS.md) |
| Pedidos de venda (lista) | [vendas/pedidos](vendas/pedidos/MELHORIAS.md) |
| Propostas | [vendas/propostas](vendas/propostas/MELHORIAS.md) |
| Vendas (visão geral) e Funil | [vendas/visao-geral](vendas/visao-geral/MELHORIAS.md) |
| Visão geral (página inicial) e dashboards | [inicio/visao-geral](inicio/visao-geral/MELHORIAS.md) |
| Contas a receber | [financeiro/contas-receber](financeiro/contas-receber/MELHORIAS.md) |
| Clientes e fornecedores | [cadastros/clientes-fornecedores](cadastros/clientes-fornecedores/MELHORIAS.md) |
| Produtos | [cadastros/produtos](cadastros/produtos/MELHORIAS.md) |
| Contas financeiras (bloqueia Caixas e bancos e PDV) | [cadastros/contas-financeiras](cadastros/contas-financeiras/MELHORIAS.md) |
| Caixas e bancos | [financeiro/caixas-bancos](financeiro/caixas-bancos/MELHORIAS.md) |

## P2 • clareza e padrão

| Tela | Prompt |
| --- | --- |
| Hub de Cadastros e menu | [inicio/navegacao](inicio/navegacao/MELHORIAS.md) |
| Suas empresas | [preferencias/empresa](preferencias/empresa/MELHORIAS.md) |
| Assistente | [inicio/assistente-ajuda](inicio/assistente-ajuda/MELHORIAS.md) |
| Funcionários | [cadastros/funcionarios](cadastros/funcionarios/MELHORIAS.md) |
| Categorias financeiras | [cadastros/categorias-financeiras](cadastros/categorias-financeiras/MELHORIAS.md) |
| Categorias de produtos | [cadastros/categorias-produtos](cadastros/categorias-produtos/MELHORIAS.md) |
| Formas de pagamento | [cadastros/formas-pagamento](cadastros/formas-pagamento/MELHORIAS.md) |
| Listas de preços | [cadastros/listas-precos](cadastros/listas-precos/MELHORIAS.md) |
| Grupos de produtos | [cadastros/grupos-produtos](cadastros/grupos-produtos/MELHORIAS.md) |
| Tags e Grupos de tags (unificar) | [cadastros/tags](cadastros/tags/MELHORIAS.md) • [cadastros/grupos-tags](cadastros/grupos-tags/MELHORIAS.md) |
| Garantias | [vendas/garantias](vendas/garantias/MELHORIAS.md) |
| Depósitos | [estoque/depositos](estoque/depositos/MELHORIAS.md) |
| Ordens de produção | [estoque/producao](estoque/producao/MELHORIAS.md) |
| Compras (visão geral) | [compras](compras/MELHORIAS.md) |
| Pedidos de compra | [compras/pedidos](compras/pedidos/MELHORIAS.md) |
| Financeiro (visão geral) | [financeiro/visao-geral](financeiro/visao-geral/MELHORIAS.md) |
| Contas a pagar | [financeiro/contas-pagar](financeiro/contas-pagar/MELHORIAS.md) |
| Comissões | [financeiro/comissoes](financeiro/comissoes/MELHORIAS.md) |
| Fiscal (visão geral) | [fiscal/visao-geral](fiscal/visao-geral/MELHORIAS.md) |

## P3 • funções indisponíveis (tirar do menu, página específica)

| Telas | Prompt |
| --- | --- |
| Eventos, Notificações, Aplicativos, Novidades | [inicio/central-trabalho](inicio/central-trabalho/MELHORIAS.md) |
| Margem por pedido, Curva ABC, Metas | [inicio/visao-geral](inicio/visao-geral/MELHORIAS.md) |
| Loja virtual, Anúncios, Importar pedidos | [vendas/canais](vendas/canais/MELHORIAS.md) |
| Conferência de estoque | [estoque/inventarios](estoque/inventarios/MELHORIAS.md) |
| Sugestões de compra | [compras/sugestoes](compras/sugestoes/MELHORIAS.md) |
| Caixa, Ficha financeira, Remessas e retornos, Faturamento agrupado, Tributos, Contador, Conta digital | [financeiro/outros-recursos](financeiro/outros-recursos/MELHORIAS.md) |

## Ordem sugerida de execução

1. **Padrão comum primeiro** (um PR): componente de lista único (`reference-access.tsx` e equivalentes), página indisponível específica, remoção de itens indisponíveis do menu (`navigation-catalog.ts`), máscaras de documento/telefone, cabeçalho de página único. Isso resolve parte de quase todos os prompts.
2. **P0** na ordem da tabela.
3. **P1**, começando pelo Novo pedido e Simulador (componentes compartilhados).
4. **P2** por módulo.

## Telas sem captura

As capturas cobrem 62 telas no desktop e 23 no celular. Telas de detalhe e edição (`/[id]`), Preferências (exceto Plano), Logística, Serviços e Relatórios não foram capturadas no tema escuro; há versões claras em `reports/screens/mobile/`. Elas não têm prompt aqui e devem ser auditadas na próxima rodada.
