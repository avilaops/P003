# API TypeScript • quatro módulos concluídos

API de Preferências, Cadastros, Vendas e Relatórios, dentro do [inventário](../../docs/architecture/typescript-api-route-coverage.md). PostgreSQL próprio; o navegador entra pelo BFF Next e o MCP conserva seu protocolo/OAuth nativo. Esses módulos têm propriedade permanente em TypeScript; as flags antigas não alteram o destino.

## Verificação local

`pnpm --filter api-ts typecheck` verifica os tipos. `pnpm --filter api-ts test` executa as unidades e, quando `API_TS_TEST_ADMIN_URL` está definida, a integração PostgreSQL.

Para executar **a mesma matriz HTTP em TypeScript, Rust de referência e gateway Rust de produção**, defina `API_TS_TEST_ADMIN_URL` e execute `pnpm --filter api-ts test:contracts`. O comando compila dois binários distintos com lockfile e modo offline, compara integralmente o OpenAPI e testa o MCP nativo pelo gateway com PostgreSQL real. `API_TS_TEST_RUST_BINARY` aceita uma referência do checkout compilada com `--features migration-reference`; `API_TS_TEST_GATEWAY_BINARY` aceita a compilação de produção sem essa feature. A referência não deve ser implantada.

A URL de administrador deve apontar para um PostgreSQL de testes. A suíte cria bancos descartáveis, aplica as migrações e cria uma role `NOLOGIN NOSUPERUSER NOBYPASSRLS`. As duas APIs operam com essa mesma role, autenticação local controlada e empresas distintas. Os bancos e as roles pertencentes ao teste são removidos no encerramento. Nenhuma credencial de produção é necessária. O processo Rust recebe apenas as variáveis explicitamente necessárias e mantém os workers desativados.

A matriz cobre isolamento por empresa, permissões/revogação, consultas, revisões, replay/concorrência e rollback, além de fluxos comerciais, checkout, transições de pedidos, propostas e relatórios. Isso complementa os testes unitários; a validação de implantação e do BFF continua necessária.

## Pacote de produção

`pnpm --filter api-ts build` compila somente `src` para `dist/server.js`. `pnpm --filter api-ts deploy --prod --legacy artifacts/api-ts` cria o pacote com dependências de execução. `node apps/api-ts/scripts/verify-package.mjs artifacts/api-ts` inicia esse pacote em uma porta local temporária e verifica liveness e falha de readiness sem banco. O script recebe somente configuração sintética e não usa credenciais reais.

O processo usa `API_TS_HOST=127.0.0.1` e `API_TS_PORT=8081` por padrão, respeita `AUTH_USERINFO_URL` da mesma origem do issuer, limita conexões e encerra o pool ao receber SIGTERM/SIGINT. `/health/ready` consulta o banco real e não revela o erro interno. O processo é obrigatório no Compose e no runtime; a saúde pública exige as duas APIs.

`POST /internal/mcp/dispatch` é privado e revalida o access token, o grant, o recurso `ERP_MCP_ORIGIN/mcp`, a expiração, a revogação e o escopo no PostgreSQL. A identidade existe apenas no contexto assíncrono desse despacho; cabeçalhos não podem declarar um usuário. O token MCP continua inválido como token Auth na API normal. Não há redirecionamento, retry de comando ou retorno automático ao Rust. Recuperação usa a [release anterior completa](../../docs/architecture/typescript-api-transition-finalization.md).

## Browser Use

`POST /api/v1/integrations/browser-use/runs` executa uma tarefa de agente na Browser Use Cloud (API V4, `browser-use-sdk/v4`) e devolve `{ runId, sessionId, result, totalCostUsd }`. O corpo aceita somente `task` (até 4.000 caracteres) e, opcionalmente, `model`. Sem `model`, vale o padrão do projeto Browser Use. Um modelo explícito, como `bu-ultrafast`, é repassado sem alteração.

- Exige autenticação, `x-tenant-id` e a permissão `platform.company.manage`, porque cada execução consome créditos. A permissão é conferida em uma transação curta, só de leitura, liberada antes da execução.
- Toda execução tem `maxCostUsd: 1`. A resposta só é aceita com status `completed` e `result` preenchido. Os outros casos respondem `502 integration_failed`, sem repassar o texto de erro do provedor.
- Se a execução não terminar em 5 minutos, ela é cancelada e a rota responde `504 integration_timeout`. Uma falha ao criar a execução responde `502 integration_unavailable` e não é repetida, porque a execução pode já existir.
- Sem `BROWSER_USE_API_KEY`, ou com o valor vazio, a rota responde `503 integration_unavailable`.

A chave é lida somente no servidor. Em desenvolvimento, `pnpm --filter api-ts dev` carrega `apps/api-ts/.env.local` quando o arquivo existe. Esse arquivo é ignorado pelo Git. Em produção, a chave é a única credencial de terceiros aceita no processo TypeScript, e nunca chega aos processos web ou Rust. No layout Compose, ela vai em `api-ts.env` (veja `deploy/api-ts.env.example`). No `compose.json` gerado por `deploy/production-deploy.sh`, ela é lida do `api-ts` anterior ou do serviço `api` e conservada entre releases. No runtime Cloudflare, ela faz parte de `TYPESCRIPT_KEYS`, em `deploy/cloudflare/runtime-configuration.mjs`. Sem a chave, a rota responde 503.

`test/browser-use.test.ts` e `test/browser-use-routes.test.ts` cobrem o fluxo com clientes simulados, sem gasto real.

## Publicação do catálogo

`GET /api/v1/catalog-publication` mostra a prévia sem preços e a última publicação. `POST` publica a prévia pelo hash, com `Idempotency-Key` igual ao identificador da publicação. O snapshot é gravado antes da chamada de rede, então repetir a mesma chave publica a mesma versão. O envio ao Worker público só existe com `CATALOG_MEDIA_ORIGIN` (`https://ludusequipamentos.com`), `CATALOG_MEDIA_TOKEN` (32 caracteres ou mais) e `CATALOG_MEDIA_TENANT`, os três juntos. Sem eles, a prévia responde `configured: false` e a publicação responde `409`. O token é lido só no servidor. A entrega dessas variáveis ao serviço `api-ts` ainda não está no deploy e precisa entrar antes da remoção do Rust.
