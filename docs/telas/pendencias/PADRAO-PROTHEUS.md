# Padrão de desenvolvimento de referência Protheus

[Funcionalidades pendentes](README.md) • [Padrão visual das telas](../PADRAO-MELHORIAS.md) • [Todas as telas](../../README.md)

Este documento diz **como** toda funcionalidade pendente deve ser desenvolvida para ter a maturidade de um ERP de referência como o TOTVS Protheus (Linha Protheus / Backoffice). Os arquivos por módulo desta pasta dizem **o que** falta.

O documento estratégico (`docs/strategy/analise-saas-comercial-padrao-totvs.pdf`, seção 1) usa o Protheus "como parâmetro de maturidade e não como modelo a ser copiado integralmente". Por isso o padrão abaixo adota os **conceitos** que dão robustez ao Protheus (ciclo completo, integração, parâmetros, alçadas, estorno, rastreabilidade, fechamento, relatórios) com a experiência web e o foco vertical do Ávila Ops. Nomes de rotinas e tabelas do Protheus aparecem só como referência para quem conhece o produto; confira-os no TDN da TOTVS antes de usá-los em especificações.

## 1. Os dez princípios

| # | Princípio | No Protheus | No Ávila Ops |
| --- | --- | --- | --- |
| 1 | **Ciclo transacional completo** | Toda rotina tem incluir, alterar, visualizar, excluir/estornar, copiar, imprimir e legenda de status. | Toda tela operacional tem criar, editar, consultar, arquivar/estornar, duplicar, imprimir/exportar e selo de status (documento, seção 7.1). |
| 2 | **Documento gera documento** | Pedido → liberação → documento de saída → título → baixa → lançamento contábil, com vínculo entre eles. | Cada etapa cria a seguinte por ação explícita e guarda o vínculo nos dois sentidos (origem e destino), navegável na tela. |
| 3 | **Estorno, não exclusão** | Documento movimentado não é apagado; é estornado/cancelado com rastreio. | Depois da primeira movimentação (estoque, financeiro, fiscal), só estorno com motivo, usuário e data. Excluir só em rascunho. |
| 4 | **Parâmetros por empresa** | Parâmetros `MV_*` controlam o comportamento das rotinas por empresa/filial. | Cada funcionalidade declara seus parâmetros com valor padrão, aparece em Preferências e é lida pelo servidor, nunca fixada no código da tela. |
| 5 | **Regra fiscal e de movimento por tipo de operação** | O TES (tipo de entrada/saída) define CFOP, impostos, se movimenta estoque e se gera financeiro. | Um cadastro de **tipos de operação** (ver Fiscal) decide, por documento e item, CFOP, tributação, efeito em estoque e efeito em financeiro. Telas não decidem isso sozinhas. |
| 6 | **Alçadas de aprovação** | Grupos de aprovadores, níveis e limites por tipo de documento, com bloqueio até aprovar. | Uma engine única de aprovação (desconto, crédito, compra, pagamento) com níveis, limites, substituto, histórico e aprovação no celular. |
| 7 | **Consulta padrão** | Campos de código abrem uma consulta com busca e filtros. | Todo campo que referencia outro cadastro usa o mesmo seletor com busca, filtros, criação rápida (quando permitido) e exibição do nome, nunca do ID. |
| 8 | **Fechamento de período** | Virada de saldos de estoque, data limite financeira e apuração fiscal bloqueiam movimentos retroativos. | Cada módulo com saldo tem fechamento mensal e uma data limite por empresa; movimento com data anterior é recusado no servidor com mensagem clara. |
| 9 | **Relatórios parametrizáveis** | Perguntas (filtros), seções, totais, impressão, planilha e agendamento. | Um motor de relatórios único: filtros salvos, colunas escolhidas, agrupamento, totais, PDF/XLSX/CSV e envio agendado por e-mail (documento, seção 7.3). |
| 10 | **Pontos de extensão** | Pontos de entrada e workflow customizam o processo sem alterar o fonte. | Eventos de domínio (a base `outbox_events` já existe) publicados como webhooks e consumidos por automações (n8n), com assinatura, reenvio e log (documento, seção 7.4). |

## 2. Anatomia obrigatória de uma funcionalidade

Toda funcionalidade pendente deve ser especificada e entregue com estes blocos. Os arquivos por módulo seguem esta ordem.

