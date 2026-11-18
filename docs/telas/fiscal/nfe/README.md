# NF-e de saída

[Todas as telas](../../../README.md) · [Fiscal](../README.md)

Preparar a nota, revisar os dados e acompanhar a autorização fiscal.

**Onde acessar:** `/fiscal/notas-saida`.

A lista filtra no servidor notas do modelo 55 por ambiente, situação, texto e data de emissão em Brasília. Cada linha identifica a origem, o pedido vinculado, o total fiscal e o motivo de rejeição quando disponível.

No pedido confirmado, abra **Faturamento por item e devoluções**, selecione o ambiente, informe as quantidades e reserve o lote. **Preparar NF-e do lote** abre o editor com o destinatário e os itens da venda. A autorização e a entrega são registradas separadamente.

## O que aparece na tela

- Dados da nota e ambiente
- Destinatário e endereço
- Produtos e valores
- Tributação declarada
- Pagamentos
- Revisão e situação da emissão

## O que você pode fazer

- Criar ou abrir um rascunho
- Copiar dados do cliente e do pedido quando disponíveis
- Salvar e corrigir pendências
- Transmitir por ação separada quando a tela liberar
- Consultar processamento e documentos disponíveis

## Regras e limites

Salvar rascunho não transmite. O botão de transmissão exige uma nota salva e as verificações do ambiente, certificado, permissões e dados fiscais. Se estiver desabilitado, confira a mensagem de bloqueio da tela. O ERP não deve inventar tributação.

## O que ainda precisa de atenção

A liberação deve ser avaliada para a empresa e o documento concretos. A documentação não representa uma autorização da SEFAZ nem um teste de emissão em produção.

No pedido, o painel **Faturamento por item e devoluções** reserva quantidades por linha e registra a entrega dos lotes autorizados. A ação de devolução na NF-e de venda abre o lote correspondente.

• Se o cliente emitiu uma NF-e de devolução, escolha **Vincular NF-e recebida do cliente**, informe o registro de entrada e confirme a conciliação. O ERP confere a chave da venda, o destinatário, as linhas e o protocolo.

• Se o consumidor não emite a nota, escolha **Emitir NF-e de entrada de devolução**, informe a quantidade e o CFOP de cada linha e registre a instrução do responsável fiscal. O ERP prepara uma NF-e modelo 55 da empresa com finalidade de devolução, direção de entrada e referência à chave original. Revise os tributos e transmita pela tela da nota. Após a autorização, retorne ao pedido para concluir.

• Em **Preferências • Políticas de vendas • Política de devoluções**, configure o prazo em dias corridos desde a entrega e o limite em reais. Valores acima do limite exigem decisão de outro aprovador. Na entrada própria, essa decisão precede a emissão.

• Para produtos rastreados, informe uma série por linha no painel do lote. Na entrega parcial, selecione as unidades reservadas que estão saindo. Na devolução, identifique as unidades recebidas. O estoque volta ao depósito de origem quando o destino é estoque. Assistência e descarte ficam no histórico de cada série.

• Em produção, a conclusão concilia a entrada com o estoque, o destino dos itens, os títulos, o crédito do cliente e as comissões aplicáveis. A homologação registra uma simulação fiscal. Consulte as duas origens por pedido, cliente, chave, ambiente ou situação em [Devoluções de venda](/vendas/devolucoes).

Emissão e consulta passam pela API Fastify e pelo motor fiscal privado. Uma autorização incerta preserva número e XML assinado. A reconciliação consulta a mesma chave. Um evento pendente também pode ser consultado pelo histórico após reabrir a tela.

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [FISCAL-AMBIENTES](referencias/FISCAL-AMBIENTES.md)
- [FISCAL-VALORES-COMERCIAIS](referencias/FISCAL-VALORES-COMERCIAIS.md)
- [NFE-SEFAZ-RECOVERY](referencias/NFE-SEFAZ-RECOVERY.md)
- [RETORNOS-E-CONTINUIDADE-FISCAL](referencias/RETORNOS-E-CONTINUIDADE-FISCAL.md)
- [nfe-draft-editor](../../../../apps/web/src/features/fiscal/nfe-draft-editor.tsx)
