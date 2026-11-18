import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Problem } from "../../platform/problem.js";
import { validDocument } from "../parties/schema.js";

export type ValidatorContext = { tenantId: string; envelopeId: string; documentId: string };
export type ValidatorSigner = { participantId: string; expectedCpf: string };
export type WireInput = { operation: "preflight"; base: Buffer }
  | { operation: "increment"; base: Buffer; parent: Buffer; candidate: Buffer;
      signer: ValidatorSigner; previousSigners: readonly ValidatorSigner[] };
export type ValidatorKey = { keyId: string; secret: Buffer };
export const POLICY_SHA256 = "88e36db3af86abbf7df5bb49794ad7f50a161aab2eb1827980a62b640825013e";
export const BUNDLE_TYPE = "application/vnd.avila.contract-validation-bundle;version=1";
export const REPORT_TYPE = "application/vnd.avila.contract-validation-result+json;version=1";
export const MIB = 1024 * 1024;
export const BUNDLE_MAX = 40 * MIB;
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export class ContractSignatureValidationError extends Problem {
  constructor(readonly statusCode: 422 | 503, code: string, message: string) {
    super(statusCode, code, message);
  }
}

export function requireWire(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid_validation_protocol");
}

export function unavailable() {
  return new ContractSignatureValidationError(503, "contract_validator_unavailable",
    "O serviço de validação de assinaturas está indisponível.");
}

function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new ContractSignatureValidationError(422, "invalid_signature_input",
    "Confira os documentos e os participantes da sequência de assinaturas.");
}

export function canonical(value: unknown, depth = 0): string {
  requireWire(depth <= 16);
  if (Array.isArray(value)) return "[" + value.map(item => canonical(item, depth + 1)).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonical(item, depth + 1)).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function readCanonical(raw: Buffer): unknown {
  const value: unknown = JSON.parse(raw.toString("utf8"));
  // The gateway emits canonical ASCII. Re-encoding also rejects duplicate JSON keys.
  requireWire(Buffer.from(canonical(value)).equals(raw));
  return value;
}

export function responseLength(headers: Record<string, string>, mediaType: string, limit: number) {
  const length = Number(headers["content-length"]);
  requireWire(headers["content-type"] === mediaType && Number.isSafeInteger(length) && length > 0
    && length <= limit && String(length) === headers["content-length"]
    && !("content-encoding" in headers) && !("transfer-encoding" in headers));
  return length;
}

function uuid(value: string) {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}
export function validValidatorCpf(value: string) {
  return typeof value === "string" && validDocument(value, "fisica");
}

function person(value: ValidatorSigner): ValidatorSigner {
  requireInput(value && uuid(value.participantId) && validValidatorCpf(value.expectedCpf));
  return { participantId: value.participantId, expectedCpf: value.expectedCpf };
}

export function encodeRequest(context: ValidatorContext, input: WireInput, trustBundleSha256: string,
  key: ValidatorKey, requestId: string, sentAt: number) {
  requireInput(uuid(context.documentId) && uuid(context.tenantId) && uuid(context.envelopeId));
  requireWire(uuid(requestId));
  const { base } = input;
  requireInput(Buffer.isBuffer(base) && base.length > 0 && base.length <= 20 * MIB);
  const parts = [{ name: "base", bytes: base }];
  let signer: ValidatorSigner | null = null;
  let previousSigners: ValidatorSigner[] = [];
  if (input.operation === "increment") {
    const { parent, candidate } = input;
    requireInput(Array.isArray(input.previousSigners) && input.previousSigners.length <= 9
      && Buffer.isBuffer(parent) && Buffer.isBuffer(candidate) && candidate.length <= 32 * MIB
      && parent.length < candidate.length && candidate.subarray(0, parent.length).equals(parent)
      && parent.subarray(0, base.length).equals(base)
      && (input.previousSigners.length ? parent.length > base.length : parent.length === base.length));
    signer = person(input.signer);
    previousSigners = input.previousSigners.map(person);
    const people = [...previousSigners, signer];
    requireInput(new Set(people.map(p => p.expectedCpf)).size === people.length
      && new Set(people.map(p => p.participantId)).size === people.length);
    parts.push({ name: "parent", bytes: parent }, { name: "candidate", bytes: candidate });
  }
  const { tenantId, envelopeId, documentId } = context;
  const metadata = { schemaVersion: "avila-contract-request/1", requestId, tenantId, envelopeId, documentId,
    operation: input.operation, policySha256: POLICY_SHA256, trustBundleSha256, signer, previousSigners,
    parts: parts.map(({ name, bytes }) => ({ name, length: bytes.length, sha256: sha256(bytes) })) };
  const header = Buffer.from(canonical(metadata));
  requireWire(header.length <= 32 * 1024);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  const frame = Buffer.concat([Buffer.from("AVILA-CV1\n"), size, header, ...parts.map(p => p.bytes)]);
  const digest = sha256(frame);
  const target = "/internal/v1/" + input.operation;
  const message = ["AVILA-CV-AUTH/1", "POST", target, key.keyId, sentAt, requestId, digest, frame.length, ""].join("\n");
  const mac = createHmac("sha256", key.secret).update(message).digest("hex");
  const headers = { authorization: "HMAC-SHA256 " + key.keyId + ":" + mac,
    "content-type": "application/vnd.avila.contract-validation+octet-stream;version=1",
    "content-length": String(frame.length), "x-validation-time": String(sentAt),
    "x-validation-request-id": requestId, "x-validation-content-sha256": digest };
  return { frame, digest, metadata, sentAt, target, headers };
}

export type EncodedRequest = ReturnType<typeof encodeRequest>;

export function authenticateResponse(raw: Buffer, headers: Record<string, string>, mediaType: string,
  limit: number, request: EncodedRequest, key: ValidatorKey) {
  requireWire(raw.length === responseLength(headers, mediaType, limit));
  const digest = sha256(raw);
  requireWire(headers["x-validation-response-sha256"] === digest);
  const message = ["AVILA-CV-RESPONSE/1", key.keyId, request.metadata.requestId, request.digest,
    digest, raw.length, ""].join("\n");
  const expectedMac = createHmac("sha256", key.secret).update(message).digest("hex");
  const expected = Buffer.from("HMAC-SHA256 " + key.keyId + ":" + expectedMac);
  const received = Buffer.from(headers["x-validation-response-mac"] ?? "");
  requireWire(received.length === expected.length && timingSafeEqual(received, expected));
  return digest;
}
