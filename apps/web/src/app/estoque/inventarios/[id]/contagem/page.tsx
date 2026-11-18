import { CountPage } from "@/features/inventory/count-access"
export const metadata = {title:"Contagem de inventário"}
export default function Page({params}:{params:Promise<{id:string}>}) { return <CountPage params={params} /> }
