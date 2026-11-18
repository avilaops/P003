# Tesouraria • configuração e conferência

## Escolher o caminho de integração

**Para emitir Pix e boleto no piloto**, a branch local usa o Checkout Transparente do Mercado Pago pela API Payments. O Mercado Pago mantém essa API para integrações existentes e indica a API Orders para projetos novos. O guia abaixo configura a versão Payments implementada no ERP. A consulta e a importação do relatório **Dinheiro em conta** também estão disponíveis na branch. [Checkout Transparente • versões e meios de pagamento](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/overview) • [Dinheiro em conta • API](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/api)

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

Abra o borderô no histórico para exportar o CSV de conferência interna. Com o vendedor vinculado, escolha o meio de cobrança e confirme a emissão de cada título. O histórico identifica a cobrança, o pagamento e as ocorrências de retorno. O cancelamento exige motivo e libera os títulos enquanto nenhuma emissão tiver começado. Para emitir uma cobrança única de vários pedidos do mesmo cliente, use **Faturamento agrupado**. A opção CNAB 240 gera o arquivo para o perfil de cobrança Santander cadastrado na conta.

## Importar um arquivo pronto do Mercado Pago

Selecione a conta vinculada em **Cobranças e retornos**. Clique em **Consultar relatórios no Mercado Pago**, escolha o CSV na lista do vendedor e confirme **Importar arquivo selecionado**. O ERP verifica o vendedor, ambiente, arquivo e valores. Para conferir ocorrências ou divergências, abra o histórico do título no borderô. A seleção repetida reutiliza o registro da importação. O arquivo pode ter até 2 MB e 3.000 linhas de movimentação. Configure as colunas originais do relatório e o separador ponto e vírgula.

A API lista os arquivos disponíveis e baixa o CSV selecionado. Nas contas de teste do Mercado Pago, a lista funciona e os relatórios oficiais são gerados sem movimentações. A coleta no ambiente oficial depende das credenciais da empresa. [Mercado Pago • listar e baixar relatórios](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/api) • [Mercado Pago • limites da conta de teste](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/introduction)

## Baixar um extrato da Efí para o ERP

