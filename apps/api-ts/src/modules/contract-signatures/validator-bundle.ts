import { z } from "zod";
import type { ApprovedTrust } from "./validator-config.js";
import { verifyReport, type EvidenceHashes } from "./validator-report.js";
import { authenticateResponse, BUNDLE_MAX, BUNDLE_TYPE, MIB, readCanonical, REPORT_TYPE, requireWire, sha256,
  type EncodedRequest, type ValidatorKey } from "./validator-wire.js";

const magic = Buffer.from("AVILA-CVB1\n");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fixed = ["report", "rootsPem", "intermediatesPem"] as const;
const evidenceTypes = ["certificates", "crls", "ocsps"] as const;
const limits = { report: 256 * 1024, rootsPem: 4 * MIB, intermediatesPem: 4 * MIB,
  certificates: 256 * 1024, crls: 8 * MIB, ocsps: 256 * 1024 };
const counts = { certificates: 64, crls: 16, ocsps: 16 };
const schema = z.strictObject({ schemaVersion: z.literal("avila-contract-bundle/1"), trustProfile: z.literal("icp_brasil"),
  evidenceSetSha256: hash, responseHeaders: z.strictObject({ "content-type": z.string(), "content-length": z.string(),
    "x-validation-response-sha256": hash, "x-validation-response-mac": z.string() }),
  parts: z.array(z.strictObject({ name: z.enum([...fixed, ...evidenceTypes]), index: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(), sha256: hash })).min(3).max(99) });

export function verifyBundle(bundle: Buffer, headers: Record<string, string>, request: EncodedRequest,
  key: ValidatorKey, trust: ApprovedTrust, now: number) {
  const bundleSha256 = authenticateResponse(bundle, headers, BUNDLE_TYPE, BUNDLE_MAX, request, key);
  requireWire(bundle.length > magic.length + 4 && bundle.subarray(0, magic.length).equals(magic));
  const size = bundle.readUInt32BE(magic.length);
  let offset = magic.length + 4 + size;
  requireWire(size > 0 && size <= 32 * 1024 && offset < bundle.length);
  const metadata = schema.parse(readCanonical(bundle.subarray(magic.length + 4, offset)));
  const evidence: EvidenceHashes = { certificates: new Set(), crls: new Set(), ocsps: new Set() };
  let report = Buffer.alloc(0) as Buffer;
  let evidenceBytes = 0;
  let lastGroup = 0;
  for (const [position, part] of metadata.parts.entries()) {
    const { name, length, index } = part;
    requireWire(length <= limits[name] && (length > 0 || name === "intermediatesPem") && offset + length <= bundle.length);
    const bytes = bundle.subarray(offset, offset + length);
    requireWire(sha256(bytes) === part.sha256);
    offset += length;
    if (position < 3) {
      requireWire(name === fixed[position] && index === 0);
      if (name === "report") report = bytes;
      else if (name === "rootsPem") requireWire(part.sha256 === trust.rootsPemSha256);
      else requireWire(part.sha256 === trust.intermediatesPemSha256);
    } else {
      requireWire(name === "certificates" || name === "crls" || name === "ocsps");
      const group = evidenceTypes.indexOf(name);
      requireWire(group >= lastGroup && index === evidence[name].size && index < counts[name] && !evidence[name].has(part.sha256));
      lastGroup = group;
      evidence[name].add(part.sha256);
      evidenceBytes += length;
      requireWire(evidenceBytes <= 32 * MIB);
    }
  }
  requireWire(offset === bundle.length && request.metadata.trustBundleSha256 === trust.sha256);
  authenticateResponse(report, metadata.responseHeaders, REPORT_TYPE, limits.report, request, key);
  const verified = verifyReport(report, request, now, evidence, metadata.evidenceSetSha256);
  const responseHeaders = Object.fromEntries(["content-type", "content-length", "x-validation-response-sha256", "x-validation-response-mac"]
    .map(name => [name, headers[name]!]));
  const { tenantId, envelopeId, documentId, signer, parts } = request.metadata;
  const binding = { tenantId, envelopeId, documentId, participantId: signer?.participantId ?? null,
    baseSha256: parts[0]!.sha256, parentSha256: (parts[1] ?? parts[0])!.sha256, candidateSha256: (parts[2] ?? parts[0])!.sha256 };
  return { ...verified, bundleSha256, bundle, policySha256: request.metadata.policySha256,
    trustBundleSha256: trust.sha256, responseHeaders, requestSha256: request.digest, binding };
}
export type ValidatorReceipt = ReturnType<typeof verifyBundle>;
