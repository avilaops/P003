# Logística e Serviços: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias de Logística](../logistica/README.md) • [Guias de Serviços](../servicos/README.md)

Referência Protheus: expedição/carga (OMS), gestão de transporte, e Gestão de Contratos e Serviços (GCT/Field Service) para contratos, ordens de serviço e medições.

> Estas telas não estavam nas capturas de 17/11/2026. O conteúdo abaixo vem dos guias e das rotas marcadas como indisponíveis em `demonstration-routes.ts`.

## O que já existe (conferido nos guias)

- **Logística:** postagens (criar e acompanhar registro interno), checkout logístico com ações por pedido. Envios, etiquetas (criação e detalhe) e logística reversa estão indisponíveis; Ávila Envios depende de integração.
- **Serviços:** contratos com modelos, revisão e ações; NFS-e e CT-e recebidos; cobranças e ordens ligadas a garantias.

---

## L1. Expedição e romaneio

**Prioridade:** 90–180 dias • **Referência:** montagem de carga e expedição.

**Como desenvolver.** A partir de pedidos faturados: separação (itens e séries • Estoque E3), conferência, volumes e peso (o peso bruto já é calculado no pedido), romaneio por veículo/transportadora, impressão. Estados: A separar → Separado → Conferido → Expedido → Entregue. Entrega confirmada atualiza o pedido (Vendas V4) e dispara o início da garantia.

**Aceite.** Um pedido expedido mostra romaneio, volumes, transportadora e data de entrega no detalhe.

## L2. Envios, etiquetas e cotação de frete

**Prioridade:** 90–180 dias. Integração com transportadoras/intermediadores (Ávila Envios): cotar frete pelo peso e destino, contratar, gerar etiqueta, rastrear com eventos no pedido. Remover `/logistica/envios*` e `/logistica/etiquetas/*` da lista de indisponíveis ao entregar.

## L3. Transporte próprio e MDF-e

**Prioridade:** 180–365 dias. Cadastro de veículos e motoristas, viagens com as NF-e transportadas, emissão e encerramento do MDF-e (Fiscal F9).

## L4. Logística reversa

**Prioridade:** 90–180 dias. Coleta de devolução ou assistência: autorização, agendamento de coleta, recebimento e destino (estoque, assistência), integrado a Vendas V5 e V10.

---

## S1. Contrato com faturamento recorrente

**Prioridade:** 90–180 dias • **Referência:** gestão de contratos com medição e cronograma financeiro.

**Como desenvolver.** Contrato com vigência, valor, periodicidade, reajuste (índice e data-base), itens de serviço; cronograma de faturamento gera NFS-e (Fiscal F6) e títulos a cada período; aditivos versionados; alerta de vencimento e de reajuste.

**Aceite.** Contrato mensal gera a nota e o título do mês na data do cronograma, sem intervenção manual.

## S2. Ordens de serviço

**Prioridade:** 90–180 dias. OS com cliente, equipamento/série, técnico, agenda, checklist, horas, peças consumidas (baixa de estoque), fotos e assinatura do cliente no celular; fechamento gera cobrança (quando fora da garantia) e histórico do equipamento.

## S3. Relatórios de serviços

**Prioridade:** 90–180 dias. Contratos a vencer, receita recorrente mensal, OS por técnico e por SLA, no motor de relatórios.
