/** URLs publicados em https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/WebServices.aspx */
export function nfceSp(environment:"homologacao"|"producao") {
  const homologation=environment==="homologacao";
  const host=(homologation?"homologacao.":"")+"nfce.fazenda.sp.gov.br";
  const publicSite="https://www."+host;
  const ws="https://"+host+"/ws/";
  return {qrCodeUrl:publicSite+"/qrcode",accessKeyUrl:publicSite+(homologation?"/consulta":"/NFCeConsultaPublica"),
    authorize:ws+"NFeAutorizacao4.asmx",consult:ws+"NFeConsultaProtocolo4.asmx",event:ws+"NFeRecepcaoEvento4.asmx"};
}
