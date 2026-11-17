# Proposta de layout: Novo Pedido (desktop e mobile)

Base: [novo-pedido-ux-prompt.md](novo-pedido-ux-prompt.md) e `analise-saas-comercial-padrao-totvs.pdf`.
Escopo desta proposta: entregável 2 do prompt. Nada foi implementado ainda.

## O que já existe (e muda o plano)

A leitura do código mostrou que parte da estrutura já está pronta, só mal posicionada:

| Peça | Onde | Estado hoje |
| --- | --- | --- |
| Coluna de resumo `sticky` | `commercial-order.css:105` (`.order-negotiation-area`) | Existe a partir de 1100 px, mas fica na **linha 3** da grade, ao lado de Pagamento. Como Equipamentos ocupa as duas colunas (`grid-column: 1 / -1`), o resumo só aparece depois da lista inteira. |
| Barra inferior mobile | `order-mobile-navigation.tsx` (`OrderQuickSummary`) | Existe abaixo de 1100 px, com total, pendências e "Revisar pedido". Já some com o teclado aberto. |
| Barra de seções fixa | `OrderSectionNavigation` + `.order-section-navigation` | Existe e é `sticky`. Conta pendências só para leitor de tela (`sr-only`); não marca a seção visível. |
| Dados do limite comercial | `negotiation-types.ts` (`Sale`, `PriceItem`) | A simulação já devolve `maximumAtTargetDiscountBps`, `freeDiscountBps`, `minimumDownPaymentCents/Bps`, `requiredDownPaymentCents`, `approvalReasons`, `policyGroups[].version` e `calculatorVersion`; o item traz `maxOwnDiscountBps`. Falta só **quem aprova**. |
| 12 pendências de cliente | `order-customer-model.ts:128` | Uma pendência por campo, com o texto "Confira X: preenchimento obrigatório dentro do limite de N caracteres", mesmo sem cliente selecionado. |

Consequência: o maior ganho visível (resumo sempre à vista no desktop) é uma mudança de grade CSS, não um componente novo.

## Desktop (≥ 1100 px)

```text
┌──────────────────────────────────────────────────────────────┬──────────────────────────┐
│ NOVO PEDIDO          Em preenchimento · Copiar · PDF          │                          │
├──────────────────────────────────────────────────────────────┤  RESUMO (sticky, top 112)│
│ [Equipamentos 14] [Cliente •1] [Entrega] [Desconto] [Pagam.]  │  Total de tabela  R$ ... │
│   ▔▔▔▔▔▔▔▔▔▔▔ seção visível                (sticky, top 64)  │  Desconto 0%      − ...  │
├──────────────────────────────────────────────────────────────┤  Valor sem IPI    R$ ... │
│ EQUIPAMENTOS · 14 un. · 829 kg           [Recolher lista]     │  IPI              R$ ... │
│ [ Buscar equipamento: nome ou código                      ]   │  ─────────────────────── │
│ ┌ SKU/Nome ─────────── Qtd ──── Unit. s/IPI ── Total ──── ┐   │  TOTAL        R$ 125.4k  │
│ │ LD-A042 Banco Reto  [-]1[+]   2.497,25     2.497,25  ✕ │   │  Entrada 30%  R$ 37,6k   │
│ │  ■ Piano Black · ■ Matte Graphite · ■ Saddle Brown  ✎  │   │  Saldo        R$ 87,8k   │
│ │ LD-A045 Banco Incl. [-]1[+]   3.001,36     3.001,36  ✕ │   │                          │
│ │  ○ Escolher acabamentos ⚠                          ✎  │   │  CONDIÇÃO DESTE PEDIDO   │
│ │ ... (cabeçalho da tabela sticky a partir de 8 itens)  │   │  Desconto máx. 18% (…k)  │
│ └────────────────────────────────────────────────────────┘   │  Entrada mín. 30% (…k)   │
├──────────────────────────────────────────────────────────────┤  Limite: margem mínima   │
│ CLIENTE (resumo de 1 linha quando concluído)                  │  da linha importada      │
│ ENTREGA E CONDIÇÕES                                           │  Acima: aprova Gerência  │
│ DESCONTO  [ 12,00 % ]──────●───────|░░░░░|▓▓▓                 │                          │
│           livre ≤10%    aprovação ≤18%    bloqueado           │  2 pendências            │
│ FORMA DE PAGAMENTO                                            │  • Selecione o cliente → │
│                                                               │  • Prazo de fabricação → │
│                                                               │  [   Salvar pedido   ]   │
└──────────────────────────────────────────────────────────────┴──────────────────────────┘
```

- Grade: coluna principal + coluna de 360 px que ocupa **todas as linhas** (`grid-row: 1 / -1`). Equipamentos deixa de usar `grid-column: 1 / -1`. O card Desconto sai da coluna direita e volta para a principal; a direita fica só com resumo, condição, pendências e salvar (seção 8 do documento: uma ação principal).
- Acabamentos: linha de chips sob o item; ✎ abre o drawer à direita (sobrepõe o resumo enquanto aberto) com "‹ Anterior · Próximo ›" e "Aplicar a compatíveis".
- Colunas "Desconto" e "Total c/ IPI" por item só aparecem com simulação válida; antes, a coluna Total mostra o valor de tabela.

