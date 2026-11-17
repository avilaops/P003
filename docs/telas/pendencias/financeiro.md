# Financeiro: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias do Financeiro](../financeiro/README.md)

Referência Protheus: Financeiro (SIGAFIN) • contas a receber (FINA040) e baixas (FINA070), contas a pagar (FINA050) e baixas (FINA080), naturezas financeiras, borderô e CNAB, conciliação bancária, fluxo de caixa, adiantamentos, compensação, liquidação/renegociação e data limite de movimentação. Contabilização (SIGACTB) fica no roteiro de 180–365 dias.

## O que já existe (conferido nos guias)

- **Contas a receber:** títulos gerados no aceite do pedido; registrar recebimento; estorno; envio do título por e-mail (endpoint existente).
- **Contas a pagar:** obrigações de compras e de funcionários; registrar pagamento; estorno.
- **Caixas e bancos:** extrato interno por conta; transferência entre contas (endpoint `financial/account-transfers`).
- **Comissões:** consulta, ajustes, pagamentos declarados, vínculo com pedido.
- **Cadastros:** contas financeiras, categorias financeiras (receita/despesa com hierarquia), formas de pagamento.
- **Indisponíveis:** controle de caixa, ficha financeira, remessas e retornos, faturamento agrupado, tributos, contador, conta digital.
- Os registros são **declarações manuais**: não movimentam banco nem comprovam liquidação.

---

## FI1. Baixa completa: parcial, juros, multa, desconto e acréscimos

**Prioridade:** 0–90 dias • **Referência:** baixa a receber/pagar com valores acessórios.

**Como desenvolver.**
- **Dados:** baixa como documento próprio (título, data, conta financeira, forma, valor principal, juros, multa, desconto, acréscimo, valor líquido, comprovante anexo).
- **Regras:** baixa parcial mantém saldo no título; juros e multa calculados por parâmetro (% ao mês, carência) e editáveis com permissão; desconto acima de limite pede aprovação.
- **Integração:** cada baixa gera lançamento no extrato da conta financeira (Caixas e bancos); estorno da baixa remove o lançamento.
- **Telas:** "Registrar recebimento/pagamento" com prévia do cálculo; baixa em lote.

**Aceite.** Receber metade de um título vencido com juros gera baixa parcial, lançamento no extrato e saldo restante correto.

---

## FI2. Natureza financeira e centro de custo obrigatórios

**Prioridade:** 0–90 dias • **Referência:** naturezas financeiras e centros de custo.

**Como desenvolver.** Todo título e lançamento recebe categoria financeira (natureza) e, quando ativado por parâmetro, centro de custo. Padrão por tipo de origem (venda de equipamento → "Receita de vendas"; compra de matéria-prima → "Fornecedores"). Cadastro de centros de custo em Cadastros. Rateio entre centros (fase 2).

**Aceite.** Nenhum título novo fica sem categoria; o padrão vem da origem e pode ser alterado.

---

## FI3. Fluxo de caixa realizado e projetado

**Prioridade:** 90–180 dias • **Referência:** fluxo de caixa.

**Como desenvolver.** Visão diária/semanal/mensal: saldo inicial das contas + recebimentos e pagamentos realizados + títulos a vencer (projetado) + pedidos aceitos não faturados (opcional, parâmetro) + despesas fixas cadastradas em Preferências. Filtro por conta e categoria. Exportável.

**Aceite.** O saldo projetado do último dia = saldo atual + a receber − a pagar do período.

---

## FI4. Conciliação bancária

**Prioridade:** 90–180 dias • **Referência:** conciliação bancária.

**Como desenvolver.** Importar extrato OFX (fase 1) e via API bancária (fase 2); sugerir correspondência por valor, data e documento; conciliar 1:1 ou 1:N; lançamentos do banco sem correspondência viram "a classificar" com criação rápida de título/lançamento; saldo conciliado × saldo do extrato.

**Aceite.** Extrato importado concilia automaticamente os lançamentos com mesmo valor e data, e mostra os pendentes.

---

## FI5. Cobrança: boleto, PIX e CNAB

