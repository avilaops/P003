# Monitor fiscal e XML recebidos

[Todas as telas](../../../README.md) · [Fiscal](../README.md)

Consultar documentos recebidos pela empresa e importar XML individual.

**Onde acessar:** `/fiscal/monitor`, `/compras/notas-entrada`.

## O que aparece na tela

- Lista paginada da empresa por emissão no horário de Brasília, manifestação e compra vinculada
- Vínculo com devoluções de pedidos ao acessar por Vendas
- Ambiente da distribuição, NSU e retorno em detalhes técnicos
- Arquivo XML
- Busca por fornecedor, CNPJ, nota ou chave
- Período e documentos armazenados

## O que você pode fazer

- Atualizar a consulta
- Consultar a SEFAZ conforme as regras do serviço
- Importar XML completo com protocolo
- Abrir os documentos e acompanhar sua conciliação

## Regras e limites

Falha de consulta não comprova ausência de documentos. Importar uma NF-e não recebe mercadoria nem gera pagamento automaticamente. O detalhe canônico fica no Monitor. O endereço de Compras abre o mesmo registro e o caminho de volta preserva a origem.

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [MONITOR-FISCAL-CANONICO](referencias/MONITOR-FISCAL-CANONICO.md)
- [RECEBIMENTO-NFE-AVL-91-94-97](referencias/RECEBIMENTO-NFE-AVL-91-94-97.md)
- [CONTRATOS-FISCAL-RECEBIDAS](referencias/CONTRATOS-FISCAL-RECEBIDAS.md)
- [received-monitor](../../../../apps/web/src/features/fiscal/received-monitor.tsx)
- [received-document-detail](../../../../apps/web/src/features/fiscal/received-document-detail.tsx)
