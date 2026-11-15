# Documentos comerciais • padrão do ERP Next

A referência visual é o contrato Ludus aprovado pelo usuário: documento monocromático, título central, logo do emitente, seções com faixas escuras, dados em quadros e rodapé discreto. A identidade é da empresa ativa; o nome Ludus não deve ser fixado no código de outro emitente.

O padrão está aplicado ao PDF nativo dos pedidos, ao documento e à impressão das propostas e ao HTML anexado pelo envio de proposta. O PDF do contrato anexado continua com seu conteúdo e suas áreas de preenchimento originais. Documentos fiscais com leiaute normativo não adotam este modelo automaticamente.

Os emissores operacionais e seus limites estão no [mapa atual de relatórios](../relatorios/padrao-relatorios.md). Os envios existentes de pedidos, propostas e pacotes usam o SMTP central da plataforma. O pacote contratual envia pedido e comprovante de recebimento em PDF; anexos fiscais e contratos preservados mantêm seus bytes originais. A suíte `playwright.commercial-documents.config.ts` confere configuração SMTP global, encaminhamento autenticado, revisão, download e composição de mensagem usando servidores simulados.

O complemento de envio financeiro oferece confirmação de destinatário, assunto e mensagem no detalhe do recebível e no relatório financeiro. A API gera o PDF do snapshot autorizado; revisão e hash impedem enviar dados diferentes dos conferidos. O relatório abrange até 100 títulos por fonte, sem filtros implícitos. O histórico distingue aceite pelo servidor SMTP, recusa e resultado incerto; aceite não comprova entrega na caixa do destinatário. Resultados incertos não são reenviados automaticamente. Enviar não altera o saldo nem registra recebimento.

## Implementações

• `apps/web/src/components/documents/commercial-document.tsx`: `CommercialDocument` recebe título, identificação, emitente e conteúdo; `DocumentSection` fornece faixa e quadro. Controles de edição, aprovação e envio ficam fora do documento.
• `apps/web/src/components/documents/commercial-document.css`: paleta, hierarquia editorial, tabelas, total, impressão A4 e cabeçalho/rodapé repetidos por grupos de tabela. A tipografia deste arquivo tem exceção explícita à escala de controles operacionais; a exceção não libera outras folhas de estilo.
• `apps/api/src/domains/sales/order_document_pdf.rs`: implementação vetorial com fonte Unicode incorporada, logo privado, quadros paginados e reserva conjunta de espaço para o título, as colunas e a primeira linha de itens.
• `apps/api/assets/documents/commercial-document.css`: equivalente editorial para os anexos HTML, incorporado ao binário e sem dependências remotas.

## Dados e paginação

A ordem do pacote documental é: pedido • nota fiscal (DANFE e XML) • comprovantes de pagamento disponíveis • contrato • demais documentos anexados. Recibos e anexos da mesma categoria preservam sua ordem de inclusão. O arquivo é reordenado junto de seus metadados de auditoria; não se altera o conteúdo de contratos já assinados. A regra vale para a montagem de novos pacotes e para as minutas de conferência, sem inventar documentos ausentes.

O gerador usa o snapshot autorizado e a revisão consultada. Não recalcula preços, não preenche dados ausentes por suposição e não inclui custos, margens ou comissões. Pagamento previsto não comprova recebimento. A situação comercial permanece explícita.

No navegador, todas as colunas voltam a aparecer na impressão, mesmo quando a consulta é feita no celular. O cabeçalho e rodapé usam `thead`/`tfoot` de uma tabela de apresentação para repetir sem sobreposição. A numeração usa contadores em `@page`; a validação de paginação é feita em Chromium. Outros motores podem não implementar as caixas de margem e devem ser conferidos antes de se afirmar equivalência.

## Conferência

```powershell
./scripts/verification/order-pdf-harness.ps1 -OutputDirectory artifacts/document-standard/review
python scripts/verification/inspect-order-pdf.py artifacts/document-standard/review/pedido-longo.pdf --output artifacts/document-standard/inspection --render
$env:ERP_BROWSER_DEV='1'
pnpm --filter web exec playwright test --config playwright.proposals.config.ts
python scripts/verification/inspect-proposal-pdf.py CAMINHO_DO_PDF --identity 'Proposta 1' --expect 'EQ-0024'
```

As amostras devem ser abertas para inspeção visual, além das verificações de texto, limites, A4 e identidade por página. Exemplos com dados de clientes pertencem apenas a `artifacts/`, ignorado pelo Git.
