import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyDanfeSignature } from "./lib/fiscal/danfe-signature.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const rsaSha1Refusal = "Signature method RSA_SHA1 forbidden by configuration";
export const fiscalMcpEndpoint = "http://127.0.0.1:8093/mcp";

/** A Streamable HTTP response can leave its SSE connection open after the matching result. */
export async function rpcResponse(response: Response, id: unknown, maximum = 131_072): Promise<RecordValue> {
  const sse = response.headers.get("content-type")?.startsWith("text/event-stream");
  const parse = (source: string) => {
    const item: unknown = JSON.parse(source);
    return record(item) && item.jsonrpc === "2.0" && item.id === id ? item : null;
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, pending = "";
  if (!response.body) throw new Error("Resposta MCP vazia");
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error("Resposta MCP excedeu o limite");
    pending += decoder.decode(chunk, { stream: true });
    if (!sse) continue;
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop()!;
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      const item = data && parse(data);
      if (item) return item;
    }
  }
  if (!sse) {
    const item = parse(pending + decoder.decode());
    if (item) return item;
  }
  throw new Error("Resposta MCP incompatível");
}

/** Retain the upstream metadata, errors and session. Only the NF-e profile rejected by SignXML's
 * generic SHA1 policy is eligible for independent digest, signature and ICP path verification. */
async function adaptSignature(message: RecordValue, args: RecordValue) {
  const result = message.result;
  if (!record(result) || result.isError === true) return;
  const blocks = result.content;
  if (!Array.isArray(blocks) || blocks.length !== 1 || !record(blocks[0]) ||
      blocks[0].type !== "text" || typeof blocks[0].text !== "string") return;
  const details: unknown = result.structuredContent ?? JSON.parse(blocks[0].text);
  if (!record(details) || details.assinatura_valida !== false || details.motivo !== rsaSha1Refusal) return;
  const valid = await verifyDanfeSignature(args.xml_content, args.ca_bundle);
  const checked = { ...details, assinatura_valida: valid, motivo: valid ? null : "Assinatura ou cadeia ICP-Brasil inválida" };
  result.structuredContent = checked;
  blocks[0].text = JSON.stringify(checked);
}

export async function handleDanfeMcp(request: IncomingMessage, response: ServerResponse, body?: unknown, endpoint = fiscalMcpEndpoint) {
  const headers = new Headers();
  for (const name of ["accept", "authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const result = await fetch(endpoint, {
    method: request.method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(55_000),
  });
  const outgoing: Record<string, string> = { "cache-control": "no-store" };
  for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version", "www-authenticate", "allow"]) {
    const value = result.headers.get(name);
    if (value) outgoing[name] = value;
  }
  if (result.ok && record(body) && body.method === "tools/call" && body.jsonrpc === "2.0" &&
      (typeof body.id === "number" || typeof body.id === "string") && record(body.params) &&
      body.params.name === "validar_assinatura_nfe" && record(body.params.arguments)) {
    const message = await rpcResponse(result, body.id);
    await adaptSignature(message, body.params.arguments);
    response.writeHead(result.status, { ...outgoing, "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(result.status, outgoing);
  if (result.body) await pipeline(Readable.fromWeb(result.body), response);
  else response.end();
}
