import type { ReactNode } from "react"
import "./order-summary.css"

type OrderSummaryLayoutProps = {
  equipment: ReactNode
  customer: ReactNode
  delivery: ReactNode
  discount: ReactNode
  payment: ReactNode
  totals: ReactNode
  save: ReactNode
  issueCount: number
}

export function OrderSummaryLayout({ equipment, customer, delivery, discount, payment, totals, save, issueCount }: OrderSummaryLayoutProps) {
  return <div className="order-summary-layout">
    <div className="order-summary-main">
      <div className="order-equipment-area">{equipment}</div>
      <div className="order-customer-area">
        {customer}
        <section className="order-delivery-area" aria-label="Entrega e condições">{delivery}</section>
      </div>
      <div className="order-discount-area">{discount}</div>
      <div className="order-payment-area">{payment}</div>
    </div>
    <aside className="order-summary-aside" aria-label="Revisão e totais">
      <div className="order-summary-aside-body">{totals}</div>
      <section className="order-save-area order-summary-aside-save" aria-label="Salvar pedido">
        <p className="order-summary-count">{issueCount} {issueCount === 1 ? "pendência" : "pendências"} para salvar</p>
        {save}
      </section>
    </aside>
  </div>
}
