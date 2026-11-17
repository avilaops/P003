# API TypeScript • conclusão da transição dos quatro módulos

## Escopo e estado verificado

O usuário escolheu concluir Preferências, Cadastros, Vendas e Relatórios, sem abrir outra frente funcional. A release `3c00410091fc30e6191f301f2b762740643a2772` está saudável com os quatro módulos ativos. Em 17/11/2026, a sessão autenticada do navegador retornou 200 e empresa correta para preferências, produtos, pedidos e relatórios personalizados. Seus JSONs normalizados e o ETag de preferências coincidiram com o MCP Rust; o titular das preferências também coincidiu. A verificação fez somente leituras e não exportou credenciais ou registros.

O MCP atual é nativo da API Rust. Ele valida seus próprios tokens OAuth, monta a requisição tipada e injeta uma identidade verificada no router de negócio. Retirar os handlers antigos sem tratar esse caminho quebraria as ferramentas conectadas.

## Decisão técnica

Conservar o protocolo MCP, OAuth, catálogo e validação de argumentos existentes. Trocar os handlers HTTP dos recursos migrados por um encaminhamento de transporte para a API TypeScript. Navegador e MCP passam a executar a mesma implementação de negócio. Demais recursos permanecem no router original.

Requisições HTTP usuais conservam o Bearer Auth e o corpo original. O despacho MCP recebe uma extensão interna tipada, criada exclusivamente depois de validar sua credencial. O encaminhamento usa um endpoint privado TypeScript, que revalida o token MCP no PostgreSQL, seu recurso, validade, revogação e escopo. Não confiar em cabeçalhos que declarem identidade; não criar senha compartilhada nem converter tokens MCP em tokens do Auth.

Somente após essa validação, um contexto assíncrono interno fornece a identidade à requisição injetada no mesmo Fastify. Isolar identidades concorrentes. A operação continua abrindo sua transação com RLS, carregando permissões e usando as mesmas revisões, auditoria e idempotência. O endpoint privado aceita apenas métodos/recursos migrados e cabeçalhos permitidos; não permite URLs externas ou despacho recursivo.

## Retirada da implementação antiga

Os handlers de negócio Rust migrados ficam disponíveis apenas em testes e no recurso de compilação explícito `migration-reference`. A compilação de produção usa encaminhamento, não regras de negócio duplicadas. Tipos/utilitários compartilhados com os módulos restantes permanecem quando necessários.

Conservar o contrato OpenAPI e o catálogo MCP por um fragmento versionado das operações migradas, comparado em teste com as anotações da implementação de referência. O executor de contratos compila explicitamente a referência; testes do encaminhamento exercitam a compilação de produção.

## Runtime e retorno

A API TypeScript torna-se dependência permanente da aplicação para esses quatro módulos. Configuração, Compose e supervisor devem iniciá-la mesmo sem uma seleção gradual parcial. A saúde pública considera as duas APIs. O gateway Rust usa origem HTTPS ou HTTP em loopback, sem credenciais na URL, timeout e sem redirecionamento ou nova tentativa.

Após encerrar a seleção por módulo, o retorno é a release anterior validada, mantendo banco e comandos persistidos. Documentar essa mudança operacional; não apresentar a remoção de um módulo da variável antiga como retorno para regras Rust que já não estão na imagem nova. Manter a release anterior e sua configuração para recuperação.

## Critérios de conclusão

• Matriz HTTP existente passa contra TypeScript e a referência Rust explícita.
• MCP autenticado exercita os quatro módulos pela implementação TypeScript, com escopos, revogação, isolamento de empresa, ETag e comando preservados.
• Nenhuma credencial, cliente ou conexão MCP precisa ser recriada.
• O encaminhamento não repete comandos após erro, timeout ou perda de resposta.
• Contrato OpenAPI, catálogo e recursos fora do escopo permanecem compatíveis.
• Build de produção exclui os handlers de negócio antigos desses recursos.
• CI, release, saúde e conferências autenticadas em produção passam; documentação e memória registram o resultado e seus limites.

Fiscal, Financeiro, Estoque, Compras, Contratos, documentos/e-mail e o outro worktree de documentos ficam fora desta alteração.
