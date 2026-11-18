# Financeiro • implementação em TypeScript

O [levantamento aprovado](../../telas/financeiro/LEVANTAMENTO-2026-11-17.md) contém as regras e os critérios de homologação. Este plano acompanha as entregas na branch `feat/financeiro-integral-ts`.

- [ ] FI1 e FI2 • portar carteiras, comprovantes e baixas, implantar encargos, políticas de classificação e aprovação. Testar R$ 400 de principal e R$ 10 de juros, repetição, estorno, concorrência e isolamento.
- [ ] FI3, FI8 e FI12 • posição por parceiro, totais da carteira inteira, faixas de atraso, projeção e demonstrativo por competência. Conferir mais de 100 títulos, transferências internas e parcelas liquidadas.
- [ ] FI4, FI5 e FI9 • extrato, transferência, OFX, conciliação, fechamento de caixa e cobrança com remessa e retorno. Validar reimportação, período fechado, conta e conciliação ambígua. Homologar com o fornecedor escolhido.
- [ ] FI6, FI7 e FI10 • antecipação, compensação, renegociação e agrupamento. Conferir parcelas e rastrear os documentos originários sem duplicar caixa.
- [ ] FI11 e FI13 • comissão por recebimento ou faturamento, fechamento com obrigação ao vendedor, partidas dobradas, fechamento contábil e exportação.
- [ ] Integrar API, BFF e telas, conferir perfis e navegar em base isolada. Homologar cada fluxo através da interface e comparar com o PostgreSQL.
