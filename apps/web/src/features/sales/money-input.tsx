"use client"

import { useState, type ComponentProps } from "react"
import { Input } from "@/components/ui/input"
import { money, parseAmount } from "./negotiation-types"

// Shows a typed amount as "R$ 1.500,00" once the field loses focus. The parent keeps the raw text
// the user typed ("1500,00"), so every existing parser keeps working; editing shows the raw text again.
export function MoneyInput({ value, onFocus, onBlur, ...props }: Omit<ComponentProps<typeof Input>, "value"> & { value: string }) {
  const [focused, setFocused] = useState(false)
  const cents = value.trim() ? parseAmount(value) : null
  const shown = !focused && cents !== null ? money(cents) : value
  return <Input {...props} inputMode="decimal" value={shown}
    onFocus={event => { setFocused(true); onFocus?.(event) }}
    onBlur={event => { setFocused(false); onBlur?.(event) }} />
}
