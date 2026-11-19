# PDV, fechamento e histórico

[Todas as telas](../../../README.md) • [Vendas](../README.md)

Operar as vendas do PDV e consultar seu fechamento e histórico.

**Onde acessar** • `/vendas/pdv`, `/vendas/pdv/fechamento`, `/vendas/pdv/historico`.

## O que aparece na tela

- Identificação do caixa, conta financeira e fundo de abertura
- Produtos, quantidades, UF e condição de contribuinte
- Cliente, quando informado, e pagamentos
- Suprimentos, sangrias, dinheiro esperado e contado
- Fechamento e histórico

## O que você pode fazer

- Abrir uma sessão de caixa
- Conferir produtos e pagamentos e concluir a venda
- Registrar suprimento ou sangria com motivo e conta de origem ou destino
- Conferir o dinheiro contado e fechar a sessão
- Consultar o histórico e cancelar uma venda permitida

## Regras e limites

O fundo de abertura exige saldo real suficiente na conta caixa. A venda usa os preços comerciais calculados pelo servidor, exige estoque disponível e registra a saída de produtos e os lançamentos financeiros internos. Esses registros não comprovam liquidação em banco ou adquirente.

Fechar a sessão e cancelar uma venda exigem permissões próprias. Diferença no fechamento exige justificativa. O cancelamento só ocorre uma vez e precisa de sessão aberta e saldos suficientes para o estorno. A autorização de NFC-e segue um fluxo fiscal separado.

## Primeira utilização e visibilidade

Cadastre uma conta financeira ativa do tipo Caixa e confira o saldo disponível para o fundo de abertura. O menu Vendas tem uma entrada PDV. Dentro dela, as abas Frente de caixa, Fechamento do caixa e Histórico dos caixas abrem as três operações, que também aparecem na busca e no índice completo. Em Preferências → Vendas → Frente de caixa, um administrador escolhe se o PDV fica disponível para a empresa. O caixa vem habilitado por padrão. O histórico permite consultar sessões por situação, registro e intervalo de datas. Um erro de consulta permite tentar novamente e apresenta o identificador fornecido pela API.

## Referências para manutenção

Fluxo conferido na API TypeScript, no PostgreSQL local e no Chromium em 18/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [pos-access](../../../../apps/web/src/features/pos/pos-access.tsx)
- [Operações e condições do PDV](../../../../apps/api-ts/src/modules/pos/routes.ts)
- [Conciliação de sessão, estoque e financeiro](../../../../apps/api-ts/test/pos-postgres.test.ts)
