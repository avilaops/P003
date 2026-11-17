# Melhorias: Canais e importação (Loja virtual, Anúncios, Importar pedidos)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rotas:** `/vendas/loja-virtual`, `/vendas/anuncios`, `/vendas/importacao` • **Código:** `apps/web/src/features/sales/sales-capability-unavailable.tsx`, `apps/web/src/components/feedback/unavailable-import.tsx` • **Capturas:** web 37, 38, 39.

## O que está errado hoje

- **Loja virtual** e **Anúncios**: marcados "Indisponível" no menu e abrindo a página genérica com 8 atalhos sem relação.
- **Importar pedidos**: o item do menu **não** tem a marca "Indisponível", mas a tela inteira diz "Importação indisponível • Nenhum arquivo é recebido, validado ou importado aqui. Não há resultados, totais de linhas ou relatório de processamento." Inconsistência entre menu e tela.
- Grupo "Canais e importação" no menu ocupa espaço com três itens sem função.

## O que fazer

1. Remover Loja virtual, Anúncios e Importar pedidos do menu enquanto indisponíveis (padrão comum). Se o grupo ficar vazio, remover o grupo.
2. Acesso direto pela URL: página indisponível específica para cada um (o que fará, por que não está ativo, quem ativa) com um atalho relacionado: Loja virtual / Anúncios → Preferências → Integrações; Importar pedidos → Pedidos de venda.
3. Quando **Importar pedidos** for implementado (documento seção 9.2, item 4 e 7.5 "importação assistida"): passo a passo Arquivo → Mapear colunas → Validar (erros por linha) → Importar → Relatório, com modelo para download.

## Critérios de aceite

- Nenhum dos três itens aparece no menu enquanto indisponível.
- Menu e tela nunca divergem sobre a disponibilidade.
