import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { verifyBundle, type ValidatorReceipt } from "./validator-bundle.js";
import { validatorConfiguration } from "./validator-config.js";
import { BUNDLE_MAX, BUNDLE_TYPE, ContractSignatureValidationError, encodeRequest, POLICY_SHA256, requireWire, responseLength, unavailable,
  type EncodedRequest, type ValidatorContext, type ValidatorSigner, type WireInput } from "./validator-wire.js";

export { ContractSignatureValidationError, validValidatorCpf } from "./validator-wire.js";
export type { ValidatorContext, ValidatorSigner, ValidatorReceipt };

export interface ContractSignatureValidator {
  readonly policySha256: string;
  readonly trustBundleSha256: string;
  preflight(context: ValidatorContext, base: Buffer): Promise<ValidatorReceipt>;
  increment(context: ValidatorContext, base: Buffer, parent: Buffer, candidate: Buffer,
    signer: ValidatorSigner, previousSigners: readonly ValidatorSigner[]): Promise<ValidatorReceipt>;
}

function httpHeaders(raw: string[]) {
  requireWire(raw.length <= 64 && raw.length % 2 === 0);
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    const value = raw[i + 1]!;
    requireWire(/^[a-z0-9-]+$/.test(name) && /^[\x20-\x7e]*$/.test(value) && !(name in result));
    result[name] = value;
  }
  return result;
}

async function post(config: ReturnType<typeof validatorConfiguration>, request: EncodedRequest) {
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const outgoing = httpsRequest(new URL(request.target, config.origin), {
      method: "POST", headers: request.headers, ca: config.ca, rejectUnauthorized: true, minVersion: "TLSv1.2",
      agent: false, maxHeaderSize: 16 * 1024, signal: AbortSignal.timeout(55_000),
    }, resolve);
    outgoing.maxHeadersCount = 0;
    outgoing.on("error", reject);
    outgoing.end(request.frame);
  });
  try {
    requireWire(response.statusCode === 200);
    const headers = httpHeaders(response.rawHeaders);
    const length = responseLength(headers, BUNDLE_TYPE, BUNDLE_MAX);
    // Read once into exactly the authenticated protocol's declared size limit.
    const bundle = Buffer.allocUnsafe(length);
    let received = 0;
    for await (const chunk of response) {
      requireWire(Buffer.isBuffer(chunk) && received + chunk.length <= length);
      chunk.copy(bundle, received);
      received += chunk.length;
    }
    requireWire(response.complete && received === length);
    return verifyBundle(bundle, headers, request, config.key, config.trust, Date.now());
  } finally { response.destroy(); }
}

export function contractSignatureValidatorFromEnv(env: NodeJS.ProcessEnv = process.env): ContractSignatureValidator {
  try {
    const config = validatorConfiguration(env);
    async function validate(context: ValidatorContext, input: WireInput) {
      try {
        const request = encodeRequest(context, input, config.trust.sha256, config.key, randomUUID(), Math.floor(Date.now() / 1000));
        return await post(config, request);
      } catch (error) {
        if (error instanceof ContractSignatureValidationError) throw error;
        throw unavailable();
      }
    }
    return {
      policySha256: POLICY_SHA256,
      trustBundleSha256: config.trust.sha256,
      preflight: (context, base) => validate(context, { operation: "preflight", base }),
      increment: (context, base, parent, candidate, signer, previousSigners) =>
        validate(context, { operation: "increment", base, parent, candidate, signer, previousSigners }),
    };
  } catch { throw unavailable(); }
}
