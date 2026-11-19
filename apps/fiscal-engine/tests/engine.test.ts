import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { dispatch, mapDraft } from "../src/engine.ts";
import { createHandler } from "../src/server.ts";
import { testPfx } from "./fiscal-helpers.ts";

const key = "35261012345678000195550010000001231482917364";
const certificate = {
  pkcs12Base64: Buffer.from(testPfx({ name: "EMITENTE TESTE:12345678000195" })).toString("base64"),
  password: "senha-de-teste",
};
function preparation() {
  return {
    environment: "homologation", certificate, number: 123,
    issuedAt: "2026-10-17T13:00:00Z", randomCode: "48291736",
    issuer: { taxId: "12345678000195", company: {
      legalName: "EMITENTE TESTE", taxId: "12345678000195", state: "SP",
      postalCode: "15035000", street: "Rua de Teste", number: "1", district: "Centro", city: "São José do Rio Preto",
    }, profile: { state: "SP", municipalityCode: "3549805", stateRegistration: "110042490114", crt: 1, series: 1 } },
    draft: {
      environment: "homologation", model: 55, operationNature: "Venda de mercadoria", taxRuleReference: "instrução de teste",
      recipient: { taxId: "11222333000181", legalName: "CLIENTE TESTE", state: "SP", municipalityCode: "3549805", postalCode: "15035000", street: "Rua Teste", number: "2", district: "Centro" },
      items: [{ code: "TEST-1", description: "Produto de teste", unit: "UN", ncm: "95069100", cfop: "5102", quantity: "1.0000", unitPrice: "100.0000000000", grossTotal: "100.00", origin: 0, icmsCst: null, csosn: "102", pisCst: "07", cofinsCst: "07" }], productsTotal: "100.00", payments: [{ code: "17", description: null, amount: "100.00" }],
    },
  };
}

test("prepare maps exact draft amounts, uses IBGE name, signs and passes the pinned XSD", async () => {
  const input = preparation();
  const mapped = mapDraft(input);
  assert.equal(mapped.recipient.city, "São José do Rio Preto");
  assert.equal(mapped.issuedAt, "2026-10-17T10:00:00-03:00");
  assert.equal(mapped.items[0].unitPrice, 100);
  const result = await dispatch("prepare", input);
  assert.equal(result.accessKey, key);
  assert.match(String(result.signedXml), /<Signature /);
  assert.match(String(result.signedXml), /<vNF>100.00<\/vNF>/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|senha-de-teste|pkcs12Base64/);
});

test("enderEmit/fone vem do telefone da empresa (ou celular) e é omitido quando inválido", async () => {
  const base = preparation();
  const withPhone = { ...base, issuer: { ...base.issuer, company: { ...base.issuer.company, phone: "(17) 9721-8555" } } };
  assert.equal(mapDraft(withPhone).issuer.phone, "1797218555");
  assert.match(String((await dispatch("prepare", withPhone)).signedXml), /<enderEmit>.*<fone>1797218555<\/fone><\/enderEmit>/);
  const mobileOnly = { ...base, issuer: { ...base.issuer, company: { ...base.issuer.company, phone: "", mobile: "17 99781-1471" } } };
  assert.equal(mapDraft(mobileOnly).issuer.phone, "17997811471");
  const invalid = { ...base, issuer: { ...base.issuer, company: { ...base.issuer.company, phone: "123" } } };
  assert.equal(mapDraft(invalid).issuer.phone, undefined);
  assert.doesNotMatch(String((await dispatch("prepare", invalid)).signedXml), /<enderEmit>.*<fone>/);
});

