import HomeContent from "@/content/home/overview.mdx"
import { PendingWorkPanel } from "@/features/pending-work/pending-work-panel"

export function ErpDashboard() {
  return <>
    <HomeContent />
    <div className="mx-auto w-full min-w-0 max-w-[1600px] px-4 pb-6 lg:px-6"><PendingWorkPanel /></div>
  </>
}
