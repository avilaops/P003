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
