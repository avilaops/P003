# API TypeScript • migração gradual

API separada para Preferências, Cadastros, Vendas e Relatórios. PostgreSQL próprio; a entrada do navegador continua no BFF Next. A ativação por módulo depende dos testes e da configuração de implantação.

## Verificação local

`pnpm --filter api-ts typecheck` verifica os tipos. `pnpm --filter api-ts test` executa as unidades e, quando `API_TS_TEST_ADMIN_URL` está definida, a integração PostgreSQL.

Para executar **a mesma matriz HTTP nas implementações TypeScript e Rust**, defina `API_TS_TEST_ADMIN_URL` e execute `pnpm --filter api-ts test:contracts`. O comando exige essa variável, compila o binário Rust com lockfile e modo offline e falha se qualquer implementação divergir das asserções. `API_TS_TEST_RUST_BINARY` permite informar explicitamente um binário já compilado do checkout atual.

A URL de administrador deve apontar para um PostgreSQL de testes. A suíte cria bancos descartáveis, aplica as migrações e cria uma role `NOLOGIN NOSUPERUSER NOBYPASSRLS`. As duas APIs operam com essa mesma role, autenticação local controlada e empresas distintas. Os bancos e as roles pertencentes ao teste são removidos no encerramento. Nenhuma credencial de produção é necessária. O processo Rust recebe apenas as variáveis explicitamente necessárias e mantém os workers desativados.

A matriz cobre isolamento por empresa, permissões/revogação, consultas, revisões, replay/concorrência e rollback, além de fluxos comerciais, checkout, transições de pedidos, propostas e relatórios. Isso complementa os testes unitários; a validação de implantação e do BFF continua necessária.

## Pacote de produção

`pnpm --filter api-ts build` compila somente `src` para `dist/server.js`. `pnpm --filter api-ts deploy --prod --legacy artifacts/api-ts` cria o pacote com dependências de execução. `node apps/api-ts/scripts/verify-package.mjs artifacts/api-ts` inicia esse pacote em uma porta local temporária e verifica liveness e falha de readiness sem banco. O script recebe somente configuração sintética e não usa credenciais reais.

O processo usa `API_TS_HOST=127.0.0.1` e `API_TS_PORT=8081` por padrão, respeita `AUTH_USERINFO_URL` da mesma origem do issuer, limita conexões e encerra o pool ao receber SIGTERM/SIGINT. `/health/ready` consulta o banco real e não revela o erro interno. O runtime Cloudflare inicia esse processo somente quando algum módulo está habilitado; a rota pública de saúde verifica as duas APIs.