1. **Objetivo e referência.** Uma frase do problema de negócio e a rotina equivalente no Protheus, quando houver.
2. **Modelo de dados.** Entidades, campos obrigatórios, chaves únicas por empresa (`tenant_id`), `revision` para concorrência otimista, datas de criação/alteração e usuário. Valores monetários em centavos inteiros; quantidades em micros (padrão já usado no estoque).
3. **Estados e transições.** Diagrama simples (ex.: Rascunho → Aguardando aprovação → Aprovado → Faturado → Cancelado), quem pode executar cada transição, o que cada transição gera em outros módulos e qual transição a desfaz.
4. **Regras de validação no servidor.** Campo, linha e documento (equivalente às validações de campo, de linha e "tudo OK" do Protheus). A tela repete as regras só para orientar; a decisão é do servidor.
5. **Integração.** O que a funcionalidade cria, reserva, baixa ou estorna em Estoque, Financeiro, Fiscal e Comissões; vínculos gravados.
6. **Parâmetros.** Lista de configurações em Preferências com padrão e efeito.
7. **Permissões.** Permissões separadas para consultar, criar/editar, aprovar e estornar (padrão `modulo.recurso.acao` já usado, ex.: `catalog.products.read`).
8. **API.** Endpoints REST tipados no OpenAPI, com `Idempotency-Key` em criação e `If-Match` em alteração (padrão atual do ERP), erros de negócio tipados (409/422) e nunca 500 para pré-requisito ausente.
9. **Telas.** Lista (browse com selo de status e filtros), detalhe (cabeçalho, itens, vínculos, histórico), formulário e ações; desktop e celular conforme o [padrão visual](../PADRAO-MELHORIAS.md).
10. **Relatórios e indicadores.** O que precisa sair impresso ou em planilha, e qual indicador da seção 10 do documento estratégico a funcionalidade alimenta.
11. **Auditoria.** Eventos gravados em `audit_log` e publicados em `outbox_events`.
12. **Critérios de aceite e testes.** Testes de API (contrato e regras), testes de UI (desktop 1280 px e celular 390 px) e um teste do ciclo completo com estorno.

## 3. Padrões de tela herdados do Protheus

| Padrão Protheus | Como implementar |
| --- | --- |
| Browse com legenda de cores | Lista com selo de status colorido e legenda acessível ("Rascunho", "Bloqueado por crédito", "Faturado"…); filtro por status com contagem. |
| Filtros salvos do browse | Botão "Salvar filtro" por usuário; filtros na URL (já preservados hoje). |
| Cabeçalho + itens (Modelo 2/3, MVC) | Formulário com cabeçalho fixo e grade de itens editável, totais no rodapé, adição por busca; mesmo padrão do Novo pedido. |
| Gatilhos de campo | Ao escolher cliente: preencher condição de pagamento, tabela de preço, vendedor, transportadora e tipo de operação padrão; sempre editáveis e com origem indicada. |
| Copiar registro | Ação "Duplicar" em pedidos, propostas, pedidos de compra, produtos e regras. |
| Banco de conhecimento | Anexos em qualquer documento (contrato, comprovante, XML, fotos), com tipo e data. |
| Consultas de posição | Telas de posição: posição do cliente (financeiro + pedidos + notas), posição do produto (kardex + reservas + pedidos), posição do fornecedor. |
| Rastreabilidade | Bloco "Documentos relacionados" no detalhe de todo documento, com links nos dois sentidos. |

## 4. Prioridade e roteiro

As funcionalidades dos arquivos por módulo têm prioridade alinhada à seção 9 do documento estratégico:

- **0–90 dias (núcleo comercial):** fechar Vendas de ponta a ponta, conectar proposta → pedido → contrato → nota → recebível → entrega, cálculo contextual de desconto e entrada, painel de pendências e aprovações.
- **90–180 dias (escala operacional):** conciliação bancária e fluxo de caixa, relatórios configuráveis, fechamento fiscal e financeiro, integrações bancárias e logísticas, onboarding SaaS, aprovações no celular.
- **180–365 dias (capacidade empresarial):** contabilidade e controladoria, ativo imobilizado, planejamento de compras e produção, portais de cliente e vendedor, API pública e webhooks, alertas e previsões.

## 5. O que não copiar do Protheus

- Telas densas com dezenas de campos visíveis: mostrar o essencial e revelar o resto sob demanda.
- Códigos internos expostos ao usuário (tabelas, campos, `LEGACY-*`).
- Configuração por arquivo ou dicionário de dados técnico: configuração sempre por tela de Preferências com explicação.
- Dependência de rotinas batch noturnas para ver dados atualizados: preferir atualização transacional; batch só para fechamentos.