test("NFC-e de SP • prepara, assina e usa os serviços do modelo 65 nos dois ambientes com transporte local", async () => {
  // Catálogo público de endereços da SEFAZ-SP https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/WebServices.aspx
  for (const environment of ["homologation", "production"]) {
    const base=preparation(), tpAmb=environment==="production"?"1":"2";
    const host=(environment==="production"?"":"homologacao.")+"nfce.fazenda.sp.gov.br";
    const input={...base,environment,issuer:{...base.issuer,profile:{...base.issuer.profile,environment}},
      draft:{...base.draft,environment,model:65},nfce:{version:"2",csc:{id:"000001",secret:"CSC-SINTETICO-SEM-VALOR"}}};
    assert.equal(mapDraft(input).presenceIndicator,1);
    const prepared=await dispatch("prepare",input);
    const signedXml=String(prepared.signedXml), accessKey=String(prepared.accessKey);
    assert.equal(accessKey.slice(20,22),"65");
    assert.ok(signedXml.includes("https://www."+host+"/qrcode?p="+accessKey));
    const digest=/<DigestValue>([^<]+)<\/DigestValue>/.exec(signedXml)![1];
    const receipt='<protNFe versao="4.00"><infProt><tpAmb>'+tpAmb+'</tpAmb><verAplic>test</verAplic><chNFe>'+accessKey+
      '</chNFe><dhRecbto>2026-10-17T10:00:01-03:00</dhRecbto><nProt>135260000000001</nProt><digVal>'+digest+
      '</digVal><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe>';
    const payload={environment,certificate,accessKey,signedXml};
    const authorized=await dispatch("authorize",payload,async(url,_action,envelope)=>{
      assert.equal(url,"https://"+host+"/ws/NFeAutorizacao4.asmx");assert.ok(envelope.includes(accessKey));
      return "<retEnviNFe><cStat>104</cStat>"+receipt+"</retEnviNFe>";
    });
    assert.equal(authorized.status,"authorized");
    const consulted=await dispatch("consult",payload,async(url)=>{
      assert.equal(url,"https://"+host+"/ws/NFeConsultaProtocolo4.asmx");
      return "<retConsSitNFe><tpAmb>"+tpAmb+"</tpAmb><cStat>100</cStat><chNFe>"+accessKey+"</chNFe>"+receipt+"</retConsSitNFe>";
    });
    assert.equal(consulted.status,"authorized");
    const event={...payload,issuerTaxId:base.issuer.taxId,issuedAt:input.issuedAt,sequence:1,protocol:"135260000000001",text:"Cancelamento de teste do cupom"};
    await assert.rejects(dispatch("event",{...event,kind:"correcao"},async()=>{throw Error("transmissão inesperada")}),/modelo 65/);
    const cancellation=await dispatch("event",{...event,kind:"cancelamento"},async(url,_action,envelope)=>{
      assert.equal(url,"https://"+host+"/ws/NFeRecepcaoEvento4.asmx");assert.ok(envelope.includes(event.text));
      return "<retEnvEvento><cStat>128</cStat><retEvento><infEvento><tpAmb>"+tpAmb+"</tpAmb><cStat>135</cStat><chNFe>"+accessKey+
        "</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><nProt>135260000000002</nProt></infEvento></retEvento></retEnvEvento>";
    });
    assert.equal(cancellation.registered,true);
  }
});

test("return preparation emits finNFe 4, incoming tpNF and explicit NFref", async () => {
  const base = preparation();
  const input = {
    ...base,
    draft: {
      ...base.draft,
      purpose: 4,
      returnDirection: "incoming",
      referencedAccessKeys: [key],
      items: [{ ...base.draft.items[0], cfop: "1102" }],
    },
  };
  const mapped = mapDraft(input);
  assert.equal(mapped.purpose, 4);
  assert.equal(mapped.returnDirection, "incoming");
  const result = await dispatch("prepare", input);
  const signed = String(result.signedXml);
  assert.match(signed, /<tpNF>0<\/tpNF>/);
  assert.match(signed, /<finNFe>4<\/finNFe>/);
  assert.match(signed, new RegExp(`<NFref><refNFe>${key}<\/refNFe><\/NFref>`));
  assert.match(signed, /<CFOP>1102<\/CFOP>/);
});

test("V5 • assina entrada de consumidor com CPF e referência à venda nos dois ambientes", async () => {
  for (const environment of ["homologation","production"]) {
    const base=preparation();
    const input={...base,environment,number:124,issuer:{...base.issuer,profile:{...base.issuer.profile,environment}},
      draft:{...base.draft,environment,operationNature:"Devolução de venda",purpose:4,returnDirection:"incoming",referencedAccessKeys:[key],finalConsumer:true,
        recipient:{...base.draft.recipient,taxId:"52998224725",legalName:"Pessoa consumidora"},
        items:[{...base.draft.items[0],cfop:"1202",quantity:"2.0000",grossTotal:"200.00"}],productsTotal:"200.00",payments:[{code:"90",amount:"0.00"}]}};
    const result=await dispatch("prepare",input,async()=>assert.fail("Preparar entrada não deve transmitir"));
    const signed=String(result.signedXml);
    assert.notEqual(result.accessKey,key);
    for (const fragment of ["<mod>55</mod>","<tpNF>0</tpNF>","<finNFe>4</finNFe>","<CPF>52998224725</CPF>",
      "<CFOP>1202</CFOP>","<NFref><refNFe>"+key+"</refNFe></NFref>","<vNF>200.00</vNF>","<tPag>90</tPag>",
      "<tpAmb>"+(environment==="production"?"1":"2")+"</tpAmb>","<Signature "]) assert.ok(signed.includes(fragment),fragment);
  }
});

