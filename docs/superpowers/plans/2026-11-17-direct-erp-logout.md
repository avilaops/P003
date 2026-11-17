# ERP e Auth • saída direta

Resultado solicitado: sair do ERP encerra a sessão e termina em `https://avilaops.com/`, sem a tela de confirmação do Auth.

1. O POST inicial do ERP continua exigindo a origem do próprio ERP e cria o marcador cifrado com validade curta.
2. A continuação valida o marcador e envia automaticamente um formulário POST ao endpoint de saída do Auth, com CSP, nonce e política de referência que preserva a origem do formulário.
3. O Auth admite esse POST sem confirmação somente para `erp-next`, origem exata `https://erp.avilaops.com`, issuer de produção e callback exato já cadastrado. Cliente ativo e autorização do callback são revalidados antes dos efeitos. GET e origens externas não encerram sessão.
4. O callback do ERP consome o marcador e redireciona ao site fixo. Nenhum destino vem da requisição do usuário.
5. Verificar os casos de origem/cliente/revogação no Auth e o percurso do navegador no ERP, incluindo cookie e método POST. Integrar e publicar sem cancelar a publicação comercial em andamento.

As alterações do Auth ficam em worktree isolado; arquivos preexistentes modificados no checkout principal são preservados. A atualização de dependências Prisma já está na main do Auth no commit 1fe4ad7.