**Prioridade:** 90–180 dias • **Referência:** borderô, CNAB remessa/retorno.

**Como desenvolver.** Fase 1: PIX cobrança/boleto registrado via API do banco ou intermediador (ligado à conta financeira), com baixa automática por webhook. Fase 2: borderô e arquivos CNAB 240/400 de remessa e leitura do retorno. Parâmetros por conta: banco, carteira, convênio, instruções de juros/multa. Remover `/financeiro/remessas-retornos` da lista de indisponíveis ao entregar.

**Aceite.** Um título com PIX emitido é baixado sozinho quando o banco confirma o pagamento, com o comprovante vinculado.

---

## FI6. Adiantamentos de cliente e fornecedor

**Prioridade:** 90–180 dias • **Referência:** recebimento antecipado e pagamento antecipado.

**Como desenvolver.** A entrada do pedido recebida antes do faturamento é um adiantamento do cliente; ao faturar, compensa os títulos. O mesmo para pagamento antecipado a fornecedor. Saldo de adiantamento visível na posição do cliente/fornecedor.

**Aceite.** Entrada recebida no aceite aparece como adiantamento e é compensada automaticamente no faturamento.

---

## FI7. Compensação, liquidação e renegociação

**Prioridade:** 180–365 dias • **Referência:** compensação entre carteiras e liquidação de títulos.

**Como desenvolver.** Compensar títulos a receber e a pagar do mesmo parceiro; liquidar vários títulos em um novo parcelamento (renegociação) com juros, mantendo a origem; aprovação acima de limite.

---

## FI8. Posição financeira do cliente/fornecedor (ficha financeira)

**Prioridade:** 0–90 dias • **Referência:** posição do cliente / ficha financeira.

**Como desenvolver.** Tela por parceiro: títulos em aberto e pagos, atrasos, prazo médio, adiantamentos, limite de crédito usado (Vendas V2), pedidos aceitos não faturados. Acesso a partir do cadastro, do pedido e do título. Substitui a rota indisponível `/financeiro/ficha-financeira`.

**Aceite.** A ficha do cliente soma exatamente os títulos e pedidos listados.

---

## FI9. Controle de caixa diário e data limite financeira

**Prioridade:** 90–180 dias • **Referência:** caixa e data limite de movimentação financeira.

**Como desenvolver.** Abertura e fechamento do caixa físico por dia (unificar com o PDV, que já tem sessão); data limite por empresa: baixas e lançamentos com data anterior são recusados; reabertura com permissão e auditoria.

---

## FI10. Faturamento agrupado

**Prioridade:** 180–365 dias. Agrupar pedidos do mesmo cliente em uma cobrança com vencimento único (contratos de serviço e manutenção). Depende de FI1 e FI5.

---

## FI11. Comissões completas

**Prioridade:** 90–180 dias • **Referência:** cálculo de comissões por faturamento ou baixa.

**Como desenvolver.** Regras por vendedor, linha e produto; base por faturamento ou por recebimento (parâmetro); estorno proporcional em devolução e cancelamento; fechamento por competência; geração de título a pagar ao vendedor no fechamento.

**Aceite.** Comissão por recebimento só nasce quando o título é baixado e é estornada quando a baixa é estornada.

---

## FI12. DRE gerencial e relatórios financeiros

**Prioridade:** 90–180 dias (DRE gerencial) • **Referência:** demonstrativos por natureza.

DRE por categoria financeira e competência; aging de receber e pagar; inadimplência; realizado × orçado (quando houver orçamento). Indicadores: inadimplência e prazo médio (documento, seção 10).

---

## FI13. Contabilidade (roteiro empresarial)

**Prioridade:** 180–365 dias • **Referência:** Contabilidade Gerencial (SIGACTB) e lançamentos padronizados.

Plano de contas, lançamentos automáticos por evento (venda faturada, baixa, entrada de compra) a partir de regras configuráveis, balancete, razão e exportação para o contador (substitui `/financeiro/contador`). Só iniciar depois que FI1–FI4 estiverem estáveis (documento, seção 7.2).
