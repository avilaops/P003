# Vendas: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias de Vendas](../vendas/README.md)

Referência Protheus: módulo de Faturamento (SIGAFAT) • pedido de venda (MATA410), liberação de pedido e de crédito, documento de saída (MATA460), condição de pagamento, tabela de preço, regras de desconto e comissões.

## O que já existe (conferido nos guias)

- **Propostas:** rascunho, versões, impressão, envio por e-mail, registro de aceite/rejeição/cancelamento, conversão em pedido.
- **Pedidos:** fluxo Rascunho → Encomenda aceita → Reservado → Concluído; o aceite congela o acordo e gera os títulos da entrada e das parcelas; reserva de estoque; preparo de NF-e; envio do documento por e-mail.
- **Simulador e Tabela publicada:** preço por linha, UF e contribuinte; alçada por perfil; motivos de aprovação.
- **Funil:** oportunidades por etapa.
- **Garantias:** protocolos, responsáveis, ordens de serviço relacionadas.
- **PDV:** fluxos documentados (sessão, venda, sangria/suprimento, fechamento), mas a API `pos/sessions` responde 500 para a empresa de exemplo (ver [prompt do PDV](../vendas/pdv/MELHORIAS.md)).

## Fluxo de referência e lacunas

```text
Oportunidade → Proposta → [Aprovação comercial] → Pedido → [Liberação de crédito] → [Liberação de estoque]
→ Faturamento (NF-e) → Título a receber → Baixa → Comissão → Entrega → Garantia/Devolução
```

Entre colchetes: etapas que não existem como rotina própria hoje.

---

## V1. Painel de aprovações comerciais

**Prioridade:** 0–90 dias • **Referência:** controle de alçadas e liberação de regras comerciais.

**Objetivo.** Hoje o pedido indica "Aprovação necessária" e manda aprovar "no detalhe". Falta uma fila única para o aprovador.

**Como desenvolver.**
- **Dados:** `approval_requests` (tipo do documento, id, motivo • reaproveitar `approvalReasons` —, valor, nível exigido, solicitante, situação, decisor, decisão, justificativa, datas). Uma solicitação por documento e nível.
- **Estados:** Pendente → Aprovada / Recusada / Cancelada (pedido alterado invalida a pendente e gera nova).
- **Regras:** aprovador precisa ter o nível exigido (`managerTarget`, `managerProfit`, `director` já existem em `PriceTable.authority`); não aprova o próprio pedido; recusa exige justificativa.
- **Integração:** aprovado libera "Aceitar encomenda"; recusado volta o pedido para Rascunho com a justificativa visível.
- **Parâmetros:** limites por perfil (já em Preferências → Aprovação comercial), aprovador substituto, prazo para alerta.
- **Telas:** "Aprovações" (lista com selo de motivo, valor, desconto, margem prevista, tempo de espera), aprovar/recusar em lote, notificação ao solicitante; versão celular prioritária (documento, seções 6 e 9.2).
- **Indicador:** tempo até aprovação (documento, seção 10).

**Aceite.** Pedido acima da alçada aparece na fila do aprovador certo; a decisão registra usuário, data e justificativa e libera ou devolve o pedido.

---

## V2. Liberação de crédito do cliente

**Prioridade:** 0–90 dias • **Referência:** limite de crédito do cliente e liberação de crédito do pedido.

**Objetivo.** Impedir que pedido de cliente inadimplente ou acima do limite siga para reserva e faturamento sem decisão explícita.

**Como desenvolver.**
- **Dados:** no cliente: limite de crédito, validade do limite, classificação de risco, bloqueio manual. No pedido: situação de crédito (Não avaliado, Liberado, Bloqueado, Liberado manualmente).
- **Regra:** no aceite, calcular exposição = títulos em aberto + pedidos aceitos não faturados + este pedido; bloquear se exceder o limite, se houver título vencido há mais de N dias ou se o cliente estiver bloqueado.
- **Integração:** bloqueio impede "Reservar"; liberação manual entra no Painel de aprovações (V1) como tipo "crédito".
- **Parâmetros:** dias de atraso tolerados, avaliar crédito no aceite ou na reserva, considerar entrada já recebida.
- **Telas:** campo de limite no cadastro do cliente; selo de crédito no pedido; "Posição do cliente" (títulos, pedidos, limite usado).
- **Indicador:** inadimplência e prazo médio.

**Aceite.** Cliente com título vencido além do parâmetro tem o pedido bloqueado com o motivo; liberação manual fica registrada.

---

## V3. Condição de pagamento cadastrada

**Prioridade:** 0–90 dias • **Referência:** cadastro de condições de pagamento.

**Objetivo.** Hoje o plano de pagamento é montado pedido a pedido. Condições recorrentes ("Entrada 30% + 3x 30/60/90") devem ser cadastradas uma vez.

**Como desenvolver.**
- **Dados:** `payment_terms` (nome, entrada %, número de parcelas, intervalos em dias ou datas fixas, forma de pagamento padrão, situação).
- **Regras:** soma das parcelas = 100% do saldo; entrada mínima continua vindo da política comercial (a condição não pode ficar abaixo dela sem aprovação).
- **Integração:** escolher a condição gera as parcelas do pedido (substitui o "Gerar parcelas" manual, mantendo ajuste fino); padrão por cliente.
- **Telas:** cadastro em Cadastros → Condições de pagamento; seletor no pedido e na proposta.

**Aceite.** Aplicar uma condição gera parcelas que somam o saldo e respeitam a entrada mínima.

---

## V4. Faturamento parcial e múltiplas notas por pedido

