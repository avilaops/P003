# Compras: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias de Compras](../compras/README.md)

Referência Protheus: Compras (SIGACOM) • solicitação de compra (MATA110), cotação e mapa de cotação, pedido de compra (MATA120/MATA121), controle de alçadas, documento de entrada (MATA103), pré-nota e avaliação de fornecedores.

## O que já existe (conferido nos guias)

- **Pedido de compra:** preparo, transições permitidas, vínculo com recebimento.
- **Recebimento:** etapa explícita de conferência; importação de XML não substitui a conferência física.
- **Notas de entrada:** Monitor fiscal com distribuição da SEFAZ, importação de XML, manifestação e vínculo com compra (endpoints `purchase-preview`, `purchase-match`, `purchase` já existem).
- **Contas a pagar:** obrigações originadas da compra.
- **Sugestões de compra:** indisponível.

## Fluxo de referência e lacunas

```text
[Solicitação] → [Cotação] → Pedido de compra → [Aprovação] → Recebimento ↔ Nota de entrada → Contas a pagar → Pagamento
                                                                       └→ Estoque (custo)      └→ [Devolução ao fornecedor]
```

---

## C1. Solicitação de compra

**Prioridade:** 90–180 dias • **Referência:** solicitação de compras.

**Como desenvolver.** Documento interno (solicitante, centro de custo, itens, quantidade, necessidade em data, justificativa) com estados Aberta → Aprovada → Em cotação → Atendida / Recusada. Aprovação pela engine de alçadas. Atendimento parcial por item. Origem automática a partir de sugestões (C4) e de ordens de produção sem componente (Estoque E8).

**Aceite.** Uma solicitação aprovada vira cotação ou pedido mantendo o vínculo por item.

---

## C2. Cotação e mapa comparativo

**Prioridade:** 180–365 dias • **Referência:** cotação e análise/mapa de cotação.

**Como desenvolver.** Cotação com vários fornecedores por item; registro de preço, prazo, condição de pagamento e frete por fornecedor; envio de pedido de cotação por e-mail (link para o fornecedor responder, fase 2); mapa comparativo com menor custo total e melhor prazo destacados; escolha por item gera um pedido por fornecedor vencedor.

**Aceite.** Uma cotação com 3 fornecedores gera pedidos só para os vencedores escolhidos.

---

## C3. Aprovação de pedido de compra por alçada

**Prioridade:** 0–90 dias • **Referência:** controle de alçadas de compras.

**Como desenvolver.** Reaproveitar a engine de aprovação (Vendas V1) com tipo "compra": limite por valor e por centro de custo/categoria; pedido acima do limite fica "Aguardando aprovação" e não pode ser enviado ao fornecedor nem recebido. Aprovação no celular.

**Aceite.** Pedido acima do limite do comprador só segue após a aprovação registrada.

---

## C4. Sugestões de compra

**Prioridade:** 90–180 dias • **Referência:** sugestão de compras por ponto de pedido.

**Como desenvolver.** Depende de Estoque E7 (mínimo, ponto de pedido, lote, prazo). Lista de produtos com necessidade calculada, fornecedor preferido e último preço; quantidade editável; "Gerar pedidos" agrupa por fornecedor (ou gera solicitações, por parâmetro). Remover `/compras/sugestoes` da lista de rotas indisponíveis ao entregar.

**Aceite.** Produtos abaixo do ponto de pedido geram pedidos agrupados por fornecedor com a quantidade sugerida.

---

## C5. Documento de entrada completo (nota ↔ pedido ↔ recebimento)

**Prioridade:** 0–90 dias • **Referência:** documento de entrada e pré-nota.

**Objetivo.** Os vínculos existem em partes; falta uma rotina única que feche a entrada.

**Como desenvolver.**
- **Conciliação em três vias:** item da nota × item do pedido × quantidade recebida; divergência de preço ou quantidade acima da tolerância (parâmetro) bloqueia e pede aprovação.
- **Efeitos:** ao confirmar, entrada em estoque com custo da nota (Estoque E2), escrituração fiscal de entrada (Fiscal F3) e títulos a pagar conforme as parcelas da nota (substituindo os provisórios do pedido).
- **Estorno:** desfaz estoque, fiscal e financeiro se nada tiver sido pago.
- **Telas:** a partir da nota no Monitor ("Dar entrada") ou do recebimento.

**Aceite.** Uma nota com divergência de preço acima da tolerância fica bloqueada; sem divergência, gera estoque, escrituração e títulos vinculados.

---

## C6. Devolução ao fornecedor

**Prioridade:** 90–180 dias • **Referência:** devolução de compras.

**Como desenvolver.** A partir da nota de entrada: itens e quantidades, motivo; gera NF-e de devolução (Fiscal), saída de estoque e abatimento/crédito no contas a pagar.

**Aceite.** Devolução parcial ajusta estoque, fiscal e financeiro proporcionalmente, vinculada à nota de origem.

---

## C7. Avaliação de fornecedores

**Prioridade:** 180–365 dias. Indicadores por fornecedor: prazo cumprido, divergências no recebimento, devoluções, preço médio; nota de avaliação no cadastro; uso no mapa de cotação.

---

## C8. Visão geral e relatórios de compras

**Prioridade:** 0–90 dias (visão geral) • 90–180 dias (relatórios). Indicadores e pendências conforme o [prompt da visão geral](../compras/MELHORIAS.md); relatórios de compras por fornecedor, por produto, em aberto e atrasadas, no motor de relatórios.
