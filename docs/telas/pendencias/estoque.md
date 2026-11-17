# Estoque e produção: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias de Estoque](../estoque/README.md)

Referência Protheus: Estoque/Custos (SIGAEST) • saldos por armazém (SB2), movimentos internos (MATA240/MATA241), transferências (MATA261), inventário, rastreabilidade por lote e número de série, recálculo do custo médio (MATA330) e virada de saldos (MATA280); PCP para ordens de produção e estrutura de produto.

## O que já existe (conferido nos guias)

- **Saldos:** consolidados por produto e empresa, **sem divisão por depósito**; saldo, reservado e disponível.
- **Lançamentos:** entrada e saída manuais, estorno de movimento manual com motivo; movimentos de pedido não são estornados por esta tela.
- **Depósitos:** cadastro de identificação e localização (não separa saldo).
- **Conferência (inventário):** o guia descreve sessões de contagem com aprovação de ajustes, **mas a rota `/estoque/inventarios` está na lista de rotas indisponíveis** (`apps/web/src/lib/demonstration-routes.ts`) e mostra "Funcionalidade indisponível". Resolver a divergência é o primeiro passo (E5).
- **Ordens de produção:** preparar a partir de pedido, registrar consumo de componentes, etapas configuráveis.
- **Defeito de navegação:** Visão geral, Saldos e Lançamentos abrem a mesma página (ver [prompt](../estoque/saldos/MELHORIAS.md)).

---

## E1. Saldo por depósito e transferência entre depósitos

**Prioridade:** 90–180 dias • **Referência:** saldo por armazém e transferência entre armazéns.

**Como desenvolver.**
- **Dados:** saldo por (produto, depósito); todo movimento passa a ter depósito; depósito padrão por empresa e por tipo de operação.
- **Migração:** saldo consolidado atual vai para o depósito padrão ("Principal"), criado automaticamente se não existir.
- **Transferência:** documento com origem, destino, itens e quantidades; gera saída e entrada atômicas; estorno desfaz as duas.
- **Integração:** reserva do pedido indica o depósito; NF-e e recebimento de compra movimentam o depósito escolhido.
- **Parâmetros:** usar depósitos (sim/não), depósito padrão de venda, de compra e de produção.
- **Telas:** filtro e coluna Depósito em Saldos; "Nova transferência"; Depósitos mostra itens com saldo.

**Aceite.** Transferir 2 unidades entre depósitos mantém o saldo total e altera o saldo de cada depósito; estorno restaura.

---

## E2. Custo médio e valorização do estoque

**Prioridade:** 90–180 dias • **Referência:** custo médio ponderado e recálculo do custo médio.

**Como desenvolver.**
- **Dados:** custo unitário em cada entrada (compra: valor da nota + frete − impostos recuperáveis; produção: consumo + custos apropriados); custo médio corrente por produto (e por depósito, quando E1 estiver ativo).
- **Regras:** saída valorizada pelo custo médio do momento; entrada retroativa dispara recálculo do período aberto (job assíncrono com status).
- **Integração:** margem realizada do pedido (Vendas V8) usa o custo da saída; base para contabilização futura.
- **Telas:** coluna Valor em Saldos; Kardex com custo; relatório de posição valorizada.

**Aceite.** Duas entradas com custos diferentes resultam no custo médio ponderado correto na saída seguinte.

---

## E3. Rastreabilidade por número de série

**Prioridade:** 90–180 dias • **Referência:** controle de rastro por lote e número de série.

**Objetivo.** Equipamentos de musculação são itens de alto valor com garantia: cada unidade precisa ser identificada da entrada (produção ou compra) até o cliente.

**Como desenvolver.**
- **Dados:** parâmetro por produto "controla número de série"; tabela de séries com produto, depósito, situação (Em estoque, Reservada, Vendida, Em assistência, Baixada), documento de entrada e de saída.
- **Regras:** produto com série exige informar as séries em toda entrada e saída (quantidade = número de séries); série única por produto e empresa.
- **Integração:** reserva e NF-e listam as séries; garantia (Vendas V10) localiza a venda pela série; devolução retorna a série ao estoque ou à assistência.
- **Telas:** leitura por código de barras no celular; consulta "Onde está a série X".