**Prioridade:** 0–90 dias • **Referência:** liberação parcial de itens e documento de saída por item/quantidade.

**Objetivo.** Equipamentos são produzidos e entregues em lotes; o pedido precisa ser faturado em partes.

**Como desenvolver.**
- **Dados:** por item do pedido: quantidade liberada, faturada, entregue e saldo; vínculo item da NF ↔ item do pedido.
- **Estados do pedido:** Reservado → Parcialmente faturado → Faturado → Parcialmente entregue → Entregue (Concluído).
- **Regras:** não faturar acima do saldo; nota cancelada devolve o saldo ao item; títulos já gerados no aceite não se duplicam (a NF referencia os títulos existentes).
- **Integração:** NF-e de saída consome os itens selecionados e baixa a reserva de estoque correspondente.
- **Telas:** no pedido, aba "Faturamento" com saldo por item e "Faturar selecionados".

**Aceite.** Pedido com 14 itens faturado em duas notas mostra saldo correto por item e muda para Faturado só ao zerar o saldo.

---

## V5. Devolução de venda

**Prioridade:** 90–180 dias • **Referência:** documento de entrada de devolução vinculado à nota de origem.

**Como desenvolver.**
- **Dados:** `sales_returns` (nota de origem, itens e quantidades devolvidas, motivo, destino do item • estoque, assistência, descarte —, crédito ou estorno financeiro).
- **Integração:** gera NF de entrada de devolução (Fiscal), entrada em estoque conforme destino, crédito ao cliente ou estorno/abatimento dos títulos, estorno proporcional da comissão.
- **Regras:** quantidade devolvida ≤ faturada; prazo de devolução por parâmetro; aprovação acima de valor.
- **Telas:** ação "Registrar devolução" na NF e no pedido; lista de devoluções.

**Aceite.** Devolução parcial gera nota, entrada em estoque e abatimento financeiro proporcionais, todos vinculados à nota de origem.

---

## V6. Tabela de preço por cliente e vigência aplicada automaticamente

**Prioridade:** 90–180 dias • **Referência:** tabela de preço por cliente/vigência.

**Objetivo.** As Listas de preços existem como cadastro, mas não são aplicadas no pedido.

**Como desenvolver.** Precedência: lista do cliente vigente → lista do canal → tabela publicada. O preço aplicado e sua origem ficam gravados no item. Desconto da alçada é calculado sobre o preço aplicado. Parâmetro para permitir ou não lista abaixo do menor preço da política.

**Aceite.** Cliente com lista vigente recebe o preço da lista no pedido, com a origem visível no item.

---

## V7. Metas comerciais

**Prioridade:** 90–180 dias • **Referência:** metas de venda por vendedor/período.

**Como desenvolver.** Cadastro de meta por vendedor, mês e linha (valor e quantidade); realizado calculado de pedidos aceitos ou faturados (parâmetro); tela Metas com % atingido e projeção do mês; alerta quando a projeção ficar abaixo de 80%.

**Aceite.** A tela Metas deixa de mostrar "não cadastradas" e exibe realizado por vendedor a partir dos pedidos.

---

## V8. Margem por pedido e Curva ABC

**Prioridade:** 90–180 dias • **Referência:** relatórios de rentabilidade e curva ABC de vendas.

**Como desenvolver.** Gravar no aceite o resultado gerencial da simulação (custo, impostos, lucro líquido • campos de `Director`) como "margem prevista"; "margem realizada" após faturamento com custo efetivo. Curva ABC por valor de pedidos faturados (ou aceitos, por parâmetro). Ambas no motor de relatórios (filtros, exportação).

**Aceite.** Margem por pedido lista prevista × realizada; Curva ABC classifica produtos em A/B/C com % acumulado.

---

## V9. Funil comercial completo

**Prioridade:** 90–180 dias • **Referência:** CRM / oportunidades.

**Como desenvolver.** Etapas configuráveis; atividades (ligação, visita, e-mail) com data e responsável; motivo de perda obrigatório; conversão em proposta mantendo vínculo; kanban com valor por etapa; indicador de conversão por etapa.

**Aceite.** Oportunidade convertida mostra a proposta e o pedido gerados; oportunidade perdida exige motivo.

---

## V10. Garantia e assistência técnica com número de série

**Prioridade:** 90–180 dias • **Referência:** assistência técnica / ordens de serviço.

**Como desenvolver.** Depende do número de série no estoque (ver [Estoque E3](estoque.md#e3-rastreabilidade-por-número-de-série)). Elegibilidade calculada pela data da nota e prazo do produto; etapas com SLA; peças consumidas baixando estoque; custo do atendimento; abertura a partir do pedido/nota.

**Aceite.** Ao informar a série, a garantia identifica cliente, nota e prazo restante.

---

## V11. Canais: loja virtual, anúncios e importação de pedidos

**Prioridade:** 90–180 dias (importação) • 180–365 dias (loja e marketplaces) • **Referência:** integrações de e-commerce.

**Como desenvolver.** Importação primeiro: assistente Arquivo → Mapear colunas → Validar por linha → Importar → Relatório, com modelo para download e idempotência por número externo. Loja e marketplaces via conector (o MCP de Lojas já é separado) criando pedidos com origem "canal", reserva automática e status sincronizado.

**Aceite.** Planilha com pedidos válidos e inválidos importa só os válidos e devolve relatório por linha.

---

## V12. PDV

**Prioridade:** P0 (defeito) • depois 90–180 dias.

Corrigir primeiro o erro 500 da API de sessões. Para a operação da empresa de exemplo (venda técnica a empresas), avaliar se o PDV deve ficar oculto por parâmetro de empresa.
