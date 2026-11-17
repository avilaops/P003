# Gestão, relatórios e plataforma SaaS: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias de Início](../inicio/README.md) • [Guias de Preferências](../preferencias/README.md) • [Guias de Relatórios](../relatorios/README.md)

Referência Protheus: relatórios parametrizáveis (TReport), workflow e notificações, painéis de gestão, configurador (parâmetros, usuários, privilégios, auditoria) e o ciclo de implantação/suporte da TOTVS.

## O que já existe (conferido nos guias)

Visão geral com atalhos e dashboards básicos; assistente do ERP (consultas); histórico importado; relatórios por visão com filtros; Preferências com empresa, plano, usuários e papéis, segurança/auditoria e exclusões, importação e exportação de produtos (CSV), integrações por chave de serviço, campos/relatórios/etiquetas customizados, transições, e-mail. Eventos, notificações, aplicativos e novidades estão indisponíveis; Margem por pedido, Curva ABC e Metas mostram "ainda indisponível".

---

## G1. Painel de pendências e próxima ação

**Prioridade:** 0–90 dias (documento, seção 9.1, item 6).

**Como desenvolver.** Serviço que agrega, por usuário e permissão: aprovações (Vendas V1, Compras C3), pedidos parados, propostas vencendo, títulos vencidos, pendências de configuração (conta financeira, certificado, categorias). Exibido na Visão geral e no sino de notificações. Cada item com link para a lista filtrada e ação direta quando possível.

**Aceite.** Cada pendência leva à lista com o mesmo total; itens resolvidos somem sem recarregar a página.

## G2. Notificações e eventos (workflow)

**Prioridade:** 90–180 dias • **Referência:** workflow e eventos do sistema.

**Como desenvolver.** Assinatura de eventos de domínio (`outbox_events`) por usuário/papel: no app (sino), e-mail e WhatsApp (já há canal de operação); preferências por tipo de evento; linha do tempo de eventos da empresa (substitui `/eventos` e `/notificacoes` indisponíveis).

## G3. Motor de relatórios configuráveis

**Prioridade:** 90–180 dias (documento, seção 7.3) • **Referência:** TReport.

**Como desenvolver.** Uma fonte de dados declarada por relatório (consulta com filtros permitidos e checagem de permissão); usuário escolhe colunas, agrupamentos e totais; filtros salvos; exportação PDF, XLSX e CSV; agendamento por e-mail com histórico de execução. Os relatórios listados nos outros arquivos (Vendas V8, Estoque E9, Compras C8, Financeiro FI12, Serviços S3) usam este motor.

**Aceite.** Um relatório salvo com filtros é enviado por e-mail na periodicidade escolhida, com o arquivo e o registro da execução.

## G4. Dashboards com dados reais

**Prioridade:** 0–90 dias. Conforme o [prompt dos dashboards](../inicio/visao-geral/MELHORIAS.md): só exibir no menu dashboards com dados; os demais dependem de V7 (metas), V8 (margem e ABC).

## G5. Parâmetros centralizados

**Prioridade:** 90–180 dias • **Referência:** parâmetros `MV_*` e configurador.

**Como desenvolver.** Catálogo único de parâmetros (nome legível, módulo, tipo, padrão, valor por empresa, descrição do efeito, quem alterou e quando), exibido em Preferências com busca. Toda funcionalidade nova registra seus parâmetros aqui (padrão Protheus, princípio 4).

## G6. Fechamentos e data limite

**Prioridade:** 90–180 dias. Painel "Fechamento do mês" que reúne Estoque E6, Financeiro FI9 e Fiscal F3/F4 com checklist, ordem recomendada e reabertura auditada.

## G7. Onboarding e implantação

**Prioridade:** 90–180 dias (documento, seção 7.5).

**Como desenvolver.** Checklist de implantação por empresa (dados da empresa, certificado, contas financeiras, categorias, formas e condições de pagamento, produtos, clientes, usuários, tabela publicada) com progresso; importação assistida de produtos, clientes e saldos (ampliar a importação CSV atual para categoria, ficha técnica e acabamentos, como o guia já indica); dados de exemplo nunca misturados com os reais.

## G8. Planos, assinatura e limites

**Prioridade:** 90–180 dias. Conectar a cobrança (Mercado Pago, já previsto na tela de Plano), medir consumo (dados, usuários, importações), avisar ao se aproximar do limite e bloquear de forma suave; plano atual e consumo visíveis (ver [prompt do Plano](../preferencias/empresa/MELHORIAS.md)).

## G9. API pública e webhooks

**Prioridade:** 180–365 dias (documento, seção 7.4). Documentação pública do OpenAPI existente, chaves por aplicação com escopos (as chaves de serviço já existem), webhooks assinados com reenvio e log, ambiente de homologação, limites de uso.

## G10. Exportação integral e backup do cliente

**Prioridade:** 90–180 dias. Exportar todos os dados da empresa (cadastros, documentos, XMLs, anexos) em formato aberto, sob demanda e agendado; o CSV de produtos atual não é backup integral (guia de Exportação).

## G11. Portais de cliente e vendedor

**Prioridade:** 180–365 dias. Cliente: propostas para aceite, pedidos, notas, boletos e garantias. Vendedor externo: carteira, tabela publicada, simulador e pedidos no celular.

## G12. Status, suporte e versões

**Prioridade:** 90–180 dias. Página de status dos serviços (SEFAZ, banco, e-mail), central de ajuda integrada ao assistente, política de versões com "Novidades" (substitui `/novidades`), canal de suporte com contexto da tela.
