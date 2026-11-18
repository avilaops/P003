# Tesouraria • configuração e conferência

## Vínculo Mercado Pago

Cada vínculo associa uma conta bancária ativa do ERP a uma empresa, a um vendedor brasileiro e a um ambiente do Mercado Pago. A emissão confere a identidade do vendedor no provedor. Use contas financeiras distintas para homologação e produção. A aplicação para assinaturas do ERP tem credenciais próprias.

Configure `FINANCE_MP_CONNECTIONS` no ambiente privado da API TypeScript como lista JSON. Substitua os identificadores pelos da empresa piloto. As variáveis indicadas em `tokenEnv` e `webhookEnv` armazenam o token de acesso e o segredo de assinatura da aplicação.

```json
[
  {
    "tenantId": "<UUID da empresa>",
    "accountId": "<UUID da conta bancária>",
    "collectorId": "<ID numérico do vendedor>",
    "subject": "<identidade técnica ativa da empresa>",
    "mode": "sandbox",
    "enabled": true,
    "tokenEnv": "FINANCE_MP_PILOTO_TOKEN",
    "webhookEnv": "FINANCE_MP_PILOTO_WEBHOOK"
  }
]
```

Para um piloto único, a API também aceita `FINANCE_MP_SANDBOX_TENANT_ID`, `FINANCE_MP_SANDBOX_ACCOUNT_ID`, `FINANCE_MP_SANDBOX_COLLECTOR_ID`, `FINANCE_MP_SANDBOX_SUBJECT`, `FINANCE_MP_SANDBOX_ACCESS_TOKEN` e `FINANCE_MP_SANDBOX_WEBHOOK_SECRET`. Cada conta deve aparecer uma única vez na configuração.

A identidade técnica precisa de vínculo ativo com a empresa e das permissões `finance.collections.manage`, `finance.receivables.read` e `finance.receivables.manage`. O operador também usa `finance.collections.read` para consultar a tela. Fechar ou reabrir uma conta usa `finance.reconciliation.close` ou `finance.reconciliation.reopen`, respectivamente.

Registre o evento **Payments** no painel do Mercado Pago. A URL pública é `https://erp.avilaops.com/api/integrations/finance/mercadopago/{tenantId}/{accountId}`. O ERP autentica a assinatura HMAC e consulta a transação antes de aplicar a baixa. Configure a URL correspondente ao ambiente usado. [Mercado Pago • notificações](https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks)

## Homologar cobrança

1. Cadastre um pagador de teste e um título em reais com vencimento válido. Para boleto, preencha o endereço. Use o e-mail do comprador de teste do Mercado Pago.
2. Em **Financeiro • Remessas e retornos**, escolha a conta marcada como homologação, selecione o título e emita Pix ou boleto. Confira o identificador do pagamento e o código retornado. O ERP reserva os títulos antes da emissão e mantém a chave ao recuperar uma tentativa. [Mercado Pago • Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/pix) • [Mercado Pago • boleto](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/other-payment-methods)
3. Confira os eventos de teste disponíveis para o meio de pagamento. A confirmação de um pagamento aprovado identifica o vendedor, a conta, a moeda, o valor, a data e o líquido. A baixa grava o principal em cada título e registra eventual tarifa como saída na conta. Estornos externos, chargebacks e divergências exigem conferência.
4. Importe o CSV **Dinheiro em conta** da conta correspondente. Use o delimitador ponto e vírgula e os nomes originais das colunas. O importador compara os valores bruto e líquido à consulta do provedor. Verifique que receber a mesma operação por webhook e depois por arquivo preserva uma única baixa por título. [Mercado Pago • campos do relatório](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/report-fields)

Para habilitação posterior de uma conta de produção, cadastre um vínculo próprio com `mode: "production"`, credenciais do vendedor e URL de notificações desse ambiente. A ativação exige `enabled: true` no vínculo e `FINANCE_MP_ENABLE_PRODUCTION=true` na API. A tela identifica o ambiente da conta antes da emissão.

## Conferir extratos e fechar o período

Em **Caixas e bancos**, escolha a conta e importe um OFX em BRL ou um extrato Efí CNAB 240. O cadastro precisa conter o número da conta conforme o extrato, incluindo o dígito quando fornecido. O importador Efí aceita um arquivo de um lote, serviço 04, versão 033 e segmentos E. Ele confere o número de registros e reconcilia o saldo inicial, os movimentos e o saldo final. A emissão de Pix e boleto usa a API do Mercado Pago. Arquivo de remessa de cobrança depende de um leiaute contratado. [Efí • extrato CNAB 240](https://dev.efipay.com.br/pdfelement/Manual_de_procedimentos_Extrato_CNAB_240.pdf)

Selecione a linha do banco e os lançamentos que a compõem. Data e valor iguais geram sugestões. O operador confirma a seleção e justifica diferenças ou exceções. Antes do fechamento, importe o extrato até a data de corte, trate as linhas e vincule os movimentos da conta. O fechamento bloqueia novos movimentos no período, inclusive no PDV. A reabertura exige motivo e começa pelo último período encerrado.
