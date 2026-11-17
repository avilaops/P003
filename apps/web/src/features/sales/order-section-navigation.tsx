"use client"

import { useEffect, useRef, useState } from "react"
import { orderIssuesBySection, orderSteps, type OrderIssue, type OrderStepId } from "./order-progress"
import "./order-section-navigation.css"

function pendingCount(count: number) {
  return `${count} ${count === 1 ? "pendência" : "pendências"}`
}

function visible(element: HTMLElement) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible" && !element.closest("[hidden], [inert], [aria-hidden=true]")
}

function firstVisible(section: HTMLElement, selector: string) {
  return Array.from(section.querySelectorAll<HTMLElement>(selector)).find(visible)
}

export function revealOrderSection(step: OrderStepId, field?: string) {
  const section = document.getElementById(`order-${step}`)
  const fieldKey = field && CSS.escape(field.slice(field.indexOf(".") + 1))
  const target = field && section?.querySelector<HTMLElement>(
    `[data-order-field="${CSS.escape(field)}"], [data-order-customer-field="${fieldKey}"], [data-checkout-field="${fieldKey}"]`,
  )
  for (let node = target || section; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true
    if (node.hidden && node.id) {
      document.querySelector<HTMLButtonElement>(`button[aria-controls~="${CSS.escape(node.id)}"][aria-expanded=false]:not(:disabled)`)?.click()
    }
  }
  window.dispatchEvent(new CustomEvent("order-reveal-section", { detail: { section: step } }))
}

export function focusOrderSection(step: OrderStepId) {
  if (step === "review" && !window.matchMedia("(min-width: 1100px)").matches) {
    window.dispatchEvent(new CustomEvent("order-open-summary"))
    return
  }

  revealOrderSection(step)
  requestAnimationFrame(() => {
    const section = document.getElementById(`order-${step}`)
    if (!section || !visible(section)) return
    const target = firstVisible(section, ":is(input:not([type=hidden]), select, textarea):not(:disabled)")
      ?? firstVisible(section, "h2, h3") ?? firstVisible(section, "button:not(:disabled), summary") ?? section
    if (target === section || target.matches("h2, h3")) target.tabIndex = -1
    target.focus({ preventScroll: true })
    if (step !== "review") section.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" })
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
  })
}

export function OrderSectionNavigation({ issues }: { issues: OrderIssue[] }) {
  const nav = useRef<HTMLElement>(null)
  const [active, setActive] = useState<OrderStepId>("equipment")
  const counts = new Map(orderIssuesBySection(issues).map(group => [group.id, group.issues.length]))
  const issueCount = [...counts.values()].reduce((total, count) => total + count, 0)
  const [announcement, setAnnouncement] = useState(() => `${pendingCount(issueCount)} para salvar`)

  useEffect(() => {
    const timeout = window.setTimeout(() => setAnnouncement(`${pendingCount(issueCount)} para salvar`), 300)
    return () => window.clearTimeout(timeout)
  }, [issueCount])

  useEffect(() => {
    const navigation = nav.current
    if (!navigation || typeof IntersectionObserver === "undefined") return
    // Review is a fixed summary or dialog. The other sections follow the document flow.
    const sections = orderSteps.filter(step => step.id !== "review").flatMap(step => {
      const element = document.getElementById(`order-${step.id}`)
      return element ? [{ id: step.id, element }] : []
    })
    let observer: IntersectionObserver | undefined
    function observe() {
      if (!navigation) return
      observer?.disconnect()
      const top = (Number.parseFloat(getComputedStyle(navigation).top) || 0) + navigation.offsetHeight
      const bottom = Math.max(0, window.innerHeight - top - 56)
      observer = new IntersectionObserver(entries => {
        const boundary = entries[0]?.rootBounds?.bottom ?? top + 56
        const step = sections.findLast(({ element }) => visible(element) && element.getBoundingClientRect().top <= boundary + 1)
        setActive(step?.id ?? "equipment")
      }, { rootMargin: `-${top}px 0px -${bottom}px 0px` })
      sections.forEach(({ element }) => observer?.observe(element))
    }
    observe()
    window.addEventListener("resize", observe)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", observe)
    }
  }, [])

  useEffect(() => {
    const navigation = nav.current
    const current = navigation?.querySelector<HTMLElement>("[aria-current=step]")
    if (!navigation || !current) return
    const navBounds = navigation.getBoundingClientRect()
    const currentBounds = current.getBoundingClientRect()
    const left = currentBounds.left - navBounds.left
    const right = currentBounds.right - navBounds.right
    if (left < 0 || right > 0) navigation.scrollBy({ left: left < 0 ? left : right, behavior: "instant" })
  }, [active])

  return <nav ref={nav} className="order-section-navigation" aria-label="Seções do pedido">
    {orderSteps.map(step => {
      const count = counts.get(step.id) ?? 0
      return <button key={step.id} type="button" className="order-section-nav-button"
        aria-current={active === step.id ? "step" : undefined} aria-label={`${step.label} • ${pendingCount(count)}`}
        onClick={() => { setActive(step.id); focusOrderSection(step.id) }}>
        {step.label}<span className="order-section-nav-count" aria-hidden="true">{count}</span>
      </button>
    })}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
  </nav>
}

export function OrderPendingReview({ issues, onFocus, attempted }: { issues: OrderIssue[]; onFocus: (issue: OrderIssue) => void; attempted: boolean }) {
  const groups = orderIssuesBySection(issues)
  const issueCount = groups.reduce((total, group) => total + group.issues.length, 0)

  return <section className="order-pending-review" aria-label="Pendências do pedido">
    <h3>{pendingCount(issueCount)} para salvar</h3>
    {groups.map(group => <details key={group.id} open={attempted || group.issues.length < 3}>
      <summary>{group.label} • {pendingCount(group.issues.length)}</summary>
      <ul>{group.issues.map(issue => <li key={issue.field}>
        <button type="button" onClick={() => onFocus(issue)}>{issue.message}</button>
      </li>)}</ul>
    </details>)}
  </section>
}