**Aceite.** Ao buscar uma série vendida, o ERP mostra produto, nota, cliente e data; a mesma série não pode ser vendida duas vezes.

---

## E4. Kardex e posição do produto

**Prioridade:** 0–90 dias • **Referência:** kardex por produto / consulta de saldos.

**Como desenvolver.** Tela por produto com saldo inicial do período, cada movimento (data, tipo, documento de origem com link, entrada, saída, saldo, custo) e saldo final; reservas e pedidos em aberto ao lado. Exportável pelo motor de relatórios. Substitui o link "Ver movimentos" atual.

**Aceite.** A soma das entradas menos as saídas do período bate com a variação do saldo.

---

## E5. Inventário (conferência de estoque) ativo

**Prioridade:** 0–90 dias • **Referência:** inventário com digitação de contagem e acerto.

**Como desenvolver.**
1. Decidir a divergência: se as sessões de contagem descritas no guia estão prontas no backend, remover `/estoque/inventarios*` de `demonstration-routes.ts`; se não, alinhar o guia.
2. Completar: escopo por depósito (após E1) e por categoria; contagem cega opcional; bloqueio de movimentação dos itens em contagem (parâmetro); segunda contagem para divergências acima de X%; aprovação do ajuste em alçada; lançamento com motivo "Inventário".
3. Celular é o uso principal: campos grandes, leitor de código, avanço automático.

**Aceite.** Uma sessão aprovada gera lançamentos de ajuste iguais às divergências, com vínculo à sessão.

---

## E6. Fechamento mensal de estoque

**Prioridade:** 90–180 dias • **Referência:** virada de saldos e data limite de movimentação.

**Como desenvolver.** Rotina "Fechar mês" que grava saldo e custo finais por produto/depósito, impede movimentos com data no período fechado (validação no servidor) e permite reabrir com permissão e registro. Pré-checagem: lançamentos pendentes, inventários abertos, recálculo de custo concluído.

**Aceite.** Lançamento com data em mês fechado é recusado com mensagem; reabertura fica auditada.

---

## E7. Estoque mínimo, ponto de pedido e sugestões de compra

**Prioridade:** 90–180 dias • **Referência:** ponto de pedido e estoque de segurança.

**Como desenvolver.** Campos por produto: estoque mínimo, ponto de pedido, lote de compra, prazo do fornecedor. Necessidade = (pedidos aceitos não atendidos + mínimo) − (disponível + compras em aberto). Alimenta Compras → Sugestões (ver [Compras C4](compras.md#c4-sugestões-de-compra)).

**Aceite.** Produto abaixo do ponto de pedido aparece na sugestão com a quantidade calculada.

---

## E8. Estrutura de produto e apontamento de produção

**Prioridade:** 180–365 dias • **Referência:** estrutura (BOM), ordens de produção e apontamento.

**Como desenvolver.**
- **Estrutura:** componentes e quantidades por produto acabado, com versão.
- **Ordem:** consumo previsto pela estrutura; empenho dos componentes; apontamento de produção (quantidade produzida, perda, tempo); entrada do acabado com custo apurado; encerramento.
- **Integração:** ordem nasce do pedido aceito (já existe); prazo de fabricação do pedido vira data prevista da ordem; atraso alerta Vendas.
- **Telas:** kanban por etapa (ver [prompt](../estoque/producao/MELHORIAS.md)).

**Aceite.** Apontar uma ordem baixa os componentes da estrutura e dá entrada no acabado com o custo somado.

---

## E9. Relatórios de estoque

**Prioridade:** 90–180 dias. Posição de estoque (valorizada), Kardex, giro e cobertura, itens parados, divergências de inventário, ABC de estoque, todos no motor de relatórios. Indicador: **acurácia de estoque** (documento, seção 10).
