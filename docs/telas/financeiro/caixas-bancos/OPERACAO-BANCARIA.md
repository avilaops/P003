# Tesouraria • configuração e conferência

## Escolher o caminho de integração

**Para emitir Pix e boleto no piloto**, a branch local usa o Checkout Transparente do Mercado Pago pela API Payments. A consulta e a importação de **Dinheiro em conta** também têm API pública. O ERP já implementa esses dois fluxos em TypeScript. [Checkout Transparente • meios de pagamento](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/overview) • [Dinheiro em conta • API](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/api)

**Para conciliar uma conta Efí**, a API Extratos fornece o arquivo CNAB 240. A branch recebe esse arquivo na tela Caixas e bancos. A Efí oferece APIs próprias de boleto e Pix. Habilitar a emissão pelo segundo provedor exigiria um adaptador no ERP. [Extratos Efí](https://dev.efipay.com.br/docs/api-extratos/extratos/) • [Boleto Efí](https://dev.efipay.com.br/docs/api-cobrancas/boleto/) • [Pix Efí](https://dev.efipay.com.br/docs/api-pix/credenciais/)

**Para remeter títulos de cobrança por arquivo**, há manuais públicos de bancos como o Santander. Nos portais de integração de Mercado Pago e Efí consultados em 18/11/2026, o caminho documentado para a cobrança é a API. A equipe da Efí descreve a confirmação do boleto emitido por API por meio da notificação. O banco do convênio define a carteira, o canal e a versão do arquivo a homologar. [Orientação da Efí sobre boleto por API](https://comunidade.sejaefi.com.br/discussao/diferencas-emissao-boletos-api-44) • [Leiautes de arquivos Santander](https://www.santander.com.br/layout-de-arquivos) • [Padrão FEBRABAN](https://portal.febraban.org.br/pagina/3425/33/pt-br/layout-febraban)

## Vínculo Mercado Pago

1. Acesse o painel de desenvolvedores com a conta responsável pela aplicação. Em **Suas integrações**, crie ou selecione a aplicação do ERP com Checkout Transparente via Payments. Confira a chave Pix do vendedor para receber nessa modalidade. [Pré-requisitos oficiais](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/overview)
2. Em **Credenciais**, selecione **Teste**. Copie o Access Token para o gerenciador de segredos da API e consulte o User ID da conta de teste vinculada ao vendedor. Na configuração do ERP, esse identificador é `collectorId`. O ERP verifica o vendedor e o ambiente antes de emitir a cobrança. [Credenciais e contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/test/accounts)
3. Cadastre a conta bancária no ERP e anote os UUIDs da empresa e da conta. No ambiente de homologação, configure uma identidade técnica ativa para essa empresa. Use o exemplo de vínculo e as permissões abaixo.
4. Na aplicação do Mercado Pago, abra **Webhooks**, informe a URL HTTPS da versão de homologação do ERP, escolha o evento **Pagamentos** e salve a assinatura secreta no gerenciador. Configure a API para ler esse segredo. A publicação da branch em um ambiente de homologação é o que tornará esse endereço acessível ao provedor. [Configurar e simular notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks)

### Configuração da API TypeScript

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

A empresa ainda não possui conta de homologação do provedor. O aceite local usa PostgreSQL descartável, API TypeScript, BFF e Chromium com uma instituição HTTP de teste. A emissão e a notificação no ambiente oficial dependem da conta de teste do vendedor e de suas credenciais.

Para reproduzir o aceite local, informe a URL administrativa de um PostgreSQL de teste em `API_TS_TEST_ADMIN_URL` e execute `pnpm --dir apps/web exec playwright test --config playwright.finance-treasury.config.ts finance-treasury-persistence.spec.ts`. O teste cria um banco descartável, roda as migrações, usa um papel sujeito a RLS e compara os valores da tela com os lançamentos no PostgreSQL. A web, a API e a instituição de teste escutam nas portas locais 33247, 33249 e 33250.

1. Cadastre um pagador de teste e um título em reais com vencimento válido. Para boleto, preencha o endereço. Use o e-mail do comprador de teste do Mercado Pago.
2. Em **Financeiro • Remessas e retornos**, escolha a conta marcada como homologação, selecione o título e emita Pix ou boleto. Confira o identificador do pagamento e o código retornado. O ERP reserva os títulos antes da emissão e mantém a chave ao recuperar uma tentativa. [Mercado Pago • Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/pix) • [Mercado Pago • boleto](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/other-payment-methods)
3. Simule a entrega da notificação pelo painel do Mercado Pago e confira a resposta HTTP e o histórico no ERP. A simulação testa o transporte. Para verificar uma baixa, use uma cobrança originada no ERP com um ID consultável e situação aprovada no provedor. A API confere vendedor, conta, moeda, valor, data e líquido antes de baixar o principal e registrar eventual tarifa. Confira estornos, chargebacks e divergências no histórico. [Webhooks de Payments](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks)
4. Importe o CSV **Dinheiro em conta** da conta correspondente. Use o delimitador ponto e vírgula e os nomes originais das colunas. O importador compara os valores bruto e líquido à consulta do provedor. Verifique que receber a mesma operação por webhook e depois por arquivo preserva uma única baixa por título. [Mercado Pago • campos do relatório](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/report-fields)

Para habilitação posterior de uma conta de produção, cadastre um vínculo próprio com `mode: "production"`, credenciais do vendedor e URL de notificações desse ambiente. A ativação exige `enabled: true` no vínculo e `FINANCE_MP_ENABLE_PRODUCTION=true` na API. A tela identifica o ambiente da conta antes da emissão.

## Preparar um borderô

Em **Financeiro • Remessas e retornos**, abra **Preparar ou consultar borderô**. Escolha uma conta bancária ativa, dê uma referência ao lote e selecione os títulos. O ERP preserva cliente, saldo e vencimento de cada título. A conta pode preparar o lote antes de vincular o vendedor do Mercado Pago.

Abra o borderô no histórico para exportar o CSV de conferência interna. Com o vendedor vinculado, escolha o meio de cobrança e confirme a emissão de cada título. O histórico identifica a cobrança, o pagamento e as ocorrências de retorno. O cancelamento exige motivo e libera os títulos enquanto nenhuma emissão tiver começado. Para emitir uma cobrança única de vários pedidos do mesmo cliente, use **Faturamento agrupado**. A geração de remessa CNAB de cobrança depende do convênio e do leiaute contratados.

## Importar um arquivo pronto do Mercado Pago

Selecione a conta vinculada em **Cobranças e retornos**. Clique em **Consultar relatórios no Mercado Pago**, escolha o CSV na lista do vendedor e confirme **Importar arquivo selecionado**. O ERP verifica o vendedor, ambiente, arquivo e valores. Para conferir ocorrências ou divergências, abra o histórico do título no borderô. A seleção repetida reutiliza o registro da importação. O arquivo pode ter até 2 MB e 3.000 linhas de movimentação. Configure as colunas originais do relatório e o separador ponto e vírgula.

A API lista os arquivos disponíveis e baixa o CSV selecionado. Nas contas de teste do Mercado Pago, a lista funciona e os relatórios oficiais são gerados sem movimentações. A coleta no ambiente oficial depende das credenciais da empresa. [Mercado Pago • listar e baixar relatórios](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/api) • [Mercado Pago • limites da conta de teste](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/introduction)

## Baixar um extrato da Efí para o ERP

1. Na conta Efí, abra **API**, crie ou edite uma aplicação e habilite **API Extratos**. Conceda leitura de extratos (`gn.cnab-statement.statement.read`). Para configurar a geração recorrente pela API, habilite também `gn.cnab-statement.statement.write`. Gere o certificado do ambiente e armazene-o com as credenciais da aplicação. [Credenciais, escopos e certificado](https://dev.efipay.com.br/docs/api-extratos/credenciais/)
2. Com o certificado de cliente e o par `Client_Id` e `Client_Secret`, solicite um token com `POST /v1/oauth/token` e `grant_type=client_credentials`. Use o host do ambiente disponibilizado pela Efí para a conta. O certificado acompanha a autenticação e as consultas. [Autorização Efí](https://dev.efipay.com.br/docs/api-extratos/credenciais/)
3. Consulte `GET /v1/extrato-cnab/arquivos` e, com um nome devolvido para a conta, solicite `GET /v1/extrato-cnab/download/{nome_arquivo}`. Se precisar programar a geração, o serviço também documenta `POST /v1/extrato-cnab/agendar`. Essas chamadas podem ser feitas com um cliente HTTP que suporte certificado ou com nós HTTP do n8n configurados para a conta. [Endpoints de extrato Efí](https://dev.efipay.com.br/docs/api-extratos/extratos/)
4. Abra **Financeiro • Caixas e bancos**, selecione a conta correspondente, importe o arquivo de extrato no formato CNAB 240 Efí e confira data, saldos e lançamentos. Execute a conciliação e revise as divergências antes de fechar o período.

### Usar n8n para coletar o extrato Efí

No n8n, use um disparo manual durante a homologação e três nós **HTTP Request** na sequência de autenticação, listagem e download. No primeiro, configure o par da aplicação em credencial HTTP Basic e envie o grant de credenciais de cliente. Nos dois seguintes, configure o cabeçalho **Authorization** com o token retornado pelo primeiro. Em cada nó, ative **SSL Certificates** em **Settings** e selecione a credencial do certificado do ambiente. Escolha o arquivo da conta na listagem, salve o extrato em uma pasta privada e importe-o no ERP. O agendamento pode ser ativado depois de validar uma coleta manual. [n8n • certificado no HTTP Request](https://docs.n8n.io/integrations/builtin/credentials/httprequest/#provide-an-ssl-certificate) • [Efí • consultar e baixar](https://dev.efipay.com.br/docs/api-extratos/extratos/)

## Integrar cobrança por remessa e retorno CNAB

O borderô da branch gera um CSV para conferência. O arquivo de transmissão ao banco precisa seguir o manual específico do convênio. O roteiro abaixo descreve a integração a desenvolver para o banco que a empresa escolher.

1. Solicite à instituição a habilitação de **cobrança registrada por troca de arquivos**. Peça a versão do leiaute de cobrança (240 ou 400), o código do beneficiário, a carteira, a regra do nosso número, o canal de transmissão, o acesso a testes e exemplos de retorno de registro, rejeição e liquidação. O manual público permite preparar os campos antes da contratação. [Santander • cobrança empresarial](https://www.santander.com.br/servicos-financeiros/solucoes-de-recebimento/cobrancas) • [Leiautes bancários](https://www.santander.com.br/layout-de-arquivos)
2. Com o manual escolhido, associe a conta e o convênio ao borderô. O adaptador TypeScript deverá gerar remessa com o sequencial do arquivo e os identificadores de cada título seguindo o leiaute da instituição. Valide largura, totais e dígitos com o arquivo de referência do banco.
3. Transmita a remessa pelo canal de homologação habilitado para a empresa. Guarde o protocolo e importe o primeiro retorno. **Entrada confirmada** marca o título como registrado. Uma rejeição deve exibir o motivo para correção. O retorno de **liquidação** é o que gera a baixa, com data, principal, encargos e tarifa aplicáveis.
4. Reimporte o retorno e compare os títulos, a conta e o extrato. A segunda importação deve conservar um único movimento por liquidação. Libere a transmissão real depois do aceite do banco. O n8n pode transportar os arquivos quando o convênio oferecer um canal automatizável. A API do ERP valida o conteúdo e efetua a baixa.

## Conferir extratos e fechar o período

Em **Caixas e bancos**, escolha a conta e importe um OFX em BRL ou um extrato Efí CNAB 240. O cadastro precisa conter o número da conta conforme o extrato, incluindo o dígito quando fornecido. O importador Efí aceita um arquivo de um lote, serviço 04, versão 033 e segmentos E. Ele confere o número de registros e reconcilia o saldo inicial, os movimentos e o saldo final. A emissão de Pix e boleto usa a API do Mercado Pago. Arquivo de remessa de cobrança depende de um leiaute contratado. [Efí • extrato CNAB 240](https://dev.efipay.com.br/pdfelement/Manual_de_procedimentos_Extrato_CNAB_240.pdf)

Na importação, marque **Conciliar correspondências únicas por data e valor** para vincular automaticamente uma linha pendente a um movimento de mesmo valor, sinal, conta e data. Duas linhas ou dois movimentos com os mesmos dados ficam pendentes. Para conciliar um depósito agrupado, selecione a linha e os movimentos que o compõem. Para uma tarifa ou outro movimento que só aparece no banco, selecione a linha, descreva o histórico, escolha a natureza e confirme **Criar movimento e conciliar**. Sem seleção explícita, o ERP aplica a natureza de movimentação da empresa para entrada ou saída.

Antes do fechamento, importe o extrato até a data de corte, confira diferenças e exceções e vincule os movimentos da conta. O fechamento bloqueia novos movimentos no período, inclusive no PDV. A reabertura exige motivo e começa pelo último período encerrado.
