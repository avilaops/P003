// Explanations for features listed in demonstrationRoutes. Each entry is matched by
// the longest route prefix; frontend-models.spec.ts checks that every route resolves.
export type UnavailableFeature = { title: string; purpose: string; related: readonly [label: string, href: string] }

export const unavailableFeatures: Record<string, UnavailableFeature> = {
  "/aplicativos": { title: "Aplicativos", purpose: "Conectar aplicativos externos ao ERP.", related: ["Integrações", "/preferencias/integracoes"] },
  "/compras/notas-entrada": { title: "Nota fiscal de entrada", purpose: "Consultar o detalhe de uma nota recebida.", related: ["Notas fiscais de entrada", "/compras/notas-entrada"] },
  "/estoque/lancamentos": { title: "Lançamento de estoque", purpose: "Consultar o detalhe de uma movimentação de estoque.", related: ["Saldos de estoque", "/estoque"] },
  "/eventos": { title: "Eventos", purpose: "Acompanhar os acontecimentos da empresa em uma linha do tempo.", related: ["Visão geral", "/"] },
  "/financeiro/conta-digital": { title: "Conta digital", purpose: "Movimentar uma conta de pagamento integrada ao ERP.", related: ["Caixas e bancos", "/financeiro/caixas-bancos"] },
  "/financeiro/tributos": { title: "Tributos", purpose: "Apurar os impostos da empresa e acompanhar as guias.", related: ["Fiscal", "/fiscal"] },
  "/fiscal/guias": { title: "Guias tributárias", purpose: "Emitir e acompanhar as guias de recolhimento de impostos.", related: ["Fiscal", "/fiscal"] },
  "/logistica/envios": { title: "Envios", purpose: "Organizar e acompanhar a expedição dos pedidos.", related: ["Logística", "/logistica"] },
  "/logistica/etiquetas": { title: "Etiquetas de envio", purpose: "Gerar etiquetas de transporte para os pedidos.", related: ["Etiquetas", "/logistica/etiquetas"] },
  "/logistica/reversa": { title: "Logística reversa", purpose: "Organizar devoluções e coletas de mercadoria.", related: ["Logística", "/logistica"] },
  "/notificacoes": { title: "Notificações", purpose: "Reunir os avisos e pendências que pedem a sua atenção.", related: ["Visão geral", "/"] },
  "/novidades": { title: "Novidades", purpose: "Mostrar as mudanças recentes do ERP.", related: ["Visão geral", "/"] },
  "/vendas/anuncios": { title: "Anúncios", purpose: "Publicar e acompanhar anúncios dos produtos em marketplaces.", related: ["Integrações", "/preferencias/integracoes"] },
  "/vendas/loja-virtual": { title: "Loja virtual", purpose: "Receber pedidos da loja virtual da empresa.", related: ["Integrações", "/preferencias/integracoes"] },
}

export function unavailableFeatureFor(pathname: string): UnavailableFeature | undefined {
  const path = pathname.replace(/\/$/, "") || "/"
  const prefix = Object.keys(unavailableFeatures).filter(route => path === route || path.startsWith(route + "/")).sort((a, b) => b.length - a.length)[0]
  return prefix ? unavailableFeatures[prefix] : undefined
}
