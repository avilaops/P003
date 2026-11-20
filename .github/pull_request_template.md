<!--
Atenção: todo merge na `main` publica em produção (Release). Descreva o PR como se
fosse a nota de publicação e não apague as seções; escreva "não se aplica" quando for o caso.
-->

## O que muda e por quê

<!-- Em poucas linhas: o problema, a solução e quem é afetado. Link do pedido ou da conversa, se houver. -->

## Como foi verificado

<!-- Só o que foi de fato executado, com o resultado. Marque o que rodou. -->

- [ ] `pnpm --filter api-ts typecheck` e `pnpm --filter api-ts test` (mudanças na API)
- [ ] `node scripts/architecture/check.mjs` e `pnpm run test:architecture`
- [ ] `pnpm run test:verification`
- [ ] Testes do web (`apps/web`) / navegador
- [ ] Conferido na tela, no celular e no desktop (anexe prints se mudou interface)

Resultado e observações:

## Não verificado

<!-- O que NÃO foi testado e por quê (depende de deploy, dados reais, dispositivo...). Não deixe em branco: escreva "nada". -->

## Risco e reversão

- [ ] Muda banco de dados ou migração (descreva a ordem e se é reversível)
- [ ] Muda variáveis de ambiente, segredos ou o fluxo de deploy
- [ ] Muda contrato da API, `openapi.json` ou `architecture/structure.json` (regenerado, não editado à mão)
- [ ] Mexe em fiscal (NF-e, NFS-e, CT-e) ou financeiro

Como reverter se der errado:

## Notas para quem revisa

<!-- Por onde começar, decisões discutíveis, pontos que merecem atenção. -->
