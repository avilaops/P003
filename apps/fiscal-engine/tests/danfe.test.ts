import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import forge from "node-forge";
import { verifyDanfeSignature } from "../src/lib/fiscal/danfe-signature.ts";
import { buildNfeXml } from "../src/lib/fiscal/nfe.ts";
import { signNfeXml } from "../src/lib/fiscal/sign.ts";
import { createHandler } from "../src/server.ts";
import { layoutInvoice } from "./fiscal-layout-fixture.ts";

type Identity = { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair };
function issue(name: string, serial: string, ca: boolean, issuer?: Identity): Identity {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: "commonName", value: name }]);
  cert.setIssuer((issuer?.cert ?? cert).subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", critical: true, cA: ca },
    { name: "keyUsage", critical: true, digitalSignature: !ca, keyCertSign: ca },
  ]);
  cert.sign((issuer?.keys ?? keys).privateKey, forge.md.sha256.create());
  return { cert, keys };
}

test("DANFE confere o perfil RSA-SHA1 da NF-e e constrói a cadeia até uma raiz local", async () => {
  const root = issue("Raiz de teste", "01", true);
  const intermediate = issue("AC de teste", "02", true, root);
  const leaf = issue("Emitente de teste", "03", false, intermediate);
  const { xml: unsigned } = buildNfeXml(layoutInvoice());
  const signed = signNfeXml(unsigned, {
    privateKeyPem: forge.pki.privateKeyToPem(leaf.keys.privateKey),
    certificateBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(leaf.cert)).getBytes()),
  });
  const xml = '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' + signed.replace(/^<\?xml[^>]*>/, "") + "</nfeProc>";
  const directory = await mkdtemp(join(tmpdir(), "danfe-test-"));
  const rootPem = forge.pki.certificateToPem(root.cert);
  try {
    await writeFile(join(directory, "icp-brasil-roots.pem"), rootPem);
    await writeFile(join(directory, "icp-brasil-intermediates.pem"), forge.pki.certificateToPem(intermediate.cert));
    assert.equal(await verifyDanfeSignature(xml, rootPem, directory), true);
    assert.equal(await verifyDanfeSignature(xml.replace("<nNF>123</nNF>", "<nNF>124</nNF>"), rootPem, directory), false);
    assert.equal(await verifyDanfeSignature(xml.replace("<SignatureValue>", "<SignatureValue>A"), rootPem, directory), false);
    assert.equal(await verifyDanfeSignature(xml, forge.pki.certificateToPem(intermediate.cert), directory), false);
    assert.equal(await verifyDanfeSignature(xml, null), false);
    await writeFile(join(directory, "icp-brasil-intermediates.pem"), rootPem);
    assert.equal(await verifyDanfeSignature(xml, rootPem, directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ponte DANFE preserva a sessão, o XSD e as recusas do serviço fiscal", async t => {
  const token = "danfe-synthetic-test-token";
  const provider = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    assert.equal(req.headers["mcp-session-id"], "sessao");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.params.name === "validar_xml_fiscal") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sessao" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { valido: false } } }));
      return;
    }
    const details = { assinatura_valida: false, motivo: body.id === 3 ? "Signature method RSA_SHA1 forbidden by configuration" : "Outra recusa" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: message\r\ndata: " + JSON.stringify({
      jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(details) }], structuredContent: details },
    }) + "\r\n\r\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => provider.close());
  const upstream = provider.address(); assert.ok(upstream && typeof upstream === "object");
  const proxy = createServer(createHandler(token, "http://127.0.0.1:" + upstream.port + "/mcp"));
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => proxy.close());
  const address = proxy.address(); assert.ok(address && typeof address === "object");
  const endpoint = "http://127.0.0.1:" + address.port + "/mcp/danfe";
  assert.equal((await fetch(endpoint)).status, 401);
  async function call(id: number, name: string) {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token, "mcp-session-id": "sessao" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id, params: { name, arguments: { xml_content: "<invalid/>" } } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal((await call(2, "validar_xml_fiscal")).result.structuredContent.valido, false);
  assert.deepEqual((await call(3, "validar_assinatura_nfe")).result.structuredContent, {
    assinatura_valida: false, motivo: "Assinatura ou cadeia ICP-Brasil inválida",
  });
  assert.equal((await call(4, "validar_assinatura_nfe")).result.structuredContent.motivo, "Outra recusa");
});
