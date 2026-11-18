import { z } from "zod";
import { canonical, ContractSignatureValidationError, readCanonical, requireWire, sha256,
  type EncodedRequest } from "./validator-wire.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().max(64).regex(/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/);
const verdict = z.enum(["accepted", "invalid", "unsupported", "indeterminate"]);
const code = z.string().regex(/^[a-z_]{1,80}$/);
const check = z.strictObject({ name: code, verdict, reason: code, evidenceHashes: z.array(hash).max(128) });
const common = { verdict, trustProfile: z.literal("icp_brasil"), longTermValidation: z.literal("not_established"),
  engine: z.strictObject({ validator: version, pyHanko: version, certvalidator: version }), checks: z.array(check).max(32) };
const context = { documentId: z.string(), policySha256: hash, trustBundleSha256: hash };
const preflight = z.strictObject({ ...common, schemaVersion: z.literal("avila-contract-preflight/1"),
  binding: z.strictObject({ ...context, checkedAt: z.string(), baseSha256: hash }),
  baseline: z.strictObject({ ...context, baseSha256: hash, baseSize: z.number().int().positive(),
    signatures: z.array(z.strictObject({ cmsSha256: hash, certificateSha256: hash, fieldSha256: hash })).max(32) }).nullable() });
const increment = z.strictObject({ ...common, schemaVersion: z.literal("avila-contract-validation/1"),
  binding: z.strictObject({ ...context, checkedAt: z.string(), participantId: z.string(), parentSha256: hash, candidateSha256: hash }),
  timestampStatus: z.enum(["absent", "unsupported", "invalid"]) });
const wrapper = z.strictObject({ schemaVersion: z.literal("avila-contract-response/1"),
  requestId: z.string(), tenantId: z.string(), envelopeId: z.string(), documentId: z.string(),
  operation: z.enum(["preflight", "increment"]), requestSha256: hash, checkedAt: z.string(), reportSha256: hash,
  report: z.discriminatedUnion("schemaVersion", [preflight, increment]) });

function validateTime(stamp: string, now: number, sentAt: number) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{6}))?Z$/.exec(stamp);
  requireWire(match && match[2] !== "000000");
  const seconds = Date.parse(match[1] + "Z");
  requireWire(Number.isFinite(seconds) && new Date(seconds).toISOString().slice(0, 19) === match[1]);
  const micros = seconds * 1000 + Number(match[2] ?? 0);
  for (const difference of [now * 1000 - micros, micros - sentAt * 1_000_000]) {
    requireWire(difference >= -5_000_000 && difference <= 60_000_000);
  }
}

export type EvidenceHashes = { certificates: Set<string>; crls: Set<string>; ocsps: Set<string> };

export function verifyReport(raw: Buffer, request: EncodedRequest, now: number, evidence: EvidenceHashes, evidenceSetSha256: string) {
  const parsed = wrapper.parse(readCanonical(raw));
  const { report, checkedAt, reportSha256 } = parsed;
  const meta = request.metadata;
  requireWire(parsed.requestId === meta.requestId && parsed.tenantId === meta.tenantId && parsed.envelopeId === meta.envelopeId
    && parsed.documentId === meta.documentId && parsed.operation === meta.operation && parsed.requestSha256 === request.digest
    && sha256(canonical(report)) === reportSha256);
  validateTime(checkedAt, now, request.sentAt);
  requireWire(report.binding.checkedAt === checkedAt && report.binding.documentId === meta.documentId
    && report.binding.policySha256 === meta.policySha256 && report.binding.trustBundleSha256 === meta.trustBundleSha256);
  let required: string[];
  let hasBaseline = true;
  if (report.schemaVersion === "avila-contract-preflight/1") {
    const base = meta.parts[0]!;
    requireWire(meta.operation === "preflight" && report.binding.baseSha256 === base.sha256);
    const baseline = report.baseline;
    hasBaseline = baseline !== null;
    if (baseline) requireWire(baseline.documentId === meta.documentId && baseline.baseSha256 === base.sha256
      && baseline.baseSize === base.length && baseline.policySha256 === meta.policySha256
      && baseline.trustBundleSha256 === meta.trustBundleSha256);
    required = ["binding", "baseline", "format"];
  } else {
    requireWire(meta.operation === "increment" && report.binding.participantId === meta.signer?.participantId
      && report.binding.parentSha256 === meta.parts[1]!.sha256 && report.binding.candidateSha256 === meta.parts[2]!.sha256);
    required = ["binding", "increment", "baseline", "identity", "chain", "revocation",
      "prior_signatures", "modifications", "coverage", "algorithms"];
  }
  const checks = new Map(report.checks.map(item => [item.name, item]));
  requireWire(checks.size === report.checks.length);
  const inventory = checks.get("evidence_set");
  const manifest = { observedAt: checkedAt, certificates: [...evidence.certificates].sort(),
    crls: [...evidence.crls].sort(), ocsps: [...evidence.ocsps].sort() };
  requireWire(sha256(canonical(manifest)) === evidenceSetSha256 && inventory?.verdict === "accepted"
    && inventory.reason === "typed_evidence_set_bound" && inventory.evidenceHashes.length === 1
    && inventory.evidenceHashes[0] === evidenceSetSha256);
  const available = new Set([...manifest.certificates, ...manifest.crls, ...manifest.ocsps]);
  for (const item of report.checks) {
    if (item.name !== "evidence_set") requireWire(item.evidenceHashes.every(h => available.has(h)));
  }
  const states = new Set(report.checks.map(item => item.verdict));
  let computed: z.infer<typeof verdict> = "accepted";
  if (states.has("invalid")) computed = "invalid";
  else if (states.has("unsupported")) computed = "unsupported";
  else if (!hasBaseline || states.has("indeterminate") || required.some(name => !checks.has(name))) computed = "indeterminate";
  requireWire(report.verdict === computed);
  if (computed !== "accepted") {
    throw new ContractSignatureValidationError(422, "contract_signature_" + computed,
      "O validador ICP-Brasil não confirmou a assinatura ou o documento apresentado.");
  }
  if (report.schemaVersion === "avila-contract-validation/1") {
    const chain = checks.get("chain")!;
    const revocation = checks.get("revocation")!;
    requireWire(report.timestampStatus === "absent" && chain.reason === "chain_and_revocation_validated"
      && revocation.reason === chain.reason && chain.evidenceHashes.length > 0 && revocation.evidenceHashes.length > 0
      && chain.evidenceHashes.every(h => evidence.certificates.has(h))
      && revocation.evidenceHashes.every(h => evidence.crls.has(h) || evidence.ocsps.has(h)));
  }
  return { checkedAt, reportSha256, verdict: computed, evidenceSetSha256 };
}
