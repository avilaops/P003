# Melhorias: Propostas

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/vendas/propostas` • **Código:** `apps/web/src/features/sales/proposals-access.tsx`, `proposals.tsx` • **Capturas:** web 31.

## O que está errado hoje

- Botão **"Novo orçamento"** numa tela chamada "Propostas" (vocabulário duplo).
- Validade **vencida** (08/11/2026 e 11/11/2026, hoje é 17/11) mostrada como data comum, com status "Rascunho", sem destaque.
- CPF/CNPJ sem máscara sob o nome do cliente (`00000000000`, `00000000000000`).
- "Versão 1" em toda linha, ocupando espaço sem informar nada quando só há uma versão.
- Botão de busca "Pesquisar" (padrão comum: busca ao digitar); "2 proposta(s)".
- Na lista não há "Converter em pedido" nem "Enviar ao cliente"; só "Continuar".
- Sem coluna de vendedor; sem filtro por período ou validade.

## O que fazer

1. Nome único: "Nova proposta" (alinhado com a decisão de vocabulário da área de Vendas).
2. Colunas: Proposta (número), Cliente (nome + CNPJ mascarado em secundário), Vendedor, Validade (selo **"Vencida"** em vermelho, "Vence em 2 dias" em âmbar), Situação, Valor.
3. "Versão N" só quando N > 1.
4. Ações por linha conforme status: Rascunho → "Continuar"; Enviada → "Converter em pedido" / "Renovar validade"; Vencida → "Renovar validade".
5. Filtros: busca ao digitar (número, cliente, CNPJ), Situação, Validade (Vigentes / Vencidas), Vendedor.
6. Indicador no topo: "2 propostas vencidas" com link de filtro.

## Mobile

- Cartão: cliente, número, selo de validade, valor, ação principal.

## Critérios de aceite

- As duas propostas atuais aparecem com selo "Vencida".
- Nenhum CPF/CNPJ sem máscara.
