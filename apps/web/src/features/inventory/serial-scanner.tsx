"use client"

import {useEffect,useRef,useState} from "react"
import {Button} from "@/components/ui/button"

type Detector = {detect:(video:HTMLVideoElement)=>Promise<{rawValue:string}[]>}
export function SerialScanner({onRead}:{onRead:(value:string)=>void}) {
  const [active,setActive]=useState(false),[error,setError]=useState("")
  const view=useRef<HTMLVideoElement>(null),callback=useRef(onRead)
  useEffect(()=>{callback.current=onRead},[onRead])
  useEffect(()=>{
    if(!active) return
    let stopped=false,stream:MediaStream|undefined,timer=0
    async function scan(){
      const detector=(window as Window & {BarcodeDetector?:new()=>Detector}).BarcodeDetector
      if(!detector || !navigator.mediaDevices?.getUserMedia) throw Error("A câmera deste navegador não oferece leitura de códigos. Digite a série ou use o leitor conectado.")
      const reader=new detector()
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false})
      if(stopped||!view.current){stream.getTracks().forEach(t=>t.stop());return}
      view.current.srcObject=stream
      await view.current.play()
      async function frame(){
        if(stopped||!view.current) return
        try{
          const [found]=await reader.detect(view.current)
          if(stopped) return
          if(found?.rawValue){callback.current(found.rawValue);setActive(false);return}
          timer=window.setTimeout(()=>void frame(),200)
        }catch{if(!stopped){setError("A leitura falhou. Tente novamente ou digite a série.");setActive(false)}}
      }
      await frame()
    }
    void scan().catch(e=>{if(!stopped){setError(e instanceof Error ? e.message : "Câmera indisponível");setActive(false)}})
    return ()=>{stopped=true;window.clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop())}
  },[active])
  return <div><Button type="button" variant="outline" onClick={()=>{setError("");setActive(!active)}}>{active?"Fechar câmera":"Ler código com a câmera"}</Button>
    {active&&<video ref={view} muted playsInline aria-label="Leitor de código de barras" className="max-h-64 w-full"/>}
    {error&&<p role="status">{error}</p>}</div>
}
