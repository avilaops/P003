import { randomUUID } from "node:crypto"
import { lockSession, rights, sessionDetail, type Context } from "./read.js"
import { conflict, invalid, minor, type Open, type Movement, type Close } from "./schema.js"
import type { Revision } from "../../platform/revision.js"

export const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date"
export async function accounts(c: Context, ids: string[]) {
  const result=await c.client.query("SELECT id,account_type,status FROM financial_accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",[c.tenantId,ids])
  return new Map(result.rows.map(row=>[String(row.id),row]))
}
export async function accountBalance(c: Context,id: string) {
  const row=(await c.client.query("SELECT COALESCE(sum(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END),0) AS amount FROM financial_account_entries WHERE tenant_id=$1 AND account_id=$2",[c.tenantId,id])).rows[0]!
  return BigInt(String(row.amount))
}
export async function ledgerEntry(c: Context,account: string,value: bigint,direction: "credit"|"debit",reference: string,transfer: string|null=null) {
  const id=randomUUID()
  await c.client.query(`INSERT INTO financial_account_entries(id,tenant_id,account_id,transfer_id,direction,amount_cents,occurred_on,description,reference) VALUES($1,$2,$3,$4,$5,$6,${today},$7,$8)`,[id,c.tenantId,account,transfer,direction,value,`PDV ${reference}`,reference])
  return id
}
export async function bumpSession(c: Context,id:string) {
  await c.client.query("UPDATE pos_sessions SET revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])
}
export async function open(c: Context,input: Open) {
  const account=(await accounts(c,[input.cashAccountId])).get(input.cashAccountId)
  if (account?.status!=="active" || account.account_type!=="cash") conflict("Cadastre ou selecione uma conta financeira ativa do tipo Caixa para abrir o PDV")
  if (await accountBalance(c,input.cashAccountId)<minor(input.openingAmount)) conflict("O fundo de abertura excede o saldo da conta caixa")
  const existing=(await c.client.query("SELECT id FROM pos_sessions WHERE tenant_id=$1 AND status='open' AND (lower(register)=lower($2) OR cash_account_id=$3)",[c.tenantId,input.register,input.cashAccountId])).rows[0]
  if (existing) conflict("Este caixa ou conta já tem sessão aberta")
  const id=randomUUID()
  await c.client.query("INSERT INTO pos_sessions(tenant_id,id,register,cash_account_id,opening_cents,opened_by) VALUES($1,$2,$3,$4,$5,$6)",[c.tenantId,id,input.register,input.cashAccountId,minor(input.openingAmount),c.authSubject])
  return { ...rights(c),data:await sessionDetail(c,id) }
}
export async function movement(c: Context,id:string,revision:Revision,input:Movement) {
  const cash=await lockSession(c,id,revision)
  const supply=input.direction==="supply", other=supply?input.sourceAccountId:input.targetAccountId
  if (!other || (supply?input.targetAccountId:input.sourceAccountId) || other===cash) invalid("Informe a conta de contrapartida, diferente da conta do caixa")
  const from=supply?other:cash, to=supply?cash:other, amount=minor(input.amount)
  if (amount<=0n) invalid("Valor do movimento deve ser positivo")
  const eligible=await accounts(c,[from,to])
  if ([from,to].some(account=>eligible.get(account)?.status!=="active")) conflict("Selecione duas contas ativas desta empresa")
  if ((await c.client.query("SELECT id FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open'",[c.tenantId,other])).rows.length) conflict("Selecione uma conta de contrapartida sem caixa aberto")
  if (await accountBalance(c,from)<amount) conflict("Saldo financeiro insuficiente na conta de origem")
  if (!supply && minor((await sessionDetail(c,id)).totals.expectedCash!)<amount) conflict("Sangria excede o dinheiro esperado no caixa")
  const transfer=randomUUID(), movementId=randomUUID()
  await c.client.query(`INSERT INTO financial_account_transfers(id,tenant_id,source_account_id,target_account_id,amount_cents,occurred_on,description,reference) VALUES($1,$2,$3,$4,$5,${today},$6,$7)`,[transfer,c.tenantId,from,to,amount,input.reason,movementId])
  await ledgerEntry(c,from,amount,"debit",movementId,transfer)
  await ledgerEntry(c,to,amount,"credit",movementId,transfer)
  await c.client.query("INSERT INTO pos_cash_movements(tenant_id,id,session_id,direction,amount_cents,reason,transfer_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[c.tenantId,movementId,id,input.direction,amount,input.reason,transfer])
  await bumpSession(c,id)
  return {...rights(c), data:await sessionDetail(c,id)}
}
export async function close(c: Context,id:string,revision:Revision,input:Close) {
  await lockSession(c,id,revision)
  const expected=(await sessionDetail(c,id)).totals.expectedCash
  if (expected!==input.countedCash && !input.reason) invalid("Justifique a diferença entre dinheiro contado e esperado")
  await c.client.query("UPDATE pos_sessions SET status='closed',closed_at=clock_timestamp(),counted_cents=$3,close_reason=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,minor(input.countedCash),input.reason])
  return {...rights(c),canEdit:false,data:await sessionDetail(c,id)}
}
