import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import {
  ambiguousNumbers, checkCollectionBank, loadIssuedItem, markCollectionReview, processEvent,
  profileFields, rights, type ProfileRow,
} from "./collection-files.js"
import type { Headers } from "./collections.js"
import { conflict, missing, textField } from "./ledger.js"
import { parseSantander240 } from "./santander-240.js"

export const reviewCollectionEventSchema = z.strictObject({
  accountId: id,
  returnId: id,
  ordinal: z.number().int().min(1).max(2147483647),
  reason: textField(3, 300),
})

type ReviewInput = z.output<typeof reviewCollectionEventSchema>
type Original = {
  receivableId: string | null
  outcome: string
  content: string
  fileHash: string
  eventHash: string
  ourNumber: string
  resolved: boolean
}
type Outcome = { state: "registered" | "rejected" | "paid" | "review" | "duplicate"; reason: string | null }
const review = (reason: string): Outcome => ({ state: "review", reason })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

async function reevaluate(
  ctx: AuthorizedContext,
  input: ReviewInput,
  headers: Headers,
  original: Original,
  profile: ProfileRow,
): Promise<Outcome> {
  if (hash(original.content) !== original.fileHash) return review("O arquivo armazenado diverge do protocolo original")
  await checkCollectionBank(ctx, input.accountId, profile.profile)
  const parsed = parseSantander240(original.content, profile.profile)
  const event = parsed.events[input.ordinal - 1]
  if (!event || event.ourNumber !== original.ourNumber || hash(canonicalJson(event)) !== original.eventHash)
    return review("A ocorrência do arquivo diverge da evidência original")
  const item = await loadIssuedItem(ctx, profile.id, event.ourNumber)
  if (!item || item.receivable_id !== original.receivableId)
    return review("O título vinculado à ocorrência original não foi localizado")
  const result = await processEvent(
    ctx, headers, profile, item, event, original.eventHash, input.returnId,
    ambiguousNumbers(parsed.events).has(event.ourNumber), parsed.generatedOn,
  )
  // Uma ocorrência desconhecida na importação não pode ser vinculada a outro título pela revisão.
  return result.state === "unknown" ? review("Título desconhecido na reavaliação") : { state: result.state, reason: result.reason }
}

export async function reviewCollectionEvent(ctx: AuthorizedContext, input: ReviewInput, headers: Headers = {}) {
  rights(ctx, true)
  // Serialize with imports and other reviews before reading the effective outcome.
  const profile = (await ctx.client.query<ProfileRow>(
    `SELECT ${profileFields} FROM finance_collection_file_profiles
     WHERE tenant_id=$1 AND account_id=$2 AND id=(
       SELECT profile_id FROM finance_collection_returns WHERE tenant_id=$1 AND account_id=$2 AND id=$3
     ) FOR UPDATE`,
    [ctx.tenantId, input.accountId, input.returnId],
  )).rows[0]
  if (!profile) throw missing()
  const keys = [ctx.tenantId, input.accountId, input.returnId, input.ordinal]
  const original = (await ctx.client.query<Original>(
    `SELECT e.receivable_id AS "receivableId",e.outcome,
      f.content,f.sha256 AS "fileHash",e.event_sha256 AS "eventHash",e.our_number AS "ourNumber",
      EXISTS (SELECT FROM finance_collection_return_reviews r WHERE (r.tenant_id,r.return_id,r.ordinal) =
        (e.tenant_id,e.return_id,e.ordinal) AND r.state <> 'review') AS resolved
    FROM finance_collection_returns f JOIN finance_collection_return_events e
      ON (e.tenant_id,e.return_id,e.profile_id)=(f.tenant_id,f.id,f.profile_id)
    WHERE f.tenant_id=$1 AND f.account_id=$2 AND f.id=$3 AND e.ordinal=$4`, keys,
  )).rows[0]
  if (!original) throw missing()
  if (original.outcome !== "review" || original.resolved) throw conflict("A ocorrência não está pendente de conferência")

  let outcome: Outcome
  await ctx.client.query("SAVEPOINT cnab_reassessment")
  try {
    outcome = await reevaluate(ctx, input, headers, original, profile)
  } catch (error) {
    if (!(error instanceof Problem) || ![409, 422].includes(error.status)) throw error
    await ctx.client.query("ROLLBACK TO SAVEPOINT cnab_reassessment")
    outcome = review(error.title)
  }
  await ctx.client.query("RELEASE SAVEPOINT cnab_reassessment")
  if (outcome.state === "review" && original.receivableId)
    await markCollectionReview(ctx, profile.id, original.ourNumber, outcome.reason)
  const attempt = (await ctx.client.query<{
    id: string; state: string; reason: string | null; reviewReason: string; createdAt: string; createdBy: string
  }>(
    `INSERT INTO finance_collection_return_reviews(tenant_id,id,return_id,ordinal,state,reason,review_reason,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,state,reason,review_reason AS "reviewReason",created_at::text AS "createdAt",created_by AS "createdBy"`,
    [ctx.tenantId, randomUUID(), input.returnId, input.ordinal, outcome.state, outcome.reason, input.reason, ctx.authSubject],
  )).rows[0]!
  const { accountId, returnId, ordinal } = input
  return {
    id: attempt.id,
    result: { tenantId: ctx.tenantId, data: { ...attempt, accountId, returnId, ordinal } },
    details: { accountId, returnId, ordinal, state: outcome.state, reviewReason: input.reason },
  }
}
