import { Suspense } from "react"
import { ChannelWorkspace } from "@/features/sales/channel-workspace"

export const metadata = {title:"Anúncio"}
type Props={params:Promise<{id:string}>}
export default function Page(props:Props){
 return <Suspense fallback={<p role="status">Consultando anúncio…</p>}><Detail {...props}/></Suspense>
}
async function Detail({params}:Props) {
 const {id}=await params
 return <ChannelWorkspace mode="view" id={id}/>
}