## Mobile (< 768 px)

```text
┌───────────────────────────────┐
│ LUDUS EQUIP...   (empresa)  ☰ │  cabeçalho fixo
│ Equipamentos ▾  ·  Seção 1/5  │  seletor de seção fixo (≤ 48 px)
├───────────────────────────────┤
│ [ Buscar equipamento        ] │
│ ┌───────────────────────────┐ │
│ │ LD-A042 · Banco Reto     ✕│ │
│ │ [-] 1 [+]      R$ 2.497,25│ │
│ │ ■■■ Piano Black +2      ✎ │ │  toque abre bottom sheet
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ LD-A045 · Banco Incl. 55°✕│ │
│ │ [-] 1 [+]      R$ 3.001,36│ │
│ │ ⚠ Escolher acabamentos  ✎ │ │
│ └───────────────────────────┘ │
│  …                            │
├───────────────────────────────┤
│ Total R$ 125.430,00   2 pend. │  OrderQuickSummary (já existe)
│ Desc. máx. 18%  [Salvar]      │  + linha do limite comercial
└───────────────────────────────┘

Bottom sheet de acabamentos (≤ 90vh):
┌───────────────────────────────┐
│ ‹  Banco Reto (1 de 14)  ›  ✕ │
│ Estrutura   [■ Piano Black ▾] │
│ Braços      [■ Matte Graph. ▾]│
│ Anilheiro   [Não se aplica ▾] │
│ Estofado    [■ Saddle Brown ▾]│
│ [Aplicar a compatíveis]       │
│ [        Próximo item       ] │
└───────────────────────────────┘
```

- Cartão de item com no máximo 3 linhas. Alvo de toque ≥ 44 px (o CSS atual já garante abaixo de 1100 px).
- A barra inferior existente ganha a linha "Desc. máx." e troca "Revisar pedido" por "Salvar pedido" quando não há pendências; com pendências, o botão leva à primeira.
- Entre 768 e 1099 px: mesma estrutura do mobile com cartões em duas colunas e a barra inferior.

## Componentes que mudam

| Componente / arquivo | Mudança | Seção do documento | PR |
| --- | --- | --- | --- |
| `SelectedProduct` (`commercial-simulator.tsx`) | Busca de acabamentos sai da linha; vira `OrderItemRow` + `OrderItemCard` com chips; mesmo componente no Simulador | 9.1-4 | a, b |
| Novo `useItemFinishes(productIds)` | Uma busca para todos os itens (ver decisão 3) em vez de N `GET /products/{id}` | 7.1 | a |
| Novo `FinishesPanel` (drawer/bottom sheet) | Edição de um item por vez, anterior/próximo, aplicar a compatíveis, foco preso | 8 | b |
| `commercial-order.css` (grade ≥1100 px) | Coluna direita em todas as linhas; Desconto volta para a principal | 8 | c |
| `OrderTotals` + novo `OrderCommercialCondition` | Desconto máximo, entrada mínima, motivo (`approvalLabels`), aprovador, versão da política | 5 | c, d |
| `OrderQuickSummary` | Linha do limite comercial; botão Salvar quando sem pendências | 5, 6 | c |
| `OrderDiscountFields` | Slider com faixas livre / aprovação / teto; alçada visível, sem `<details>` | 5 | d |
| `OrderSectionNavigation` | Scroll-spy (`IntersectionObserver`), contador visível, seletor compacto no mobile | 8 | e |
| `order-customer-model.ts` | Sem cliente: 1 pendência; mensagens curtas por campo | 8 | e |
| Novo `useOrderDraft` | Rascunho local por empresa + usuário, restaurar/descartar | 7.1 | f |

## Decisões em aberto

1. **Quem aprova**: a simulação devolve os motivos (`approvalReasons`), mas não o perfil aprovador. Opção sugerida: derivar no front a partir de `table.authority` e das faixas (`freeDiscountBps`, `maxOwnDiscountBps`, `maximumAtTargetDiscountBps`), exibindo "Gerência" ou "Diretoria"; se isso não for confiável, adicionar o campo na API em PR separado.
2. **Rascunho**: começar só no navegador (mais simples). Rascunho no servidor fica para depois, se o local não bastar.
3. **Lista em lote**: `GET /api/v1/products` aceita `q`, `limit` e `offset`, mas não filtro por IDs. O `limit` máximo é 100. Opções: (a) carregar os produtos ativos do tenant uma vez, paginando de 100 em 100, e cachear na tela; ou (b) adicionar `?ids=` na API (uma chamada, só os itens do pedido). Sugestão: (b), por ser exato e não depender do tamanho do catálogo; (a) só se a mudança de API for bloqueada.

## Ordem de implementação

a. Busca em lote dos acabamentos.
b. Linha/cartão compacto + painel de acabamentos (Simulador e Pedido).
c. Grade com resumo fixo em todas as linhas + condição comercial no resumo + barra inferior.
d. Faixas no controle de desconto e estado de aprovação.
e. Scroll-spy, contador visível e pendências agrupadas.
f. Rascunho local.
g. Textos, formulários e reflow a 200%.

Cada PR atualiza `apps/web/tests/commercial-checkout-ui.spec.ts`.
