import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { prepareNationalNfse } from "../src/lib/fiscal/nfse-issuance.ts";
import { cancelNationalNfse, consultNationalNfse, issueNationalNfse } from "../src/lib/fiscal/nfse-sefin.ts";
import { signingKeyOf } from "../src/lib/fiscal/sign.ts";
import { dispatch } from "../src/engine.ts";
import { nationalNfseXml, issuerTaxId, nfseKey } from "./fixtures/nfse-national.ts";
import { testPfx } from "./fiscal-helpers.ts";

const password = "senha-de-teste";
const pfx = testPfx({ name: `EMITENTE TESTE:${issuerTaxId}`, password });
const certificate = { pkcs12Base64: Buffer.from(pfx).toString("base64"), password };

async function prepared() {
  return prepareNationalNfse({
    environment: "homologation",
    issuedAt: "2026-11-17T10:30:00-03:00",
    competence: "2026-11-17",
    applicationVersion: "avilaops-erp-1",
    series: "1",
    number: "1",
    issuer: { taxId: issuerTaxId, name: "Emitente teste", municipalityCode: "3543402" },
    recipient: { taxId: "19131243000197", name: "Cliente de teste" },
    service: { municipalityCode: "3543402", nationalTaxCode: "010101", description: "Serviço sintético." },
    amount: "123.45",
    taxation: { issTaxation: "1", issWithholding: "1", totalTaxIndicator: "0" },
  });
}

