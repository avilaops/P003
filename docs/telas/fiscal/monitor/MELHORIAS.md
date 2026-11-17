# Melhorias: Monitor de notas fiscais (Notas recebidas / Notas fiscais de entrada)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rotas:** `/fiscal/monitor` e `/compras/notas-entrada` (a mesma tela nos dois módulos) • **Código:** `apps/web/src/features/fiscal/received-monitor.tsx` • **Capturas:** web 48 (aberta por Compras), mobile 22.

## O que está errado hoje

- A mesma tela aparece em Compras ("Notas fiscais de entrada") e em Fiscal ("Monitor fiscal e XML recebidos"), com o breadcrumb "Fiscal / Notas recebidas" mesmo quando aberta por Compras • o usuário perde a referência de onde está.
- Bloco "Distribuição da SEFAZ" com dados técnicos: **NSU `000000000000000`** (último e maior), "Último retorno: Nenhuma consulta concluída", "**A última consulta falhou. O lote não foi aplicado e o cursor foi preservado.**", "Nenhum documento coletado na SEFAZ".
- Dois botões com diferença não explicada: "Atualizar distribuição" e "Consultar SEFAZ".
- Acordeão "Distribuição em homologação, sem valor fiscal" no meio da página.
- Filtros de data rotulados **"Emissão de (UTC)" / "Emissão até (UTC)"**.
- Quatro blocos empilhados (distribuição, homologação, importar XML, notas armazenadas): a lista de notas, que é o principal, fica no fim.
- No celular a página fica mais larga que a tela (texto reduzido pelo navegador).

## O que fazer

1. **Ordem:** lista de notas recebidas primeiro; importação de XML e status da SEFAZ como ações/painéis secundários.
2. Status da SEFAZ resumido em uma linha: "Última busca na SEFAZ: falhou em 17/11 às 14:02 • Tentar de novo" (ou "Atualizado há 2 h"). Detalhes técnicos (NSU, lote, cursor) em "Detalhes técnicos" recolhido, só para administrador. Nunca exibir NSU zerado.
3. Um único botão "Buscar notas na SEFAZ"; se houver duas operações reais, explicar cada uma no tooltip.
4. Homologação: selo "Ambiente de testes" no cabeçalho, não acordeão.
5. Datas em horário de Brasília, sem "UTC".
6. Lista: Emissão, Fornecedor (nome + CNPJ mascarado), Número/série, Valor, Manifestação (selo: Pendente / Ciência / Confirmada / Desconhecida), Vínculo com compra (link ou "Vincular"), ações (DANFE, XML, Manifestar, Gerar compra).
7. Em Compras, abrir com breadcrumb "Compras / Notas de entrada" e filtro padrão "sem compra vinculada"; em Fiscal, "Fiscal / Notas recebidas" com filtro padrão "manifestação pendente".
8. Corrigir a largura no celular (nenhum elemento com largura fixa maior que 390 px; tabelas viram cartões).

## Critérios de aceite

- Nenhum NSU, "cursor", "lote" ou "UTC" visível para usuário comum.
- Breadcrumb correto conforme o módulo de origem.
- Sem rolagem horizontal nem zoom reduzido em 390 px.
