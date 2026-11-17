# API TypeScript • conclusão dos quatro módulos

Atualizado em 17/11/2026 • implementação em validação, publicação pendente.

## Escopo e propriedade

Preferências pessoais, Cadastros, Vendas e Relatórios seguem o [inventário de rotas](typescript-api-route-coverage.md). As fontes dessas operações são `apps/api-ts/src/modules`. Não há Supabase, novo banco, nova senha compartilhada ou alteração dos vínculos OAuth dos clientes MCP.

O fechamento abrange 65 handlers em 43 caminhos. A compilação Rust de produção conserva apenas o encaminhamento dessas operações. Os handlers anteriores e seus helpers exclusivos exigem `cfg(test)` ou a feature explícita `migration-reference`. Tipos e utilitários consumidos por recursos não migrados continuam disponíveis.

Financeiro, Fiscal, Estoque, Compras, Produção, Contratos, documentos, e-mail e administração mantêm suas implementações existentes. Relatórios aqui compreendem o painel e as definições de relatórios personalizados; geração de documentos e fontes financeiras não foram incluídas nesta onda.

## Entradas e autenticação

• Navegador • BFF Next encaminha uma única requisição à origem TypeScript privada nas operações inventariadas. As demais mantêm sua origem existente.

• HTTP Rust • os nomes canônicos dos handlers migrados apontam para o gateway. A API TypeScript valida o Bearer Auth original e aplica empresa, permissões, RLS e transação.

• MCP • Rust conserva OAuth, protocolo, catálogo, schemas e montagem tipada dos argumentos. Depois da autenticação insere uma extensão interna com a credencial original. O gateway envia um envelope limitado para `/internal/mcp/dispatch`; TypeScript consulta os tokens/grants existentes, verifica recurso, expiração, revogação e escopo e executa a rota migrada. Cabeçalhos não podem declarar identidade. O token MCP não é aceito como token Auth na API normal.

• Assistente interno • suas consultas a pedidos, clientes e produtos usam o mesmo gateway, com o Bearer original ou a extensão MCP validada. Consulta de estoque conserva sua implementação.

O despacho preserva bytes JSON e inteiros i64, query, empresa, revisão, chave do comando, request ID, status e cabeçalhos de resposta selecionados. Há limites para corpo e resposta. Imagens inline conservam o limite existente da rota de produto. Não há retry de comando, redirecionamento HTTP ou troca de backend após o envio; falhas podem indicar resultado incerto.

## Contrato e testes

`apps/api/src/http/fixtures/migrated_operations.json` fixa as 65 operações e 85 schemas exportados pela referência, incluindo os componentes `GroupReference` e `TagReference` registrados sem referência transitiva. O OpenAPI das operações não migradas continua derivado de seus handlers. A resolução antiga de nomes globais repetidos, como `CheckoutInput`, é conservada para preservar compatibilidade. Um teste compara o fragmento às anotações da referência; a matriz integrada exige igualdade dos dois OpenAPI completos, preservando também o catálogo MCP.

```powershell
$env:API_TS_TEST_ADMIN_URL='postgresql://postgres@127.0.0.1:55432/postgres'
pnpm --filter api-ts test
pnpm --filter api-ts typecheck
pnpm --filter api-ts test:contracts
```

A matriz aplica migrations em bancos descartáveis e opera com uma role sem superusuário ou bypass de RLS. Executa os fluxos nas implementações TypeScript, Rust de referência e gateway de produção. O MCP nativo é testado no gateway, com credenciais expiradas/revogadas, recurso incorreto, escopo de leitura, isolamento entre empresas, comando idempotente, auditoria única e produto com foto acima de 64 KB. A suíte unitária cobre concorrência de identidades, cabeçalhos forjados e destinos arbitrários.

Navegador/Next real usam fixtures HTTP locais; as regras do banco são verificadas separadamente pela matriz. As verificações reais de produção são somente leituras, sem enviar e-mails ou criar pedidos.

## Runtime e recuperação

Rust e TypeScript compartilham o PostgreSQL próprio e a role restrita. TypeScript escuta em `127.0.0.1:8081`, sem porta publicada. O pacote permanece dentro da imagem web validada; o manifesto não ganha outro componente de imagem.

O Compose e o supervisor sempre iniciam TypeScript. O supervisor espera a prontidão das duas APIs antes do web. A saúde pública depende de ambas. TypeScript recebe somente configuração de banco/Auth e `ERP_MCP_ORIGIN`; não recebe segredos de sessão, SMTP, Fiscal ou assinatura.

`ERP_TYPESCRIPT_MODULES` foi aposentada. A ausência ou alteração dessa variável não muda a propriedade de um comando e não desliga o processo. `ERP_TYPESCRIPT_API_URL` é obrigatória no BFF; origem inválida ou ausente impede o envio.

Para recuperar a operação:

1. Selecionar a release anterior validada pelo dispatcher existente, conservando suas imagens e configuração privada.
2. Recriar o conjunto da release e aguardar sua saúde; esta entrega não altera migrations nem exige desfazer o banco.
3. Conferir o SHA público e leituras autenticadas na empresa correta.
4. Para uma operação cujo resultado se perdeu, consultar o estado antes de qualquer nova intenção. O dispatcher e os gateways não repetem comandos comerciais.

A referência Rust com `migration-reference` é um oráculo de testes, não uma imagem alternativa de produção. Não usar flags antigas como procedimento de recuperação.

## Evidências operacionais

A verificação local passou: API TypeScript 46 testes sem skips; mesma matriz PostgreSQL em três backends, incluindo MCP nativo; OpenAPI completo idêntico; três unidades de transporte Rust e a unidade do fragmento; clippy em todos os targets com avisos tratados como erro; 179 modelos web, 98 testes de runtime, 50 de CI, 45 de verificação, dois projetos de navegador com Next real, nove simulações Linux do dispatcher e parser Compose real. O build web e o pacote TypeScript com dependências somente de produção também passaram. CI do PR e publicação ainda estão pendentes.

Antes desta entrega, leituras autenticadas de Preferências, Produtos, Pedidos e Relatórios no navegador e no MCP retornaram JSON normalizado idêntico, com mesma empresa, titular e revisão de preferências. O MCP ainda usava os handlers antigos naquele momento; por isso essa igualdade, isoladamente, não comprova o novo encaminhamento.

A confirmação final exige a nova release saudável e `x-erp-backend: typescript` nos quatro caminhos pelo navegador e pelo MCP. SHA, CI e resultados dessa confirmação serão registrados após a publicação.