test("issueNationalNfse signs DPS with RSA-SHA256 and sends gzip JSON through fixed restricted-production mTLS", async () => {
  let calls = 0;
  const result = await issueNationalNfse({ prepared: await prepared(), issuerTaxId, certificate }, async request => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/nfse");
    assert.equal(request.timeoutMs, 45_000);
    assert.deepEqual(request.certificate, { pfx: Buffer.from(pfx), passphrase: password });
    const payload = JSON.parse(request.body!);
    const signed = gunzipSync(Buffer.from(payload.dpsXmlGZipB64, "base64")).toString("utf8");
    assert.match(signed, /rsa-sha256/);
    assert.match(signed, /xmlenc#sha256/);
    const signature = /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">[\s\S]*<\/Signature>/.exec(signed)?.[0];
    assert.ok(signature);
    const key = signingKeyOf(pfx, password);
    const checker = new SignedXml({ publicCert: `-----BEGIN CERTIFICATE-----\n${key.certificateBase64}\n-----END CERTIFICATE-----`, getCertFromKeyInfo: () => null });
    checker.loadSignature(signature);
    assert.equal(checker.checkSignature(signed), true);
    return { status: 201, body: JSON.stringify({ tipoAmbiente: 2, versaoAplicativo: "fixture", dataHoraProcessamento: "2026-11-17T10:30:01-03:00", idDps: (await prepared()).id, chaveAcesso: nfseKey, nfseXmlGZipB64: Buffer.from(await import("node:zlib").then(({ gzipSync }) => gzipSync(nationalNfseXml()))).toString("base64"), alertas: [] }) };
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "authorized");
  assert.equal(result.accessKey, nfseKey);
  assert.match(result.xml!, /<NFSe /);
});

test("issueNationalNfse blocks a certificate from another CNPJ and production before transport", async () => {
  let calls = 0;
  const transport = async () => { calls++; throw new Error("must not run"); };
  const other = testPfx({ name: "OUTRA EMPRESA:12345678000195", password });
  const document = await prepared();
  await assert.rejects(() => issueNationalNfse({ prepared: document, issuerTaxId, certificate: { pkcs12Base64: Buffer.from(other).toString("base64"), password } }, transport), /certificado|CNPJ/i);
  await assert.rejects(() => issueNationalNfse({ prepared: { ...document, environment: "production" as never }, issuerTaxId, certificate }, transport), /produção|homologação/i);
  assert.equal(calls, 0);
});

test("issueNationalNfse maps timeout and transient authority failures to uncertain without reflecting secrets", async () => {
  for (const failure of [new DOMException("senha-de-teste", "TimeoutError"), { status: 503, body: "<html>pkcs12Base64 senha-de-teste</html>" }]) {
    const result = await issueNationalNfse({ prepared: await prepared(), issuerTaxId, certificate }, async () => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    assert.deepEqual(result, { status: "uncertain", code: "sefin_unavailable", reason: "Operação fiscal não confirmada; consulte a DPS antes de repetir." });
    assert.doesNotMatch(JSON.stringify(result), /senha-de-teste|pkcs12Base64|html/i);
  }
});

test("consultNationalNfse reconciles a DPS before returning the authorized XML", async () => {
  const document = await prepared();
  const requests: string[] = [];
  const result = await consultNationalNfse({ dpsId: document.id, issuerTaxId, certificate }, async request => {
    requests.push(request.url);
    if (request.url.endsWith(`/dps/${document.id}`)) return { status: 200, body: JSON.stringify({ chaveAcesso: nfseKey }) };
    return { status: 200, body: JSON.stringify({ tipoAmbiente: 2, chaveAcesso: nfseKey, nfseXmlGZipB64: Buffer.from(await import("node:zlib").then(({ gzipSync }) => gzipSync(nationalNfseXml()))).toString("base64") }) };
  });

  assert.deepEqual(requests, [
    `https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/dps/${document.id}`,
    `https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/nfse/${nfseKey}`,
  ]);
  assert.equal(result.status, "authorized");
  assert.equal(result.accessKey, nfseKey);
});

test("consultNationalNfse returns pending for an unknown DPS and uncertain for transient failures", async () => {
  const document = await prepared();
  const pending = await consultNationalNfse({ dpsId: document.id, issuerTaxId, certificate }, async () => ({ status: 404, body: "{}" }));
  assert.deepEqual(pending, { status: "pending", reason: "NFS-e ainda não localizada para a DPS." });
  const unknown = await consultNationalNfse({ dpsId: document.id, issuerTaxId, certificate }, async () => ({ status: 503, body: "secret" }));
  assert.deepEqual(unknown, { status: "uncertain", code: "sefin_unavailable", reason: "Operação fiscal não confirmada; consulte a DPS antes de repetir." });
});

test("cancelNationalNfse signs the cancellation request and posts the official event envelope", async () => {
  const result = await cancelNationalNfse({ accessKey: nfseKey, issuerTaxId, certificate, occurredAt: "2026-11-17T11:00:00-03:00", applicationVersion: "avilaops-erp-1", reasonCode: "2", reason: "Serviço não prestado por cancelamento do cliente." }, async request => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, `https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/nfse/${nfseKey}/eventos`);
    const payload = JSON.parse(request.body!);
    const signed = gunzipSync(Buffer.from(payload.pedidoRegistroEventoXmlGZipB64, "base64")).toString("utf8");
    assert.match(signed, new RegExp(`Id="PRE${nfseKey}101101"`));
    assert.match(signed, /<e101101><xDesc>Cancelamento de NFS-e<\/xDesc><cMotivo>2<\/cMotivo>/);
    assert.match(signed, /rsa-sha256/);
    return { status: 201, body: JSON.stringify({ tipoAmbiente: 2, eventoXmlGZipB64: Buffer.from(await import("node:zlib").then(({ gzipSync }) => gzipSync("<eventoRegistrado/>"))).toString("base64") }) };
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.accessKey, nfseKey);
});

test("engine dispatch exposes issue, consult and cancel NFS-e operations through the injected SEFIN boundary", async () => {
  const document = await prepared();
  const issued = await dispatch("issue-nfse", { prepared: document, issuerTaxId, certificate }, undefined, async request => {
    assert.equal(request.url.endsWith("/nfse"), true);
    return { status: 201, body: JSON.stringify({ tipoAmbiente: 2, idDps: document.id, chaveAcesso: nfseKey, nfseXmlGZipB64: Buffer.from(await import("node:zlib").then(({ gzipSync }) => gzipSync(nationalNfseXml()))).toString("base64") }) };
  });
  assert.equal(issued.status, "authorized");
});
