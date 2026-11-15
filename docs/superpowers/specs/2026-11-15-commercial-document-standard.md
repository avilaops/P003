# Padrão de documentos comerciais • ERP Next

O usuário aprovou a padronização imediata tomando como referência o contrato Ludus de 17 páginas já anexado ao ERP. A referência é sua organização visual: logo, cabeçalho compacto, título central, faixas pretas, quadros de identificação, tabelas com divisórias finas e rodapé discreto.

Aplicar ao PDF nativo de pedidos, à consulta/impressão de propostas e ao HTML de proposta anexado ao e-mail. Disponibilizar componentes de documento reutilizáveis para próximos relatórios. O contrato original continua sendo a referência documental; suas cláusulas e campos não são reescritos.

## Ampliação aprovada • todos os emissores de relatórios

O usuário solicitou aplicar o padrão em todos os módulos que emitem relatórios e levar a alteração ao ERP, após a confirmação de que os PDFs anteriores eram locais. Os emissores atuais incluem relatórios financeiro, estoque e serviços; análises gerencial, vendas, produtos e clientes; comprovantes do PDV; documentos comerciais e documentos do pacote contratual. Aliases reutilizam o mesmo componente. Relatórios indisponíveis, definições de relatórios customizados sem execução e cadastros operacionais não passam a fabricar dados ou relatórios.

As consultas operacionais ganham visualização documental e impressão/PDF com a mesma identidade; os filtros e limites de cada fonte ficam explícitos no documento. CSV preserva seu formato de dados. O PDV e os documentos do pacote de contratos adotam o padrão compartilhado; PDF de contrato assinado e documentos fiscais normativos permanecem preservados.

A implantação segue branch de alteração, PR, CI obrigatório, integração e Release de uma revisão exata. Nenhuma impressão de teste envia e-mail, registra pagamento ou altera documento assinado. Concluir os gates e conferir a revisão ativada antes de afirmar que o ERP em produção foi atualizado.

## Visual

• Papel A4, fundo branco, tinta #202020, secundária #626262, divisórias #d6d6d6 e preenchimento #f4f4f4.
• Fonte sem serifa, logo da empresa preservado, sem cor de destaque decorativa.
• Cabeçalho separado por linha fina; título central com número, revisão/versão e situação legíveis.
• Seções com faixa escura e texto branco; conteúdo em quadros de bordas finas.
• Colunas numéricas alinhadas à direita, totais destacados e nenhuma informação comercial omitida para caber.
• Rodapé com identidade e paginação onde o motor oferecer suporte. No navegador, usar página nomeada e contadores de impressão; verificar o resultado em Chromium.
• Separador textual •. Preservar operadores e sintaxe de código.

## Comportamento preservado

Manter valores, permissões, revisão, snapshots, anexos e regras de envio existentes. Rascunho permanece rascunho; pagamento previsto não comprova recebimento. Não enviar e-mails reais nem alterar pedidos na validação. Não expandir esta alteração para documentos fiscais com leiaute normativo ou telas operacionais.

## Aceite

PDF vetorial pesquisável, fonte incorporada, logo sem sobreposição, texto e divisórias dentro da A4, cabeçalho e tabela repetidos em pedidos longos. Proposta legível em 320/390/768/1280px e impressa com todas as colunas. Conferência visual de amostras geradas, testes existentes de paginação e testes do documento/HTML escapado.
