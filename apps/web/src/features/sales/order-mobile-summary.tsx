import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronUp, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { money, type Sale } from "./negotiation-types"
import type { OrderIssue } from "./order-progress"
import "./order-summary.css"

type OrderMobileSummaryProps = {
  sale: Sale | null
  pending: boolean
  hasItems: boolean
  issueCount: number
  tableTotalCents: number | null
  onSave: () => void
  saveDisabled: boolean
  saveLabel: string
  saveReason?: string
  renderSummary: (onFocus: (issue: OrderIssue) => void) => ReactNode
  onFocusIssue: (issue: OrderIssue) => void
}

const desktopSummary = "(min-width: 1100px)"
const editableField = "input:not([type=hidden], [type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=reset], [type=file], [type=color]), textarea, select, [contenteditable=true]"

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element === document.body || element.closest("[inert], [aria-hidden=true]") || element.matches(":disabled")) return false
  if (!element.getClientRects().length || getComputedStyle(element).visibility !== "visible") return false
  const bounds = element.getBoundingClientRect()
  const viewport = window.visualViewport
  const top = viewport?.offsetTop ?? 0
  return bounds.bottom > top && bounds.top < top + (viewport?.height ?? window.innerHeight)
}

export function OrderMobileSummary({
  sale, pending, hasItems, issueCount, tableTotalCents, onSave, saveDisabled, saveLabel, saveReason, renderSummary, onFocusIssue,
}: OrderMobileSummaryProps) {
  const [open, setOpen] = useState(false)
  const bar = useRef<HTMLElement>(null)
  const reviewButton = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const [requestedIssue, setRequestedIssue] = useState<OrderIssue | null>(null)
  const afterCloseFrame = useRef(0)

  const amount = sale?.totalCents ?? (hasItems ? tableTotalCents : null)
  const totalLabel = sale || amount === null ? "Total do pedido" : "Total de tabela"
  const total = amount === null ? "—" : money(amount)
  const calculationStatus = !sale && (pending ? "Calculando…" : !hasItems ? "Adicione equipamentos" : "Confira o cálculo")
  const issueLabel = issueCount === 1 ? "1 pendência para salvar" : `${issueCount} pendências para salvar`
  const announcementText = [totalLabel, total, calculationStatus, issueLabel].filter(Boolean).join(" • ")
  const [announcement, setAnnouncement] = useState(announcementText)

  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncement(announcementText), 400)
    return () => window.clearTimeout(timer)
  }, [announcementText])

  useEffect(() => {
    const desktop = window.matchMedia(desktopSummary)
    function openSummary() {
      if (desktop.matches) return
      const active = document.activeElement
      opener.current = active instanceof HTMLElement ? active : null
      setOpen(true)
    }
    function changeBreakpoint() {
      if (desktop.matches) setOpen(false)
    }

    window.addEventListener("order-open-summary", openSummary)
    desktop.addEventListener("change", changeBreakpoint)
    return () => {
      window.removeEventListener("order-open-summary", openSummary)
      desktop.removeEventListener("change", changeBreakpoint)
      window.cancelAnimationFrame(afterCloseFrame.current)
    }
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    let frame = 0

    function updateViewport() {
      const height = viewport?.height ?? window.innerHeight
      const offsetTop = viewport?.offsetTop ?? 0
      const coveredBottom = Math.max(0, window.innerHeight - height - offsetTop)
      const mobileBar = bar.current
      mobileBar?.style.setProperty("--order-summary-covered-bottom", `${coveredBottom}px`)
      popup.current?.style.setProperty("--order-summary-covered-bottom", `${coveredBottom}px`)
      popup.current?.style.setProperty("--order-summary-visible-height", `${height}px`)

      if (open || popup.current || !mobileBar?.getClientRects().length) return
      const field = document.activeElement
      if (!(field instanceof HTMLElement) || !field.matches(editableField) || !field.closest(".commercial-order-page") || field.closest("[role=dialog]")) return
      if (field.getBoundingClientRect().bottom + 8 > mobileBar.getBoundingClientRect().top) {
        field.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
      }
    }

    function scheduleUpdate() {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateViewport)
    }

    scheduleUpdate()
    viewport?.addEventListener("resize", scheduleUpdate)
    viewport?.addEventListener("scroll", scheduleUpdate)
    window.addEventListener("resize", scheduleUpdate)
    document.addEventListener("focusin", scheduleUpdate)
    return () => {
      window.cancelAnimationFrame(frame)
      viewport?.removeEventListener("resize", scheduleUpdate)
      viewport?.removeEventListener("scroll", scheduleUpdate)
      window.removeEventListener("resize", scheduleUpdate)
      document.removeEventListener("focusin", scheduleUpdate)
    }
  }, [open])

  function focusAfterClose(issue: OrderIssue) {
    setRequestedIssue(issue)
    setOpen(false)
  }

  function restoreFocus(isOpen: boolean) {
    if (isOpen) return
    const issue = requestedIssue
    const previousFocus = opener.current
    setRequestedIssue(null)
    opener.current = null

    afterCloseFrame.current = window.requestAnimationFrame(() => {
      if (issue) {
        onFocusIssue(issue)
        return
      }
      if (canRestoreFocus(previousFocus)) {
        previousFocus.focus({ preventScroll: true })
      } else if (canRestoreFocus(reviewButton.current)) {
        reviewButton.current.focus({ preventScroll: true })
      } else {
        document.querySelector<HTMLElement>("#order-review h2")?.focus({ preventScroll: true })
      }
    })
  }

  return <Sheet open={open} onOpenChange={setOpen} onOpenChangeComplete={restoreFocus}>
    <section ref={bar} className="order-mobile-summary" aria-label="Resumo rápido do pedido">
      <Button
        ref={reviewButton} type="button" variant="ghost" className="order-mobile-summary-review"
        aria-label="Revisar pedido" aria-haspopup="dialog" aria-expanded={open}
        onClick={event => {
          opener.current = event.currentTarget
          setOpen(true)
        }}
      >
        <span className="order-mobile-summary-copy">
          <span>{totalLabel}</span>
          <strong>{total}</strong>
          {calculationStatus && <small>{calculationStatus}</small>}
          <small>{issueLabel}</small>
        </span>
        <ChevronUp aria-hidden="true" />
      </Button>
      <Button
        className="order-mobile-summary-save" type="button" disabled={saveDisabled} onClick={onSave}
        title={saveReason || undefined} aria-description={saveReason || undefined}
      >{saveLabel}</Button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </section>
    <SheetContent ref={popup} side="bottom" className="order-summary-sheet" showCloseButton={false} initialFocus={closeButton} finalFocus={false}>
      <header className="order-summary-sheet-header">
        <SheetTitle>Resumo do pedido</SheetTitle>
        <SheetClose render={<Button ref={closeButton} type="button" variant="ghost" size="icon" aria-label="Fechar resumo" />}>
          <X aria-hidden="true" />
        </SheetClose>
      </header>
      <div className="order-summary-sheet-body">{renderSummary(focusAfterClose)}</div>
    </SheetContent>
  </Sheet>
}
