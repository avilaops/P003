"use client"

import { useRef, useState } from "react"
import { erpFetch } from "@/lib/api/client"
import { useNavigationGuard } from "@/components/shell/navigation-guard"

type CountRequest = { url: string; data: object; revision?: number; expects: "line" | "session"; key: string }
export function useCountCommand(tenant: string) {
  const current = useRef<CountRequest | null>(null),
    running = useRef(false)
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("")
  useNavigationGuard(busy || uncertain ? "Sair antes de confirmar o resultado desta operação?" : null)
  async function send(url: string, data: object, expects: CountRequest["expects"], revision?: number) {
    if (running.current) return null
    const cmd = current.current ?? { url, data, expects, revision, key: crypto.randomUUID() }
    current.current = cmd
    running.current = true
    setBusy(true)
    setError("")
    try {
      const response = await erpFetch(cmd.url, {
        method: "POST",
        headers: {
          "X-Tenant-Id": tenant,
          "Content-Type": "application/json",
          "Idempotency-Key": cmd.key,
          ...(cmd.revision === undefined ? {} : { "If-Match": '"' + cmd.revision + '"' }),
        },
        body: JSON.stringify(cmd.data),
      })
      if (!response.ok) {
        const problem = await response.json().catch(() => ({ title: "O servidor recusou a operação." }))
        setError(problem.title || "O servidor recusou a operação.")
        if (response.status >= 500) setUncertain(true)
        else {
          current.current = null
          setUncertain(false)
        }
        return null
      }
      const result = cmd.expects === "line" && response.status === 204 ? { id: "" } : await response.json()
      if (typeof result.id !== "string" || (cmd.expects === "session" && !result.id)) throw Error()
      current.current = null
      setUncertain(false)
      return result as { id: string }
    } catch {
      setUncertain(true)
      setError("A resposta não confirmou o resultado. Repita a mesma confirmação.")
      return null
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { send, busy, uncertain, error }
}
