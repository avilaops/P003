# Canais e importação de pedidos

## Importar um arquivo

Em Vendas → Importar pedidos, baixe o modelo CSV ou selecione um arquivo UTF-8 de até 64 KiB e 200 linhas de itens. Informe o identificador do canal, que pode conter letras minúsculas, números, hífen ou sublinhado. Mapeie pedido externo, CPF/CNPJ do cliente cadastrado, vencimento no formato AAAA-MM-DD, SKU e quantidade. Os campos de cor e acabamento atendem ao catálogo de cada produto.

Clique em **Validar e gerar prévia**. Linhas com o mesmo número externo pertencem ao mesmo pedido. Se um item tiver erro, corrija as linhas desse pedido e envie um arquivo novo. **Confirmar pedidos válidos** cria os rascunhos habilitados. Um reenvio com os mesmos dados aponta para o pedido existente. O relatório CSV e a página da importação identificam cada linha, resultado e pedido do ERP.

## Contrato de integração

O conector autenticado atua na empresa indicada em `X-Tenant-Id`. A leitura exige `sales.orders.read`. A prévia, a confirmação e as mudanças do pedido exigem também `sales.orders.manage`. Cada comando usa uma `Idempotency-Key` UUID persistida pelo conector. Para repetir depois de uma interrupção, envie o mesmo corpo e chave.

1. Envie `POST /api/v1/sales-imports/preview` com `filename`, `channel` e `rows`. Cada item informa `line`, `external`, `customer`, `due`, `sku` e `quantity`. Os nomes de cor são `structureColor`, `swingArmColor`, `plateHolderColor`, `plateHolderType` e `upholsteryColor`. A API calcula o preço do catálogo do cliente.
2. Use o identificador e o ETag da prévia em `POST /api/v1/sales-imports/{id}/confirm`, corpo `{}`, cabeçalho `If-Match` e uma chave própria para confirmação. `GET /api/v1/sales-imports/{id}` recupera o resultado. A empresa, o canal e o número externo identificam um único pedido. Uma alteração de conteúdo para o mesmo número requer conciliação.
3. Consulte `GET /api/v1/sales-channels/{canal}/orders?external={numero}` para ler o estado e a revisão atuais do pedido. Um evento de confirmação autorizado pelo canal pode chamar `POST /api/v1/orders/{orderId}/confirm` com o `If-Match` da revisão e sua própria chave. A API verifica crédito, política comercial e saldo antes de reservar. Sem estoque, a tentativa pode ser repetida após reposição. Cancelamentos de pedidos elegíveis passam pelo comando `/cancel`. Entregas já concluídas seguem o fluxo de devolução.
4. O vínculo de origem emite `order.channel_imported`. Acompanhe o pedido por seu número externo após confirmação ou cancelamento e persista a confirmação de recebimento do provedor antes de concluir a sincronização.

Loja virtual e Anúncios direcionam às integrações. A publicação no marketplace e a entrega de status ao provedor precisam de um conector homologado para aquele canal. A execução local cobriu o contrato do ERP e a reserva usando PostgreSQL e um provedor de identidade simulado.

[Fluxo da importação](../../../../apps/api-ts/src/modules/order-imports/routes.ts) • [Teste com PostgreSQL](../../../../apps/api-ts/test/order-import-postgres.test.ts) • [Teste da interface](../../../../apps/web/tests/order-import-ui.spec.ts)
