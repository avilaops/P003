import type { ComponentProps, ReactNode } from "react"
import Image from "next/image"
import "./commercial-document.css"

export type DocumentIssuer = { legalName: string; tradeName?: string | null; taxId?: string | null; email?: string | null; phone?: string | null; logoDataUrl?: string | null }

/** Contract-inspired document shell. Keep application controls outside this article. */
export function CommercialDocument({ title, identity, issuer, children, className = "", ...props }: ComponentProps<"article"> & { title: string; identity: string; issuer?: DocumentIssuer; children: ReactNode }) {
  return <article {...props} data-commercial-document className={`commercial-document ${className}`}>
    <table role="presentation" className="commercial-document-pages">
      <thead><tr><td><div className="commercial-document-running-header" aria-hidden="true">{title} • {identity}</div></td></tr></thead>
      <tbody><tr><td>
    <header className="commercial-document-header">
      <div className="commercial-document-brand">
        {issuer?.logoDataUrl && /^data:image\/(png|jpeg|webp);base64,/.test(issuer.logoDataUrl) && <Image unoptimized className="commercial-document-logo" src={issuer.logoDataUrl} alt="Logo da empresa" width={1024} height={1024} />}
        <div>{issuer?.legalName && <p className="commercial-document-issuer-name">{issuer.tradeName || issuer.legalName}</p>}{issuer?.taxId && <p>CPF/CNPJ: {issuer.taxId}</p>}</div>
      </div>
      <p className="commercial-document-caption">{title}</p>
    </header>
    <div className="commercial-document-title"><h2>{title}</h2><p>{identity}</p></div>
    {children}
      </td></tr></tbody>
      <tfoot><tr><td>
    <footer className="commercial-document-footer"><span>{identity}</span><span>Documento comercial • ERP Next</span></footer>
      </td></tr></tfoot>
    </table>
  </article>
}

export function DocumentSection({ title, children, className = "", ...props }: ComponentProps<"section"> & { title: string; children: ReactNode }) {
  return <section {...props} className={`commercial-section ${className}`}><h3>{title}</h3><div className="commercial-section-body">{children}</div></section>
}
