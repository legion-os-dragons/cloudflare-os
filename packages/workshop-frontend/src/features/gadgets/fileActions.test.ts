// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
// @ts-expect-error Node crypto is provided by the test runner, not the browser runtime.
import { webcrypto } from 'node:crypto'
import { GadgetFileActions, sanitizePrintHtml } from './fileActions'
const scope={userId:'reader',gadgetId:1}
it('rejects wrong digest, unsafe names, MIME and revoked sessions before side effects',async()=>{
 vi.stubGlobal('crypto',webcrypto);const create=vi.fn<()=>void>();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:create}))
 const bytes=new TextEncoder().encode('%PDF-test');const good={filename:'receipt.pdf',mediaType:'application/pdf',base64:btoa(Array.from(bytes,n=>String.fromCharCode(n)).join('')),sha256:Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')}
 for(const bad of [{...good,sha256:'0'.repeat(64)},{...good,filename:'../secret.pdf'},{...good,mediaType:'text/html'},{...good,base64:'%%%'}])expect((await new GadgetFileActions(scope,()=>true).save(bad)).status).toBe('failed')
 expect((await new GadgetFileActions(undefined,()=>true).save(good)).status).toBe('failed');expect((await new GadgetFileActions(scope,()=>false).save(good)).status).toBe('failed');expect(create).not.toHaveBeenCalled()
})
it('removes active markup and external resources while retaining financial SVG and print selectors',()=>{
 const html=sanitizePrintHtml('<section data-print="yes"><script>alert(1)</script><img src="https://evil/track" onerror="bad()"><svg viewBox="0 0 10 10"><foreignObject><iframe src="x"></iframe></foreignObject><path d="M0 0L1 1" fill="url(https://evil)"></path><text>123.45</text></svg><a href="javascript:bad()">Money</a></section>')
 expect(html).toContain('data-print="yes"');expect(html).toContain('123.45');expect(html).toContain('<path');for(const bad of ['script','foreignObject','iframe','https://','onerror','href='])expect(html).not.toContain(bad)
})
it('opens one sanitized snapshot with no opener and prints only after load',()=>{
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn<()=>string>(()=> 'blob:owned'),revokeObjectURL:vi.fn<()=>void>()}))
 const print=vi.fn<()=>void>(),focus=vi.fn<()=>void>();let loaded:()=>void=()=>{};const popup={opener:window,focus,print,addEventListener:vi.fn<(event:string,callback:()=>void)=>void>((_event,callback)=>{loaded=callback})};const open=vi.spyOn(window,'open').mockReturnValue(popup as unknown as Window)
 expect(new GadgetFileActions(scope,()=>true).print({title:'Portfolio',html:'<main>$1,234</main>',css:'main{color:black}'})).toMatchObject({status:'available',value:{action:'print-opened'}})
 expect(open).toHaveBeenCalledOnce();expect(popup.opener).toBe(null);expect(print).not.toHaveBeenCalled();loaded();expect(print).toHaveBeenCalledOnce()
})
it('verifies original bytes before rotating a derived PDF and leaves the original unchanged',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();pdf.addPage([200,300]);const original=await pdf.save();const bytes=new Uint8Array(original)
 vi.stubGlobal('crypto',webcrypto);let delivered:Blob|undefined;vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn<(blob:Blob)=>string>((blob:Blob)=>{delivered=blob;return 'blob:owned'}),revokeObjectURL:vi.fn<()=>void>()}));const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 const result=await new GadgetFileActions(scope,()=>true).savePdf({filename:'receipt.pdf',base64:btoa(Array.from(bytes,n=>String.fromCharCode(n)).join('')),sha256:Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join(''),rotations:{1:90}})
 expect(result).toMatchObject({status:'available',value:{filename:'receipt-rotated.pdf'}});expect(click).toHaveBeenCalledOnce()
 const buffer=await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.addEventListener('load',()=>resolve(reader.result as ArrayBuffer));reader.addEventListener('error',reject);reader.readAsArrayBuffer(delivered!)})
 expect((await PDFDocument.load(buffer)).getPage(0).getRotation().angle).toBe(90);expect((await PDFDocument.load(original)).getPage(0).getRotation().angle).toBe(0)
})
