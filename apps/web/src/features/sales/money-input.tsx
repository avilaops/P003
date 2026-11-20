"use client"

import { useLayoutEffect, useRef, useState, type ComponentProps } from "react"
import { Input } from "@/components/ui/input"
import { money, parseAmount } from "./negotiation-types"

// Shows a typed amount as "R$ 1.500,00" once the field loses focus. The parent keeps the raw text
// the user typed ("1500,00"), so every existing parser keeps working; editing shows the raw text again.
export function MoneyInput({ value, onFocus, onBlur, ...props }: Omit<ComponentProps<typeof Input>, "value"> & { value: string }) {
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // Ao focar, o texto troca de "R$ 1.500,00" para "1500,00" e o navegador perde a seleção feita ao
  // entrar no campo (Tab ou clique); sem isto o que se digita é anexado ao valor antigo.
  useLayoutEffect(() => { if (focused) input.current?.select() }, [focused])
  const cents = value.trim() ? parseAmount(value) : null
  const shown = !focused && cents !== null ? money(cents) : value
  return <Input {...props} ref={input} inputMode="decimal" value={shown}
    onFocus={event => { setFocused(true); onFocus?.(event) }}
    onBlur={event => { setFocused(false); onBlur?.(event) }} />
}