1. Na conta Efí, abra **API**, crie ou edite uma aplicação e habilite **API Extratos**. Conceda leitura de extratos (`gn.cnab-statement.statement.read`). Para configurar a geração recorrente pela API, habilite também `gn.cnab-statement.statement.write`. Gere o certificado do ambiente e armazene-o com as credenciais da aplicação. [Credenciais, escopos e certificado](https://dev.efipay.com.br/docs/api-extratos/credenciais/)
2. Com o certificado de cliente e o par `Client_Id` e `Client_Secret`, solicite um token com `POST /v1/oauth/token` e `grant_type=client_credentials`. Use o host do ambiente disponibilizado pela Efí para a conta. O certificado acompanha a autenticação e as consultas. [Autorização Efí](https://dev.efipay.com.br/docs/api-extratos/credenciais/)
3. Consulte `GET /v1/extrato-cnab/arquivos` e, com um nome devolvido para a conta, solicite `GET /v1/extrato-cnab/download/{nome_arquivo}`. Se precisar programar a geração, o serviço também documenta `POST /v1/extrato-cnab/agendar`. Essas chamadas podem ser feitas com um cliente HTTP que suporte certificado ou com nós HTTP do n8n configurados para a conta. [Endpoints de extrato Efí](https://dev.efipay.com.br/docs/api-extratos/extratos/)
4. Abra **Financeiro • Caixas e bancos**, selecione a conta correspondente, importe o arquivo de extrato no formato CNAB 240 Efí e confira data, saldos e lançamentos. Execute a conciliação e revise as divergências antes de fechar o período.

### Usar n8n para coletar o extrato Efí

1. Baixe o [workflow importável](../../../integrations/n8n-financeiro-extrato-efi.json) e, no n8n, escolha **Import from File**. O fluxo usa disparo manual. Em **Configurar conta**, preencha `tenantId`, `accountId` e `apiErp` com a origem HTTPS da API TypeScript acessível ao n8n. A conta precisa estar ativa no ERP, com o número e o dígito do extrato Efí. Deixe `nomeArquivo` vazio na primeira execução.
2. Em **Autorizar na Efí**, selecione uma credencial **HTTP Basic Auth** com o Client ID e o Client Secret da aplicação Efí. Nos três nós **Autorizar na Efí**, **Listar extratos** e **Baixar extrato**, selecione a credencial **SSL Certificates** com o certificado e a chave privada da mesma conta. O modelo usa o host de produção que a Efí publica para a API Extratos, com o escopo de leitura. [Efí • autenticação](https://dev.efipay.com.br/docs/api-extratos/credenciais/) • [n8n • certificado do cliente](https://docs.n8n.io/integrations/builtin/credentials/httprequest/#provide-an-ssl-certificate)
3. Em **Importar no ERP**, selecione a credencial **OAuth2 API** do Auth Ávila para a identidade integradora. Use **Authorization Code** e **Connect my account**. Na empresa, a identidade precisa de `finance.account_entries.read` e `finance.account_entries.manage`. O nó envia o token do ERP exclusivamente à sua API. [Como configurar o cliente OAuth no n8n](../../../integrations/FISCAL-N8N-MCP.md#conectar-pelo-oauth-do-auth-ávila)
4. Execute o workflow. Em **Arquivos disponíveis**, confira os nomes e os períodos. Copie o nome desejado para `nomeArquivo` em **Configurar conta** e execute novamente. Selecione o **CNAB 240 em texto sem compressão**, em lote único. Para um agendamento da Efí, use a opção de geração sem comprimir o arquivo. [Efí • consulta, download e agendamentos](https://dev.efipay.com.br/docs/api-extratos/extratos/)
5. Confira `extratoId` em **Conferir protocolo** e abra a conta em **Financeiro • Caixas e bancos** para revisar as correspondências. A importação mantém a conciliação manual. Repetir o mesmo arquivo devolve o protocolo original. Se a Efí reapresentar o mesmo nome com conteúdo diferente, o ERP sinaliza o conflito para conferência.

O workflow foi validado no verificador oficial do n8n e testado localmente com um extrato de exemplo e PostgreSQL. A execução contra a Efí depende das credenciais e do certificado da empresa.

## Integrar cobrança por remessa e retorno CNAB

A opção **Remessa e retorno CNAB 240 • Santander** usa o manual H7815 v8.5 como referência para cobrança simples registrada em reais. A geração e a leitura dos arquivos rodam dentro do ERP. É possível exercitar o ciclo inteiro em uma empresa fictícia, sem login bancário. O canal de transmissão e a aprovação do leiaute para uma carteira real dependem do banco. [Manual H7815](https://cms.santander.com.br/sites/WPS/documentos/arq-layout-de-arquivos-download-cob240ptbr/26-02-25_131410_h7815_layout_cobran%C3%A7a_cnab_240_posi%C3%A7%C3%B5es_padr%C3%A3o_santander_multibanco_fev_2026_v.8.5_%28portugu%C3%AAs%29.pdf) • [Santander • leiautes e teste de arquivos](https://www.santander.com.br/layout-de-arquivos)

O perfil gera duplicata mercantil tradicional em reais, em carteira simples registrada, sem aceite, protesto ou baixa automática. Os segmentos P e Q levam o título e o pagador. Com multa, o arquivo inclui também o segmento R. Para juros mensais, a implementação segue as cinco casas decimais da nota 18 do H7815. A tabela do segmento P indica duas casas para o mesmo campo. Essa codificação precisa ser conferida com o banco quando a empresa habilitar juros no convênio real.

1. Em uma empresa de teste, cadastre uma conta financeira do tipo **Banco**. Para reproduzir o exemplo local, use banco `033`, agência `4321-0` e conta `23456-1`. Cadastre um pagador com CPF ou CNPJ, endereço completo e um título a receber. Esses dados servem apenas para o ensaio local.
2. Em **Financeiro • Remessas e retornos • Preparar ou consultar borderô**, selecione a conta e os títulos e prepare o lote. Abra **Remessa e retorno CNAB 240 • Santander • Configurar convênio Santander**. Use a inscrição da empresa de teste. No exemplo automatizado, o código de transmissão é `123456789012345`, o beneficiário é `001234567` e a conta ocupa nove dígitos antes do DV (`000023456`). Defina as sequências iniciais e as instruções de juros e multa conforme o cenário. Salve o convênio.
3. Selecione **Gerar remessa CNAB** e **Baixar remessa original**. Confira o vencimento, o valor e o nosso número de cada título no arquivo. Um novo download do mesmo borderô recupera o mesmo arquivo. O ERP mantém o protocolo de geração e os eventos de cada título.
4. Use **Importar retorno CNAB** para carregar o arquivo do mesmo convênio. O código `02` confirma o registro, `03` identifica a rejeição e `06` informa a liquidação. Confira o resultado por título, o valor recebido, a tarifa e o crédito líquido. Uma divergência fica disponível para conferência. Reimportar a liquidação deve conservar a baixa original.
5. Para repetir o exemplo sem banco, aponte `API_TS_TEST_ADMIN_URL` para um PostgreSQL descartável com permissão de criar bancos de teste. Na raiz do repositório, execute `pnpm --filter api-ts exec tsx --test test/finance-collection-batches.test.ts`. O teste cria a empresa e a carteira fictícias e confere os registros persistidos. A suíte `playwright.finance-treasury.config.ts` contém o cenário **remessa e retorno CNAB sem credenciais bancárias**, que baixa o arquivo no navegador e importa retornos sintéticos. Os arquivos de exemplo ficam nos artefatos locais desse cenário. Cada retorno contém os identificadores da sua própria remessa. Para testar outra carteira, gere um novo par usando os títulos dessa carteira.

**Quando o retorno ficar em conferência**, abra a ocorrência e compare o nominal, o bruto pago, a tarifa, o líquido e as datas de ocorrência e de crédito. Se a causa era um período fechado, o responsável pode reabrir o período e usar **Reavaliar ocorrência**, informar o motivo e confirmar. Se o crédito está previsto para uma data futura, reavalie a partir dessa data. O ERP reaplica as validações ao arquivo original e registra quem fez a reavaliação e o resultado. Um desconto que não constava na remessa ou juros cujo cálculo não possa ser comprovado continuam em conferência.

**Quando for preciso corrigir uma baixa já efetuada**, faça o estorno pela carteira de contas a receber com a data efetiva e a justificativa. O título é reaberto e pode compor outro borderô. O extrato conserva o recebimento original, a contrapartida e a tarifa cobrada pelo banco. A repetição do retorno original não liquida o título outra vez.

Ao iniciar a homologação oficial, solicite ao banco os dados reais do beneficiário e da carteira, o código de transmissão, a faixa de nossos números, o canal de troca e retornos de referência. Confira os juros, a multa, as tarifas e as ocorrências com a instituição antes de enviar cobranças de clientes. O perfil implementado nesta branch é o de **240 posições**. O manual Santander de 400 posições descreve outro formato.

## Conferir extratos e fechar o período

Em **Caixas e bancos**, escolha a conta e importe um OFX em BRL ou um extrato Efí CNAB 240. O cadastro precisa conter o número da conta conforme o extrato, incluindo o dígito quando fornecido. O importador Efí aceita um arquivo de um lote, serviço 04, versão 033 e segmentos E. Ele confere o número de registros e reconcilia o saldo inicial, os movimentos e o saldo final. A emissão de Pix e boleto usa a API do Mercado Pago. O borderô de cobrança usa o perfil de remessa da conta. [Efí • extrato CNAB 240](https://dev.efipay.com.br/pdfelement/Manual_de_procedimentos_Extrato_CNAB_240.pdf)

Na importação, marque **Conciliar correspondências únicas por data e valor** para vincular uma linha a um único movimento de mesma conta, data, valor e sinal. Quando os dois lados trazem um documento, a referência do ERP também precisa coincidir com uma das referências do extrato. O ERP preserva zeros à esquerda e pontuação. Uma divergência ou vários candidatos deixam a linha pendente.

Selecione uma linha pendente para ver as sugestões. Os movimentos com o mesmo documento aparecem primeiro, inclusive quando estão em outra página do extrato interno. O OFX informa a referência ou o número do cheque e a Efí informa o documento do segmento E. As linhas importadas antes do registro desses campos continuam disponíveis para conferência por data e valor.

Para conciliar um depósito agrupado, selecione a linha e os movimentos que o compõem. Para uma tarifa ou outro movimento que só aparece no banco, selecione a linha, descreva o histórico, escolha a natureza e confirme **Criar movimento e conciliar**. Sem seleção explícita, o ERP aplica a natureza de movimentação da empresa para entrada ou saída.

Antes do fechamento, importe o extrato até a data de corte, confira diferenças e exceções e vincule os movimentos da conta. O fechamento bloqueia novos movimentos no período, inclusive no PDV. A reabertura exige motivo e começa pelo último período encerrado.