test("prepare refuses missing tax rules, changed totals, incompatible item rules and production", () => {
  const input = preparation();
  input.issuer.profile.crt = 3;
  assert.throws(() => mapDraft(input), /recorte|regime/i);
  const wrongTotal = preparation();
  wrongTotal.draft.items[0].grossTotal = "100.01";
  assert.throws(() => mapDraft(wrongTotal), /total/i);
  const wrongCity = preparation();
  wrongCity.draft.recipient.municipalityCode = "3599999";
  assert.throws(() => mapDraft(wrongCity), /IBGE|município/i);
  const incompatible = preparation();
  incompatible.draft.items.push({ ...incompatible.draft.items[0], pisCst: "04" });
  assert.throws(() => mapDraft(incompatible), /classifica|regra/i);
});

test("component finishes survive preparation in infAdProd and pass the pinned XSD", async () => {
  const input = preparation();
  const additionalInfo = "Estrutura: Piano Black; Anilheiros: Azul; Tipo de anilheiro: Olímpico";
  const withFinishes = { ...input, draft: { ...input.draft, items: [{ ...input.draft.items[0], additionalInfo }] } };
  assert.equal(mapDraft(withFinishes).items[0].additionalInfo, additionalInfo);
  const result = await dispatch("prepare", withFinishes);
  assert.ok(String(result.signedXml).includes(`<infAdProd>${additionalInfo}</infAdProd>`));
  assert.throws(() => mapDraft({ ...withFinishes, draft: { ...withFinishes.draft, items: [{ ...withFinishes.draft.items[0], additionalInfo: "x".repeat(501) }] } }), /Informações|500/i);
});

test("engine refuses mismatched environments and uncorrelated signed XML before any external call", async () => {
  let calls = 0;
  const send = async () => { calls++; return ""; };
  await assert.rejects(dispatch("authorize", { ...preparation(), environment: "production", accessKey: key, signedXml: "<NFe/>" }, send), /XML|assinad/i);
  await assert.rejects(dispatch("authorize", { ...preparation(), accessKey: key, signedXml: "<NFe/>" }, send), /XML|assinad/i);
  assert.equal(calls, 0);
});

