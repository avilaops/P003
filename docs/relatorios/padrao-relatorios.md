# Padrão dos emissores de relatórios • ERP Next

Ampliação solicitada em 15/11/2026. Este mapa descreve o escopo do código em alteração; publicação em produção exige a revisão e o Release registrados no plano de execução.

| Saída existente | Padrão adotado | Fonte e limites |
| --- | --- | --- |
| Pedido de venda e anexo de e-mail | PDF A4 vetorial do pedido | Revisão autorizada do pedido e seu snapshot comercial |
| Proposta e anexo de e-mail | Documento comercial e impressão A4; HTML com o mesmo padrão | Versão consultada da proposta; valores registrados |
| Financeiro | Visualização documental e impressão/PDF; CSV preservado | Até 100 títulos por fonte financeira; o documento explicita o recorte |
| Envio financeiro por e-mail | Título/recebível e relatório com PDF nativo gerado no servidor | SMTP central; revisão e hash do snapshot conferidos antes do envio; relatório com até 100 registros de cada fonte |
| Estoque | Visualização documental e impressão/PDF; CSV preservado | Página consultada de até 100 produtos, sem afirmar estoque integral |
| Serviços | Visualização documental e impressão/PDF; CSV preservado | Até 100 ordens retornadas; indicadores derivados desse recorte |
| Visão executiva e vendas | Visualização documental e impressão/PDF | Período consultado; contagens/saldos atuais distinguidos de série de pedidos |
| Análises de produtos e clientes | Visualização documental e impressão/PDF | Contagens atuais autorizadas; sem série histórica inventada |
| Comprovante comercial PDV | Mesmo cabeçalho, quadros, tabela e total; impressão A4 | Venda consultada, pagamentos e troco registrados; não substitui documento fiscal |
| Pedido e comprovantes do pacote contratual | PDF vetorial compartilhado | Snapshot preservado no contrato e recebimentos efetivos elegíveis |
| Contrato, originais anexados e comprovantes enviados | Conteúdo preservado | PDF assinado não é reescrito para mudar apresentação |
| DANFE e XML | Leiaute/documento fiscal preservado | XML autorizado e gerador fiscal existentes |

Aliases em Vendas, Financeiro e Serviços reutilizam os componentes acima. Auditoria analítica, curva ABC e metas indisponíveis não recebem dados ou exportações fictícias. Preferências de relatórios customizados armazenam definições; não há uma execução de dataset a padronizar nessa tela. Cadastros e telas operacionais sem emissor documental não passam a ser contados como novos relatórios.

Para desenvolvimento e validação, consulte o [padrão técnico](../tecnica/PADRAO-DOCUMENTOS-COMERCIAIS.md) e o [plano de integração/publicação](../superpowers/plans/2026-11-15-report-standard-all-modules.md).
