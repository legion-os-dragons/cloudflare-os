import { RpcTarget } from 'capnweb'
import type { DeviceStateScope } from './deviceState'

export type FileActionResult = { status: 'available'; value: { action: 'download-requested' | 'preview-opened' | 'print-opened'; filename?: string } } | { status: 'failed' | 'unavailable'; reason: string }
export interface FileRequest { filename: string; mediaType: string; base64: string; sha256: string }
export interface PdfRequest { filename: string; base64: string; sha256: string; rotations?: Record<string, 0 | 90 | 180 | 270> }
const MAX_BYTES = 64 * 1024 * 1024
const mimeTypes = new Set(['application/pdf', 'text/csv', 'text/plain', 'application/json'])
const htmlTags = new Set('div span p section article main header footer nav aside h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr td th caption colgroup col ul ol li dl dt dd strong em b i small label button details summary br hr pre code a img svg g path rect circle ellipse line polyline polygon text tspan defs clippath lineargradient radialgradient stop title desc'.split(' '))
const svgAttrs = new Set('viewbox d x y x1 x2 y1 y2 cx cy r rx ry width height points fill stroke stroke-width stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity transform text-anchor dominant-baseline font-size offset stop-color stop-opacity clip-path preserveaspectratio'.split(' '))
function safeCss(css: string): string {
  return css.replace(/@import\s[^;{}]*(?:;|$)/gi, '').replace(/url\s*\([^)]*\)/gi, value => /^url\(\s*['"]?#[\w-]+['"]?\s*\)$/i.test(value) ? value : 'none').replace(/expression\s*\([^)]*\)/gi, '').replace(/-moz-binding\s*:[^;}]*/gi, '').replace(/<\/style/gi, '<\\/style')
}
/** Inert parsing followed by reconstruction: active elements never enter the print document. */
export function sanitizePrintHtml(html: string, doc: Document = document): string {
  const template = doc.createElement('template'); template.innerHTML = html
  const output = doc.createElement('div')
  const copy = (source: Node, destination: Node) => {
    if (source.nodeType === 3) { destination.appendChild(doc.createTextNode(source.textContent ?? '')); return }
    if (!(source instanceof doc.defaultView!.Element)) return
    const tag = source.localName.toLowerCase()
    if (!htmlTags.has(tag)) return
    const node = source.namespaceURI === 'http://www.w3.org/2000/svg' ? doc.createElementNS(source.namespaceURI, source.localName) : doc.createElement(tag)
    for (const attribute of source.attributes) {
      const key = attribute.name.toLowerCase(), value = attribute.value
      if (key === 'style') node.setAttribute('style', safeCss(value))
      else if (['class', 'id', 'role', 'colspan', 'rowspan', 'open', 'dir', 'lang', 'hidden'].includes(key) || key.startsWith('data-') || key.startsWith('aria-')) node.setAttribute(attribute.name, value)
      else if (tag === 'img' && key === 'src' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length < 4 * 1024 * 1024) node.setAttribute('src', value)
      else if (svgAttrs.has(key) && !/[<>]/.test(value) && (!/url\s*\(/i.test(value) || /^url\(#[\w-]+\)$/.test(value))) node.setAttribute(attribute.name, value)
    }
    for (const child of source.childNodes) copy(child, node)
    destination.appendChild(node)
  }
  for (const child of template.content.childNodes) copy(child, output)
  return output.innerHTML
}
export class GadgetFileActions extends RpcTarget {
  #current: () => boolean
  #scoped: boolean
  constructor(scope: DeviceStateScope | undefined, current: () => boolean) {
    super(); this.#current = current; this.#scoped = !!scope?.userId && Number.isSafeInteger(scope.gadgetId) && scope.gadgetId >= 0
  }
  #check(): void { if (!this.#scoped || !this.#current()) throw Error('The authenticated gadget session is not available.') }
  async #bytes(request: FileRequest): Promise<Uint8Array<ArrayBuffer>> {
    this.#check()
    if (!request || typeof request.filename !== 'string' || (request.filename.length < 1 || request.filename.length > 180 || /[/\\]/.test(request.filename) || Array.from(request.filename).some(character => character.charCodeAt(0) < 32)) || request.filename === '.' || request.filename === '..' || !mimeTypes.has(request.mediaType)) throw Error('The file name or media type is not supported.')
    if (typeof request.base64 !== 'string' || request.base64.length > Math.ceil(MAX_BYTES / 3) * 4 || request.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(request.base64)) throw Error('The file bytes are not valid bounded base64.')
    const raw = atob(request.base64), bytes = Uint8Array.from(raw, c => c.charCodeAt(0))
    if (bytes.length > MAX_BYTES || btoa(raw) !== request.base64 || !/^[a-f0-9]{64}$/.test(request.sha256)) throw Error('The file digest or size is invalid.')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
    this.#check(); if (hash !== request.sha256) throw Error('The file does not match its original digest.')
    if (request.mediaType === 'application/pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw Error('The selected file is not a PDF.')
    return bytes
  }
  #download(bytes: Uint8Array<ArrayBuffer>, mediaType: string, filename: string): FileActionResult {
    this.#check(); if (bytes.length > MAX_BYTES) throw Error('The derived file exceeds the download size limit.'); const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    return { status: 'available', value: { action: 'download-requested', filename } }
  }
  async save(request: FileRequest): Promise<FileActionResult> {
    try { return this.#download(await this.#bytes(request), request.mediaType, request.filename) } catch (error) { return { status: 'failed', reason: String((error as Error).message) } }
  }
  async savePdf(request: PdfRequest): Promise<FileActionResult> {
    try {
      let bytes = await this.#bytes({ ...request, mediaType: 'application/pdf' }); let filename = request.filename
      const rotations = Object.entries(request.rotations ?? {})
      if (rotations.length > 10000 || rotations.some(([page, angle]) => !/^[1-9]\d*$/.test(page) || ![0, 90, 180, 270].includes(angle))) throw Error('PDF rotations must identify one-based pages and quarter turns.')
      if (rotations.some(([, angle]) => angle !== 0)) {
        const { PDFDocument, degrees } = await import('pdf-lib'); const pdf = await PDFDocument.load(bytes)
        for (const [page, angle] of rotations) { const index = Number(page) - 1; if (index >= pdf.getPageCount()) throw Error('A rotated page is outside the PDF.'); const target = pdf.getPage(index); target.setRotation(degrees((target.getRotation().angle + angle) % 360)) }
        bytes = Uint8Array.from(await pdf.save()); filename = filename.replace(/\.pdf$/i, '') + '-rotated.pdf'
      }
      return this.#download(bytes, 'application/pdf', filename)
    } catch (error) { return { status: 'failed', reason: String((error as Error).message) } }
  }
  async previewPdf(request: PdfRequest): Promise<FileActionResult> {
    try {
      const bytes = await this.#bytes({ ...request, mediaType: 'application/pdf' }); this.#check()
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); const popup = window.open(url, '_blank'); if (!popup) { URL.revokeObjectURL(url); throw Error('The browser blocked the local PDF preview window.') }
      popup.opener = null; setTimeout(() => URL.revokeObjectURL(url), 60000)
      return { status: 'available', value: { action: 'preview-opened', filename: request.filename } }
    } catch (error) { return { status: 'failed', reason: String((error as Error).message) } }
  }
  print(request: { title: string; html: string; css: string }): FileActionResult {
    try {
      this.#check()
      if (!request || typeof request.title !== 'string' || request.title.length > 240 || typeof request.html !== 'string' || request.html.length > 8 * 1024 * 1024 || typeof request.css !== 'string' || request.css.length > 1024 * 1024) throw Error('The print snapshot exceeds its bounded report size.')
      const title = document.createElement('span'); title.textContent = request.title
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${title.innerHTML}</title><style>${safeCss(request.css)}</style></head><body>${sanitizePrintHtml(request.html)}</body></html>`
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })); const popup = window.open(url, '_blank')
      if (!popup) { URL.revokeObjectURL(url); throw Error('The browser blocked the print window.') }
      popup.opener = null; popup.addEventListener('load', () => { if (this.#current()) { popup.focus(); popup.print() } URL.revokeObjectURL(url) }, { once: true })
      return { status: 'available', value: { action: 'print-opened' } }
    } catch (error) { return { status: 'failed', reason: String((error as Error).message) } }
  }
}