test("distribution uses fixed national endpoint and preserves the returned NSU batch", async () => {
  const result = await dispatch("distribute", { environment: "homologation", certificate, issuerTaxId: "12345678000195", lastNsu: "0" }, async (url, action, envelope) => {
    assert.match(url, /^https:\/\/hom1\.nfe\.fazenda\.gov\.br\//);
    assert.match(action, /nfeDistDFeInteresse$/);
    assert.match(envelope, /<ultNSU>000000000000000<\/ultNSU>/);
    return '<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>137</cStat><xMotivo>Sem documentos</xMotivo><ultNSU>000000000000000</ultNSU><maxNSU>000000000000000</maxNSU></retDistDFeInt>';
  });
  assert.equal(result.code, "137");
  assert.equal(result.lastNsu, "000000000000000");
  assert.deepEqual(result.documents, []);
});

test("recipient production distribution requires opt-in and uses the tenant state in the signed transport request", async () => {
  const original = process.env.SEFAZ_MONITOR_ENABLED;
  const input = {environment:"production",certificate,issuerTaxId:"12345678000195",lastNsu:"0",authorState:"MG"};
  const calls: string[]=[];
  const fake = async (url:string, _action:string, envelope:string) => {
    calls.push(url);
    assert.match(envelope, /<cUFAutor>31<\/cUFAutor>/);
    assert.match(envelope, /<tpAmb>1<\/tpAmb>/);
    return '<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>137</cStat><xMotivo>Sem documentos</xMotivo><ultNSU>0</ultNSU><maxNSU>0</maxNSU></retDistDFeInt>';
  };
  try {
    delete process.env.SEFAZ_MONITOR_ENABLED;
    await assert.rejects(dispatch("distribute",input,fake),/desativada/);
    await assert.rejects(dispatch("manifest",input,fake),/desativada/);
    assert.equal(calls.length,0);
    process.env.SEFAZ_MONITOR_ENABLED="true";
    await assert.rejects(dispatch("distribute",{...input,authorState:"XX"},fake),/UF/);
    const result=await dispatch("distribute",input,fake);
    assert.equal(result.code,"137");
    assert.deepEqual(calls,["https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx"]);
  } finally {
    if(original===undefined) delete process.env.SEFAZ_MONITOR_ENABLED;
    else process.env.SEFAZ_MONITOR_ENABLED=original;
  }
});

test("production prepares and signs the declared environment and uses only its fixed SP endpoints", async () => {
  const base = preparation();
  const input = { ...base, environment: "production", issuer: { ...base.issuer, profile: { ...base.issuer.profile, environment: "production" } }, draft: { ...base.draft, environment: "production" } };
  const prepared = await dispatch("prepare", input);
  const signed = String(prepared.signedXml), accessKey = String(prepared.accessKey);
  assert.match(signed, /<tpAmb>1<\/tpAmb>/);
  assert.match(signed, /<xNome>CLIENTE TESTE<\/xNome>/);
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(signed)![1];
  const protocol = `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><verAplic>test</verAplic><chNFe>${accessKey}</chNFe><dhRecbto>2026-10-17T10:00:01-03:00</dhRecbto><nProt>135260000000001</nProt><digVal>${digest}</digVal><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe>`;
  const calls: string[] = [];
  const authorized = await dispatch("authorize", { environment: "production", certificate, accessKey, signedXml: signed }, async (url, _action, envelope) => {
    assert.equal(url, "https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx");
    assert.match(envelope, /<tpAmb>1<\/tpAmb>/); calls.push(url);
    return `<retEnviNFe><cStat>104</cStat>${protocol}</retEnviNFe>`;
  });
  assert.equal(authorized.status, "authorized");
  const consulted = await dispatch("consult", { environment: "production", certificate, accessKey, signedXml: signed }, async (url, _action, envelope) => {
    assert.equal(url, "https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx");
    assert.match(envelope, /<tpAmb>1<\/tpAmb>/); calls.push(url);
    return `<retConsSitNFe><tpAmb>1</tpAmb><cStat>100</cStat><chNFe>${accessKey}</chNFe>${protocol}</retConsSitNFe>`;
  });
  assert.equal(consulted.status, "authorized");
  await assert.rejects(dispatch("authorize", { environment: "homologation", certificate, accessKey, signedXml: signed }, async () => { calls.push("wrong"); return ""; }), /ambiente/);
  assert.throws(() => mapDraft({ ...input, draft: base.draft }), /Ambiente/);
  assert.equal(calls.length, 2);
});

test("authorization verifies the signed content, duplicates require reconciliation and A1 rotation permits consultation", async () => {
  const input = preparation();
  const prepared = await dispatch("prepare", input);
  const signed = String(prepared.signedXml);
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(signed)![1];
  let sends = 0;
  const protocol = `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>test</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-10-17T10:00:01-03:00</dhRecbto><nProt>135260000000001</nProt><digVal>${digest}</digVal><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe>`;
  const response = await dispatch("authorize", { environment: "homologation", certificate, accessKey: key, signedXml: signed }, async () => { sends++; return `<retEnviNFe><cStat>104</cStat>${protocol}</retEnviNFe>`; });
  assert.equal(response.status, "authorized"); assert.match(String(response.xml), /<nfeProc /);
  const tampered = signed.replace("<vProd>100.00</vProd>", "<vProd>100.01</vProd>");
  assert.notEqual(tampered, signed);
  await assert.rejects(dispatch("authorize", { environment: "homologation", certificate, accessKey: key, signedXml: tampered }, async () => { sends++; return ""; }));
  assert.equal(sends, 1);
  const duplicate = await dispatch("authorize", { environment: "homologation", certificate, accessKey: key, signedXml: signed }, async () => "<retEnviNFe><cStat>204</cStat><xMotivo>Duplicidade</xMotivo></retEnviNFe>");
  assert.equal(duplicate.status, "unknown");
  const replacement = { pkcs12Base64: Buffer.from(testPfx({ name: "EMITENTE TESTE:12345678000195" })).toString("base64"), password: "senha-de-teste" };
  const consulted = await dispatch("consult", { environment: "homologation", certificate: replacement, accessKey: key, signedXml: signed }, async () => `<retConsSitNFe><tpAmb>2</tpAmb><cStat>100</cStat><chNFe>${key}</chNFe>${protocol}</retConsSitNFe>`);
  assert.equal(consulted.status, "authorized"); assert.deepEqual(consulted.events, []);
});

test("inutilization is refused before any authority call for São Paulo", async () => {
  let calls = 0;
  await assert.rejects(
    dispatch("void", { environment: "homologation", certificate, state: "SP", issuerTaxId: "12345678000195", year: 2026, series: 1, first: 124, last: 125, text: "Numeração não utilizada no sistema" }, async () => {
      calls += 1;
      return "";
    }),
    /não se aplica.*São Paulo/i,
  );
  assert.equal(calls, 0);
});

test("HTTP boundary authenticates, bounds requests and never reflects secrets", async () => {
  const server = createServer(createHandler("test-token-with-enough-entropy"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/prepare`;
  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    const headers = { authorization: "Bearer test-token-with-enough-entropy", "content-type": "application/json" };
    const result = await fetch(url, { method: "POST", headers, body: JSON.stringify({ environment: "production", certificate }) });
    assert.equal(result.status, 200);
    assert.doesNotMatch(await result.text(), /senha-de-teste|pkcs12Base64/);
    const oversized = await fetch(url, { method: "POST", headers, body: JSON.stringify({ xml: "x".repeat(2_100_000) }) });
    assert.equal(oversized.status, 413);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
