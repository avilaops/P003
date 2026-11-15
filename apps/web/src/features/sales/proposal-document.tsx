import { DataTable } from "@/components/workspace/data-table"
import { CommercialDocument, DocumentSection, type DocumentIssuer } from "@/components/documents/commercial-document"
import { ProductThumbnail } from "@/features/catalog/product-thumbnail"
import type { Schema } from "@/lib/api/types"
import { commercialMoney, commercialQuantity } from "./order-presentation"

export type ProposalIssuer = DocumentIssuer
const labels: Record<string, string> = { draft: "Rascunho", sent: "Enviada", accepted: "Aceita", rejected: "Rejeitada", cancelled: "Cancelada", expired: "Expirada", superseded: "Substituída" }
function date(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}

export function ProposalDocument({ snapshot, issuer, issuerName }: { snapshot: Schema<"ProposalSnapshot">; issuer?: ProposalIssuer; issuerName?: string }) {
  const { data, items } = snapshot
  const name = issuer?.legalName || issuerName
  const status = data.expired ? "expired" : data.status
  const identity = `Proposta ${data.number} • Versão ${data.version} • ${labels[status] || status}`
  return <CommercialDocument data-proposal-document className="proposal-document" aria-label={`Proposta comercial ${data.number}`} title="Proposta comercial" identity={identity} issuer={issuer || (name ? { legalName: name } : undefined)}>
    <DocumentSection title="Emitente">
      <div className="proposal-issuer">
        {name && <p className="proposal-issuer-name">{name}</p>}
        {issuer?.tradeName && issuer.tradeName !== name && <p>{issuer.tradeName}</p>}
        {issuer?.taxId && <p>CPF/CNPJ: {issuer.taxId}</p>}
        {issuer?.email && <p>{issuer.email}</p>}{issuer?.phone && <p>{issuer.phone}</p>}
      </div>
    </DocumentSection>
    <div className="commercial-document-grid proposal-parties">
      <DocumentSection title="Cliente"><p className="proposal-customer-name">{data.customerName}</p>{data.customerTaxId && <p className="proposal-aux">CPF/CNPJ: {data.customerTaxId}</p>}</DocumentSection>
      <DocumentSection title="Identificação"><dl className="proposal-dates">{data.createdAt && <div><dt>Emissão</dt><dd>{date(data.createdAt)}</dd></div>}<div><dt>Validade</dt><dd>{date(data.validUntil)}</dd></div><div><dt>Versão</dt><dd>{data.version}</dd></div><div><dt>Situação</dt><dd>{labels[status] || status}</dd></div></dl></DocumentSection>
    </div>
    <DocumentSection title="Itens da proposta" className="proposal-items" aria-label="Itens da proposta"><DataTable className="commercial-document-table proposal-items-table">
      <caption className="sr-only">Itens da proposta</caption><colgroup><col className="proposal-product-column" /><col className="proposal-quantity-column" /><col className="proposal-unit-price-column" /><col /></colgroup>
      <thead><tr><th scope="col">Produto</th><th scope="col" className="proposal-quantity-column">Quantidade</th><th scope="col" className="proposal-unit-price-column">Unitário</th><th scope="col">Total</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.productId}>
        <td><div className="proposal-product-identity flex flex-col gap-2 sm:flex-row">
          <ProductThumbnail key={`${snapshot.tenantId}:${item.productId}`} id={item.productId} name={item.name} tenantId={snapshot.tenantId} eager />
          <div className="min-w-0"><p className="proposal-item-name">{item.name}</p><p className="proposal-aux">{item.sku}</p><p className="proposal-mobile-pricing proposal-aux"><span>Qtd. {commercialQuantity(item.quantity)} {item.unit}</span><span>Unit. {commercialMoney(item.unitPrice)}</span></p><p className="proposal-aux">{[item.structureColor && `Estrutura: ${item.structureColor}`, item.swingArmColor && `Braços: ${item.swingArmColor}`, `Tipo de anilheiro: ${item.plateHolderType || "Não se aplica"}`, item.upholsteryColor && `Estofado: ${item.upholsteryColor}`].filter(Boolean).join(" • ")}</p></div>
        </div></td>
        <td className="proposal-quantity-column">{commercialQuantity(item.quantity)} {item.unit}</td><td className="proposal-unit-price-column">{commercialMoney(item.unitPrice)}</td><td>{commercialMoney(item.amount)}</td>
      </tr>)}</tbody>
    </DataTable></DocumentSection>
    <div className="commercial-document-total proposal-total"><p>Total: {commercialMoney(data.amount)}</p></div>
    <div className="commercial-document-grid proposal-conditions">
      {data.paymentTerms && <DocumentSection title="Pagamento"><p>{data.paymentTerms}</p></DocumentSection>}
      {data.deliveryTerms && <DocumentSection title="Entrega"><p>{data.deliveryTerms}</p></DocumentSection>}
      {data.notes && <DocumentSection title="Observações" className="proposal-notes"><p>{data.notes}</p></DocumentSection>}
    </div>
    {!data.isCurrent && <p className="proposal-history">Versão histórica • versão {data.version}</p>}
  </CommercialDocument>
}
