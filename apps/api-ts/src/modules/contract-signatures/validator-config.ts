import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { canonical, MIB, requireWire, sha256, type ValidatorKey } from "./validator-wire.js";

// Reviewed public manifest from contract-signature-validator/trust_registry.json.
// The interoperability tests check its exact digest and every approved root.
export const REGISTRY_SHA256 = "7780e435da30c445e5a927f894640a0c09b5eca2fabbf3c4b068c7682350d5bc";
export const ICP_ROOT_HASHES = [
  "f0c15afd258fb674e7a96e1a50ff873149364b9ec70d4d93c7a9f1eb6060d020",
  "caa53fc6091c6951887c976e378f6ef89aa6377c55d97b6475422b71ed7e9b17",
  "3bdb9b509352f1d3d71c2bf64d9a38a4e6cebda27809d77f7ac476cbde6e314a",
  "5657e70580eb678983f3ed7dfce091d84cae6549389a47fccda8d0e4dc2cf576",
  "6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6",
  "1406710058180fa4081aab3f246f1702429c552a11fa3143b84c88cb3ab8e5e7",
  "d8478e37ce19c690cf657381e68fe600e4e1a042536830f06847e03e554c4b01",
  "2b07d0bc02c4a6e0478ed22d0d99e8f97e1827b269097696a7feb6aad30c3ac8",
];

export function readConfigurationFile(path: string, max: number, privateKeyring = false) {
  const before = lstatSync(path);
  requireWire(before.isFile());
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = fstatSync(fd);
    requireWire(stats.isFile() && stats.dev === before.dev && stats.ino === before.ino && stats.size <= max);
    if (privateKeyring && process.platform !== "win32") {
      requireWire((stats.mode & 0o077) === 0 && stats.uid === process.getuid?.());
    }
    const data = Buffer.alloc(stats.size + 1);
    let used = 0;
    while (used < data.length) {
      const n = readSync(fd, data, used, data.length - used, null);
      if (n === 0) break;
      used += n;
    }
    requireWire(used === stats.size);
    return data.subarray(0, used);
  } finally { closeSync(fd); }
}

function certificates(input: Buffer) {
  const raw = input.toString("utf8");
  const block = /-----BEGIN CERTIFICATE-----([a-zA-Z0-9+/=\r\n\t ]+)-----END CERTIFICATE-----/g;
  requireWire(!raw.replace(block, "").trim());
  const certs = new Map<string, Buffer>();
  let count = 0;
  for (const match of raw.matchAll(block)) {
    const base64 = match[1]!.replace(/\s/g, "");
    const der = Buffer.from(base64, "base64");
    requireWire(++count <= 256 && der.length > 0 && der.length <= 256 * 1024 && der.toString("base64") === base64);
    const cert = new X509Certificate(der);
    requireWire(cert.ca && cert.raw.equals(der));
    certs.set(sha256(der), der);
  }
  const pem = [...certs.values()].sort(Buffer.compare).map(der =>
    "-----BEGIN CERTIFICATE-----\n" + der.toString("base64").match(/.{1,64}/g)!.join("\n") + "\n-----END CERTIFICATE-----\n").join("");
  return { hashes: [...certs.keys()].sort(), pemSha256: sha256(pem) };
}

export function approvedTrust(roots: Buffer, intermediates: Buffer) {
  requireWire(roots.length + intermediates.length <= 4 * MIB);
  const r = certificates(roots);
  const i = certificates(intermediates);
  requireWire(r.hashes.length > 0 && r.hashes.every(h => ICP_ROOT_HASHES.includes(h)));
  return { sha256: sha256(canonical({ profile: "icp_brasil", registrySha256: REGISTRY_SHA256,
    roots: r.hashes, intermediates: i.hashes })), rootsPemSha256: r.pemSha256, intermediatesPemSha256: i.pemSha256 };
}
export type ApprovedTrust = ReturnType<typeof approvedTrust>;

function readKeyring(raw: Buffer, active: string): ValidatorKey {
  const text = raw.toString("utf8");
  const ring = z.strictObject({ schemaVersion: z.literal("avila-validator-keys/1"),
    keys: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), z.string()) }).parse(JSON.parse(text));
  const keys = Object.entries(ring.keys);
  // Count actual property tokens, including escaped spellings, before using JSON.parse's object.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}:,]/g) ?? [];
  requireWire(tokens.filter(t => t === ":").length === 2 + keys.length && keys.length >= 1 && keys.length <= 2);
  let selected: Buffer | undefined;
  for (const [id, base64] of keys) {
    const secret = Buffer.from(base64, "base64");
    requireWire(secret.length >= 32 && secret.length <= 64 && secret.toString("base64") === base64);
    if (active === id) selected = secret;
    else secret.fill(0);
  }
  requireWire(selected);
  return { keyId: active, secret: selected };
}

export function validatorConfiguration(env: NodeJS.ProcessEnv) {
  const required = (suffix: string) => {
    const value = env["ERP_CONTRACT_VALIDATOR_" + suffix];
    requireWire(value?.trim());
    return value!;
  };
  const origin = new URL(required("URL"));
  requireWire(origin.protocol === "https:" && origin.pathname === "/" && !origin.username
    && !origin.password && origin.href === origin.origin + "/");
  const ca = readConfigurationFile(required("TLS_CA_FILE"), 256 * 1024);
  requireWire(certificates(ca).hashes.length > 0);
  const roots = readConfigurationFile(required("ROOTS_FILE"), 4 * MIB);
  const intermediates = env.ERP_CONTRACT_VALIDATOR_INTERMEDIATES_FILE === undefined
    ? Buffer.alloc(0) : readConfigurationFile(required("INTERMEDIATES_FILE"), 4 * MIB);
  const trust = approvedTrust(roots, intermediates);
  const raw = readConfigurationFile(required("KEYRING_FILE"), 4096, true);
  try { return { origin, ca, trust, key: readKeyring(raw, required("KEY_ID")) }; }
  finally { raw.fill(0); }
}
