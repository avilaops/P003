# Envio financeiro por SMTP • desenho aprovado pelo escopo do usuário

O usuário confirmou envio nas telas de pedido, orçamento, contrato e financeiro, e escolheu ambos os contextos financeiros: título/recebível e relatório agregado. Os três primeiros já possuem fluxo SMTP; completar o financeiro sem alterar os demais.

Usar SMTP central, destinatário/assunto/mensagem conferidos, PDF A4 nativo do servidor e histórico. Não enviar e-mail real durante validação. Não aceitar HTML, URLs ou anexos arbitrários do navegador. O envio não altera saldos, pagamentos ou revisão financeira. PDF de título informa valor, vencimento, recebido declarado, saldo e situação; não apresenta recebimento manual como conciliação bancária ou quitação integral. Relatório inclui as primeiras 100 contas de cada fonte, com ordenação e limites explícitos, indicadores e todas as linhas desse recorte.

## Contrato entre servidor e tela

GET/POST `/api/v1/receivables/{id}/email` e GET/POST `/api/v1/financial-report/email`. GET devolve ETag numérico e `{tenantId,canSend,emailReady,recipient,documentTitle,scope,recordCount,snapshotHash,deliveries}`. `recipient` é o cadastro do cliente para título, null para relatório. `deliveries`: `{id,status,recipient,createdAt}`. POST recebe somente `{recipient,subject,message,snapshotHash}`, `If-Match` e `Idempotency-Key`; devolve `{tenantId,revision,delivery}` e ETag. Para relatório, revisão numérica fixa 1 mais hash SHA256 obrigatório do snapshot autoritativo; título usa sua revisão e hash. Hash não inclui instante de emissão, credenciais ou histórico de envios.

Permissões: título GET exige `finance.receivables.read`, envio exige manage; relatório exige read de recebíveis e pagáveis, envio exige manage de ambos. Conferir tenant, permissões e estado no servidor; nunca exigir permissão comercial para documento financeiro. Cancelamento impede envio do título.

Persistir intenção uncertain, comando idempotente, snapshot, hash e bytes PDF antes de cruzar SMTP. Replay não reenvia e funciona mesmo após atualização das fontes; reuso de chave com outro payload conflita. Bloquear novo comando enquanto resultado estiver incerto no mesmo contexto. Rejeição SMTP explícita vira failed; perda de transporte permanece uncertain. RLS forçada e chaves compostas por tenant. Mensagem bruta do provedor não é exposta.

O compositor permanece montado ao fechar/reabrir durante comando; campos ficam bloqueados e a consulta de resultado usa a mesma chave. Divergência 412 pede atualização e nova conferência; sem SMTP ou permissão não envia. A identidade e o hash do relatório são consultados ao abrir o envio, com escopo visível. Documentos são gerados exclusivamente desse snapshot do servidor.
