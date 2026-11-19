# Garantias e assistência

[Todas as telas](../../../README.md) · [Vendas](../README.md)

Acompanhar protocolos de garantia e o atendimento vinculado.

**Onde acessar:** `/vendas/garantias`, `/servicos/ordens`.

## O que aparece na tela

- Cliente, produto e referência da venda
- Descrição do problema e situação
- Responsável e registros do atendimento

## O que você pode fazer

- Consultar e abrir protocolos autorizados
- Acompanhar responsáveis e andamento
- Consultar as ordens de serviço relacionadas
- Abrir o chamado pelo pedido ou por um item faturado de NF-e de produção. Na abertura, consultar a série para recuperar cliente, equipamento, nota e cobertura. O vínculo de uma nova série exige uma unidade faturada disponível e uma política de garantia.
- Buscar protocolos por cliente, série, equipamento ou pedido. O filtro de etapa mostra as contagens da pesquisa e o protocolo indica o vencimento do SLA.
- Registrar mão de obra na ordem de serviço e selecionar a peça consumida. A API atualiza o estoque disponível, preserva a reserva de pedidos e vincula o movimento à peça.
- Aprovar o valor de crédito ou reembolso no campo **Valor da decisão (R$)**. O histórico guarda essa decisão separadamente do custo do atendimento.

## Regras e limites

O atendimento não cria automaticamente devolução fiscal, reembolso ou emissão de nota.

## Evidências, aceite e resolução

No protocolo, **Evidências, laudos e termos** recebe foto JPEG/PNG, vídeo MP4 ou PDF de até 10 MB. O download exige acesso à empresa da garantia. A API preserva o arquivo, o nome, o SHA-256, a autoria e a data. O registro de auditoria contém a identificação da operação. [Arquivos e registros](../../../../apps/api-ts/src/modules/warranties/records.ts)

Para emitir um laudo, selecione uma OS em andamento e registre causa, diagnóstico, conclusão, situação e agendamento. Para acompanhar um termo, selecione o documento do mesmo pedido e cliente. O protocolo lê o aceite no módulo de assinaturas. A assinatura individual acompanha a fase do envelope e a assinatura anterior exige conclusão e arquivo assinado. [Tela do protocolo](../../../../apps/web/src/features/sales/warranty-records.tsx)

**Liquidação** relaciona cada efeito a uma linha de venda e ao comprovante de origem. Crédito, reembolso e troca exigem a decisão correspondente. A recuperação do fornecedor pode registrar dinheiro na conta ou reposição em estoque. **Indicadores da assistência** reúne custo, recuperação, SLA vencido, reincidência de série, causa do último laudo e tempo entre a abertura e o encerramento. O período usa a data de abertura em São Paulo. [Liquidação](../../../../apps/api-ts/src/modules/warranties/settlement.ts) • [Indicadores](../../../../apps/api-ts/src/modules/warranties/metrics.ts)

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [AVL-319-GARANTIAS-ASSISTENCIA](referencias/AVL-319-GARANTIAS-ASSISTENCIA.md)
- [warranty-workspace](../../../../apps/web/src/features/sales/warranty-workspace.tsx)
- [Série e origem da cobertura](../../../../apps/api-ts/src/modules/warranties/equipment.ts)
- [Prova do ciclo no PostgreSQL](../../../../apps/api-ts/test/warranty-postgres.test.ts)
- [services-pages](../../../../apps/web/src/features/services/services-pages.tsx)
