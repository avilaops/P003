import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = JSON.parse(readFileSync(new URL('../../../docs/integrations/n8n-document-mail.json', import.meta.url)));
const node = name => workflow.nodes.find(item => item.name === name);
const normalize = new Function('$input', node('Validar documento').parameters.jsCode);
const outcome = new Function('$input', '$', node('Conferir aceite SMTP').parameters.jsCode);
const fixtureId = 'e554fb70-2d01-46af-89c6-fc021de85beb';
const url = 'https://n8n.avilaops.com/webhook/erp-document-mail-v1';
const input = value => ({first: () => ({json: value})});
const fixture = () => ({
  id: fixtureId, to: ['alpha@example.invalid', 'beta@example.invalid'],
  subject: 'Documento sintético', text: 'Texto <literal> sem conversão em HTML.',
  attachments: [
    {filename:'documento.pdf',contentType:'application/pdf',content:'JVBERi0='},
    {filename:'documento.xml',contentType:'text/xml; charset=utf-8',content:'PHgvPg=='},
    {filename:'proposta.html',contentType:'text/html; charset=utf-8',content:'PHA+T2s8L3A+'},
  ],
});
function check(body, overrides = {}) {
  return normalize(input({body, headers:{'content-type':'application/json; charset=utf-8'}, webhookUrl:url,
    executionMode:'production',...overrides}))[0];
}
function smtp(result, message = check(fixture()).json) {
  return outcome(input(result), () => input(message))[0].json;
}

test('preserva documentos, múltiplos destinatários e texto simples no envelope autenticado', () => {
  const data=fixture();
  const event=check(data);
  assert.equal(event.json.ready,true);
  assert.equal(event.json.to,data.to.join(', '));
  assert.equal(event.json.html,'');
  assert.equal(event.json.text,data.text);
  assert.equal(event.json.files,'file0,file1,file2');
  for (const [index, item] of data.attachments.entries()) {
    assert.equal(event.binary['file'+index].fileName,item.filename);
    assert.equal(event.binary['file'+index].data,item.content);
  }
  assert.equal(check({...data, html:'<p>Documento</p>', to:data.to[0]}).json.html,'<p>Documento</p>');
  assert.equal(check({...data, id:'a'.repeat(64)}).json.ready,true);
});

test('recusa dados inválidos, limites excedidos e acionamentos sem o webhook autenticado', () => {
  const data=fixture();
  const file=data.attachments[0];
  const bodyCases=[
    {...data,subject:'x\r\nCc: terceiro'}, {...data,to:'a@example.invalid\n'},
    {...data,to:Array.from({length:21},(_,i)=>i+'@ex.invalid')}, {...data,to:[data.to[0],data.to[0]]},
    {...data,attachments:[{...file,filename:'../documento.pdf'}]}, {...data,attachments:Array(41).fill(file)},
    {...data,attachments:[{...file,filename:'nota.xml'}]}, {...data,attachments:[{...file,content:'invalid'}]},
    {...data,attachments:[{...file,content:Buffer.alloc(10*1024*1024+1).toString('base64')}]},
    {...data,body:'unexpected'}, {...data,html:'\u0000'},
  ];
  const cases=[...bodyCases.map(b=>check(b)),check(data,{executionMode:'test'}),
    check(data,{webhookUrl:undefined}),check(data,{headers:{'content-type':'text/plain'}})];
  for(const event of cases) {
    assert.deepEqual(event,{json:{id:fixtureId,status:'failed',httpCode:422}});
  }
});

test('aceite SMTP é integral, recusa confirmada é failed e entrega parcial ou incerta é unknown', () => {
  const {to}=fixture();
  const ok={accepted:to,rejected:[],response:'250 2.0.0 accepted'};
  assert.equal(smtp(ok).status,'sent');
  for(const result of [
    {...ok,accepted:[to[0]],rejected:[to[1]]}, {...ok,accepted:[to[0],to[0]]},
    {...ok,response:'421 try later'}, {error:'timeout'}, {}, {accepted:to},
  ]) assert.equal(smtp(result).status,'unknown');
  assert.equal(smtp({...ok,accepted:[],rejected:to}).status,'failed');
  assert.equal(smtp({error:"Can't send mail - all recipients were rejected: 550"}).status,'failed');
  assert.deepEqual(Object.keys(smtp(ok)).sort(),['httpCode','id','status']);
});

test('usa credencial exclusiva, desligamento de histórico e saída protegida contra repetição', () => {
  const hook=node('Receber documentos'), sender=node('Enviar documentos'), duplicate=node('Verificar repetição');
  assert.equal(hook.parameters.authentication,'headerAuth');
  assert.equal(hook.credentials.httpHeaderAuth.id,'ErpDocMailHdr01');
  assert.equal(sender.credentials.smtp.id,'tSZlEjwt75qo2MwC');
  assert.equal(sender.retryOnFail,false);
  assert.equal(sender.parameters.options.allowUnauthorizedCerts,false);
  assert.equal(duplicate.parameters.operation,'removeItemsSeenInPreviousExecutions');
  assert.equal(duplicate.parameters.dedupeValue,'={{ $json.id.toLowerCase() }}');
  assert.equal(workflow.connections['Identificador novo'].main[1][0].node,'Responder ao ERP');
  for(const level of ['saveDataSuccessExecution','saveDataErrorExecution']) assert.equal(workflow.settings[level],'none');
  for(const flag of ['saveManualExecutions','saveExecutionProgress']) assert.equal(workflow.settings[flag],false);
});
