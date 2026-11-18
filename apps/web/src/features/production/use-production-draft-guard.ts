"use client"

import { useLayoutEffect } from "react"
import { useNavigationGuard } from "@/components/shell/navigation-guard"

export function useProductionDraftGuard(
  dirty: boolean, command: { busy: boolean; uncertain: boolean },
  draftMessage: string, onPendingChange: (pending: boolean) => void,
) {
  const pending = command.busy || command.uncertain
  useNavigationGuard(pending ? "Sair antes de confirmar o resultado desta operação?" : dirty ? draftMessage : null)
  useLayoutEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])
}
